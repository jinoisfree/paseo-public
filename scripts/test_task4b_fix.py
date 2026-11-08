"""C30/C31: app upgrades stay live; owner grants apply through the next install."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import subprocess
import unittest
from unittest import mock
import test_equipment as fixtures
from test_equipment import setup, service_runtime, launcher_runtime, ROOT


class Task4bFixTests(unittest.TestCase):
    setUp = fixtures.EquipmentTests.setUp
    load_config = fixtures.EquipmentTests.load_config
    execute = fixtures.EquipmentTests.execute
    calls = fixtures.EquipmentTests.calls
    snapshot = fixtures.EquipmentTests.snapshot
    service = fixtures.EquipmentTests.service

    def future_app(self, version='0.16.0'):
        (self.app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString': version}))
        self.cli.write_text(self.cli.read_text().replace("else '0.15.3'", "else '"+version+"'"))

    def test_C30_future_app_executes_both_supervisors_and_repairs_update_and_stopped_daemon(self):
        service, commands = self.service()
        self.future_app()
        for variant, expected in [('A', ['start']), ('B', ['daemon', 'run'])]:
            service.owner['decisions']['modules'] = {'daemon-service': {'enabled': True, 'variant': variant}}
            with mock.patch.object(service_runtime.os, 'execve') as execute:
                service.daemon_service()
            self.assertEqual(execute.call_args.args[0], str(self.cli))
            self.assertEqual(execute.call_args.args[1][1:-2], expected)
        service.update_watch()
        stop = next(i for i,c in enumerate(commands) if c[1:3] == ['daemon', 'stop'])
        kick = next(i for i,c in enumerate(commands) if 'kickstart' in c)
        self.assertLess(stop, kick)
        stopped, repairs = self.service(stopped=True)
        stopped.watchdog()
        self.assertTrue(any('kickstart' in c for c in repairs))
        warnings = [c for c in commands+repairs if c[0] == '/usr/bin/osascript' and 'Paseo 0.16.0:' in c[-1]]
        self.assertEqual(len(warnings), 1)

    def test_C30_install_refresh_and_accounts_share_one_warning_per_version(self):
        self.future_app()
        notifications = []
        actual_run = setup.run
        def record(command, home, **kwargs):
            if str(command[0]) == '/usr/bin/osascript': notifications.append(list(map(str, command)))
            return actual_run(command, home, **kwargs)
        with mock.patch.object(setup, 'run', side_effect=record):
            self.assertEqual(self.execute('install')[0], 0)
            self.assertEqual(self.execute('refresh')[0], 0)
            self.assertEqual(self.execute('install')[0], 0)
        self.assertEqual(len([c for c in notifications if 'Paseo 0.16.0:' in c[-1]]), 1)
        spec = importlib.util.spec_from_file_location('future_accounts', ROOT/'modules/codex-accounts/codex-account.py')
        accounts = importlib.util.module_from_spec(spec); spec.loader.exec_module(accounts)
        def run(command, **kwargs):
            self.assertEqual(command[0], str(self.cli))
            return subprocess.CompletedProcess(command, 0, stdout='[{"provider":"codex/default","id":"fixture","status":"idle"}]' if 'ls' in command else '', stderr='')
        with mock.patch.object(accounts.subprocess, 'run', side_effect=run) as calls:
            with contextlib.redirect_stdout(io.StringIO()): accounts.reload_codex_agents()
        self.assertTrue(any(c.args[0][1:3] == ['--home', str(self.paseo_home)] and 'reload' in c.args[0] for c in calls.call_args_list))
        warnings = self.paseo_home/'airport/runtime/version-warnings.json'
        self.assertEqual(list(json.loads(warnings.read_text())), ['0.16.0'])
        self.assertEqual(warnings.stat().st_mode & 0o777, 0o600)
        with mock.patch.object(launcher_runtime.subprocess, 'run') as notify:
            self.future_app('0.17.0')
            self.assertEqual(launcher_runtime.paseo_cli(self.app), str(self.cli))
            launcher_runtime.paseo_cli(self.app)
        self.assertEqual(notify.call_count, 1)
        self.assertEqual(set(json.loads(warnings.read_text())), {'0.16.0', '0.17.0'})

    def test_C30_doctor_compatibility_is_readonly_and_nonblocking(self):
        self.future_app()
        before = self.snapshot()
        _, report = self.execute('doctor')
        self.assertEqual(before, self.snapshot())
        warning = next(c for c in report['checks'] if c['key'] == 'app.compatibility')
        self.assertFalse(warning['ok']); self.assertFalse(warning['blocking'])
        self.assertEqual(warning['severity'], 'warning')
        with mock.patch.object(setup.Airport, 'doctor', return_value={'checks': [warning]}):
            self.assertEqual(self.execute('doctor')[0], 0)
        with mock.patch.object(launcher_runtime.Path, 'mkdir', side_effect=OSError('fixture')):
            # Even a full/unwritable runtime directory cannot deadlock the upgraded server.
            self.assertEqual(launcher_runtime.paseo_cli(self.app), str(self.cli))
        self.future_app('0.18.0')
        with mock.patch.object(launcher_runtime.subprocess, 'run', side_effect=RuntimeError('fixture notification timeout')):
            self.assertEqual(launcher_runtime.paseo_cli(self.app), str(self.cli))

    def test_C31_enable_existing_home_dry_run_and_following_install(self):
        before = self.snapshot()
        code, plan = self.execute('enable', 'daemon-service', '--variant', 'B', '--dry-run')
        self.assertEqual(code, 0); self.assertEqual(self.snapshot(), before)
        self.assertTrue(plan['decision']['enabled']); self.assertEqual(plan['decision']['variant'], 'B')
        self.execute('enable', 'daemon-service', '--variant', 'B')
        policy = setup.read_owner(self.paseo_home/'owner/policy.json', 'policy')
        self.assertEqual(policy['revision'], 1)
        self.assertEqual(policy['decisions']['modules']['daemon-service']['date'], setup.today())
        self.assertFalse((self.paseo_home/'airport/install.json').exists())
        self.execute('install', '--profile', 'server')
        job = self.home/'Library/LaunchAgents'/(setup.PREFIX+'daemon-service.plist')
        self.assertTrue(plistlib.loads(job.read_bytes())['KeepAlive'])
        self.assertEqual(self.execute('check')[0], 0)

    def test_C31_enabled_conflict_is_not_installed(self):
        agents = self.home/'Library/LaunchAgents'; agents.mkdir(parents=True)
        foreign = agents/'fixture-daemon.plist'
        original = plistlib.dumps({'Label':'fixture-daemon', 'ProgramArguments':[str(self.cli),'start']})
        foreign.write_bytes(original)
        self.execute('enable', 'daemon-service')
        _, result = self.execute('install', '--profile', 'server')
        module = next(m for m in result['equipment'] if m['id'] == 'daemon-service')
        self.assertTrue(module['enabled']); self.assertFalse(module['install'])
        self.assertEqual(module['reason'], '허가됨·충돌로 미설치')
        self.assertFalse((agents/(setup.PREFIX+'daemon-service.plist')).exists())
        self.assertEqual(foreign.read_bytes(), original)

    def test_C31_disable_restores_only_its_provider_settings_and_preserves_shared_files_and_auth(self):
        home = self.paseo_home/'claude-home'; home.mkdir()
        (home/'settings.json').write_text('{"before":true}')
        (home/'auth.json').write_text('fixture-auth')
        (self.home/'.claude/skills/paseo').mkdir(parents=True)
        original = json.loads(self.config.read_text())
        original['agents']['providers']['claude'] = {'command':['original-cli'], 'env': {'CLAUDE_CONFIG_DIR':'original-home', 'OTHER':'keep'}}
        self.config.write_text(json.dumps(original))
        for name in ('claude-home','claude-launcher','codex-accounts'): self.execute('enable', name)
        self.execute('install')
        self.assertTrue((home/'skills/paseo').is_symlink())
        before = self.snapshot()
        self.execute('disable', 'claude-launcher', '--dry-run')
        self.assertEqual(before, self.snapshot())
        self.execute('disable', 'claude-launcher'); self.execute('install')
        provider = json.loads(self.config.read_text())['agents']['providers']['claude']
        self.assertEqual(provider['command'], ['original-cli'])
        self.assertEqual(provider['env']['CLAUDE_CONFIG_DIR'], str(home))
        self.assertFalse((self.paseo_home/'airport/modules/claude-launcher/launcher.py').exists())
        self.assertTrue((self.paseo_home/'airport/modules/launcher_runtime.py').exists())
        self.execute('disable', 'claude-home'); self.execute('install')
        provider = json.loads(self.config.read_text())['agents']['providers']['claude']
        self.assertEqual(provider, original['agents']['providers']['claude'])
        self.assertEqual((home/'settings.json').read_text(), '{"before":true}')
        self.assertFalse((home/'skills/paseo').exists())
        self.assertEqual((home/'auth.json').read_text(), 'fixture-auth')
        self.execute('enable', 'claude-home'); self.execute('install')
        self.execute('disable', 'claude-home'); self.execute('install')
        self.assertEqual((home/'settings.json').read_text(), '{"before":true}')
        self.assertEqual(self.execute('check')[0], 0)

    def test_C31_disable_removes_only_owned_agent_and_plugin_preserving_other_modules(self):
        for name in ('daemon-service','update-watch','paseo-watchdog','codex-usage','codex-accounts'): self.execute('enable', name)
        self.execute('install', '--profile', 'server')
        job = self.home/'Library/LaunchAgents'/(setup.PREFIX+'daemon-service.plist')
        foreign = job.parent/'unrelated.plist'; foreign.write_bytes(plistlib.dumps({'Label':'unrelated','ProgramArguments':['/bin/true']}))
        self.execute('disable','daemon-service'); self.execute('disable','codex-usage')
        self.execute('install')
        self.assertFalse(job.exists()); self.assertTrue(foreign.exists())
        for name in ('update-watch','paseo-watchdog'):
            self.assertFalse((job.parent/(setup.PREFIX+name+'.plist')).exists())
        self.assertNotIn('codex-usage', json.loads(self.config.read_text())['plugins'])
        self.assertTrue((self.paseo_home/'airport/modules/codex-accounts/codex-account.py').exists())
        self.assertTrue((self.paseo_home/'airport/modules/launcher_runtime.py').exists())
        self.assertFalse((self.paseo_home/'airport/modules/service_runtime.py').exists())
        self.assertTrue(any(c[1:2] == ['bootout'] and c[-1].endswith('daemon-service') for c in self.calls()))
        calls = self.calls()
        removed = next(i for i,c in enumerate(calls) if c[1:2] == ['bootout'] and c[-1].endswith('daemon-service'))
        for name in ('update-watch','paseo-watchdog'):
            self.assertTrue(any(i < removed and c[1:2] == ['bootout'] and c[-1].endswith(name) for i,c in enumerate(calls)))
        self.assertFalse(any(c[0] == 'paseo' and c[1:3] in (['daemon','config'], ['daemon','restart'], ['plugin','reload']) for c in calls[removed+1:]))

    def test_C31_unknown_module_and_revision_conflict_cannot_write(self):
        before = self.snapshot()
        for name in ('not-a-module', '../daemon-service'):
            with self.assertRaisesRegex(RuntimeError, '알 수 없는 설비'): self.execute('enable', name)
        self.assertEqual(self.snapshot(), before)
        stale = setup.Airport()
        self.execute('enable', 'codex-accounts')
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, 'revision 충돌'):
            stale.set_module('daemon-service', True, 'A')
        self.assertEqual(self.snapshot(), before)

    def test_C31_disable_preserves_user_command_and_foreign_usage_registration(self):
        for name in ('codex-launcher','codex-usage'): self.execute('enable',name)
        self.execute('install')
        account = json.loads(self.config.read_text())
        account['agents']['providers']['codex']['command'] = ['user-cli']
        account['plugins']['codex-usage']['path'] = '/fixture/other-plugin'
        self.config.write_text(json.dumps(account))
        self.execute('disable','codex-launcher'); self.execute('disable','codex-usage')
        self.execute('install')
        current = json.loads(self.config.read_text())
        self.assertEqual(current['agents']['providers']['codex']['command'], ['user-cli'])
        self.assertEqual(current['plugins']['codex-usage']['path'], '/fixture/other-plugin')
        self.assertNotIn('CODEX_HOME',current['agents']['providers']['codex']['env'])
        self.assertEqual(current['agents']['providers']['codex']['env']['PRIVATE_TOKEN'], 'do-not-print-fixture')
