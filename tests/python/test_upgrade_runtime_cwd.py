"""Runtime source discovery uses synthetic /proc trees, never live services."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[2] / "scripts/upgrade.py"
spec = importlib.util.spec_from_file_location("blackdog_upgrade_runtime_cwd", MODULE)
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class RuntimeCwdTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="blackdog-upgrade-cwd-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.proc = self.root / "proc"
        self.proc.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for executable in ("node", "nodejs", "bash"):
            (self.bin / executable).write_text("synthetic executable")
        self.parent_cwd = self.root / "service-working-directory"
        self.runtime_cwd = self.root / "actual-old-release"
        self.parent_cwd.mkdir()
        self.runtime_cwd.mkdir()
        self.uid = os.geteuid()
        self.account = SimpleNamespace(pw_uid=self.uid, pw_gid=os.getegid(),
                                       pw_name="fixture-owner", pw_dir=str(self.root / "home"))

        def selected_path(*parts):
            if parts and str(parts[0]) == "/proc":
                return self.proc.joinpath(*parts[1:])
            return Path(*parts)

        filesystem = patch.object(upgrade, "Path", side_effect=selected_path)
        filesystem.start()
        self.addCleanup(filesystem.stop)

    def process(self, pid, parent, argv, *, cwd=None, executable="node",
                cgroup=b"0::/user.slice/fixture.service\n", environment=None, comm="node"):
        directory = self.proc / str(pid)
        directory.mkdir()
        # The real /proc stat field after the final ')' is state, then ppid.
        (directory / "stat").write_text(str(pid) + " (" + comm + ") S " + str(parent) + " 0 0 0\n")
        (directory / "cgroup").write_bytes(cgroup)
        (directory / "cmdline").write_bytes(b"\0".join(os.fsencode(arg) for arg in argv) + b"\0")
        (directory / "environ").write_bytes(b"\0".join(
            os.fsencode(key + "=" + value) for key, value in (environment or {}).items()) + b"\0")
        (directory / "exe").symlink_to(self.bin / executable)
        (directory / "cwd").symlink_to(cwd or self.parent_cwd)
        return directory

    def wrappers(self):
        self.process(100, 1, ["node", "/usr/bin/pnpm", "start"], cwd=self.parent_cwd)
        self.process(110, 100, ["bash", "scripts/launch.sh"], executable="bash")
        self.process(120, 110, ["node", "tsx/dist/cli.mjs", "src/index.ts"], cwd=self.runtime_cwd)
        self.process(130, 120, ["node", "--import", "tsx", "src/index.ts"], cwd=self.runtime_cwd,
                     environment={"PATH": "/runtime/node/bin", "BLACKDOGBOT_DATA_DIR": str(self.root / "data"),
                                  "LD_LIBRARY_PATH": "/runtime/cuda"})

    def test_direct_node_main_pid_is_accepted(self):
        self.process(100, 1, ["node", "src/index.ts"], cwd=self.runtime_cwd)
        self.assertEqual(upgrade.runtime_process_pid(100, self.uid), 100)

    def test_selects_leaf_bot_below_pnpm_shell_and_tsx(self):
        self.wrappers()
        self.assertEqual(upgrade.runtime_process_pid(100, self.uid), 130)

    def test_handles_parentheses_in_proc_command_name(self):
        self.process(100, 1, ["node", "src/index.ts"], comm="node (loader) ) special")
        self.assertEqual(upgrade.runtime_process_pid(100, self.uid), 100)

    def test_supports_compiled_nodejs_runtime(self):
        self.process(100, 1, ["node", "pnpm", "start"])
        self.process(101, 100, ["nodejs", str(self.runtime_cwd / "dist/index.js")], executable="nodejs")
        self.assertEqual(upgrade.runtime_process_pid(100, self.uid), 101)

    def test_excludes_other_cgroups_and_non_descendants(self):
        self.process(100, 1, ["node", "pnpm", "start"])
        self.process(101, 100, ["node", "src/index.ts"])
        self.process(102, 100, ["node", "src/index.ts"], cgroup=b"0::/other.service\n")
        self.process(200, 1, ["node", "src/index.ts"])
        self.assertEqual(upgrade.runtime_process_pid(100, self.uid), 101)

    def test_excludes_processes_owned_by_another_user(self):
        self.process(100, 1, ["node", "pnpm", "start"])
        self.process(101, 100, ["node", "src/index.ts"])
        foreign = self.process(102, 100, ["node", "src/index.ts"])
        original = Path.stat

        def ownership(location, *args, **kwargs):
            result = original(location, *args, **kwargs)
            if location == foreign:
                fields = list(result)
                fields[4] = self.uid + 1
                return os.stat_result(fields)
            return result

        with patch.object(Path, "stat", ownership):
            self.assertEqual(upgrade.runtime_process_pid(100, self.uid), 101)

    def test_refuses_zero_bot_matches_instead_of_using_wrapper_cwd(self):
        self.process(100, 1, ["node", "pnpm", "start"])
        self.process(101, 100, ["node", "unrelated-worker.js"])
        with self.assertRaisesRegex(upgrade.UpgradeError, "one running bot"):
            upgrade.runtime_process_pid(100, self.uid)

    def test_refuses_two_independent_bot_leaves(self):
        self.process(100, 1, ["node", "pnpm", "start"])
        self.process(101, 100, ["node", "src/index.ts"])
        self.process(102, 100, ["node", "src/index.ts"])
        with self.assertRaisesRegex(upgrade.UpgradeError, "one running bot"):
            upgrade.runtime_process_pid(100, self.uid)

    def test_ignores_cycles_and_vanished_unrelated_processes(self):
        self.process(100, 1, ["node", "src/index.ts"])
        self.process(201, 202, ["node", "src/index.ts"])
        self.process(202, 201, ["node", "src/index.ts"])
        (self.proc / "300").mkdir()
        (self.proc / "not-a-pid").mkdir()
        self.assertEqual(upgrade.runtime_process_pid(100, self.uid), 100)

    def test_fails_closed_when_main_process_disappears(self):
        with self.assertRaisesRegex(upgrade.UpgradeError, "process tree"):
            upgrade.runtime_process_pid(100, self.uid)

    def test_does_not_fall_back_to_parent_after_runtime_disappears(self):
        self.process(100, 1, ["node", "pnpm", "start"])
        child = self.process(101, 100, ["node", "src/index.ts"])
        (child / "exe").unlink()
        with self.assertRaisesRegex(upgrade.UpgradeError, "one running bot"):
            upgrade.runtime_process_pid(100, self.uid)

    def test_discover_service_uses_runtime_child_cwd_executable_and_environment(self):
        self.wrappers()
        properties = {
            "LoadState": "loaded", "MainPID": "100", "ActiveState": "active", "UnitFileState": "enabled",
            "WorkingDirectory": str(self.parent_cwd), "Environment": "PATH=/parent/bin",
            "ExecStart": "{ path=/usr/bin/pnpm ; argv[]=/usr/bin/pnpm start ; }",
        }
        with patch.object(upgrade, "unit_properties", return_value=properties), \
             patch.object(upgrade, "unit_files", return_value=[]):
            discovered = upgrade.discover_service("user", "fixture.service", self.account)
        self.assertEqual(discovered["runtimeCwd"], str(self.runtime_cwd))
        self.assertEqual(discovered["runtimeNode"], str(self.bin / "node"))
        self.assertEqual(discovered["environment"]["PATH"], "/runtime/node/bin")
        self.assertEqual(discovered["environment"]["BLACKDOGBOT_DATA_DIR"], str(self.root / "data"))
        self.assertEqual(discovered["environment"]["LD_LIBRARY_PATH"], "/runtime/cuda")
        self.assertEqual(discovered["properties"]["WorkingDirectory"], str(self.parent_cwd))
        self.assertTrue(discovered["wasActive"])

    def test_relative_source_entry_resolves_against_runtime_cwd(self):
        self.process(100, 1, ["node", "--import", "tsx", "src/index.ts"], cwd=self.runtime_cwd)
        self.assertEqual(upgrade.runtime_source_entry(100, self.runtime_cwd), self.runtime_cwd / "src/index.ts")

    def test_absolute_source_entry_remains_separate_from_runtime_cwd(self):
        pinned = self.root / "pinned-old-source/src/index.ts"
        self.process(100, 1, ["node", "--import", "tsx", str(pinned)], cwd=self.runtime_cwd)
        self.assertEqual(upgrade.runtime_source_entry(100, self.runtime_cwd), pinned)
        self.assertNotEqual(pinned.parent.parent, self.runtime_cwd)

    def test_multiple_source_arguments_are_ambiguous(self):
        self.process(100, 1, ["node", "src/index.ts", "/other/src/index.ts"])
        with self.assertRaisesRegex(upgrade.UpgradeError, "ambiguous source"):
            upgrade.runtime_source_entry(100, self.runtime_cwd)

    def test_stopped_absolute_source_entry_is_independent_of_working_directory(self):
        pinned = self.root / "pinned-old-source/src/index.ts"
        properties = {"WorkingDirectory": str(self.runtime_cwd),
                      "ExecStart": "{ path=/usr/bin/node ; argv[]=/usr/bin/node --import tsx " + str(pinned) + " ; }"}
        self.assertEqual(upgrade.stopped_source_entry(properties), pinned)
        self.assertEqual(upgrade.stopped_runtime_cwd(properties), str(self.runtime_cwd))

    def git(self, *args, cwd):
        import subprocess
        result = subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", *args],
                                cwd=cwd, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"})
        return result.stdout.strip()

    def detached_source(self):
        main = self.root / "main-repository"
        main.mkdir()
        (main / "src").mkdir()
        (main / "package.json").write_text('{"name":"blackdogbot"}\n')
        (main / "src/index.ts").write_text("// old version\n")
        self.git("init", "-q", cwd=main)
        self.git("add", "package.json", "src/index.ts", cwd=main)
        self.git("commit", "-qm", "old fixture", cwd=main)
        old = self.git("rev-parse", "HEAD", cwd=main)
        (main / "src/index.ts").write_text("// newer version\n")
        self.git("commit", "-qam", "new fixture", cwd=main)
        new = self.git("rev-parse", "HEAD", cwd=main)
        detached = self.root / "running-old-worktree"
        self.git("worktree", "add", "--detach", str(detached), old, cwd=main)
        return main, detached, old, new

    def test_runtime_repository_keeps_detached_worktree_identity(self):
        main, detached, old, new = self.detached_source()
        service = {"runtimeSourceEntry": str(detached / "src/index.ts"), "runtimeCwd": str(main)}
        selected = upgrade.runtime_repository(service)
        self.assertEqual(selected, detached)
        self.assertEqual(upgrade.git_revision(selected), old)
        self.assertNotEqual(upgrade.git_revision(selected), new)

    def test_standalone_plan_keeps_old_worktree_baseline_and_runtime_cwd_separate(self):
        main, detached, old, new = self.detached_source()
        data = Path(self.account.pw_dir) / ".blackdogbot"
        data.mkdir(parents=True)
        (data / "config.yaml").write_text("synthetic: config\n")
        service = {"scope": "user", "unit": "fixture.service", "environment": {},
                   "runtimeCwd": str(main), "runtimeSourceEntry": str(detached / "src/index.ts"),
                   "properties": {"MainPID": "100", "WorkingDirectory": str(main)}, "files": []}
        arguments = SimpleNamespace(scope="user", unit="fixture.service", data_dir=None, state=None,
                                    repo=main, revision=new, previous_revision=None, runtime_cwd=None,
                                    database_source=None, import_legacy_tasks=False, timeout=75)
        with patch.object(upgrade, "discover_service", return_value=service), \
             patch.object(upgrade, "ensure_no_competing_service"):
            plan = upgrade.build_plan(arguments, self.account)
        self.assertEqual(plan["repo"], str(main))
        self.assertEqual(plan["baselineRepo"], str(detached))
        self.assertEqual(plan["previousRevision"], old)
        self.assertEqual(plan["service"]["runtimeCwd"], str(main))
        self.assertEqual(plan["service"]["runtimeSourceEntry"], str(detached / "src/index.ts"))

    def test_existing_unmarked_baseline_refuses_tracked_source_edits_before_install(self):
        main, detached, old, _ = self.detached_source()
        state = self.root / "state"
        baseline = state / "legacy-baselines" / old
        baseline.parent.mkdir(parents=True)
        self.git("worktree", "add", "--detach", str(baseline), old, cwd=main)
        (baseline / "src/index.ts").write_text("// preserve this newer manual edit\n")
        operation = {"repo": str(main), "baselineRepo": str(detached), "previousRevision": old,
                     "state": str(state), "service": {"files": [], "runtimeCwd": str(self.runtime_cwd), "environment": {}}}
        original_run = upgrade.run

        def guarded_run(argv, **kwargs):
            self.assertNotEqual(argv[0], "pnpm", "Dirty baseline must fail before package installation")
            return original_run(argv, **kwargs)

        with patch.object(upgrade, "run", side_effect=guarded_run), self.assertRaisesRegex(upgrade.UpgradeError, "edited source"):
            upgrade.prepare_baseline(operation, state / "prepare.log")
        self.assertFalse((baseline / ".blackdog-legacy-baseline.json").exists())
        self.assertIn("manual edit", (baseline / "src/index.ts").read_text())

    def test_custom_deploy_cwd_does_not_select_an_unrelated_data_directory(self):
        data = Path(self.account.pw_dir) / ".blackdogbot"
        data.mkdir(parents=True)
        (data / "config.yaml").write_text("synthetic: correct\n")
        custom = self.root / "custom"
        (custom / "deploy/current").mkdir(parents=True)
        (custom / "config.yaml").write_text("synthetic: unrelated\n")
        service = {"environment": {}, "properties": {"WorkingDirectory": str(custom / "deploy/current")}}
        self.assertEqual(upgrade.data_directory(None, service, self.account), data)
        self.assertEqual((custom / "config.yaml").read_text(), "synthetic: unrelated\n")

    def test_two_legacy_default_data_roots_require_selection(self):
        for name in (".blackdogbot", ".betterclaw"):
            root = Path(self.account.pw_dir) / name
            root.mkdir(parents=True)
            (root / "config.yaml").write_text("synthetic: config\n")
        service = {"environment": {}, "properties": {"WorkingDirectory": str(self.root / "custom/deploy/current")}}
        with self.assertRaisesRegex(upgrade.UpgradeError, "ambiguous"):
            upgrade.data_directory(None, service, self.account)

    def test_stopped_service_keeps_verified_absolute_working_directory(self):
        self.assertEqual(upgrade.stopped_runtime_cwd({"WorkingDirectory": str(self.parent_cwd)}), str(self.parent_cwd))

    def test_stopped_launcher_uses_release_root_after_launch_sh_changes_directory(self):
        script = self.runtime_cwd / "scripts/launch.sh"
        script.parent.mkdir()
        script.write_text("#!/bin/sh")
        properties = {
            "WorkingDirectory": str(self.parent_cwd),
            "ExecStart": "{ path=/usr/bin/bash ; argv[]=/usr/bin/bash " + str(script) + " ; }",
        }
        self.assertEqual(upgrade.stopped_runtime_cwd(properties), str(self.runtime_cwd))

    def test_stopped_preserved_baseline_keeps_original_literal_path_cwd(self):
        baseline = self.root / "releases" / ("a" * 40)
        baseline.mkdir(parents=True)
        (baseline / ".blackdog-legacy-baseline.json").write_text(json.dumps({"runtimeCwd": str(self.runtime_cwd)}))
        properties = {
            "WorkingDirectory": str(baseline),
            "ExecStart": "{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 /home/fixture/.local/lib/blackdogbot/launch-upgrade.py ; }",
        }
        self.assertEqual(upgrade.stopped_runtime_cwd(properties), str(self.runtime_cwd))
        self.assertNotEqual(upgrade.stopped_runtime_cwd(properties), str(baseline))

    def test_stopped_current_symlink_resolves_before_baseline_lookup(self):
        baseline = self.root / "releases" / ("b" * 40)
        baseline.mkdir(parents=True)
        (baseline / ".blackdog-legacy-baseline.json").write_text(json.dumps({"runtimeCwd": str(self.runtime_cwd)}))
        current = self.root / "current"
        current.symlink_to(baseline)
        self.assertEqual(upgrade.stopped_runtime_cwd({"WorkingDirectory": str(current)}), str(self.runtime_cwd))

    def test_stopped_service_refuses_missing_or_relative_working_directory(self):
        for working in ("", "relative/release"):
            with self.subTest(working=working), self.assertRaisesRegex(upgrade.UpgradeError, "absolute verified"):
                upgrade.stopped_runtime_cwd({"WorkingDirectory": working})

    def test_stopped_baseline_refuses_relative_preserved_cwd(self):
        (self.parent_cwd / ".blackdog-legacy-baseline.json").write_text(json.dumps({"runtimeCwd": "relative"}))
        with self.assertRaisesRegex(upgrade.UpgradeError, "absolute path"):
            upgrade.stopped_runtime_cwd({"WorkingDirectory": str(self.parent_cwd)})


if __name__ == "__main__":
    unittest.main()
