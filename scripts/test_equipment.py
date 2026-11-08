"""C21~C29: isolated owner homes and real fake CLI/service boundaries."""
import contextlib
import io
import copy
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import test_setup
from owner_store import save_owner
setup=test_setup.setup
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'modules'))
import service_runtime
import launcher_runtime


class EquipmentTests(unittest.TestCase):
    setUp=test_setup.SetupTests.setUp
    load_config=test_setup.SetupTests.load_config
    execute=test_setup.SetupTests.execute
    calls=test_setup.SetupTests.calls
    snapshot=test_setup.SetupTests.snapshot

    def grant(self, modules, **decisions):
        a=setup.Airport();p=copy.deepcopy(a.policy)
        p['decisions']['modules']={name:{'enabled':True,'date':'2026-01-01',**value} for name,value in modules.items()}
        p['decisions'].update(decisions)
        save_owner(a.policy_file,'policy',p,p['revision'])

    def test_C21_legacy_home_has_no_implicit_grants_and_conflicts_are_reported_without_writes(self):
        agents=self.home/'Library/LaunchAgents';agents.mkdir(parents=True)
        (agents/'fixture-daemon.plist').write_bytes(plistlib.dumps({'Label':'fixture-daemon','ProgramArguments':[str(self.cli),'start']}))
        (agents/'fixture-watch.plist').write_bytes(plistlib.dumps({'Label':'fixture-watch','WatchPaths':[str(self.app/'Contents/Info.plist')]}))
        before=self.snapshot();code,value=self.execute('install','--profile','server','--dry-run')
        self.assertEqual(code,0);self.assertEqual(self.snapshot(),before)
        modules={m['id']:m for m in value['equipment']}
        self.assertFalse(any(m['install'] for m in modules.values()))
        self.assertTrue(modules['daemon-service']['conflicts']);self.assertTrue(modules['update-watch']['conflicts'])
        self.grant({'daemon-service':{},'update-watch':{}})
        self.execute('install','--profile','server')
        self.assertFalse((agents/(setup.PREFIX+'daemon-service.plist')).exists())
        self.assertTrue(any(x['conflicts'] for x in self.execute('check')[1]['equipment']))
        (agents/'fixture-daemon.plist').unlink();(agents/'fixture-watch.plist').unlink()
        self.grant({'update-watch':{}},profile={'value':'desktop','date':'2026-01-01'})
        decision=next(m for m in setup.Airport().module_plan() if m['id']=='update-watch')
        self.assertFalse(decision['install']);self.assertFalse(decision['conflicts']);self.assertIn('daemon-service',decision['reason'])

    def test_C21_new_home_persists_recommended_grants_but_later_missing_grants_are_not_added(self):
        self.legacy.unlink()
        runtime={'node':str(self.bin/'node'),'python':sys.executable,'app':str(self.app)}
        with mock.patch.object(setup,'load_config',return_value=runtime),contextlib.redirect_stdout(io.StringIO()):
            code=setup.main(['install'])
        self.assertEqual(code,0)
        policy=setup.read_owner(self.paseo_home/'owner/policy.json','policy')
        self.assertTrue(policy['decisions']['modules']['codex-usage']['enabled'])
        policy['decisions']['modules'].pop('codex-usage');save_owner(self.paseo_home/'owner/policy.json','policy',policy,policy['revision'])
        self.assertFalse(next(m for m in setup.Airport().module_plan() if m['id']=='codex-usage')['install'])

    def test_C22_AB_templates_use_only_installed_wrapper_and_explicit_home(self):
        for variant,keep in [('A',False),('B',True)]:
            rows=setup.module_files(['daemon-service'],self.home,{**self.load_config(),'moduleVariants':{'daemon-service':variant}})
            plists=[plistlib.loads(row['content']) for row in rows if row['target'].suffix=='.plist']
            self.assertEqual(len(plists),1);self.assertEqual(plists[0]['KeepAlive'],keep)
            self.assertEqual(plists[0]['EnvironmentVariables']['PASEO_HOME'],str(self.paseo_home))
            self.assertTrue(Path(plists[0]['ProgramArguments'][0]).is_absolute())
            service,_=self.service();service.owner['decisions']['modules']={'daemon-service':{'enabled':True,'date':'2026-01-01','variant':variant}}
            with mock.patch.object(service_runtime.os,'execve') as execute, mock.patch.dict(os.environ,{'PASEO_HOST':'example.invalid:1'}):
                service.daemon_service()
            expected=['start'] if variant=='A' else ['daemon','run']
            args=execute.call_args.args
            self.assertEqual(args[0],str(self.cli));self.assertEqual(args[1][1:1+len(expected)],expected);self.assertNotIn('PASEO_HOST',args[2])

    def service(self, status_version='0.15.2', plugins=None, stopped=False):
        commands=[]
        def runner(command,**kwargs):
            args=list(map(str,command));commands.append(args)
            if args[0] == str(self.cli):
                self.assertEqual(kwargs['env']['PASEO_HOME'],str(self.paseo_home));self.assertNotIn('PASEO_HOST',kwargs['env'])
            output=''
            if args[1:3]==['daemon','status']:output=json.dumps({'pid':123,'daemonVersion':status_version})
            if args[1:3]==['plugin','ls']:output=json.dumps(plugins or [])
            return subprocess.CompletedProcess(args,1 if stopped and args[1:3]==['daemon','status'] else 0,stdout=output,stderr='')
        if not (self.paseo_home/'owner/policy.json').exists(): self.execute('install')
        if plugins:
            config=json.loads(self.config.read_text())
            for plugin in plugins: config['plugins'][plugin['id']]={'source':plugin.get('source','directory'),'enabled':True}
            setup.atomic_json(self.config,config)
        return service_runtime.Service(self.paseo_home,runner=runner,now=lambda:100000),commands

    def test_C23_version_mismatch_replaces_supervisor_only_when_idle(self):
        service,commands=self.service()
        # C33 preserves stop → kickstart only for an explicit A decision.
        service.owner['decisions'].setdefault('modules', {})['daemon-service'] = {'enabled':True,'variant':'A'}
        service.update_watch()
        self.assertTrue(any(c[1:3]==['daemon','stop'] for c in commands));self.assertTrue(any('kickstart' in c for c in commands))
        self.assertLess(next(i for i,c in enumerate(commands) if c[1:3]==['daemon','stop']),next(i for i,c in enumerate(commands) if 'kickstart' in c))
        self.assertFalse(any('pkill' in c or 'quit' in c for c in commands))
        service,commands=self.service('0.15.3');service.update_watch();self.assertFalse(any('stop' in c for c in commands))
        directory=self.paseo_home/'role-workflow';directory.mkdir(exist_ok=True)
        (directory/'state.json').write_text(json.dumps({'workflows':[{'status':'active','pending':{'stage':'sending'}}]}))
        service,commands=self.service();service.update_watch();self.assertFalse(any('stop' in c for c in commands))
        (self.app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString':'0.16.0'}))
        # C30 replaces the old range rejection: clear busy state, then upgrade across ranges.
        (directory/'state.json').write_text(json.dumps({'workflows':[]}))
        # C33 defaults to B: compatibility warnings must not reintroduce a separate stop.
        commands.clear();service.update_watch();self.assertFalse(any('stop' in c for c in commands));self.assertTrue(any('osascript' in c[0] for c in commands))

    def test_C24_watchdog_restart_and_per_plugin_three_attempt_hour_limit(self):
        service,commands=self.service(plugins=[{'id':'fixture','enabled':True,'source':'directory','status':'failed'},{'id':'built-in','enabled':True,'source':'builtin','status':'failed'}])
        with mock.patch.object(service_runtime,'find_cli',side_effect=ValueError('missing')):
            for _ in range(4):service.watchdog()
        self.assertEqual(sum(c[1:3]==['plugin','reload'] for c in commands),3)
        service.now=lambda:104000;service.watchdog();self.assertEqual(sum(c[1:3]==['plugin','reload'] for c in commands),4)
        service,commands=self.service(stopped=True);service.watchdog();self.assertTrue(any('kickstart' in c for c in commands))

    def test_C25_archive_copies_before_remove_and_preserves_auth_memory_and_recent_files(self):
        service,_=self.service();service.now=lambda:time.time();service.owner['decisions']['archiveRotate']={'days':7,'date':'2026-01-01'}
        (self.paseo_home/'airport/presets').mkdir(exist_ok=True,parents=True)
        (self.paseo_home/'airport/presets/recommended.json').write_text(json.dumps({'equipment':{'archiveRotate':{'afterDays':30}}}))
        # The runtime source finds presets relative to installation; patch only its __file__ location.
        records=[]
        for product,subdir in [('claude-home','projects'),('codex-home','sessions')]:
            folder=self.paseo_home/product/subdir;folder.mkdir(parents=True)
            old=folder/'old.jsonl';old.write_text('old');os.utime(old,(time.time()-10*86400,)*2);records.append((product,subdir,old))
            (folder/'new.jsonl').write_text('new');(folder/'memory.md').write_text('memory')
            (self.paseo_home/product/'auth.json').write_text('keep')
        with mock.patch.object(service_runtime,'__file__',str(self.paseo_home/'airport/modules/service_runtime.py')):service.archive_rotate()
        for product,subdir,old in records:
            self.assertFalse(old.exists());self.assertEqual((self.paseo_home/'archive'/product/subdir/'old.jsonl').read_text(),'old')
            self.assertTrue((self.paseo_home/product/'auth.json').exists());self.assertTrue((old.parent/'memory.md').exists())

    def test_C27_C28_claude_home_assembly_and_command_env_restore(self):
        self.execute('install')
        source=self.home/'.claude/skills';(source/'paseo').mkdir(parents=True);(source/'personal-not-selected').mkdir()
        home=self.paseo_home/'claude-home';home.mkdir();(home/'settings.json').write_text('{"old":true}');(home/'auth.json').write_text('keep')
        manual=self.home/'manual';manual.mkdir()
        self.grant({'claude-home':{},'claude-launcher':{}},claudeHome={'date':'2026-01-01','settings':{'language':'Korean'},'manuals':{'manual':str(manual)}})
        self.execute('install')
        settings=json.loads((home/'settings.json').read_text());self.assertEqual(settings['language'],'Korean');self.assertNotIn('hooks',settings)
        self.assertTrue((home/'skills/paseo').is_symlink());self.assertTrue((home/'skills/manual').is_symlink());self.assertFalse((home/'skills/personal-not-selected').exists())
        config=json.loads(self.config.read_text())['agents']['providers']['claude'];self.assertEqual(config['env']['CLAUDE_CONFIG_DIR'],str(home));self.assertEqual(len(config['command']),2)
        self.execute('uninstall');self.assertEqual((home/'settings.json').read_text(),'{"old":true}');self.assertEqual((home/'auth.json').read_text(),'keep');self.assertFalse((home/'skills/paseo').exists())
        config=json.loads(self.config.read_text())['agents']['providers']['claude'];self.assertNotIn('command',config);self.assertNotIn('CLAUDE_CONFIG_DIR',config['env'])

    def test_V2_local_claude_and_V3_missing_keychain_item_fall_back_without_token(self):
        local=self.home/'.local/bin/claude';local.parent.mkdir(parents=True);local.write_text('#!/bin/sh\nexit 0\n');local.chmod(0o700)
        self.assertEqual(launcher_runtime.find_cli('claude',bundled=[],brew_roots=[],path=''),str(local))
        self.execute('install');vault=setup.read_owner(self.paseo_home/'owner/vault.json','vault');vault['keychain']={'claude':{'service':'fixture','account':'fixture'}};save_owner(self.paseo_home/'owner/vault.json','vault',vault,vault['revision'])
        with mock.patch.object(launcher_runtime.subprocess,'run',return_value=subprocess.CompletedProcess([],44,stdout='',stderr='missing')) as keychain, mock.patch.object(launcher_runtime.os,'execve') as execute:
            launcher_runtime.launch('claude',['argument with spaces'])
        sent=execute.call_args.args[2];self.assertNotIn('CLAUDE_CODE_OAUTH_TOKEN',sent);self.assertEqual(sent['CLAUDE_CONFIG_DIR'],str(self.paseo_home/'claude-home'));self.assertIn('-w',keychain.call_args.args[0])

    def test_C26_codex_accounts_names_come_from_vault_not_directory_discovery(self):
        self.execute('install');vault=setup.read_owner(self.paseo_home/'owner/vault.json','vault');vault['codexAccounts']=['selected'];save_owner(self.paseo_home/'owner/vault.json','vault',vault,vault['revision'])
        spec=importlib.util.spec_from_file_location('accounts_fixture',ROOT/'modules/codex-accounts/codex-account.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        (self.paseo_home/'codex-accounts/not-selected').mkdir(parents=True)
        self.assertEqual(module.names(),['selected'])
        with self.assertRaises(SystemExit):module.require_name('not-selected')
