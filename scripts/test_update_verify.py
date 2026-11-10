"""update-watch verifies the setup after an app version change; doctor reports plugin load state."""
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import unittest
from unittest import mock
import test_equipment as fixtures
from test_equipment import setup, service_runtime

SECRET = 'SECRET-BODY-must-not-leak'
RECORD = 'airport/runtime/update-verify.json'


class UpdateVerifyTests(unittest.TestCase):
    setUp = fixtures.EquipmentTests.setUp
    load_config = fixtures.EquipmentTests.load_config
    execute = fixtures.EquipmentTests.execute
    calls = fixtures.EquipmentTests.calls
    snapshot = fixtures.EquipmentTests.snapshot
    grant = fixtures.EquipmentTests.grant

    def build(self, daemon='0.15.3', clone=True, check=None, doctor=None, status=None):
        """A Service with a fake clock, fake paseo/launchctl/osascript and a fake setup.py runner."""
        if not (self.paseo_home/'owner/policy.json').exists(): self.execute('install')
        self.clock = [100000.0]
        self.daemon = daemon
        self.status = status
        self.commands, self.setup_calls, self.statuses, self.status_calls = [], [], [], []
        self.check = {'differences': []} if check is None else check
        self.doctor = {'checks': []} if doctor is None else doctor
        if clone:
            script = self.base/'clone/scripts/setup.py'
            script.parent.mkdir(parents=True, exist_ok=True); script.write_text('# fixture')
            config = json.loads(self.config.read_text())
            config.setdefault('plugins', {})['role-workflow'] = {'source': 'directory', 'enabled': True, 'path': str(self.base/'clone/plugin/role-workflow')}
            setup.atomic_json(self.config, config)
        job = self.home/'fixture-daemon-service.plist'
        job.write_bytes(plistlib.dumps({'Label': 'fixture', 'EnvironmentVariables': {'PASEO_HOME': str(self.paseo_home)}}))

        def runner(command, **kwargs):
            args = list(map(str, command)); self.commands.append(args)
            if args[0] == sys.executable:
                self.setup_calls.append(args)
                self.assertEqual(kwargs['env']['PASEO_HOME'], str(self.paseo_home)); self.assertNotIn('PASEO_HOST', kwargs['env'])
                self.assertEqual(kwargs['env']['PYTHONDONTWRITEBYTECODE'], '1'); self.assertEqual(kwargs['timeout'], 120)
                value = self.check if args[2] == 'check' else self.doctor
                if isinstance(value, BaseException): raise value
                return subprocess.CompletedProcess(args, 1 if value == 'one' else 0, stdout=value if isinstance(value, str) else json.dumps(value), stderr='')
            if args[0] == str(self.cli) and args[1:3] == ['daemon', 'status']:
                self.statuses.append(kwargs['timeout']); self.status_calls.append((self.clock[0], kwargs['timeout']))
                reply = self.status(self) if self.status else None
                if isinstance(reply, BaseException):
                    # A hung status call consumes its whole timeout on the fake clock.
                    if isinstance(reply, subprocess.TimeoutExpired): self.clock[0] += kwargs['timeout']
                    raise reply
                if reply is not None: return reply
                return subprocess.CompletedProcess(args, 0, stdout=json.dumps({'pid': 1, 'daemonVersion': self.daemon}), stderr='')
            if 'kickstart' in args: self.daemon = self.version()
            return subprocess.CompletedProcess(args, 0, stdout='', stderr='')
        def sleep(seconds): self.clock[0] += seconds
        return service_runtime.Service(self.paseo_home, runner=runner, now=lambda: self.clock[0], sleep=sleep, probe=lambda h, p: False, daemon_plist=job)

    def version(self):
        return plistlib.loads((self.app/'Contents/Info.plist').read_bytes())['CFBundleShortVersionString']

    def record(self):
        return json.loads((self.paseo_home/RECORD).read_text())

    def notices(self):
        return [c for c in self.commands if c[0] == '/usr/bin/osascript']

    def results(self):
        return [e['result'] for e in self.events_of('update-watch')]

    def events_of(self, task):
        file = self.paseo_home/'airport/logs'/f'{task}.jsonl'
        return [json.loads(r) for r in file.read_text().splitlines()] if file.exists() else []

    def commit(self):
        return json.loads((self.paseo_home/'airport/install.json').read_text()).get('activatedCommit')

    def test_AC01_AC02_AC12_first_check_passes_then_current_without_setup_calls(self):
        service = self.build(check={'differences': []}, doctor={'checks': [{'key': 'a', 'ok': True, 'blocking': True, 'instruction': SECRET}]})
        service.update_watch()
        self.assertEqual(len(self.setup_calls), 2); self.assertFalse(any('kickstart' in c for c in self.commands))
        record = self.record()
        self.assertEqual((record['ok'], record['failing'], record['appVersion'], record['activatedCommit']), (True, [], '0.15.3', self.commit()))
        self.assertEqual(self.results(), ['verified']); self.assertEqual(self.notices(), [])
        service.update_watch()
        self.assertEqual(len(self.setup_calls), 2); self.assertEqual(self.results(), ['verified', 'current'])
        self.assertNotIn(SECRET, (self.paseo_home/'airport/logs/update-watch.jsonl').read_text()+json.dumps(record))

    def test_AC03_restart_then_wait_ready_then_verify_keeps_A_order(self):
        service = self.build(daemon='0.15.2')
        service.owner['decisions'].setdefault('modules', {})['daemon-service'] = {'enabled': True, 'variant': 'A'}
        service.update_watch()
        stop = next(i for i, c in enumerate(self.commands) if c[1:3] == ['daemon', 'stop']); kick = next(i for i, c in enumerate(self.commands) if 'kickstart' in c)
        self.assertLess(stop, kick)
        self.assertEqual(self.results(), ['restarted', 'verified']); self.assertTrue(self.record()['ok'])
        self.assertEqual(len(self.setup_calls), 2); self.assertEqual(self.statuses[1:], [10])

    def test_AC04_AC06_failure_notifies_once_per_version_commit_pair(self):
        service = self.build(check={'differences': [{'key': 'config.x', 'expected': SECRET, 'actual': SECRET}]})
        service.update_watch()
        self.assertEqual((self.record()['ok'], self.record()['failing']), (False, ['config.x']))
        self.assertEqual(len(self.notices()), 1); self.assertIn('0.15.3', self.notices()[0][-1]); self.assertIn('1', self.notices()[0][-1])
        self.assertNotIn(SECRET, json.dumps(self.notices()))
        service.update_watch()
        self.assertEqual(len(self.setup_calls), 4); self.assertEqual(len(self.notices()), 1)
        self.check = {'differences': []}; service.update_watch()
        self.assertTrue(self.record()['ok']); self.assertEqual(len(self.notices()), 1)
        self.check = {'differences': [{'key': 'config.y'}]}
        (self.app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString': '0.15.4'})); self.daemon = '0.15.4'
        service.update_watch()
        self.assertEqual(len(self.notices()), 2); self.assertEqual(self.record()['appVersion'], '0.15.4')

    def test_AC05_only_blocking_doctor_failures_are_recorded(self):
        service = self.build(doctor={'checks': [{'key': 'z.block', 'ok': False, 'blocking': True}, {'key': 'a.warn', 'ok': False, 'blocking': False}, {'key': 'm.ok', 'ok': True, 'blocking': True}]})
        service.update_watch()
        self.assertEqual(self.record()['failing'], ['z.block'])

    def test_AC07_not_ready_variants_defer_without_record_or_notice(self):
        def timeout(test): return subprocess.TimeoutExpired('paseo', 10)
        def bad_json(test): return subprocess.CompletedProcess([], 0, stdout='not json', stderr='')
        def code1(test): return subprocess.CompletedProcess([], 1, stdout='', stderr='')
        def missing(test): return subprocess.CompletedProcess([], 0, stdout='{}', stderr='')
        for reply in (None, timeout, bad_json, code1, missing):
            first = [True]
            def status(test, reply=reply, first=first):
                # The initial status call sees the old version; only the wait afterwards misbehaves.
                if first[0]:
                    first[0] = False
                    return subprocess.CompletedProcess([], 0, stdout=json.dumps({'daemonVersion': '0.15.2'}), stderr='')
                return reply(test) if reply else subprocess.CompletedProcess([], 0, stdout=json.dumps({'daemonVersion': '0.15.2'}), stderr='')
            service = self.build(daemon='0.15.2', status=status)
            # Kickstart must not make it ready in this scenario.
            started = self.clock[0]
            with mock.patch.object(service, 'kickstart'):
                service.update_watch()
            self.assertEqual(self.results(), ['restarted', 'verify-deferred'])
            self.assertFalse((self.paseo_home/RECORD).exists()); self.assertEqual(self.setup_calls, [])
            self.assertEqual([n for n in self.notices() if 'Paseo 설비' in n[-1] and '점검' in n[-1]], [])
            elapsed = self.clock[0]-started
            self.assertLessEqual(elapsed, 60); self.assertGreaterEqual(elapsed, 58)
            waits = self.status_calls[1:]
            self.assertGreater(len(waits), 2); self.assertTrue(all(t <= 10 for _, t in waits))
            # Every wait call fits inside the deadline and nothing is queried at or after it.
            self.assertTrue(all(at-started < 60 and at-started+t <= 60 for at, t in waits))
            for f in (self.paseo_home/'airport/logs/update-watch.jsonl',): f.unlink()

    def test_AC07_second_recheck_ready_verifies_immediately(self):
        count = [0]
        def status(test):
            count[0] += 1
            return subprocess.CompletedProcess([], 0, stdout=json.dumps({'daemonVersion': '0.15.2' if count[0] < 3 else '0.15.3'}), stderr='')
        service = self.build(daemon='0.15.2', status=status)
        with mock.patch.object(service, 'kickstart'):
            service.update_watch()
        self.assertEqual(count[0], 3); self.assertEqual(self.results(), ['restarted', 'verified']); self.assertTrue(self.record()['ok'])

    def test_AC07_call_near_the_deadline_gets_the_remaining_time_and_none_after(self):
        seen = []
        def status(test):
            seen.append(test.clock[0])
            if len(seen) == 2: test.clock[0] += 55  # the first wait query returns only at 55s
            return subprocess.CompletedProcess([], 0, stdout=json.dumps({'daemonVersion': '0.15.2'}), stderr='')
        service = self.build(daemon='0.15.2', status=status)
        started = self.clock[0]
        with mock.patch.object(service, 'kickstart'):
            service.update_watch()
        waits = self.status_calls[1:]
        self.assertEqual([round(at-started) for at, _ in waits], [0, 57, 59])
        self.assertEqual([t for _, t in waits], [10, 3, 1]); self.assertLessEqual(self.clock[0]-started, 60)
        self.assertEqual(self.results(), ['restarted', 'verify-deferred'])

    def test_frozen_clock_still_terminates(self):
        service = self.build(daemon='0.15.2')
        service.sleep = lambda seconds: None
        with mock.patch.object(service, 'kickstart'):
            service.update_watch()
        self.assertEqual(self.results(), ['restarted', 'verify-deferred'])

    def test_AC08_clone_unavailable_notifies_once_across_hours(self):
        for path in (None, 'nowhere/plugin/role-workflow'):
            service = self.build(clone=False)
            if path:
                config = json.loads(self.config.read_text())
                config.setdefault('plugins', {})['role-workflow'] = {'source': 'directory', 'enabled': True, 'path': str(self.base/path)}; setup.atomic_json(self.config, config)
            self.commands.clear()
            service.update_watch()
            self.assertEqual((self.record()['ok'], self.record()['failing']), (False, ['clone:unavailable'])); self.assertEqual(len(self.notices()), 1)
            for _ in range(3):
                self.clock[0] += 7200; service.update_watch()
            self.assertEqual(len(self.notices()), 1); self.assertEqual(self.setup_calls, [])
            (self.paseo_home/RECORD).unlink()

    def test_AC09_unparseable_or_timed_out_setup_is_a_recorded_failure(self):
        for check, doctor, expected in [('not json', {'checks': []}, ['check:error']), ({'differences': []}, subprocess.TimeoutExpired('x', 120), ['doctor:error']),
                                        (OSError('boom'), 'garbage', ['check:error', 'doctor:error']), ([], {'checks': []}, ['check:error'])]:
            service = self.build(check=check, doctor=doctor)
            service.update_watch()
            self.assertEqual(self.record()['failing'], expected); self.assertNotIn('failed', self.results())
            self.assertEqual(len(self.notices()), 1)
            (self.paseo_home/RECORD).unlink(); (self.paseo_home/'airport/logs/update-watch.jsonl').unlink()

    def test_AC10_busy_defers_restart_but_not_read_only_verification(self):
        service = self.build(daemon='0.15.2')
        folder = self.paseo_home/'role-workflow'; folder.mkdir(exist_ok=True)
        (folder/'state.json').write_text(json.dumps({'workflows': [{'status': 'active', 'pending': {'stage': 'sending'}}]}))
        service.update_watch()
        self.assertEqual(self.results(), ['busy']); self.assertEqual(self.setup_calls, []); self.assertFalse(any('kickstart' in c for c in self.commands))
        self.daemon = '0.15.3'
        service.update_watch()
        self.assertEqual(len(self.setup_calls), 2); self.assertEqual(self.results(), ['busy', 'verified'])

    def test_AC15_record_lifetime_and_commit_change(self):
        service = self.build()
        service.update_watch(); self.assertEqual(len(self.setup_calls), 2)
        record = self.paseo_home/RECORD
        other = self.paseo_home/'airport/runtime/notifications.json'; other.write_text('{}')
        install = self.paseo_home/'airport/install.json'
        data = json.loads(install.read_text()); data['activatedCommit'] = 'f'*40; install.write_text(json.dumps(data))
        service.update_watch(); self.assertEqual(len(self.setup_calls), 4); self.assertEqual(self.record()['activatedCommit'], 'f'*40)
        self.execute('uninstall')
        self.assertFalse(record.exists()); self.assertTrue(other.exists()); self.assertTrue((self.paseo_home/'owner/policy.json').exists())

    def test_AC15_removing_update_watch_deletes_record_and_reinstall_reverifies(self):
        self.grant({'daemon-service': {}, 'update-watch': {}})
        self.execute('install', '--profile', 'server')
        service = self.build(clone=False)
        service.update_watch(); record = self.paseo_home/RECORD; self.assertTrue(record.exists())
        other = self.paseo_home/'airport/runtime/notifications.json'; other.write_text('{}')
        self.execute('disable', 'update-watch'); self.execute('install', '--profile', 'server')
        self.assertFalse(record.exists()); self.assertTrue(other.exists())
        self.execute('enable', 'update-watch'); self.execute('install', '--profile', 'server')
        service.update_watch()
        self.assertEqual(self.results().count('verified'), 2); self.assertNotIn('current', self.results()); self.assertTrue(record.exists())


class DoctorPluginTests(unittest.TestCase):
    setUp = fixtures.EquipmentTests.setUp
    load_config = fixtures.EquipmentTests.load_config
    execute = fixtures.EquipmentTests.execute
    snapshot = fixtures.EquipmentTests.snapshot

    def row(self, listing, plugins=None, running=True):
        config = json.loads(self.config.read_text())
        config['plugins'] = plugins if plugins is not None else {'a': {'source': 'directory', 'enabled': True}, 'b': {'source': 'npm', 'enabled': True}, 'off': {'source': 'directory', 'enabled': False}, 'core': {'source': 'builtin', 'enabled': True}}
        setup.atomic_json(self.config, config)
        airport = setup.Airport()
        real = airport.command
        def command(*args, **kwargs):
            if args[:2] == ('plugin', 'ls'):
                if isinstance(listing, BaseException): raise listing
                return subprocess.CompletedProcess(args, 0, stdout=listing if isinstance(listing, str) else json.dumps(listing), stderr='')
            return real(*args, **kwargs)
        before = self.snapshot()
        with mock.patch.object(setup, 'daemon_running', return_value=running), mock.patch.object(airport, 'command', side_effect=command):
            checks = airport.doctor()['checks']
        self.assertEqual(self.snapshot(), before)
        return next((c for c in checks if c['key'] == 'plugins.loaded'), None)

    def good(self, **change):
        return [{'id': 'a', 'enabled': True, 'status': 'running'}, {'id': 'b', 'enabled': True, 'status': 'running', 'path': '/elsewhere', **change}]

    def test_AC11_running_plugins_pass_and_path_is_ignored(self):
        row = self.row(self.good()); self.assertTrue(row['ok'] and row['blocking'])

    def test_AC11_each_bad_state_fails_with_only_the_id(self):
        bad = [{'status': 'failed'}, {'status': None}, {'status': 'loading'}, {'error': 'boom-detail'}, {'enabled': False}, {'enabled': None}]
        for change in bad:
            entries = self.good(); entries[1] = {k: v for k, v in {**entries[1], **change}.items() if v is not None}
            row = self.row(entries)
            self.assertFalse(row['ok'], change); self.assertTrue(row['blocking']); self.assertIn('b', row['instruction']); self.assertNotIn('boom-detail', row['instruction'])
        row = self.row([self.good()[0]]); self.assertFalse(row['ok']); self.assertIn('b', row['instruction'])

    def test_AC11_unreadable_listing_fails_and_inapplicable_cases_are_skipped(self):
        for listing in ('not json', {'a': 1}, OSError('x')):
            self.assertFalse(self.row(listing)['ok'])
        self.assertIsNone(self.row(self.good(), running=False))
        self.assertIsNone(self.row([], plugins={'off': {'source': 'directory', 'enabled': False}, 'core': {'source': 'builtin', 'enabled': True}}))


if __name__ == '__main__':
    unittest.main()
