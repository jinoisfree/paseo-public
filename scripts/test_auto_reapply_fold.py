# Adapted for the portable paseo-public distribution.
"""No real app, launchd or notification writes; integration runs in a temp app."""
import contextlib

import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import tarfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('auto_fold', Path(__file__).with_name('auto-reapply-fold.py'))
auto = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auto)


class Fixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.app = self.root/'Paseo.app'
        (self.app/'Contents/MacOS').mkdir(parents=True)
        (self.app/'Contents/MacOS/Paseo').write_bytes(b'fake executable')
        (self.app/'Contents/Resources').mkdir()
        (self.app/'Contents/Resources/app.asar').write_bytes(b'protected archive')
        (self.app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString': '0.12.0'}))
        self.dist = self.root/'source/packages/app/dist'
        self.dist.mkdir(parents=True)
        (self.dist/'index.html').write_text('<script src="/index-new.js"></script>')
        (self.dist/'index-new.js').write_text('sidebar-project-pushed-new')
        installed = self.app/'Contents/Resources/app-dist'
        installed.mkdir()
        (installed/'index.html').write_text('<script src="/index-old.js"></script>')
        (installed/'index-old.js').write_text('sidebar-project-pushed-old')
        (self.root/'patches').mkdir()
        (self.root/'patches/sidebar-pushed-fold-0.11.4.patch').write_text('invalid patch\n')
        self.args = auto.arguments(['--root', str(self.root), '--app', str(self.app), '--stable-seconds', '0', '--data-root', str(self.root/'automation/fold-reapply')])
        self.events = []

    def machine(self, conflict=False, fail_install=False, plugin_failure=False):
        fixture = self
        class Machine(auto.Automation):
            def notify(self, text): fixture.events.append(('notify', text))
            def probe_plugin(self, version, timeout):
                fixture.events.append(('plugin-probe', version))
                return {'status': 'failed' if plugin_failure else 'passed', 'daemonVersion': version,
                        'summary': 'workflow.folders RPC 응답 실패' if plugin_failure else '정상',
                        'foldersCount': 3}
            def prepare_source(self, version):
                fixture.events.append(('prepare', version))
                return fixture.root/'source'
            def build(self, source):
                fixture.events.append(('build', str(source)))
                return fixture.dist
            def command(self, command, cwd=None, capture=False, timeout=3600):
                command = list(map(str, command))
                fixture.events.append(('command', command))
                if command[0] == 'git' and conflict:
                    # Use actual git to reproduce a rejected patch; do not call installer.
                    result = subprocess.run(command, cwd=cwd, capture_output=True)
                    if result.returncode: raise RuntimeError('patch conflict')
                if '--apply' in command:
                    if fail_install: raise RuntimeError('installer failed (owns rollback)')
                    backup = fixture.root/'backups/original/Paseo.app'
                    backup.parent.mkdir(parents=True)
                    shutil.copytree(fixture.app, backup)
                    installed = fixture.app/'Contents/Resources/app-dist'
                    shutil.rmtree(installed)
                    shutil.copytree(fixture.dist, installed)
                if command[-1].endswith('diagnose-pushed-fold.py'):
                    return json.dumps({'apps': [{'app': str(fixture.app), 'bundles': [{'pushedFold': True}]}]})
                return ''
        return Machine(self.args)

    def quiet_run(self, machine):
        with contextlib.redirect_stdout(io.StringIO()): return machine.run()

    def test_official_internal_symlinks_and_escaping_link_refusal(self):
        archive = self.root/'official.tar.gz'
        def write_archive(target):
            with tarfile.open(archive, 'w:gz') as stream:
                package = b'{"version":"0.12.0"}'
                member = tarfile.TarInfo('paseo-0.12.0/package.json'); member.size = len(package)
                stream.addfile(member, io.BytesIO(package))
                link = tarfile.TarInfo('paseo-0.12.0/AGENTS.md')
                link.type = tarfile.SYMTYPE; link.linkname = target
                stream.addfile(link)
        self.args.dry_run = True; self.args.source_archive = archive
        machine = auto.Automation(self.args)
        machine.log = self.root/'logs'; machine.log.mkdir()
        write_archive('CLAUDE.md')
        with contextlib.redirect_stdout(io.StringIO()):
            source = machine.prepare_source('0.12.0')
        self.assertTrue((source/'AGENTS.md').is_symlink())
        write_archive('../../outside')
        with self.assertRaisesRegex(ValueError, 'escapes source'):
            machine.prepare_source('0.12.0')

    def test_plugin_check_success_is_recorded_and_combined_with_fold_notification(self):
        machine = self.machine()
        self.assertEqual(self.quiet_run(machine), 0)
        check = json.loads(machine.state_file.read_text())['pluginChecks']['0.12.0']
        self.assertEqual(check['status'], 'passed')
        self.assertEqual(check['daemonVersion'], '0.12.0')
        self.assertEqual(check['foldersCount'], 3)
        notifications = [event[1] for event in self.events if event[0] == 'notify']
        self.assertEqual(len(notifications), 1)
        self.assertIn('접기 재적용 완료, Cmd+R\nrole-workflow 플러그인 점검 정상', notifications[0])

    def test_plugin_failure_is_recorded_and_notified_without_reloading(self):
        machine = self.machine(plugin_failure=True)
        self.assertEqual(self.quiet_run(machine), 1)
        self.assertEqual(machine.state['pluginChecks']['0.12.0']['status'], 'failed')
        self.assertEqual(machine.state['appliedVersion'], '0.12.0')
        self.assertTrue(any(event[0] == 'notify' and 'Paseo 0.12.0: role-workflow 플러그인 점검 실패 — workflow.folders RPC 응답 실패' in event[1] for event in self.events))
        self.assertFalse(any('reload' in event[1] for event in self.events if event[0] == 'command'))

    def test_plugin_check_once_per_version_even_when_fold_retry_is_explicit(self):
        self.assertEqual(self.quiet_run(self.machine()), 0)
        first_check = json.loads((self.root/'automation/fold-reapply/state.json').read_text())['pluginChecks']['0.12.0']
        self.events.clear()
        self.assertEqual(self.quiet_run(self.machine()), 0)
        self.assertEqual(self.events, [])
        self.args.force_version = '0.12.0'
        # Only the fake backup fixture needs a different destination for the fold retry.
        shutil.rmtree(self.root/'backups')
        self.assertEqual(self.quiet_run(self.machine()), 0)
        self.assertFalse(any(event[0] == 'plugin-probe' for event in self.events))
        self.assertEqual(json.loads((self.root/'automation/fold-reapply/state.json').read_text())['pluginChecks']['0.12.0'], first_check)

    def test_plugin_check_runs_even_if_fold_patch_conflicts(self):
        machine = self.machine(conflict=True)
        self.assertEqual(self.quiet_run(machine), 1)
        self.assertEqual(machine.state['attempts']['0.12.0']['status'], 'failed')
        self.assertEqual(machine.state['pluginChecks']['0.12.0']['status'], 'passed')
        self.assertTrue(any(event[0] == 'plugin-probe' for event in self.events))

    def test_plugin_waits_for_new_daemon_before_check_result(self):
        machine = self.machine()
        machine.probe_plugin = mock.Mock(side_effect=[
            {'status': 'waiting', 'daemonVersion': '0.11.4'},
            {'status': 'passed', 'daemonVersion': '0.12.0', 'foldersCount': 3},
        ])
        with mock.patch.object(auto.time, 'sleep') as sleep:
            self.assertEqual(self.quiet_run(machine), 0)
        self.assertEqual(machine.probe_plugin.call_count, 2)
        self.assertTrue(any(call.args == (10,) for call in sleep.call_args_list))

    def test_plugin_daemon_wait_has_ten_minute_deadline(self):
        machine = self.machine()
        clock = {'seconds': 0.0}
        def probe(version, timeout):
            clock['seconds'] += timeout
            return {'status': 'waiting', 'daemonVersion': '0.11.4'}
        machine.probe_plugin = probe
        with mock.patch.object(auto.time, 'monotonic', side_effect=lambda: clock['seconds']), mock.patch.object(auto.time, 'sleep', side_effect=lambda seconds: clock.__setitem__('seconds', clock['seconds'] + seconds)):
            self.assertEqual(self.quiet_run(machine), 1)
        self.assertEqual(clock['seconds'], 600)
        self.assertEqual(machine.state['pluginChecks']['0.12.0']['elapsedSeconds'], 600)
        self.assertIn('10분', machine.state['pluginChecks']['0.12.0']['summary'])

    def test_pending_check_recovers_without_repeating_fold_installation(self):
        machine = self.machine()
        machine.state['attempts']['0.12.0'] = {'status': 'failed', 'pluginCheckPending': True}
        machine.save()
        self.assertEqual(self.quiet_run(machine), 1)
        self.assertFalse(any(event[0] in ('build', 'prepare') for event in self.events))
        self.assertEqual(machine.state['pluginChecks']['0.12.0']['status'], 'passed')
        self.events.clear()
        self.assertEqual(self.quiet_run(self.machine()), 0)
        self.assertEqual(self.events, [])

    def test_same_version_no_action(self):
        machine = self.machine()
        machine.state['appliedVersion'] = '0.12.0'; machine.save()
        self.assertEqual(self.quiet_run(machine), 0)
        self.assertEqual(self.events, [])

    def test_conflict_no_install_notifies_and_blocks_automatic_retry(self):
        before = auto.active_bundle(self.app/'Contents/Resources/app-dist')
        self.assertEqual(self.quiet_run(self.machine(conflict=True)), 1)
        self.assertFalse(any('--apply' in event[1] for event in self.events if event[0] == 'command'))
        self.assertEqual(auto.active_bundle(self.app/'Contents/Resources/app-dist'), before)
        self.assertTrue(any(event[0] == 'notify' and '실패' in event[1] for event in self.events))
        self.events.clear()
        self.assertEqual(self.quiet_run(self.machine()), 0)
        self.assertEqual(self.events, [])
        self.args.force_version = '0.12.0'
        self.assertEqual(self.quiet_run(self.machine()), 0)
        self.assertTrue(any(event[0] == 'build' for event in self.events))

    def test_success_temporary_app_preserves_protected_content_and_verifies(self):
        before = auto.app_snapshot(self.app)
        self.assertEqual(self.quiet_run(self.machine()), 0)
        self.assertEqual(auto.app_snapshot(self.app), before)
        self.assertEqual(auto.active_bundle(self.app/'Contents/Resources/app-dist'), auto.active_bundle(self.dist))
        self.assertTrue((self.root/'backups/original/Paseo.app/Contents/Resources/app-dist/index-old.js').is_file())
        state = json.loads((self.root/'automation/fold-reapply/state.json').read_text())
        self.assertEqual(state['appliedVersion'], '0.12.0')
        self.assertEqual(state['attempts']['0.12.0']['status'], 'applied')
        calls = [event[1] for event in self.events if event[0] == 'command']
        self.assertEqual(sum('--apply' in call for call in calls), 1)
        self.assertTrue(any('diagnose-pushed-fold.py' in call[-1] for call in calls))
        self.assertTrue(any(event[0] == 'notify' and '완료, Cmd+R' in event[1] for event in self.events))
        self.assertNotIn('directory-search', '\n'.join(' '.join(call) for call in calls))

    def test_installer_failure_never_retries(self):
        self.assertEqual(self.quiet_run(self.machine(fail_install=True)), 1)
        calls = [event[1] for event in self.events if event[0] == 'command']
        self.assertEqual(sum('--apply' in call for call in calls), 1)
        self.events.clear()
        self.assertEqual(self.quiet_run(self.machine()), 0)
        self.assertEqual(self.events, [])

    def test_lock_prevents_concurrent_attempt(self):
        machine = self.machine()
        with auto.lock_file(machine.state_dir/'run.lock') as locked:
            self.assertTrue(locked)
            self.assertEqual(self.quiet_run(machine), 0)
        self.assertEqual(self.events, [])

    def test_changed_app_deferred_without_attempt(self):
        machine = self.machine()
        before = auto.app_snapshot(self.app)
        with mock.patch.object(auto, 'app_snapshot', side_effect=[before, {**before, 'asar': 'changed'}]):
            self.assertEqual(self.quiet_run(machine), 0)
        self.assertFalse(machine.state_file.exists())
        self.assertEqual(self.events, [])

    def test_dry_run_does_not_install_or_mark_version(self):
        self.args.dry_run = True
        before = auto.active_bundle(self.app/'Contents/Resources/app-dist')
        self.assertEqual(self.quiet_run(self.machine()), 0)
        self.assertEqual(auto.active_bundle(self.app/'Contents/Resources/app-dist'), before)
        self.assertFalse((self.root/'automation/fold-reapply/state.json').exists())
        self.assertFalse(any('--apply' in event[1] for event in self.events if event[0] == 'command'))

    def test_update_during_build_blocks_install(self):
        machine = self.machine()
        before = auto.app_snapshot(self.app)
        with mock.patch.object(auto, 'app_snapshot', side_effect=[before, before, {**before, 'asar': 'changed'}]):
            self.assertEqual(self.quiet_run(machine), 1)
        self.assertFalse(any('--apply' in event[1] for event in self.events if event[0] == 'command'))


if __name__ == '__main__': unittest.main()
