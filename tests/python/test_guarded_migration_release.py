"""Isolated release/migration orchestration tests. No service or network calls."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "guarded-release.py"
spec = importlib.util.spec_from_file_location("blackdog_migration_guard", MODULE_PATH)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class MigrationReleaseTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.state = self.root / "deploy"
        self.data = self.root / "data"
        self.data.mkdir()
        data_check = patch.object(guard, "validate_service_data_directory")
        data_check.start()
        self.addCleanup(data_check.stop)
        self.old_sha = "1" * 40
        self.new_sha = "2" * 40
        self.old = self.state / "releases" / self.old_sha
        self.new = self.state / "releases" / self.new_sha
        for release, sha in ((self.old, self.old_sha), (self.new, self.new_sha)):
            release.mkdir(parents=True)
            (release / ".blackdog-release-tested").write_text(sha + "\n")
        self.current = self.state / "current"
        self.current.symlink_to(self.old)
        self.cli = self.new / "src/migrations/cli.ts"
        self.cli.parent.mkdir(parents=True)
        self.cli.write_text("// test candidate")
        for target in ("notify", "update_docker_services"):
            p = patch.object(guard, target)
            p.start()
            self.addCleanup(p.stop)
        journal = patch.object(guard, "save_journal", return_value=self.state / "failed.log")
        journal.start()
        self.addCleanup(journal.stop)
        self.events = []
        self.transaction = "t-123-abc"

    def activate(self, **options):
        return guard.activate(self.state, "blackdogbot.service", self.new_sha, None,
                              data_dir=self.data, update_containers=False, timeout=10, **options)

    def migration(self, release, data_dir, action, transaction=None, **options):
        self.assertEqual(data_dir, self.data)
        self.events.append(action)
        if action == "plan":
            return {"protocolVersion": 1, "backupProtocolVersion": 1, "backupReady": True, "needsMigration": release == self.new}
        if action in ("backup-create", "backup-verify"):
            self.assertEqual(self.current.resolve(), self.old)
            self.assertEqual(self.events[-2], "stop" if action == "backup-create" else "backup-create")
            return {"protocolVersion": 1, "status": "created" if action == "backup-create" else "verified",
                    "backupPath": str(options["backup_dir"]), "manifestSha256": "a" * 64,
                    "fileCount": 2, "totalBytes": 10}
        if action == "apply":
            self.assertEqual(self.current.resolve(), self.new)
            self.assertEqual(self.events[-2], "backup-verify")
            self.assertEqual(self.outcome()["status"], "backup_ready")
            self.assertEqual(self.outcome()["backup"]["manifestSha256"], "a" * 64)
            (self.data / ".data-schema.json").write_text('{"version":1}')
            return {"protocolVersion": 1, "status": "applied", "transactionId": self.transaction}
        if action == "rollback":
            self.assertEqual(transaction, self.transaction)
            self.assertEqual(self.events[-2], "stop")
            (self.data / ".data-schema.json").unlink()
            return {"protocolVersion": 1, "status": "rolled_back"}
        self.fail("Unexpected action")

    def stop(self, unit):
        self.events.append("stop")

    def outcome(self):
        return json.loads((self.state / "reports/latest.json").read_text())

    def test_migration_runs_only_after_stop_and_with_candidate_startup_gate(self):
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=self.stop), \
             patch.object(guard, "migration_command", side_effect=self.migration), \
             patch.object(guard, "restart_and_probe", return_value=(True, 10.0)) as start:
            self.assertTrue(self.activate())
        self.assertEqual(self.events, ["plan", "stop", "backup-create", "backup-verify", "apply"])
        self.assertEqual(self.current.resolve(), self.new)
        self.assertEqual(self.outcome()["migration_transaction"], self.transaction)
        start.assert_called_once()

    def test_candidate_without_backup_capability_is_rejected_before_stop(self):
        with patch.object(guard, "migration_command", return_value={"protocolVersion": 1, "needsMigration": False}), \
             patch.object(guard, "stop_and_verify") as stop:
            with self.assertRaisesRegex(RuntimeError, "does not support verified"):
                self.activate()
        stop.assert_not_called()
        self.assertEqual(self.current.resolve(), self.old)

    def test_backup_preflight_issue_is_actionable_and_never_stops_service(self):
        issue = "Configured skill directory is outside the runtime data root."
        plan = {"protocolVersion": 1, "backupProtocolVersion": 1, "backupReady": False,
                "backupIssue": issue, "needsMigration": False}
        with patch.object(guard, "migration_command", return_value=plan), \
             patch.object(guard, "stop_and_verify") as stop:
            with self.assertRaisesRegex(guard.MigrationCommandError, "outside the runtime"):
                self.activate()
        stop.assert_not_called()
        self.assertEqual(self.outcome()["status"], "preflight_failed")
        self.assertEqual(self.outcome()["reason"], issue)
        self.assertTrue(self.outcome()["service_unchanged"])
        self.assertEqual(self.current.resolve(), self.old)

    def test_structured_cli_failure_preserves_safe_reason_and_transaction(self):
        failure = json.dumps({"protocolVersion": 1, "status": "failed",
                              "error": "Task changed after migration", "transactionId": self.transaction})
        error = subprocess.CalledProcessError(1, ["tsx"], output=failure, stderr="UNSAFE STDERR")
        with patch.object(guard, "run", side_effect=error):
            with self.assertRaises(guard.MigrationCommandError) as caught:
                guard.migration_command(self.new, self.data, "rollback", self.transaction)
        self.assertEqual(str(caught.exception), "Task changed after migration")
        self.assertEqual(caught.exception.transaction_id, self.transaction)
        self.assertNotIn("UNSAFE STDERR", str(caught.exception))

    def test_unknown_cli_failure_does_not_expose_raw_output(self):
        error = subprocess.CalledProcessError(1, ["tsx"], output="private key in raw output", stderr="secret stderr")
        with patch.object(guard, "run", side_effect=error):
            with self.assertRaises(guard.MigrationCommandError) as caught:
                guard.migration_command(self.new, self.data, "plan")
        self.assertNotIn("private key", str(caught.exception))
        self.assertNotIn("secret stderr", str(caught.exception))
        self.assertIsNone(caught.exception.transaction_id)

    def test_failed_plan_records_structured_reason_without_mutation(self):
        error = guard.MigrationCommandError("Unsupported schema version")
        with patch.object(guard, "migration_command", side_effect=error), \
             patch.object(guard, "stop_and_verify") as stop:
            with self.assertRaises(guard.MigrationCommandError):
                self.activate()
        stop.assert_not_called()
        self.assertEqual(self.outcome()["reason"], "Unsupported schema version")
        self.assertTrue(self.outcome()["data_unchanged"])

    def test_legacy_candidate_without_backup_command_is_not_silently_unprotected(self):
        self.cli.unlink()
        with patch.object(guard, "stop_and_verify") as stop:
            with self.assertRaisesRegex(RuntimeError, "does not support verified"):
                self.activate()
        stop.assert_not_called()
        self.assertEqual(self.current.resolve(), self.old)

    def test_backup_creation_failure_keeps_old_pointer_and_blocks_migration(self):
        def migration(release, data_dir, action, transaction=None, **options):
            if action == "backup-create":
                raise RuntimeError("not enough disk space")
            return self.migration(release, data_dir, action, transaction, **options)
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=self.stop) as stop, \
             patch.object(guard, "migration_command", side_effect=migration) as commands, \
             patch.object(guard, "restart_and_probe") as start:
            self.assertFalse(self.activate())
        stop.assert_called_once()
        start.assert_not_called()
        self.assertEqual([c.args[2] for c in commands.call_args_list], ["plan", "backup-create"])
        self.assertEqual(self.current.resolve(), self.old)
        self.assertEqual(self.outcome()["status"], "backup_failed")
        self.assertTrue(self.outcome()["data_unchanged"])
        self.assertTrue(self.outcome()["service_stopped"])

    def test_backup_verification_mismatch_blocks_activation(self):
        def migration(release, data_dir, action, transaction=None, **options):
            result = self.migration(release, data_dir, action, transaction, **options)
            if action == "backup-verify":
                result["manifestSha256"] = "b" * 64
            return result
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=self.stop), \
             patch.object(guard, "migration_command", side_effect=migration), \
             patch.object(guard, "restart_and_probe") as start:
            self.assertFalse(self.activate())
        start.assert_not_called()
        self.assertNotIn("apply", self.events)
        self.assertEqual(self.current.resolve(), self.old)
        self.assertFalse(self.outcome()["backup_verified"])

    def test_backup_receipt_is_durable_before_pointer_switch(self):
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=self.stop), \
             patch.object(guard, "migration_command", side_effect=self.migration), \
             patch.object(guard, "point_to", side_effect=RuntimeError("simulated process interruption")):
            with self.assertRaisesRegex(RuntimeError, "simulated process interruption"):
                self.activate()
        self.assertEqual(self.current.resolve(), self.old)
        self.assertEqual(self.outcome()["status"], "backup_ready")
        self.assertEqual(self.outcome()["backup"]["manifestSha256"], "a" * 64)
        self.assertNotIn("apply", self.events)

    def test_backup_root_is_external_and_each_destination_is_unique(self):
        first = guard.backup_destination(self.data, self.new_sha, None)
        second = guard.backup_destination(self.data, self.new_sha, None)
        self.assertEqual(first.parent, self.data.parent / "data-backups")
        self.assertNotEqual(first, second)
        self.assertFalse(first.exists())

    def test_internal_backup_root_is_rejected_before_stop(self):
        with patch.object(guard, "migration_command", side_effect=self.migration), \
             patch.object(guard, "stop_and_verify") as stop:
            with self.assertRaisesRegex(RuntimeError, "outside the runtime"):
                self.activate(backup_root=self.data / "backups")
        stop.assert_not_called()

    def test_import_flag_is_forwarded_only_to_plan_and_apply(self):
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=self.stop), \
             patch.object(guard, "migration_command", side_effect=self.migration) as commands, \
             patch.object(guard, "restart_and_probe", return_value=(True, 10.0)):
            self.assertTrue(self.activate(import_legacy_tasks=True))
        for call in commands.call_args_list:
            self.assertEqual(call.kwargs.get("import_legacy_tasks", False), call.args[2] in ("plan", "apply"))

    def test_backup_verify_command_is_read_only_and_has_no_live_data_argument(self):
        backup = self.root / "saved-backup"
        result = subprocess.CompletedProcess([], 0, json.dumps({
            "protocolVersion": 1, "status": "verified", "backupPath": str(backup),
            "manifestSha256": "a" * 64, "fileCount": 1, "totalBytes": 10,
        }))
        with patch.object(guard, "run", return_value=result) as run:
            guard.migration_command(self.new, self.data, "backup-verify", backup_dir=backup)
        argv = run.call_args.args[0]
        self.assertNotIn("--offline", argv)
        self.assertNotIn("--data-dir", argv)
        self.assertIn("--backup-dir", argv)

    def test_backup_receipt_requires_a_manifest_hash(self):
        backup = self.root / "saved-backup"
        result = subprocess.CompletedProcess([], 0, json.dumps({
            "protocolVersion": 1, "status": "created", "backupPath": str(backup),
            "fileCount": 1, "totalBytes": 10,
        }))
        with patch.object(guard, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "manifest hash"):
                guard.migration_command(self.new, self.data, "backup-create", backup_dir=backup)

    def test_failed_health_restores_data_before_starting_previous_code(self):
        def start(unit, pid, timeout):
            release = self.current.resolve()
            self.events.append("start-new" if release == self.new else "start-old")
            if release == self.old:
                self.assertFalse((self.data / ".data-schema.json").exists())
            return release == self.old, 10.0
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=self.stop), \
             patch.object(guard, "migration_command", side_effect=self.migration), \
             patch.object(guard, "restart_and_probe", side_effect=start):
            self.assertFalse(self.activate())
        self.assertEqual(self.events, ["plan", "stop", "backup-create", "backup-verify", "apply", "start-new", "stop", "rollback", "start-old"])
        self.assertEqual(self.current.resolve(), self.old)
        self.assertEqual(self.outcome()["status"], "rolled_back")

    def test_journal_write_failure_does_not_prevent_stopping_and_rollback(self):
        def start(unit, pid, timeout):
            return self.current.resolve() == self.old, 10.0
        def failed_journal(*args):
            self.assertEqual(self.events[-1], "stop")
            raise OSError("simulated full disk")
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=self.stop), \
             patch.object(guard, "migration_command", side_effect=self.migration), \
             patch.object(guard, "restart_and_probe", side_effect=start), \
             patch.object(guard, "save_journal", side_effect=failed_journal):
            self.assertFalse(self.activate())
        self.assertEqual(self.events.count("stop"), 2)
        self.assertIn("rollback", self.events)
        self.assertEqual(self.current.resolve(), self.old)
        self.assertEqual(self.outcome()["status"], "rolled_back")
        self.assertIsNone(self.outcome()["journal"])
        self.assertEqual(self.outcome()["journal_save_error"], "OSError")

    def test_final_report_failure_does_not_mask_successful_restore(self):
        real_report = guard.report
        def report(state, outcome):
            if outcome["status"] == "rolled_back":
                raise OSError("simulated full disk")
            return real_report(state, outcome)
        def start(unit, pid, timeout):
            return self.current.resolve() == self.old, 10.0
        error_output = io.StringIO()
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=self.stop), \
             patch.object(guard, "migration_command", side_effect=self.migration), \
             patch.object(guard, "restart_and_probe", side_effect=start), \
             patch.object(guard, "report", side_effect=report), \
             patch.object(guard.sys, "stderr", error_output):
            self.assertFalse(self.activate())
        self.assertEqual(self.current.resolve(), self.old)
        self.assertIn("rollback", self.events)
        self.assertIn("reached rolled_back", error_output.getvalue())

    def test_recovery_failure_report_error_cannot_start_prior_code(self):
        real_report = guard.report
        def report(state, outcome):
            if outcome["status"] == "data_recovery_failed":
                raise OSError("simulated full disk")
            return real_report(state, outcome)
        def stop(unit):
            self.stop(unit)
            if self.events.count("stop") > 1:
                raise RuntimeError("still running")
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=stop), \
             patch.object(guard, "migration_command", side_effect=self.migration), \
             patch.object(guard, "restart_and_probe", return_value=(False, 10.0)) as start, \
             patch.object(guard, "report", side_effect=report), \
             patch.object(guard.sys, "stderr", io.StringIO()):
            self.assertFalse(self.activate())
        start.assert_called_once()
        self.assertNotIn("rollback", self.events)
        self.assertEqual(self.current.resolve(), self.new)

    def test_healthy_report_error_does_not_trigger_rollback(self):
        real_report = guard.report
        def report(state, outcome):
            if outcome["status"] == "healthy":
                raise OSError("simulated full disk")
            return real_report(state, outcome)
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=self.stop), \
             patch.object(guard, "migration_command", side_effect=self.migration), \
             patch.object(guard, "restart_and_probe", return_value=(True, 10.0)), \
             patch.object(guard, "report", side_effect=report), \
             patch.object(guard.sys, "stderr", io.StringIO()):
            self.assertTrue(self.activate())
        self.assertEqual(self.current.resolve(), self.new)
        self.assertNotIn("rollback", self.events)
        self.assertEqual(self.events.count("stop"), 1)

    def test_apply_failure_retains_candidate_gate_and_leaves_service_stopped(self):
        def migration(release, data_dir, action, transaction=None, **options):
            if action == "apply":
                raise subprocess.CalledProcessError(1, ["tsx"])
            return self.migration(release, data_dir, action, transaction, **options)
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=self.stop), \
             patch.object(guard, "migration_command", side_effect=migration), \
             patch.object(guard, "restart_and_probe") as start:
            self.assertFalse(self.activate())
        start.assert_not_called()
        self.assertEqual(self.current.resolve(), self.new)
        self.assertEqual(self.outcome()["status"], "migration_failed")
        self.assertTrue(self.outcome()["service_stopped"])

    def test_preflight_failure_preserves_running_release(self):
        with patch.object(guard, "migration_command", side_effect=RuntimeError("unknown schema")), \
             patch.object(guard, "stop_and_verify") as stop:
            with self.assertRaisesRegex(RuntimeError, "unknown schema"):
                self.activate()
        stop.assert_not_called()
        self.assertEqual(self.current.resolve(), self.old)

    def test_unstopped_service_prevents_pointer_change_and_migration(self):
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=RuntimeError("still active")), \
             patch.object(guard, "migration_command", side_effect=self.migration):
            self.assertFalse(self.activate())
        self.assertEqual(self.events, ["plan"])
        self.assertEqual(self.current.resolve(), self.old)
        self.assertEqual(self.outcome()["status"], "stop_failed")

    def test_restore_conflict_never_starts_old_code(self):
        def migration(release, data_dir, action, transaction=None, **options):
            if action == "rollback":
                raise RuntimeError("Task was edited after migration")
            return self.migration(release, data_dir, action, transaction, **options)
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=self.stop), \
             patch.object(guard, "migration_command", side_effect=migration), \
             patch.object(guard, "restart_and_probe", return_value=(False, 10.0)) as start:
            self.assertFalse(self.activate())
        start.assert_called_once()
        self.assertEqual(self.current.resolve(), self.new)
        self.assertEqual(self.events.count("stop"), 2)
        self.assertEqual(self.outcome()["status"], "data_recovery_failed")
        self.assertTrue(self.outcome()["manual_recovery_required"])

    def test_schema_marker_blocks_legacy_downgrade(self):
        self.cli.unlink()
        (self.data / ".data-schema.json").write_text('{"version":1}')
        with self.assertRaisesRegex(RuntimeError, "unverified downgrade"):
            self.activate()
        self.assertEqual(self.current.resolve(), self.old)

    def test_pending_journal_blocks_legacy_downgrade_without_schema_marker(self):
        path = self.data / ".migrations/transactions/t-pending/journal.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"formatVersion": 1, "id": "t-pending", "status": "applying"}))
        with self.assertRaisesRegex(RuntimeError, "must be recovered"):
            guard.can_start_release(self.old, self.data)

    def test_completed_rollback_allows_previous_legacy_release(self):
        path = self.data / ".migrations/transactions/t-rolled-back/journal.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"formatVersion": 1, "id": "t-rolled-back", "status": "rolled_back"}))
        guard.can_start_release(self.old, self.data)

    def test_recovery_barrier_blocks_legacy_start(self):
        barrier = self.data / ".migrations/recovery.json"
        barrier.parent.mkdir()
        barrier.write_text("{}")
        with self.assertRaisesRegex(RuntimeError, "unverified downgrade"):
            guard.can_start_release(self.old, self.data)

    def test_symlink_metadata_blocks_legacy_start(self):
        (self.data / ".migrations").symlink_to(self.state, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "must not be a symlink"):
            guard.can_start_release(self.old, self.data)

    def test_symlink_root_is_rejected_before_following_it(self):
        link = self.root / "linked-data"
        link.symlink_to(self.data, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "must not be a symlink"):
            guard.activate(self.state, "blackdogbot.service", self.new_sha, None, data_dir=link)

    def test_failed_stop_during_recovery_records_that_candidate_may_be_running(self):
        def stop(unit):
            self.stop(unit)
            if self.events.count("stop") > 1:
                raise RuntimeError("still running")
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify", side_effect=stop), \
             patch.object(guard, "migration_command", side_effect=self.migration) as migration, \
             patch.object(guard, "restart_and_probe", return_value=(False, 10.0)):
            self.assertFalse(self.activate())
        self.assertFalse(self.outcome()["service_stopped"])
        self.assertEqual(self.outcome()["recovery_phase"], "stop_candidate")
        self.assertEqual([c.args[2] for c in migration.call_args_list], ["plan", "backup-create", "backup-verify", "apply"])
        self.assertEqual(self.current.resolve(), self.new)

    def real_migration_fixture(self):
        repository = MODULE_PATH.parents[1]
        self.cli.unlink()
        self.cli.parent.rmdir()
        self.cli.parent.parent.rmdir()
        (self.new / "src").symlink_to(repository / "src", target_is_directory=True)
        (self.new / "node_modules").symlink_to(repository / "node_modules", target_is_directory=True)
        (self.new / "package.json").write_text('{"type":"module"}')
        (self.data / "config.yaml").write_text(
            "ai:\n  provider: openai-compatible\n  openAiCompatible:\n"
            "    baseUrl: http://127.0.0.1:9/v1\n    apiKey: test-only\n    model: fixture\n"
            "scheduler:\n  enabled: false\n  timezone: UTC\n"
            "skills:\n  directories: []\n  autoSetup: false\n"
            "knowledge:\n  lancedbPath: " + json.dumps(str(self.data / "knowledge/lancedb")) + "\n"
        )
        original = (repository / "tests/fixtures/migrations/timed/legacy-interval.json").read_bytes()
        task = self.data / "timed/historical-task-1.json"
        task.parent.mkdir()
        task.write_bytes(original)
        return task, original

    @unittest.skipUnless((MODULE_PATH.parents[1] / "node_modules/.bin/tsx").is_file(), "pnpm dependencies required")
    def test_real_cli_failed_health_restores_original_task_bytes(self):
        task, original = self.real_migration_fixture()
        config = (self.data / "config.yaml").read_bytes()
        def start(unit, pid, timeout):
            if self.current.resolve() == self.new:
                self.assertNotEqual(task.read_bytes(), original)
                self.assertTrue((self.data / ".data-schema.json").is_file())
                return False, 10.0
            self.assertEqual(task.read_bytes(), original)
            return True, 11.0
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify") as stop, \
             patch.object(guard, "restart_and_probe", side_effect=start):
            self.assertFalse(self.activate())
        self.assertEqual(stop.call_count, 2)
        self.assertEqual(task.read_bytes(), original)
        self.assertEqual((self.data / "config.yaml").read_bytes(), config)
        self.assertFalse((self.data / ".data-schema.json").exists())
        self.assertEqual(self.current.resolve(), self.old)
        self.assertEqual(self.outcome()["status"], "rolled_back")
        backup = self.outcome()["backup"]
        self.assertTrue(Path(backup["backupPath"]).is_dir())
        verified = guard.migration_command(self.new, self.data, "backup-verify", backup_dir=Path(backup["backupPath"]))
        self.assertEqual(verified["manifestSha256"], backup["manifestSha256"])

    @unittest.skipUnless((MODULE_PATH.parents[1] / "node_modules/.bin/tsx").is_file(), "pnpm dependencies required")
    def test_real_cli_keeps_post_upgrade_task_edit_and_blocks_old_code(self):
        task, original = self.real_migration_fixture()
        edited = None
        def start(unit, pid, timeout):
            nonlocal edited
            self.assertEqual(self.current.resolve(), self.new)
            value = json.loads(task.read_bytes())
            value["description"] = "New user change after migration"
            edited = json.dumps(value).encode()
            task.write_bytes(edited)
            return False, 10.0
        with patch.object(guard, "service_state", return_value=("active", 44)), \
             patch.object(guard, "stop_and_verify") as stop, \
             patch.object(guard, "restart_and_probe", side_effect=start) as restart:
            self.assertFalse(self.activate())
        restart.assert_called_once()
        self.assertEqual(stop.call_count, 2)
        self.assertEqual(task.read_bytes(), edited)
        self.assertTrue((self.data / ".data-schema.json").is_file())
        self.assertEqual(self.current.resolve(), self.new)
        self.assertEqual(self.outcome()["status"], "data_recovery_failed")
        self.assertTrue(self.outcome()["service_stopped"])
        self.assertTrue(Path(self.outcome()["backup"]["backupPath"]).is_dir())

    def test_same_release_stopped_is_not_reported_as_success(self):
        guard.point_to(self.current, self.new)
        with patch.object(guard, "migration_command", return_value={"protocolVersion": 1, "needsMigration": False}), \
             patch.object(guard, "service_state", return_value=("inactive", 0)):
            with self.assertRaisesRegex(RuntimeError, "Selected release is stopped"):
                self.activate()

    def test_mismatched_tested_marker_is_rejected(self):
        (self.new / ".blackdog-release-tested").write_text(self.old_sha)
        with self.assertRaisesRegex(RuntimeError, "passing tests marker"):
            self.activate()

    def test_offline_command_validates_receipt(self):
        result = subprocess.CompletedProcess([], 0, json.dumps({
            "protocolVersion": 1, "status": "applied", "transactionId": self.transaction,
        }))
        with patch.object(guard, "run", return_value=result) as run:
            receipt = guard.migration_command(self.new, self.data, "apply")
        self.assertEqual(receipt["transactionId"], self.transaction)
        argv = run.call_args.args[0]
        self.assertEqual(argv[-1], "--offline")
        self.assertEqual(argv[0], str(self.new / "node_modules/.bin/tsx"))

    def test_success_without_rollback_receipt_is_rejected(self):
        result = subprocess.CompletedProcess([], 0, '{"protocolVersion":1,"status":"applied"}')
        with patch.object(guard, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "rollback receipt"):
                guard.migration_command(self.new, self.data, "apply")

    def test_stop_verification_requires_no_process(self):
        with patch.object(guard, "run"), patch.object(guard, "service_state", return_value=("inactive", 123)):
            with self.assertRaisesRegex(RuntimeError, "has not stopped"):
                guard.stop_and_verify("blackdogbot.service")


class ReleaseHealthTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.invocation = "a" * 32
        for target, effect in (("monotonic", lambda: self.now), ("sleep", self.advance)):
            p = patch.object(guard.time, target, side_effect=effect)
            p.start()
            self.addCleanup(p.stop)

    def advance(self, seconds):
        self.now += seconds

    def result(self, text):
        return subprocess.CompletedProcess([], 0, text)

    def test_discord_only_or_no_messaging_needs_no_telegram_polling(self):
        logs = guard.STARTED + "\nTelegram not configured. Bot will not start.\n"
        with patch.object(guard, "service_identity", return_value=("active", 55, self.invocation)), \
             patch.object(guard, "run", return_value=self.result(logs)) as run:
            self.assertTrue(guard.health("blackdogbot.service", 44, 1.0, timeout=10))
        self.assertGreaterEqual(self.now, 6)
        self.assertIn("_SYSTEMD_INVOCATION_ID=" + self.invocation, run.call_args.args[0])

    def test_protocol_readiness_does_not_need_info_level_logs(self):
        for telegram in ("ready", "disabled"):
            with self.subTest(telegram=telegram):
                self.now = 0.0
                logs = f"BLACKDOGBOT_READY daemon ready\nBLACKDOGBOT_READY telegram {telegram}\n"
                with patch.object(guard, "service_identity", return_value=("active", 55, self.invocation)), \
                     patch.object(guard, "run", return_value=self.result(logs)):
                    self.assertTrue(guard.health("blackdogbot.service", 44, 1.0, timeout=10))

    def test_partial_protocol_readiness_is_not_enough(self):
        for logs in ("BLACKDOGBOT_READY daemon ready\n", "BLACKDOGBOT_READY telegram ready\n"):
            with self.subTest(logs=logs):
                self.now = 0.0
                with patch.object(guard, "service_identity", return_value=("active", 55, self.invocation)), \
                     patch.object(guard, "run", return_value=self.result(logs)):
                    self.assertFalse(guard.health("blackdogbot.service", 44, 1.0, timeout=10))

    def test_protocol_markers_require_complete_lines(self):
        logs = "BLACKDOGBOT_READY daemon ready-not-yet\nBLACKDOGBOT_READY telegram ready\n"
        with patch.object(guard, "service_identity", return_value=("active", 55, self.invocation)), \
             patch.object(guard, "run", return_value=self.result(logs)):
            self.assertFalse(guard.health("blackdogbot.service", 44, 1.0, timeout=10))

    def test_restarts_never_accumulate_a_stable_interval(self):
        def identity(unit):
            counter = int(self.now / 2)
            return "active", 55 + counter, f"{counter:032x}"
        logs = guard.STARTED + "\nTelegram bot is now receiving updates.\n"
        with patch.object(guard, "service_identity", side_effect=identity), \
             patch.object(guard, "run", return_value=self.result(logs)):
            self.assertFalse(guard.health("blackdogbot.service", 44, 1.0, timeout=20))

    def test_old_invocation_readiness_is_not_accepted(self):
        old = "b" * 32
        def journal(argv, **kwargs):
            if "_SYSTEMD_INVOCATION_ID=" + old in argv:
                return self.result(guard.STARTED + "\nTelegram bot is now receiving updates.\n")
            return self.result("")
        with patch.object(guard, "service_identity", return_value=("active", 55, self.invocation)), \
             patch.object(guard, "run", side_effect=journal):
            self.assertFalse(guard.health("blackdogbot.service", 44, 1.0, timeout=10))

    def test_configured_telegram_must_be_ready(self):
        with patch.object(guard, "service_identity", return_value=("active", 55, self.invocation)), \
             patch.object(guard, "run", return_value=self.result(guard.STARTED)):
            self.assertFalse(guard.health("blackdogbot.service", 44, 1.0, timeout=10))


class ServiceDataDirectoryTests(unittest.TestCase):
    def test_running_service_uses_actual_inherited_data_path(self):
        expected = Path("/tmp/blackdog-test-data").resolve()
        raw = b"HOME=/home/service\0BLACKDOGBOT_DATA_DIR=/tmp/blackdog-test-data\0UNRELATED_SECRET=not-output\0"
        with patch.object(guard.Path, "read_bytes", return_value=raw), patch.object(guard, "run") as run:
            guard.validate_service_data_directory("blackdogbot.service", 123, expected)
        run.assert_not_called()

    def test_different_data_root_is_rejected_before_migration(self):
        with patch.object(guard.Path, "read_bytes", return_value=b"HOME=/home/service\0"):
            with self.assertRaisesRegex(RuntimeError, "does not match service"):
                guard.validate_service_data_directory("blackdogbot.service", 123, Path("/tmp/wrong"))

    def test_stopped_service_merges_manager_and_unit_environment(self):
        properties = 'Environment=HOME=/home/service "BLACKDOGBOT_DATA_DIR=/tmp/data with spaces"\nEnvironmentFiles=\nUnsetEnvironment=\n'
        results = [
            subprocess.CompletedProcess([], 0, properties),
            subprocess.CompletedProcess([], 0, "HOME=/home/manager\nBLACKDOGBOT_DATA_DIR=/tmp/manager-data\n"),
        ]
        with patch.object(guard, "run", side_effect=results):
            guard.validate_service_data_directory("blackdogbot.service", 0, Path("/tmp/data with spaces"))

    def test_stopped_service_accepts_shell_quoted_manager_data_directory(self):
        results = [
            subprocess.CompletedProcess([], 0, "Environment=\nEnvironmentFiles=\nUnsetEnvironment=\n"),
            subprocess.CompletedProcess([], 0, "BLACKDOGBOT_DATA_DIR='/tmp/manager data'\n"),
        ]
        with patch.object(guard, "run", side_effect=results):
            guard.validate_service_data_directory("blackdogbot.service", 0, Path("/tmp/manager data"))

    def test_unset_environment_is_applied(self):
        properties = 'Environment=HOME=/home/service\nEnvironmentFiles=\nUnsetEnvironment=BLACKDOGBOT_DATA_DIR\n'
        results = [
            subprocess.CompletedProcess([], 0, properties),
            subprocess.CompletedProcess([], 0, "BLACKDOGBOT_DATA_DIR=/tmp/manager-data\n"),
        ]
        with patch.object(guard, "run", side_effect=results):
            guard.validate_service_data_directory("blackdogbot.service", 0, Path("/home/service/.blackdogbot"))

    def test_unknown_environment_file_blocks_stopped_service_guess(self):
        properties = "EnvironmentFiles=/etc/private-env (ignore_errors=no)\n"
        with patch.object(guard, "run", return_value=subprocess.CompletedProcess([], 0, properties)):
            with self.assertRaisesRegex(RuntimeError, "EnvironmentFiles"):
                guard.validate_service_data_directory("blackdogbot.service", 0, Path("/tmp/data"))

    def test_guard_default_honors_explicit_data_root(self):
        with patch.dict(guard.os.environ, {"BLACKDOGBOT_DATA_DIR": "/tmp/custom-data"}):
            self.assertEqual(guard.default_data_directory(), Path("/tmp/custom-data"))


class SourceDiscoveryTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        self.source = self.root / "custom/source"
        self.source.mkdir(parents=True)
        (self.source / ".git").mkdir()
        (self.source / "package.json").write_text('{"name":"blackdogbot"}')

    def test_explicit_source_is_preserved(self):
        self.assertEqual(guard.source_repository(self.source, self.state), self.source)

    def test_invalid_explicit_source_does_not_fall_back(self):
        with self.assertRaisesRegex(RuntimeError, "Not a BlackDogBot"):
            guard.source_repository(self.root, self.state)

    def test_external_supervisor_uses_saved_source_location(self):
        (self.state / "source-repository.json").write_text(json.dumps({"path": str(self.source)}))
        with patch.object(guard, "__file__", str(self.root / "installed/guarded-release.py")), \
             patch.object(guard.Path, "cwd", return_value=self.root), \
             patch.object(guard.Path, "home", return_value=self.root), \
             patch.dict(guard.os.environ, {"BLACKDOGBOT_SOURCE_DIR": ""}):
            self.assertEqual(guard.source_repository(None, self.state), self.source)


if __name__ == "__main__":
    unittest.main()
