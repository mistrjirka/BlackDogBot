"""System-service conversion fixtures never call real systemctl, sudo, or loginctl."""
import argparse
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('blackdog_upgrade_system', Path(__file__).resolve().parents[2] / 'scripts/upgrade.py')
upgrade = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upgrade)


def completed(output='', code=0):
    return subprocess.CompletedProcess([], code, output, '')


class SystemServiceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.system = self.root / 'etc/systemd/system'
        self.system.mkdir(parents=True)
        self.admin = self.root / 'admin'
        self.admin.mkdir(mode=0o700)
        self.home = self.root / 'home'
        self.home.mkdir(mode=0o700)
        self.data = self.home / '.blackdogbot'
        self.data.mkdir(mode=0o700)
        (self.data / 'config.yaml').write_text('knowledge: {}\n')
        self.candidate = self.data / 'deploy/releases' / ('b' * 40)
        self.baseline = self.data / 'deploy/legacy-baselines' / ('a' * 40)
        self.candidate.mkdir(parents=True)
        self.baseline.mkdir(parents=True)
        self.account = SimpleNamespace(pw_name='fixture-owner', pw_uid=os.geteuid(), pw_gid=os.getegid(), pw_dir=str(self.home))
        self.unit = 'blackdogbot.service'
        self.mask = self.system / self.unit
        self.original = ('[Unit]\nDescription=Fixture\nAfter=network-online.target\n[Service]\nType=simple\n'
                         'User=fixture-owner\nWorkingDirectory=' + str(self.home) + '\n'
                         'ExecStart=/usr/bin/node ' + str(self.home / 'src/index.ts') + '\n'
                         'Restart=on-failure\n[Install]\nWantedBy=multi-user.target\n').encode()
        self.mask.write_bytes(self.original)
        self.mask.chmod(0o644)
        self.properties = {'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running',
                           'MainPID': '123', 'UnitFileState': 'enabled', 'FragmentPath': str(self.mask),
                           'DropInPaths': '', 'User': self.account.pw_name, 'Group': '', 'SupplementaryGroups': '',
                           'WorkingDirectory': str(self.home), 'Type': 'simple', 'KillMode': 'control-group',
                           'ExecStart': '{ path=/usr/bin/node ; argv[]=/usr/bin/node ' + str(self.home / 'src/index.ts') + ' ; }',
                           'Environment': 'HOME=' + str(self.home), 'EnvironmentFiles': '', 'DynamicUser': 'no'}
        self.files = [upgrade.file_snapshot(self.mask)]
        self.args = argparse.Namespace(action='system-release', unit=self.unit, owner=self.account.pw_name,
                                       fingerprint=upgrade.fingerprint(self.properties, self.files),
                                       candidate=self.candidate, baseline=self.baseline, data_dir=self.data, start=False)
        self.receipt = self.admin / self.unit / 'receipt.json'
        self.receipt.parent.mkdir(mode=0o700)
        self.calls = []
        self.user_active = False
        self.user_enabled = False
        self.fail_reload_once = False
        self.fail_stop_once = False
        self.fail_enable_once = False
        for name, value in (('ROOT_UID', os.geteuid()), ('SYSTEM_DIR', self.system), ('ADMIN_DIR', self.admin)):
            selected = patch.object(upgrade, name, value)
            selected.start()
            self.addCleanup(selected.stop)
        for name, function in (('systemctl', self.systemctl), ('run', self.fake_run), ('run_as_owner', self.run_as_owner), ('root_command', lambda name: '/usr/bin/' + name)):
            selected = patch.object(upgrade, name, side_effect=function)
            selected.start()
            self.addCleanup(selected.stop)

    def systemctl(self, scope, *args, check=True):
        self.calls.append((scope, *args))
        action = args[0]
        if action == 'show':
            return completed('\n'.join(key + '=' + value for key, value in self.properties.items()))
        if action == 'stop':
            if self.fail_stop_once:
                self.fail_stop_once = False
                raise PermissionError('fixture stop denied')
            self.properties.update(MainPID='0', ActiveState='inactive', SubState='dead')
        elif action == 'disable':
            self.properties['UnitFileState'] = 'disabled'
        elif action == 'enable':
            if self.fail_enable_once:
                self.fail_enable_once = False
                raise PermissionError('fixture enable denied')
            self.properties['UnitFileState'] = 'enabled'
        elif action == 'daemon-reload':
            if self.fail_reload_once:
                self.fail_reload_once = False
                raise PermissionError('fixture reload denied')
            self.properties['LoadState'] = 'masked' if self.mask.is_symlink() else 'loaded'
        elif action == 'start':
            if self.user_active or self.user_enabled:
                raise AssertionError('two bot services could run')
            self.properties.update(MainPID='456', ActiveState='active', SubState='running')
        return completed()

    def fake_run(self, argv, **kwargs):
        self.calls.append(tuple(argv))
        if argv[:2] == ['/usr/bin/loginctl', 'show-user']:
            return completed('no\n')
        if argv[:2] in (['/usr/bin/loginctl', 'enable-linger'], ['/usr/bin/loginctl', 'disable-linger']):
            return completed()
        raise AssertionError('unexpected external command: ' + repr(argv))

    def run_as_owner(self, account, argv, **kwargs):
        self.calls.append(('as-owner', *argv))
        if argv[:2] == ['/usr/bin/systemctl', '--user']:
            return completed('MainPID=' + ('777' if self.user_active else '0') + '\nActiveState=' + ('active' if self.user_active else 'inactive') + '\nUnitFileState=' + ('enabled' if self.user_enabled else 'disabled'))
        if argv[:2] == ['/usr/bin/python3', '-c']:
            self.assertIn('can_start_release', argv[2])
            self.assertIn('read_activation', argv[2])
            return completed()
        raise AssertionError('unexpected owner command')

    def release(self):
        return upgrade.administrator_release(self.args, self.account, self.receipt, self.mask)

    def restore(self, start=True):
        self.args.action = 'system-restore'
        self.args.start = start
        return upgrade.administrator_restore(self.args, self.account, self.receipt, self.mask)

    def test_release_stops_disables_and_masks_before_returning(self):
        value = self.release()
        self.assertEqual(value['status'], 'system_released')
        self.assertEqual(os.readlink(self.mask), '/dev/null')
        self.assertEqual((self.receipt.parent / 'unit.before').read_bytes(), self.original)
        self.assertEqual(self.receipt.stat().st_mode & 0o777, 0o600)
        actions = [call[1] for call in self.calls if call[0] == 'system']
        self.assertLess(actions.index('stop'), actions.index('disable'))
        self.assertLess(actions.index('disable'), actions.index('daemon-reload'))
        self.assertIn(('/usr/bin/loginctl', 'enable-linger', self.account.pw_name), self.calls)
        self.assertFalse(any(call[0] == 'sudo' for call in self.calls))

    def test_permission_failure_does_not_remove_original_and_can_resume(self):
        self.fail_stop_once = True
        with self.assertRaises(PermissionError):
            self.release()
        self.assertEqual(self.mask.read_bytes(), self.original)
        self.assertEqual(upgrade.read_json(self.receipt)['phase'], 'prepared')
        self.assertEqual(self.release()['status'], 'system_released')

    def test_interruption_after_atomic_mask_is_resumable(self):
        self.fail_reload_once = True
        with self.assertRaises(PermissionError):
            self.release()
        self.assertTrue(self.mask.is_symlink())
        self.assertEqual(upgrade.read_json(self.receipt)['phase'], 'masking')
        self.assertEqual(self.release()['status'], 'system_released')
        self.assertEqual(upgrade.read_json(self.receipt)['phase'], 'masked')

    def test_repeated_release_is_idempotent(self):
        self.release()
        first = (self.receipt.parent / 'unit.before').read_bytes()
        self.release()
        self.assertEqual((self.receipt.parent / 'unit.before').read_bytes(), first)
        self.assertEqual(sum(call[:2] == ('system', 'stop') for call in self.calls), 1)

    def test_changed_fingerprint_blocks_before_stop(self):
        self.args.fingerprint = '0' * 64
        with self.assertRaisesRegex(upgrade.UpgradeError, 'changed after planning'):
            self.release()
        self.assertEqual(self.mask.read_bytes(), self.original)
        self.assertFalse(any(call[:2] == ('system', 'stop') for call in self.calls))

    def test_dropin_edit_after_release_blocks_restore(self):
        dropin = self.system / (self.unit + '.d') / '10-environment.conf'
        dropin.parent.mkdir()
        dropin.write_text('[Service]\nEnvironment=EXAMPLE=old\n')
        self.properties['DropInPaths'] = str(dropin)
        self.args.fingerprint = upgrade.fingerprint(self.properties, upgrade.unit_files(self.properties))
        self.release()
        dropin.write_text('[Service]\nEnvironment=EXAMPLE=new\n')
        with self.assertRaisesRegex(upgrade.UpgradeError, 'file changed'):
            self.restore()
        self.assertTrue(self.mask.is_symlink())
        self.assertIn('EXAMPLE=new', dropin.read_text())

    def test_restore_blocks_active_or_boot_enabled_user_daemon(self):
        self.release()
        for active, enabled in ((True, False), (False, True)):
            self.user_active, self.user_enabled = active, enabled
            with self.subTest(active=active, enabled=enabled):
                with self.assertRaisesRegex(upgrade.UpgradeError, 'Both must never run'):
                    self.restore()
                self.assertTrue(self.mask.is_symlink())
        self.assertFalse(any(call[:2] == ('system', 'start') for call in self.calls))

    def test_restore_verifies_data_as_owner_before_restoring_original(self):
        self.release()
        value = self.restore()
        self.assertEqual(value['status'], 'system_restored')
        self.assertFalse(self.mask.is_symlink())
        self.assertEqual(self.mask.read_bytes(), self.original)
        self.assertEqual(self.mask.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.properties['UnitFileState'], 'enabled')
        self.assertIn(('/usr/bin/loginctl', 'disable-linger', self.account.pw_name), self.calls)
        validations = [index for index, call in enumerate(self.calls) if call[:3] == ('as-owner', '/usr/bin/python3', '-c')]
        starts = [index for index, call in enumerate(self.calls) if call[:2] == ('system', 'start')]
        self.assertLess(validations[0], starts[0])

    def test_restore_can_resume_after_original_file_replaced(self):
        self.release()
        self.fail_enable_once = True
        with self.assertRaises(PermissionError):
            self.restore()
        self.assertEqual(self.mask.read_bytes(), self.original)
        self.assertEqual(upgrade.read_json(self.receipt)['phase'], 'restoring')
        self.assertEqual(self.restore()['status'], 'system_restored')

    def test_failed_data_compatibility_keeps_system_masked(self):
        self.release()
        original = self.run_as_owner
        def reject(account, argv, **kwargs):
            if argv[:2] == ['/usr/bin/python3', '-c']:
                raise upgrade.UpgradeError('incompatible data fixture')
            return original(account, argv, **kwargs)
        with patch.object(upgrade, 'run_as_owner', side_effect=reject):
            with self.assertRaisesRegex(upgrade.UpgradeError, 'incompatible data'):
                self.restore()
        self.assertTrue(self.mask.is_symlink())
        self.assertFalse(any(call[:2] == ('system', 'start') for call in self.calls))

    def test_unsupported_custom_system_unit_is_not_rewritten(self):
        self.mask.write_bytes(self.original + b'Alias=another.service\n')
        self.args.fingerprint = upgrade.fingerprint(self.properties, upgrade.unit_files(self.properties))
        with self.assertRaisesRegex(upgrade.UpgradeError, 'unsupported system-unit setting'):
            self.release()
        self.assertFalse(any(call[:2] == ('system', 'stop') for call in self.calls))
        self.assertFalse(self.receipt.exists())

    def test_custom_system_dependencies_are_rejected_before_stop(self):
        self.mask.write_bytes(self.original.replace(b'After=network-online.target', b'After=database.service'))
        self.args.fingerprint = upgrade.fingerprint(self.properties, upgrade.unit_files(self.properties))
        with self.assertRaisesRegex(upgrade.UpgradeError, 'dependencies'):
            self.release()
        self.assertFalse(any(call[:2] == ('system', 'stop') for call in self.calls))

    def test_effective_process_settings_survive_after_system_unit_is_masked(self):
        self.properties.update(Restart='on-abnormal', RestartUSec='7s', KillSignal='10', TimeoutStopUSec='2min')
        service = {'files': self.files, 'properties': self.properties}
        service['processSettings'] = upgrade.system_service_settings(service)
        self.args.fingerprint = upgrade.fingerprint(self.properties, self.files)
        self.release()
        rendered = upgrade.system_service_settings(service)
        self.assertIn('Restart=on-abnormal\n', rendered)
        self.assertIn('RestartSec=7s\n', rendered)
        self.assertIn('KillSignal=10\n', rendered)
        self.assertIn('TimeoutStopSec=2min\n', rendered)

    def test_admin_entry_point_rejects_missing_privilege(self):
        with patch.object(upgrade.os, 'geteuid', return_value=os.geteuid() + 1):
            with self.assertRaisesRegex(upgrade.UpgradeError, 'requires an administrator'):
                upgrade.admin_action(self.args)

    def test_admin_entry_point_rejects_root_run_bot(self):
        account = SimpleNamespace(pw_uid=0, pw_name='root')
        with patch.object(upgrade.pwd, 'getpwnam', return_value=account):
            with self.assertRaisesRegex(upgrade.UpgradeError, 'Root-run bot'):
                upgrade.admin_action(self.args)


if __name__ == '__main__':
    unittest.main()
