"""Guarded acceptance and recovery protocol. All services/network are isolated."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[2] / "scripts/guarded-release.py"
spec = importlib.util.spec_from_file_location("blackdog_activation_protocol", MODULE)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
REAL_RUNTIME_BELONGS = guard.runtime_belongs_to_service


class ActivationProtocolTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state = self.root / "custom-state"
        self.data = self.root / "data"
        self.data.mkdir()
        self.old = self.state / "releases" / ("1" * 40)
        self.new = self.state / "releases" / ("2" * 40)
        for release in (self.old, self.new):
            release.mkdir(parents=True)
            (release / ".blackdog-release-tested").write_text(release.name)
            (release / "src/migrations").mkdir(parents=True)
            (release / "src/migrations/cli.ts").write_text("// synthetic")
        (self.state / "current").symlink_to(self.old)
        self.unit = "fixture.service"
        self.invocation = "c" * 32
        self.events = []
        self.patch("service_identity", return_value=("active", 111, self.invocation))
        self.patch("runtime_belongs_to_service", return_value=True)
        self.patch("validate_service_data_directory")
        self.patch("service_runtime_cwd", return_value=self.old)
        self.patch("notify")
        self.patch("update_docker_services", return_value={"status": "fixture"})
        self.patch("save_journal", return_value=self.state / "journal")
        self.patch("stop_and_verify", side_effect=lambda unit: self.events.append("stop"))
        self.patch("restart_and_probe", return_value=(True, 1.0))
        self.patch("run", return_value=subprocess.CompletedProcess([], 0, ""))
        home = patch.object(guard.Path, "home", return_value=self.root / "home")
        home.start()
        self.addCleanup(home.stop)

    def patch(self, name, **kwargs):
        mocked = patch.object(guard, name, **kwargs)
        result = mocked.start()
        self.addCleanup(mocked.stop)
        return result

    def plan(self, **extra):
        return {"protocolVersion": 1, "backupProtocolVersion": 1, "activationProtocolVersion": 1,
                "pathMigrationProtocolVersion": 1, "needsMigration": False, "backupReady": True,
                "databasePathMigration": {"needsMigration": False}, **extra}

    def begin(self, **extra):
        approval = guard.begin_activation(self.data, self.new, {
            "origin": "activate", "statePath": str(self.state), "unit": self.unit,
            "previousPath": str(self.old), "migrationTransaction": None,
            "pathMigrationTransaction": None, "backup": {"backupPath": str(self.root / "saved")},
            **extra,
        })
        guard.point_to(self.state / "current", self.new)
        return approval

    def ready(self, approval, status="pending", **extra):
        ready = {"protocolVersion": 1, "status": status, "nonce": approval["nonce"],
                 "revision": self.new.name, "candidatePath": str(self.new),
                 "pid": 222, "invocationId": self.invocation, **extra}
        guard.write_atomic(self.data / "deploy/activation-ready.json", json.dumps(ready))
        return ready

    def accept(self, unit, old_pid, data, approval, **options):
        self.events.append("restart" if options.get("restart", True) else "resume")
        ready = self.ready(approval)
        guard.commit_activation(data, approval, ready, unit)
        self.ready(approval, "active")
        return True, 1.0

    def activate(self, **options):
        return guard.activate(self.state, self.unit, self.new.name, None, data_dir=self.data,
                              update_containers=False, timeout=1, **options)

    def outcome(self):
        return json.loads((self.state / "reports/latest.json").read_text())

    def test_acceptance_is_synced_before_runtime_release_becomes_visible(self):
        approval = self.begin()
        ready = self.ready(approval)
        original_write = guard.write_atomic
        events = []
        def write(file, value, *args):
            if file.name == "activation-release.json":
                self.assertEqual(guard.read_activation(self.data)["status"], "committed")
                self.assertIn("synced-approval", events)
            original_write(file, value, *args)
            if file == guard.activation_file(self.data):
                events.append("synced-approval")
            if file.name == "activation-release.json":
                events.append("released")
        with patch.object(guard, "write_atomic", side_effect=write):
            guard.commit_activation(self.data, approval, ready, self.unit)
        self.assertEqual(events, ["synced-approval", "released"])
        self.assertTrue(guard.activation_released(self.data, guard.read_activation(self.data)))

    def test_interruption_between_commit_and_release_does_not_release_runtime(self):
        approval = self.begin()
        ready = self.ready(approval)
        original_write = guard.write_atomic
        def interrupted(file, value, *args):
            if file.name == "activation-release.json":
                raise OSError("simulated interruption")
            original_write(file, value, *args)
        with patch.object(guard, "write_atomic", side_effect=interrupted):
            with self.assertRaises(OSError):
                guard.commit_activation(self.data, approval, ready, self.unit)
        committed = guard.read_activation(self.data)
        self.assertEqual(committed["status"], "committed")
        self.assertFalse(guard.activation_released(self.data, committed))
        # Resume validates the current staged invocation and then releases it.
        guard.commit_activation(self.data, committed, ready, self.unit)
        self.assertTrue(guard.activation_released(self.data, guard.read_activation(self.data)))

    def test_stale_invocation_or_unrelated_process_cannot_commit(self):
        approval = self.begin()
        stale = self.ready(approval, invocationId="d" * 32)
        self.assertIsNone(guard.activation_ready(self.data, approval, self.unit, "pending"))
        with self.assertRaisesRegex(RuntimeError, "invocation changed"):
            guard.commit_activation(self.data, approval, stale, self.unit)
        ready = self.ready(approval)
        with patch.object(guard, "runtime_belongs_to_service", return_value=False):
            self.assertIsNone(guard.activation_ready(self.data, approval, self.unit, "pending"))
        self.assertEqual(guard.read_activation(self.data)["status"], "pending")

    def test_stale_ready_receipt_does_not_accept_a_restarted_service(self):
        approval = self.begin()
        self.ready(approval)
        ticks = iter(range(100))
        with patch.object(guard, "service_identity", return_value=("active", 111, "e" * 32)), \
             patch.object(guard.time, "sleep"), patch.object(guard.time, "monotonic", side_effect=lambda: next(ticks)):
            self.assertIsNone(guard.wait_for_staged_readiness(self.unit, self.data, approval, timeout=5))
        self.assertEqual(guard.read_activation(self.data)["status"], "pending")

    def test_pending_same_candidate_resumes_without_new_backup_or_migration(self):
        approval = self.begin()
        commands = self.patch("migration_command", return_value=self.plan())
        self.patch("guarded_start_and_probe", side_effect=self.accept)
        self.assertTrue(self.activate())
        self.assertEqual([call.args[2] for call in commands.call_args_list], ["plan"])
        self.assertEqual(self.events, ["resume"])
        self.assertEqual(guard.read_activation(self.data)["nonce"], approval["nonce"])
        self.assertEqual(self.outcome()["status"], "healthy")

    def test_stopped_pending_candidate_restarts_but_does_not_reapply_migrations(self):
        self.begin()
        commands = self.patch("migration_command", return_value=self.plan())
        self.patch("guarded_start_and_probe", side_effect=self.accept)
        with patch.object(guard, "service_identity", return_value=("inactive", 0, "")), \
             patch.object(guard, "activation_ready", side_effect=lambda data, approval, unit, status: self.ready(approval, status)):
            self.assertTrue(self.activate())
        self.assertEqual([call.args[2] for call in commands.call_args_list], ["plan"])
        self.assertEqual(self.events, ["restart"])

    def test_another_pending_candidate_cannot_be_overwritten(self):
        self.begin()
        guard.point_to(self.state / "current", self.old)
        self.patch("migration_command", return_value=self.plan())
        with self.assertRaisesRegex(RuntimeError, "Another activation is pending"):
            self.activate()
        self.assertNotIn("stop", self.events)

    def test_candidate_without_activation_protocol_is_rejected_before_stop(self):
        plan = self.plan()
        plan.pop("activationProtocolVersion")
        self.patch("migration_command", return_value=plan)
        with self.assertRaisesRegex(RuntimeError, "guarded external-work"):
            self.activate()
        self.assertEqual(self.events, [])

    def test_accepted_startup_failure_keeps_new_data_and_never_rolls_back(self):
        self.begin(migrationTransaction="t-one", pathMigrationTransaction="p-one")
        commands = self.patch("migration_command", return_value=self.plan())
        def fail_after_accept(*args, **kwargs):
            self.accept(*args, **kwargs)
            return False, 1.0
        self.patch("guarded_start_and_probe", side_effect=fail_after_accept)
        self.assertFalse(self.activate())
        self.assertEqual([call.args[2] for call in commands.call_args_list], ["plan"])
        self.assertEqual(self.events, ["resume", "stop"])
        self.assertEqual((self.state / "current").resolve(), self.new)
        self.assertEqual(self.outcome()["status"], "activation_committed_unhealthy")
        self.assertEqual(self.outcome()["path_migration_transaction"], "p-one")

    def test_validation_failure_restores_tasks_then_paths_then_previous_approval(self):
        approval = self.begin(migrationTransaction="t-one", pathMigrationTransaction="p-one")
        def migration(release, data, action, transaction=None, **options):
            self.events.append(action)
            return self.plan() if action == "plan" else {"status": "rolled_back", "protocolVersion": 1}
        self.patch("migration_command", side_effect=migration)
        self.patch("guarded_start_and_probe", return_value=(False, 1.0))
        self.assertFalse(self.activate())
        self.assertEqual(self.events, ["plan", "stop", "rollback", "paths-rollback", "plan"])
        self.assertIsNone(guard.read_activation(self.data))
        self.assertEqual((self.state / "current").resolve(), self.old)
        self.assertTrue(guard.activation_context_file(self.data, approval["nonce"]).is_file())

    def test_unrelated_backup_coverage_blocker_prevents_path_mutation(self):
        self.patch("migration_command", return_value=self.plan(backupReady=False, preBackupMigrationReady=False,
                   backupIssue="External skill directory is not covered",
                   databasePathMigration={"needsMigration": True}))
        with self.assertRaisesRegex(guard.MigrationCommandError, "External skill"):
            self.activate()
        self.assertEqual(self.events, [])

    def run_path_upgrade(self, backup_failure=False, rollback_conflict=False):
        planned = 0
        def migration(release, data, action, transaction=None, **options):
            nonlocal planned
            self.events.append(action)
            if action == "plan":
                planned += 1
                return self.plan(backupReady=planned > 1, preBackupMigrationReady=True,
                                 databasePathMigration={"needsMigration": planned == 1})
            if action == "paths-apply":
                self.assertEqual((self.state / "current").resolve(), self.new)
                self.assertEqual(options["runtime_cwd"], self.old)
                return {"protocolVersion": 1, "pathMigrationProtocolVersion": 1, "status": "applied", "transactionId": "p-one"}
            if action == "paths-rollback":
                if rollback_conflict:
                    raise guard.MigrationCommandError("Database changed since path migration")
                return {"protocolVersion": 1, "pathMigrationProtocolVersion": 1, "status": "rolled_back"}
            if action.startswith("backup-"):
                if backup_failure:
                    raise OSError("simulated disk full")
                return {"protocolVersion": 1, "status": "created" if action == "backup-create" else "verified",
                        "backupPath": str(options["backup_dir"]), "manifestSha256": "a" * 64, "fileCount": 1, "totalBytes": 4}
            if action == "apply":
                return {"protocolVersion": 1, "status": "applied", "transactionId": "t-one"}
            self.fail(action)
        self.patch("migration_command", side_effect=migration)
        self.patch("guarded_start_and_probe", side_effect=self.accept)
        return self.activate()

    def test_database_relocation_precedes_verified_snapshot_and_task_migration(self):
        self.assertTrue(self.run_path_upgrade())
        self.assertEqual(self.events, ["plan", "stop", "paths-apply", "plan", "backup-create", "backup-verify", "apply", "restart"])
        self.assertEqual(self.outcome()["path_migration_transaction"], "p-one")
        self.assertEqual(self.outcome()["migration_transaction"], "t-one")

    def test_backup_failure_restores_completed_path_move_but_keeps_service_stopped(self):
        self.assertFalse(self.run_path_upgrade(backup_failure=True))
        self.assertEqual(self.events, ["plan", "stop", "paths-apply", "plan", "backup-create", "paths-rollback"])
        self.assertEqual((self.state / "current").resolve(), self.old)
        self.assertEqual(self.outcome()["status"], "backup_failed")
        self.assertTrue(self.outcome()["service_stopped"])

    def test_path_rollback_conflict_never_overwrites_new_data_or_selects_old_code(self):
        self.assertFalse(self.run_path_upgrade(backup_failure=True, rollback_conflict=True))
        self.assertEqual((self.state / "current").resolve(), self.new)
        self.assertTrue(self.outcome()["manual_recovery_required"])

    def test_path_cli_gets_discovery_flags_and_offline_only_for_mutation(self):
        result = {"protocolVersion": 1, "pathMigrationProtocolVersion": 1, "status": "unchanged", "transactionId": None}
        with patch.object(guard, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(result))) as run:
            guard.migration_command(self.new, self.data, "paths-apply", runtime_cwd=self.old, source=self.root / "legacy")
        argv = run.call_args.args[0]
        self.assertIn("--offline", argv)
        self.assertEqual(argv[argv.index("--runtime-cwd") + 1], str(self.old))
        self.assertEqual(argv[argv.index("--source") + 1], str(self.root / "legacy"))

    def test_private_metadata_rejects_symlinks_and_group_readable_files(self):
        self.begin()
        file = guard.activation_file(self.data)
        file.chmod(0o640)
        with self.assertRaisesRegex(RuntimeError, "private regular"):
            guard.read_activation(self.data)
        file.rename(file.with_suffix(".saved"))
        file.symlink_to(file.with_suffix(".saved"))
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            guard.read_activation(self.data)

    def test_telegram_recipient_is_never_inferred_from_known_chats(self):
        home = self.root / "home"
        known = home / ".blackdogbot/known-telegram-chats.json"
        known.parent.mkdir(parents=True)
        known.write_text('["123456"]')
        with patch.object(guard.sys, "argv", ["guarded-release.py", "prepare", "--state", str(self.state), "--revision", self.new.name]), \
             patch.object(guard, "source_repository", return_value=self.old), \
             patch.object(guard, "prepare", return_value=self.new) as prepare:
            self.assertEqual(guard.main(), 0)
        self.assertIsNone(prepare.call_args.args[3])


    def test_stopped_commit_without_release_resumes_the_gate(self):
        approval = self.begin()
        ready = self.ready(approval)
        committed = {**approval, "status": "committed", "runtimePid": ready["pid"], "invocationId": self.invocation}
        guard.write_atomic(guard.activation_file(self.data), json.dumps(committed))
        self.patch("migration_command", return_value=self.plan())
        self.patch("guarded_start_and_probe", side_effect=self.accept)
        with patch.object(guard, "service_identity", return_value=("inactive", 0, "")), \
             patch.object(guard, "activation_ready", side_effect=lambda data, approval, unit, status: self.ready(approval, status)):
            self.assertTrue(self.activate())
        self.assertEqual(self.events, ["restart"])
        self.assertTrue(guard.activation_released(self.data, guard.read_activation(self.data)))

    def test_runtime_identity_checks_real_process_ancestry_and_invocation(self):
        environment = {**os.environ, "INVOCATION_ID": self.invocation}
        child = subprocess.Popen([sys.executable, "-c", "import time; print('ready', flush=True); time.sleep(20)"],
                                 env=environment, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            self.assertTrue(REAL_RUNTIME_BELONGS(child.pid, os.getpid(), self.invocation))
            self.assertFalse(REAL_RUNTIME_BELONGS(child.pid, os.getpid(), "e" * 32))
            self.assertFalse(REAL_RUNTIME_BELONGS(child.pid, 999999999, self.invocation))
        finally:
            child.terminate()
            child.wait(timeout=5)
            child.stdout.close()

    def test_bootstrap_resumes_after_pending_receipt_before_launcher_install(self):
        (self.state / "current").unlink()
        dropin = Path.home() / ".config/systemd/user" / (self.unit + ".d/40-guarded-release.conf")
        approval = guard.begin_activation(self.data, self.new, {
            "origin": "bootstrap", "statePath": str(self.state), "unit": self.unit,
            "dropinPath": str(dropin), "backup": {"backupPath": str(self.root / "existing-snapshot")},
        })
        commands = self.patch("migration_command", return_value=self.plan())
        self.patch("guarded_start_and_probe", side_effect=self.accept)
        self.assertTrue(guard.bootstrap(self.state, self.unit, self.new.name, None, data_dir=self.data, timeout=1))
        self.assertEqual(guard.read_activation(self.data)["nonce"], approval["nonce"])
        self.assertEqual([call.args[2] for call in commands.call_args_list], ["plan"])
        self.assertEqual(self.events, ["stop", "restart"])
        self.assertTrue(dropin.is_file())

    def bootstrap_fixture(self, accepted_failure=False, pending_failure=False):
        (self.state / "current").unlink()
        self.patch("migration_command", return_value=self.plan())
        self.patch("create_verified_backup", return_value={"backupPath": str(self.root / "bootstrap-backup")})
        def start(*args, **kwargs):
            if pending_failure:
                return False, 1.0
            self.accept(*args, **kwargs)
            return not accepted_failure, 1.0
        self.patch("guarded_start_and_probe", side_effect=start)
        return guard.bootstrap(self.state, self.unit, self.new.name, None, data_dir=self.data, timeout=1)

    def test_bootstrap_uses_approval_before_any_candidate_external_work(self):
        self.assertTrue(self.bootstrap_fixture())
        self.assertEqual(self.events, ["stop", "restart"])
        self.assertTrue(guard.activation_released(self.data, guard.read_activation(self.data)))
        self.assertEqual(self.outcome()["status"], "bootstrap_healthy")

    def test_bootstrap_pending_failure_restores_original_unit(self):
        self.assertFalse(self.bootstrap_fixture(pending_failure=True))
        self.assertFalse((self.state / "current").exists())
        self.assertIsNone(guard.read_activation(self.data))
        self.assertEqual(self.outcome()["status"], "bootstrap_reverted")

    def test_bootstrap_accepted_failure_stops_without_restoring_original_code(self):
        self.assertFalse(self.bootstrap_fixture(accepted_failure=True))
        self.assertEqual((self.state / "current").resolve(), self.new)
        self.assertEqual(self.outcome()["status"], "bootstrap_committed_unhealthy")


class RuntimeDiscoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.proc = self.root / "proc"
        self.proc.mkdir()
        self.node = self.root / "node"
        self.node.write_text("")

    def process(self, pid, parent, script, group=b"fixture-group"):
        entry = self.proc / str(pid)
        entry.mkdir()
        (entry / "status").write_text("PPid: " + str(parent) + "\n")
        (entry / "cmdline").write_bytes(b"node\0" + script.encode() + b"\0")
        (entry / "cgroup").write_bytes(group)
        (entry / "exe").symlink_to(self.node)

    def test_uses_actual_node_leaf_below_pnpm_and_tsx_parents(self):
        self.process(100, 1, "pnpm")
        self.process(101, 100, "/checkout/src/index.ts")
        self.process(102, 101, "/checkout/src/index.ts")
        self.process(103, 102, "some-agent-command.js")
        self.assertEqual(guard.runtime_process_pid(100, self.proc), 102)

    def test_multiple_runtime_leaves_refuse_ambiguous_database_discovery(self):
        self.process(100, 1, "pnpm")
        self.process(101, 100, "/checkout/src/index.ts")
        self.process(102, 100, "/another/src/index.ts")
        with self.assertRaisesRegex(RuntimeError, "one actual bot runtime"):
            guard.runtime_process_pid(100, self.proc)

    def test_ignores_same_named_entry_in_another_cgroup(self):
        self.process(100, 1, "pnpm")
        self.process(101, 100, "/checkout/dist/src/index.js")
        self.process(102, 100, "/another/src/index.ts", b"other-group")
        self.assertEqual(guard.runtime_process_pid(100, self.proc), 101)


if __name__ == "__main__":
    unittest.main()
