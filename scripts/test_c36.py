"""C36: explicit task dispatch, conservative daemon death, and rate-limited failure notices."""
import json
from pathlib import Path
import plistlib
import re
import subprocess
import unittest
from unittest import mock
import test_equipment as fixtures
from test_equipment import service_runtime, ROOT


class C36Tests(unittest.TestCase):
    setUp = fixtures.EquipmentTests.setUp
    load_config = fixtures.EquipmentTests.load_config
    execute = fixtures.EquipmentTests.execute
    calls = fixtures.EquipmentTests.calls
    snapshot = fixtures.EquipmentTests.snapshot
    service = fixtures.EquipmentTests.service

    def test_F1_every_run_py_task_maps_to_an_existing_method(self):
        tasks = {re.search(r"main\(['\"]([a-z-]+)['\"]\)", f.read_text())[1] for f in (ROOT/'modules').glob('*/run.py')}
        self.assertEqual(tasks, set(service_runtime.TASKS))
        for task, method in service_runtime.TASKS.items():
            self.assertTrue(callable(getattr(service_runtime.Service, method, None)), task)

    def test_F1_main_dispatches_each_task_without_attribute_error(self):
        for task, method in service_runtime.TASKS.items():
            service, _ = self.service()
            service.owner.setdefault('decisions', {})['modules'] = {task: {'enabled': True}}
            with mock.patch.object(service_runtime, 'Service', return_value=service), \
                 mock.patch.object(service, method) as called:
                self.assertEqual(service_runtime.main(task), 0, task)
            called.assert_called_once()

    def test_F2_status_failure_with_open_port_or_recovered_recheck_never_restarts(self):
        service, commands = self.service(stopped=True)
        service.probe = lambda host, port: True
        service.watchdog()
        self.assertFalse(any('kickstart' in c for c in commands))
        service, commands = self.service(stopped=True)
        answers = iter([False, True]); waits = []
        service.probe = lambda host, port: next(answers); service.sleep = waits.append
        service.watchdog()
        self.assertEqual(waits, [service_runtime.RECHECK_SECONDS])
        self.assertFalse(any('kickstart' in c for c in commands))

    def test_F2_restart_only_after_status_port_and_recheck_all_fail(self):
        service, commands = self.service(stopped=True); waits = []
        service.sleep = waits.append
        service.watchdog()
        self.assertEqual(waits, [service_runtime.RECHECK_SECONDS])
        self.assertEqual(sum('kickstart' in c for c in commands), 1)
        events = (self.paseo_home/'airport/logs/paseo-watchdog.jsonl').read_text()
        self.assertIn('status-port-recheck', events)

    def test_F2_incident_wrong_home_cannot_restart_the_account_daemon(self):
        # Reproduces the 2026-11-08 diagnosis: a module id passed as home must not kick the real job.
        service, _ = self.service(stopped=True)
        commands = []
        def runner(command, **kwargs):
            commands.append(list(map(str, command)))
            return subprocess.CompletedProcess(command, 1, stdout='', stderr='')
        service.runner = runner
        service.home = self.home/'paseo-watchdog'  # a wrong home, as in the incident, kept inside the sandbox
        with self.assertRaises(RuntimeError):
            service.watchdog()
        self.assertFalse(any('kickstart' in c for c in commands))
        missing, commands = self.service(stopped=True)
        missing.daemon_plist = self.home/'absent.plist'
        with self.assertRaises(RuntimeError):
            missing.watchdog()
        self.assertFalse(any('kickstart' in c for c in commands))

    def test_F2_unknown_listen_is_not_evidence_of_death(self):
        service, commands = self.service(stopped=True)
        config = json.loads((self.paseo_home/'config.json').read_text())
        config.setdefault('daemon', {})['listen'] = '/tmp/paseo.sock'
        (self.paseo_home/'config.json').write_text(json.dumps(config))
        service.watchdog()
        self.assertFalse(any('kickstart' in c for c in commands))

    def test_F3_repeated_failures_notify_once_per_hour(self):
        service, commands = self.service()
        clock = [100000]
        service.now = lambda: clock[0]
        service.owner.setdefault('decisions', {})['modules'] = {'paseo-watchdog': {'enabled': True}}
        with mock.patch.object(service_runtime, 'Service', return_value=service), \
             mock.patch.object(service, 'watchdog', side_effect=RuntimeError('fixture')):
            for _ in range(3): self.assertEqual(service_runtime.main('paseo-watchdog'), 1)
            clock[0] += service_runtime.NOTIFY_INTERVAL
            service_runtime.main('paseo-watchdog')
        notices = [c for c in commands if c[0] == '/usr/bin/osascript']
        self.assertEqual(len(notices), 2)
        self.assertEqual((self.paseo_home/'airport/logs/paseo-watchdog.jsonl').read_text().count('"failed"'), 4)

    def test_F4_launchd_path_ends_with_user_local_bin(self):
        value = fixtures.setup.stable_path('/opt/homebrew/bin/node', '/opt/homebrew/bin/python3', self.home).split(':')
        self.assertEqual(value[-1], str(self.home/'.local/bin'))
        self.assertLess(value.index('/usr/bin'), value.index(str(self.home/'.local/bin')))
        self.assertNotIn(str(self.home/'.local/bin'), fixtures.setup.stable_path('/a/node', '/b/python3').split(':'))


    def launchd(self, bootstrap_failures=0, teardown_polls=0, loaded=True):
        """A launchd stand-in: bootout finishes after some polls; bootstrap fails with 5 meanwhile."""
        state = {'loaded': loaded, 'tearing': 0, 'failures': bootstrap_failures, 'calls': []}
        def run(command, home, check=True, capture=True):
            args = list(map(str, command)); state['calls'].append(args[1])
            code = 0
            if args[1] == 'bootout':
                state['tearing'] = teardown_polls
            elif args[1] == 'print':
                if state['tearing']:
                    state['tearing'] -= 1
                    if not state['tearing']: state['loaded'] = False
                code = 0 if state['loaded'] else 113
            elif args[1] == 'bootstrap':
                if state['tearing'] or state['failures']:
                    state['failures'] = max(0, state['failures'] - 1); code = 5
                else:
                    state['loaded'] = True
            if check and code: raise RuntimeError(f'명령 실패: launchctl (종료 코드 {code})')
            return subprocess.CompletedProcess(args, code, stdout='', stderr='')
        return state, run

    def test_F5_reload_waits_for_teardown_and_retries_transient_bootstrap_errors(self):
        setup = fixtures.setup
        label = setup.PREFIX + 'fixture'; agents = self.home/'Library/LaunchAgents'; agents.mkdir(parents=True, exist_ok=True)
        (agents/(label + '.plist')).write_bytes(plistlib.dumps({'Label': label, 'Old': True}))
        state, run = self.launchd(bootstrap_failures=2, teardown_polls=2)
        with mock.patch.object(setup, 'run', side_effect=run), mock.patch.object(setup.time, 'sleep'):
            setup.install_agent(label, plistlib.dumps({'Label': label}), self.home)
        self.assertTrue(state['loaded'])
        self.assertEqual(state['calls'].count('bootstrap'), 3)

    def test_F6_unchanged_but_unloaded_job_is_bootstrapped(self):
        setup = fixtures.setup
        label = setup.PREFIX + 'fixture'; agents = self.home/'Library/LaunchAgents'; agents.mkdir(parents=True, exist_ok=True)
        content = plistlib.dumps({'Label': label}); file = agents/(label + '.plist')
        file.write_bytes(content); file.chmod(0o600)
        state, run = self.launchd(loaded=False)
        with mock.patch.object(setup, 'run', side_effect=run), mock.patch.object(setup.time, 'sleep'):
            setup.install_agent(label, content, self.home)
        self.assertTrue(state['loaded']); self.assertIn('bootstrap', state['calls']); self.assertNotIn('bootout', state['calls'])


if __name__ == '__main__':
    unittest.main()
