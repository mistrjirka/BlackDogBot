import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "guarded-release.py"
spec = importlib.util.spec_from_file_location("blackdog_guard", MODULE_PATH)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GuardedReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        (self.state / "releases").mkdir()
        (self.state / "reports").mkdir()
        self.old_sha = "1" * 40
        self.new_sha = "2" * 40
        self.old = self.state / "releases" / self.old_sha
        self.new = self.state / "releases" / self.new_sha
        for directory, revision in ((self.old, self.old_sha), (self.new, self.new_sha)):
            directory.mkdir()
            (directory / ".blackdog-release-tested").write_text(revision)
        (self.state / "current").symlink_to(self.old)

    def test_atomic_switch_and_previous_release_remains(self):
        guard.point_to(self.state / "current", self.new)
        self.assertEqual((self.state / "current").resolve(), self.new)
        self.assertTrue(self.old.exists())
        self.assertTrue(self.new.exists())

    def test_activation_recovers_original_release_and_preserves_candidate(self):
        attempts = []
        def restart(_unit, _pid, timeout=75):
            attempts.append(True)
            return (False, 111.0) if len(attempts) == 1 else (True, 112.0)

        with patch.object(guard, "service_state", return_value=("active", 444)), \
             patch.object(guard, "restart_and_probe", side_effect=restart), \
             patch.object(guard, "notify"), \
             patch.object(guard, "save_journal", return_value=self.state / "reports" / "failed.log"):
            healthy = guard.activate(self.state, "blackdogbot.service", self.new_sha, None, timeout=3)
        self.assertFalse(healthy)
        self.assertEqual(len(attempts), 2)
        self.assertEqual((self.state / "current").resolve(), self.old)
        self.assertTrue(self.new.exists())
        last = json.loads((self.state / "reports" / "latest.json").read_text())
        self.assertEqual(last["status"], "rolled_back")
        self.assertEqual(last["failed_revision"], self.new_sha)
        self.assertEqual(last["restored_revision"], self.old_sha)

    def test_success_changes_live_pointer_once(self):
        with patch.object(guard, "service_state", return_value=("active", 444)), \
             patch.object(guard, "restart_and_probe", return_value=(True, 111.0)) as restart, \
             patch.object(guard, "notify"):
            healthy = guard.activate(self.state, "blackdogbot.service", self.new_sha, None, timeout=3)
        self.assertTrue(healthy)
        restart.assert_called_once()
        self.assertEqual((self.state / "current").resolve(), self.new)
        self.assertTrue(self.old.exists())
        self.assertEqual(json.loads((self.state / "reports" / "latest.json").read_text())["status"], "healthy")

    def test_docker_update_results_are_reported_after_healthy_app(self):
        with patch.object(guard,"service_state",return_value=("active",444)), \
             patch.object(guard,"restart_and_probe",return_value=(True,111.0)), \
             patch.object(guard,"update_docker_services",return_value={"searxng":"CONTAINER_DEPLOY_STATUS searxng healthy","scrapling":"failed:CalledProcessError"}) as updates, \
             patch.object(guard,"notify"):
            result=guard.activate(self.state,"blackdogbot.service",self.new_sha,None,timeout=3)
        self.assertTrue(result)
        updates.assert_called_once()
        report=json.loads((self.state/"reports/latest.json").read_text())
        self.assertEqual(report["status"],"healthy")
        self.assertEqual(report["container_updates"]["scrapling"],"failed:CalledProcessError")

    def test_skip_container_updates_keeps_app_healthy(self):
        with patch.object(guard,"service_state",return_value=("active",444)), \
             patch.object(guard,"restart_and_probe",return_value=(True,111.0)), \
             patch.object(guard,"update_docker_services") as updates, \
             patch.object(guard,"notify"):
            result=guard.activate(self.state,"blackdogbot.service",self.new_sha,None,timeout=3,update_containers=False)
        self.assertTrue(result)
        updates.assert_not_called()

    def test_refuses_activation_without_pretested_candidate(self):
        (self.new / ".blackdog-release-tested").unlink()
        with self.assertRaisesRegex(RuntimeError, "passing tests"):
            guard.activate(self.state, "blackdogbot.service", self.new_sha, None)
        self.assertEqual((self.state / "current").resolve(), self.old)

    def test_atomic_report_and_recovery_metadata(self):
        dest = guard.report(self.state, {"status": "bootstrap_reverted", "unit": "blackdogbot.service"})
        self.assertTrue(dest.is_file())
        self.assertEqual(dest.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads((self.state / "reports" / "latest.json").read_text())["status"], "bootstrap_reverted")

if __name__ == "__main__":
    unittest.main()
