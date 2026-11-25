import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import pwd
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('blackdog_upgrade_tests', ROOT / 'scripts/upgrade.py')
upgrade = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upgrade)
OLD = 'a' * 40
NEW = 'b' * 40


def result(stdout='', code=0):
    return subprocess.CompletedProcess([], code, stdout, '')


class UpgradeFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / 'home'
        self.home.mkdir(mode=0o700)
        self.account = SimpleNamespace(pw_name='botowner', pw_uid=os.geteuid(), pw_gid=os.getegid(), pw_dir=str(self.home))
        self.data = self.home / '.blackdogbot'
        self.data.mkdir(mode=0o700)
        (self.data / 'config.yaml').write_text('knowledge: {}\n')
        self.state = self.data / 'deploy'
        self.state.mkdir(mode=0o700)
        self.repo = self.home / 'source'
        self.repo.mkdir()
        self.baseline = self.state / 'legacy-baselines' / OLD
        self.baseline.mkdir(parents=True)
        self.candidate = self.state / 'releases' / NEW
        (self.candidate / 'scripts').mkdir(parents=True)
        (self.candidate / 'scripts/guarded-release.py').write_text('# tested supervisor\n')
        (self.candidate / 'scripts/upgrade.py').write_text('# standalone entry\n')
        self.unit = self.home / '.config/systemd/user/blackdogbot.service'
        self.unit.parent.mkdir(parents=True)
        self.unit.write_text('[Service]\nType=simple\nExecStart=/usr/bin/node /old/src/index.ts\n')
        self.properties = {
            'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running', 'MainPID': '11',
            'UnitFileState': 'enabled', 'FragmentPath': str(self.unit), 'DropInPaths': '',
            'User': '', 'Group': '', 'SupplementaryGroups': '',
            'WorkingDirectory': str(self.repo),
            'ExecStart': '{ path=/usr/bin/node ; argv[]=/usr/bin/node /old/src/index.ts ; ignore_errors=no ; }',
            'Type': 'simple', 'KillMode': 'control-group', 'EnvironmentFiles': '',
            'Environment': 'HOME=' + str(self.home) + ' PATH=/usr/bin',
            'DynamicUser': 'no', 'RootDirectory': '', 'RootImage': '',
            'ExecStartPre': '', 'ExecStartPost': '', 'ExecStop': '', 'ExecStopPost': '',
        }
        files = [upgrade.file_snapshot(self.unit)]
        self.service = {'scope': 'user', 'unit': 'blackdogbot.service', 'properties': self.properties,
                        'files': files, 'fingerprint': upgrade.fingerprint(self.properties, files),
                        'runtimeCwd': str(self.repo), 'runtimeNode': '/usr/bin/node',
                        'environment': {'HOME': str(self.home), 'PATH': '/usr/bin', 'PRIVATE_KEY': 'do-not-print'},
                        'owner': self.account.pw_name, 'uid': self.account.pw_uid, 'wasActive': True, 'wasEnabled': True}
        self.operation = {'formatVersion': 1, 'id': 'u-test', 'phase': 'candidate_prepared',
                          'repo': str(self.repo), 'baselineRepo': str(self.repo), 'dataDir': str(self.data),
                          'state': str(self.state), 'revision': NEW, 'reference': 'v0.2.0',
                          'previousRevision': OLD, 'previousPath': str(self.baseline),
                          'baseline': str(self.baseline), 'candidate': str(self.candidate),
                          'service': self.service, 'guarded': False, 'timeout': 15,
                          'databaseSource': None, 'importLegacyTasks': False}
        self.guard = Mock()
        self.guard.activate.return_value = True
        self.guard.read_activation.return_value = None
        self.guard.activation_lock.side_effect = lambda path: contextlib.nullcontext()

    def save_report(self, status, **values):
        (self.state / 'reports').mkdir(mode=0o700, exist_ok=True)
        upgrade.write_json(self.state / 'reports/latest.json', {'status': status, 'revision': NEW, **values})


class RevisionTests(UpgradeFixture):
    def test_moving_refs_and_short_shas_are_rejected_before_git(self):
        for ref in ('main', 'origin/main', 'abc123', '--upload-pack=evil', 'v0.2.0;touch x'):
            with self.subTest(ref=ref), patch.object(upgrade, 'run') as command:
                with self.assertRaises(upgrade.UpgradeError):
                    upgrade.resolve_revision(self.repo, ref)
                command.assert_not_called()

    def test_annotated_tag_resolves_to_commit(self):
        with patch.object(upgrade, 'run', return_value=result('c' * 40 + '\trefs/tags/v0.2.0\n' + NEW + '\trefs/tags/v0.2.0^{}\n')):
            self.assertEqual(upgrade.resolve_revision(self.repo, 'v0.2.0'), ('v0.2.0', NEW))

    def test_full_sha_is_pinned_without_branch_lookup(self):
        with patch.object(upgrade, 'run') as command:
            self.assertEqual(upgrade.resolve_revision(self.repo, NEW), (NEW, NEW))
            command.assert_not_called()

    def test_default_requires_official_origin_and_stable_release(self):
        with patch.object(upgrade, 'canonical_origin', return_value=False), patch.object(upgrade, 'latest_release') as latest:
            with self.assertRaises(upgrade.UpgradeError):
                upgrade.resolve_revision(self.repo, None)
            latest.assert_not_called()
        with patch.object(upgrade, 'canonical_origin', return_value=True), patch.object(upgrade, 'latest_release', return_value='v0.2.0'), patch.object(upgrade, 'run', return_value=result(NEW + '\trefs/tags/v0.2.0\n')):
            self.assertEqual(upgrade.resolve_revision(self.repo, None), ('v0.2.0', NEW))

    def test_tag_change_during_fetch_never_creates_worktree(self):
        missing_state = self.root / 'new-state'
        missing_state.mkdir()
        calls = []
        def fake(argv, **kwargs):
            calls.append(argv)
            return result(OLD if argv[1] == 'rev-parse' else '')
        with patch.object(upgrade, 'run', side_effect=fake):
            with self.assertRaisesRegex(upgrade.UpgradeError, 'tag changed'):
                upgrade.prepare_candidate(self.repo, missing_state, NEW, 'v0.2.0', self.root / 'prepare.log')
        self.assertFalse(any('worktree' in call for call in calls))


class FileTests(UpgradeFixture):
    def test_supervisor_refresh_preserves_private_original(self):
        target = self.home / '.local/lib/blackdogbot/guarded-release.py'
        target.parent.mkdir(parents=True)
        target.write_bytes(b'old supervisor')
        target.chmod(0o700)
        upgrade.refresh_supervisor(self.operation, self.candidate, self.account)
        item = self.operation['files'][0]
        self.assertEqual(bytes.fromhex(item['before']), b'old supervisor')
        self.assertEqual(target.read_bytes(), b'# tested supervisor\n')
        journal = self.state / 'upgrades/u-test/journal.json'
        self.assertEqual(journal.stat().st_mode & 0o777, 0o600)
        self.assertEqual(journal.parent.stat().st_mode & 0o777, 0o700)
        upgrade.refresh_supervisor(self.operation, self.candidate, self.account)
        self.assertEqual(len(self.operation['files']), 1)

    def test_saved_write_can_resume_before_atomic_replace(self):
        target = self.home / 'managed'
        target.write_bytes(b'original')
        with patch.object(upgrade, 'atomic_write', wraps=upgrade.atomic_write) as atomic:
            def fail_target(path, content, mode=0o600):
                if path == target:
                    raise PermissionError('fixture')
                return upgrade_atomic(path, content, mode)
            upgrade_atomic = atomic._mock_wraps
            atomic.side_effect = fail_target
            with self.assertRaises(PermissionError):
                upgrade.save_owned_file(self.operation, target, b'new')
        self.assertEqual(target.read_bytes(), b'original')
        upgrade.save_owned_file(self.operation, target, b'new')
        self.assertEqual(target.read_bytes(), b'new')
        self.assertEqual(len(self.operation['files']), 1)

    def test_newer_edits_are_not_overwritten_by_resume_or_restore(self):
        target = self.home / 'managed'
        target.write_bytes(b'original')
        upgrade.save_owned_file(self.operation, target, b'new')
        target.write_bytes(b'later edit')
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.save_owned_file(self.operation, target, b'new')
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.restore_owned_files(self.operation)
        self.assertEqual(target.read_bytes(), b'later edit')

    def test_existing_conversion_override_is_preserved(self):
        override = self.unit.parent / (self.unit.name + '.d') / '40-guarded-release.conf'
        override.parent.mkdir()
        override.write_text('existing unrelated override')
        with patch.object(upgrade, 'systemctl') as command:
            with self.assertRaises(upgrade.UpgradeError):
                upgrade.install_launcher(self.operation, self.baseline, self.account)
            command.assert_not_called()
        self.assertEqual(override.read_text(), 'existing unrelated override')
        self.assertFalse((self.state / 'current').is_symlink())

    def test_launcher_resume_finishes_interrupted_reload(self):
        with patch.object(upgrade, 'systemctl', side_effect=PermissionError('fixture')):
            with self.assertRaises(PermissionError):
                upgrade.install_launcher(self.operation, self.baseline, self.account)
        self.assertTrue((self.state / 'current').is_symlink())
        self.assertFalse(self.operation.get('launcherInstalled', False))
        with patch.object(upgrade, 'systemctl', return_value=result()) as command:
            upgrade.install_launcher(self.operation, self.baseline, self.account)
        self.assertTrue(self.operation['launcherInstalled'])
        command.assert_called_once_with('user', 'daemon-reload')
        self.assertEqual(len(self.operation['files']), 2)

    def test_symlink_owned_target_is_rejected(self):
        outside = self.home / 'outside'
        outside.write_bytes(b'private')
        target = self.home / 'managed'
        target.symlink_to(outside)
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.save_owned_file(self.operation, target, b'new')
        self.assertEqual(outside.read_bytes(), b'private')


class PlanAndApplyTests(UpgradeFixture):
    def test_cli_plan_is_read_only_and_supports_pnpm_separator(self):
        with patch.object(upgrade, 'os') as fake_os, patch.object(upgrade.pwd, 'getpwuid', return_value=self.account), patch.object(upgrade, 'select_saved_operation', return_value=None), patch.object(upgrade, 'build_plan', return_value=self.operation), patch.object(upgrade, 'private_directory') as private, patch.object(upgrade, 'apply_operation') as apply, contextlib.redirect_stdout(io.StringIO()) as output:
            fake_os.geteuid.return_value = 1000
            self.assertEqual(upgrade.main(['--', 'plan', '--revision', 'v0.2.0']), 0)
        private.assert_not_called()
        apply.assert_not_called()
        self.assertNotIn('do-not-print', output.getvalue())
        self.assertIn('PRIVATE_KEY', output.getvalue())

    def test_duplicate_service_blocks_before_work(self):
        active = {'LoadState': 'loaded', 'MainPID': '55', 'ActiveState': 'active', 'UnitFileState': 'enabled'}
        def properties(scope, unit):
            return active if (scope, unit) == ('system', 'blackdogbot.service') else {'LoadState': 'not-found'}
        with patch.object(upgrade, 'unit_properties', side_effect=properties):
            with self.assertRaisesRegex(upgrade.UpgradeError, 'concurrently'):
                upgrade.ensure_no_competing_service(self.service)

    def test_guarded_apply_prepares_and_refreshes_before_activate(self):
        self.operation['guarded'] = True
        (self.state / 'current').symlink_to(self.baseline)
        calls = []
        def prepare(*args, **kwargs):
            calls.append('prepare')
            return self.candidate
        def activate(*args, **kwargs):
            calls.append('activate')
            self.assertTrue((self.home / '.local/lib/blackdogbot/guarded-release.py').is_file())
            self.assertEqual(kwargs['runtime_cwd'], self.repo)
            self.assertFalse(kwargs['update_containers'])
            self.assertIsNone(args[3])
            return True
        self.guard.activate.side_effect = activate
        with patch.object(upgrade, 'ensure_no_competing_service'), patch.object(upgrade, 'systemctl', return_value=result()), patch.object(upgrade, 'check_runtime'), patch.object(upgrade, 'prepare_candidate', side_effect=prepare), patch.object(upgrade, 'load_guard', return_value=self.guard):
            value = upgrade.apply_operation(self.operation, self.account)
        self.assertEqual(value['phase'], 'healthy')
        self.assertEqual(calls, ['prepare', 'activate'])

    def test_system_permission_handoff_happens_after_tests_and_before_unit_edits(self):
        self.service['scope'] = 'system'
        with patch.object(upgrade, 'ensure_no_competing_service'), patch.object(upgrade, 'systemctl', return_value=result()) as command, patch.object(upgrade, 'check_runtime'), patch.object(upgrade, 'prepare_candidate', return_value=self.candidate) as prepare, patch.object(upgrade, 'load_guard', return_value=self.guard), patch.object(upgrade, 'system_released', return_value=False), patch.object(upgrade, 'refresh_supervisor') as refresh, patch.object(upgrade, 'install_launcher') as install:
            value = upgrade.apply_operation(self.operation, self.account)
        prepare.assert_called_once()
        refresh.assert_not_called()
        install.assert_not_called()
        self.guard.activate.assert_not_called()
        command.assert_called_once_with('user', 'show-environment', check=False)
        self.assertEqual(value['phase'], 'administrator_required')
        self.assertIn('sudo /usr/bin/python3', upgrade.public_operation(value)['administratorCommand'])

    def test_failed_candidate_preparation_never_stops_service(self):
        with patch.object(upgrade, 'ensure_no_competing_service'), patch.object(upgrade, 'systemctl', return_value=result()) as command, patch.object(upgrade, 'check_runtime'), patch.object(upgrade, 'prepare_candidate', side_effect=upgrade.UpgradeError('tests failed')), patch.object(upgrade, 'load_guard') as load:
            with self.assertRaises(upgrade.UpgradeError):
                upgrade.apply_operation(self.operation, self.account)
        load.assert_not_called()
        self.assertEqual([call.args[1] for call in command.call_args_list], ['show-environment'])

    def test_missing_user_manager_is_actionable_and_unchanged(self):
        with patch.object(upgrade, 'ensure_no_competing_service'), patch.object(upgrade, 'systemctl', return_value=result(code=1)), patch.object(upgrade, 'prepare_candidate') as prepare:
            with self.assertRaisesRegex(upgrade.UpgradeError, 'login session'):
                upgrade.apply_operation(self.operation, self.account)
        prepare.assert_not_called()

    def test_unchanged_prepared_candidate_skips_install_and_tests(self):
        with patch.object(upgrade, 'prepared', return_value=True), patch.object(upgrade, 'run') as command:
            self.assertEqual(upgrade.prepare_candidate(self.repo, self.state, NEW, 'v0.2.0', self.root / 'log'), self.candidate)
        command.assert_not_called()


class RecoveryTests(UpgradeFixture):
    def test_preacceptance_failure_restores_original_user_service(self):
        with patch.object(upgrade, 'systemctl', return_value=result()):
            upgrade.install_launcher(self.operation, self.baseline, self.account)
        self.operation['phase'] = 'rolled_back'
        self.save_report('rolled_back', failed_revision=NEW)
        events = []
        self.guard.stop_and_verify.side_effect = lambda unit: events.append('stop')
        def command(scope, action, *args, **kwargs):
            if action == 'start':
                self.assertFalse((self.state / 'current').exists())
                self.assertFalse((self.unit.parent / (self.unit.name + '.d') / '40-guarded-release.conf').exists())
            events.append(action)
            return result()
        with patch.object(upgrade, 'load_guard', return_value=self.guard), patch.object(upgrade, 'verify_original_checkout'), patch.object(upgrade, 'systemctl', side_effect=command):
            value = upgrade.recover_operation(self.operation, self.account)
        self.assertEqual(value['phase'], 'restored')
        self.assertEqual(events, ['stop', 'daemon-reload', 'start'])
        self.assertTrue(self.unit.is_file())

    def test_incomplete_database_rollback_never_changes_units(self):
        (self.state / 'current').symlink_to(self.baseline)
        self.operation['phase'] = 'recovery_required'
        self.save_report('backup_failed', data_unchanged=False, manual_recovery_required=True, path_recovery_error={'error': 'candidate wrote database'})
        with patch.object(upgrade, 'load_guard', return_value=self.guard), patch.object(upgrade, 'systemctl') as command:
            with self.assertRaisesRegex(upgrade.UpgradeError, 'Data recovery'):
                upgrade.recover_operation(self.operation, self.account)
        command.assert_not_called()
        self.guard.stop_and_verify.assert_not_called()

    def test_accepted_candidate_never_restores_old_service_even_with_stale_report(self):
        (self.state / 'current').symlink_to(self.baseline)
        self.operation['phase'] = 'rolled_back'
        self.save_report('rolled_back')
        self.guard.read_activation.return_value = {'status': 'committed', 'candidatePath': str(self.candidate)}
        with patch.object(upgrade, 'load_guard', return_value=self.guard), patch.object(upgrade, 'systemctl') as command:
            with self.assertRaisesRegex(upgrade.UpgradeError, 'accepted activation'):
                upgrade.recover_operation(self.operation, self.account)
        command.assert_not_called()

    def test_candidate_pointer_blocks_restore_even_with_safe_old_report(self):
        (self.state / 'current').symlink_to(self.candidate)
        self.operation['phase'] = 'rolled_back'
        self.save_report('rolled_back')
        with patch.object(upgrade, 'load_guard', return_value=self.guard):
            with self.assertRaisesRegex(upgrade.UpgradeError, 'pointer'):
                upgrade.recover_operation(self.operation, self.account)
        self.guard.stop_and_verify.assert_not_called()

    def test_other_revision_report_cannot_authorize_recovery(self):
        self.operation['phase'] = 'recovery_required'
        self.assertFalse(upgrade.safe_to_restore(self.operation, {'status': 'rolled_back', 'revision': OLD}))

    def test_stopped_guarded_baseline_can_be_explicitly_recovered(self):
        self.operation['guarded'] = True
        self.operation['phase'] = 'recovery_required'
        (self.state / 'current').symlink_to(self.baseline)
        self.save_report('backup_failed', data_unchanged=True, service_stopped=True)
        with patch.object(upgrade, 'load_guard', return_value=self.guard), patch.object(upgrade, 'systemctl', return_value=result()) as command:
            self.assertEqual(upgrade.recover_operation(self.operation, self.account)['phase'], 'restored')
        command.assert_called_once_with('user', 'start', self.service['unit'])

    def test_resume_can_add_database_choice_only_before_migration(self):
        args = upgrade.parser().parse_args(['apply', '--database-source', str(self.root / 'database')])
        self.operation['phase'] = 'activation_interrupted'
        self.save_report('preflight_failed', data_unchanged=True)
        upgrade.validate_resume_options(args, self.operation)
        self.assertEqual(self.operation['databaseSource'], str(self.root / 'database'))
        args.database_source = self.root / 'another-database'
        self.save_report('migration_failed')
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.validate_resume_options(args, self.operation)


if __name__ == '__main__':
    unittest.main()
