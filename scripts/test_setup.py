"""Installer contracts through isolated HOME, real subprocesses and product command doubles."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parent))
from owner_store import read_owner, save_owner
spec = importlib.util.spec_from_file_location('public_setup', Path(__file__).with_name('setup.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

FAKE = '''import json, os, sys
from pathlib import Path
args=sys.argv[1:]
home=Path(os.environ['PASEO_HOME'])
file=home/'config.json'
with Path(os.environ['FIXTURE_EVENTS']).open('a') as out: out.write(json.dumps([Path(sys.argv[0]).name,*args])+'\\n')
if '--version' in args: print('v26.0.0' if Path(sys.argv[0]).name=='node' else '0.15.3'); sys.exit(0)
if Path(sys.argv[0]).name=='launchctl':
 # Remember booted-out labels so callers that wait for launchd teardown see it finish.
 state=home.parent/'launchd-unloaded.json'; unloaded=set(json.loads(state.read_text())) if state.exists() else set()
 if args[:1]==['bootout']: unloaded.add(args[-1].rsplit('/',1)[-1]); state.write_text(json.dumps(sorted(unloaded)))
 if args[:1]==['print'] and args[-1].rsplit('/',1)[-1] in unloaded: sys.exit(113)
 if args[:1]==['bootstrap']:
  import plistlib
  spec=plistlib.loads(Path(args[-1]).read_bytes())
  if any(not Path(spec[key]).parent.is_dir() for key in ('StandardOutPath','StandardErrorPath') if key in spec): sys.exit(1)
  unloaded.discard(spec.get('Label','')); state.write_text(json.dumps(sorted(unloaded)))
if args[:3]==['daemon','config','set']:
 data=json.loads(file.read_text()); data[args[3]]=json.loads(args[4]); file.write_text(json.dumps(data));sys.exit(0)
if args[:2]==['plugin','ls']:
 data=json.loads(file.read_text()); plugin_id=args[2] if len(args)>2 and not args[2].startswith('-') else 'role-workflow'; entry=data.get('plugins',{}).get(plugin_id)
 print(json.dumps([{'id':plugin_id,'enabled':entry['enabled'],'status':'running','path':entry['path']}] if entry else []));sys.exit(0)
sys.exit(0)
'''


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base/'account'; self.home.mkdir()
        self.paseo_home = self.home/'custom-paseo'; self.paseo_home.mkdir()
        self.root = self.base/'checkout'; self.root.mkdir()
        original = Path(__file__).resolve().parents[1]
        for directory in ('launchd', 'modules', 'plugin/role-workflow/shared/presets'):
            shutil.copytree(original/directory, self.root/directory)
        (self.root/'plugin/role-workflow/server').mkdir()
        shutil.copy(original/'plugin/role-workflow/server/rules-content.ts', self.root/'plugin/role-workflow/server/rules-content.ts')
        (self.root/'package-lock.json').write_text('{}')
        (self.root/'node_modules/.bin').mkdir(parents=True)
        (self.root/'node_modules/.bin/tsx').write_text('fixture')
        self.bin = self.base/'bin'; self.bin.mkdir()
        for name in ('node', 'npm', 'launchctl', 'security'):
            file=self.bin/name; file.write_text('#!'+sys.executable+'\n'+FAKE); file.chmod(0o755)
        self.app = self.home/'Applications/Paseo.app'
        self.cli = self.app/'Contents/Resources/bin/paseo'; self.cli.parent.mkdir(parents=True)
        self.cli.write_text('#!'+sys.executable+'\n'+FAKE); self.cli.chmod(0o755)
        (self.app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString':'0.15.3'}))
        self.events = self.base/'events.jsonl'
        self.legacy = self.home/'.config/paseo-public/config.json'; self.legacy.parent.mkdir(parents=True)
        self.legacy.write_text(json.dumps({'profiles': {str(self.root): {'app':str(self.app), 'node':str(self.bin/'node'), 'python':sys.executable}}, 'phoneNotifications':False}))
        self.legacy_before=self.legacy.read_bytes()
        self.config = self.paseo_home/'config.json'
        self.config.write_text(json.dumps({'agents':{'providers':{'codex':{'env':{'PRIVATE_TOKEN':'do-not-print-fixture'}}}},'plugins':{'unrelated':{'enabled':True}}}))
        (self.paseo_home/'paseo.pid').write_text(json.dumps({'pid':os.getpid()}))
        self.env = mock.patch.dict(os.environ, {'HOME':str(self.home), 'PASEO_HOME':str(self.paseo_home), 'PASEO_PUBLIC_CONFIG':str(self.legacy), 'PASEO_PUBLIC_NODE':str(self.bin/'node'), 'FIXTURE_EVENTS':str(self.events)})
        self.env.start(); self.addCleanup(self.env.stop)
        # A Paseo-launched shell exports the real staff homes; fixtures must not inherit them.
        for name in ('CLAUDE_CONFIG_DIR', 'CODEX_HOME'): os.environ.pop(name, None)
        self.root_patch=mock.patch.object(setup,'ROOT',self.root); self.root_patch.start();self.addCleanup(self.root_patch.stop)
        self.load_patch=mock.patch.object(setup,'load_config',side_effect=self.load_config);self.load_patch.start();self.addCleanup(self.load_patch.stop)
        # Only macOS service utilities are redirected. Paseo is a real fake executable subprocess.
        actual_run=setup.run
        def invoke(command,home,**kwargs):
            command=list(command)
            if str(command[0]) in ('/bin/launchctl','/usr/bin/security'):
                command[0]=self.bin/Path(command[0]).name
            if str(command[0])=='/usr/bin/osascript':
                return subprocess.CompletedProcess(command,0,stdout='',stderr='')
            return actual_run(command,home,**kwargs)
        patch=mock.patch.object(setup,'run',side_effect=invoke);patch.start();self.addCleanup(patch.stop)
        # The fake launchd already owns the fixture daemon; C37 adoption is exercised explicitly.
        for name in ('agent_pid','daemon_parent'):
            owned=mock.patch.object(setup,name,return_value=4242);owned.start();self.addCleanup(owned.stop)

    def load_config(self):
        old=json.loads(self.legacy.read_text()) if self.legacy.exists() else {}
        return {**old, **old.get('profiles',{}).get(str(self.root),{}), **read_owner(self.paseo_home/'owner/vault.json','vault').get('paths',{})}

    def execute(self,*args):
        if args and args[0]=='install' and '--profile' not in args:
            args=(*args,'--profile','desktop')
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code=setup.main(args)
        return code,json.loads(out.getvalue())

    def calls(self):
        return [json.loads(row) for row in self.events.read_text().splitlines()] if self.events.exists() else []

    def snapshot(self):
        return {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}

    def test_install_check_refresh_uninstall_and_idempotence(self):
        self.assertEqual(self.execute('install','--with-auto-update')[0],0)
        self.assertEqual(self.execute('check','--json')[0],0)
        owner=read_owner(self.paseo_home/'owner/policy.json','policy')
        before=self.config.read_bytes(); self.events.unlink()
        self.assertEqual(self.execute('install','--with-auto-update')[0],0)
        self.assertEqual(read_owner(self.paseo_home/'owner/policy.json','policy'),owner)
        self.assertFalse(any('restart' in c or 'set' in c for c in self.calls()))
        self.assertEqual(self.execute('refresh')[0],0)
        self.assertEqual(self.config.read_bytes(),before)
        self.assertEqual(self.legacy.read_bytes(),self.legacy_before)
        self.assertEqual(self.execute('uninstall')[0],0)
        self.assertEqual(self.execute('uninstall')[0],0)
        self.assertTrue((self.paseo_home/'owner/policy.json').exists())
        self.assertIn('unrelated',json.loads(self.config.read_text())['plugins'])
        self.assertFalse(any('remove' in c for c in self.calls()))

    def test_dry_runs_and_readonly_probes_do_not_write(self):
        before=self.snapshot()
        for action in ('install','refresh','uninstall','check','doctor'):
            self.assertEqual(self.execute(action,'--dry-run')[0],0)
        self.assertEqual(self.snapshot(),before)
        self.execute('check','--json'); self.execute('doctor')
        # Version probes write only the fake external command event sink outside HOME.
        self.assertEqual(self.snapshot(),before)
        self.assertFalse(any('set' in c or 'restart' in c or 'bootstrap' in c for c in self.calls()))

    def test_uninstall_with_stopped_daemon_and_provider_restore(self):
        self.execute('install')
        a=setup.Airport(); a.record['providerCommands']={'codex':'original-command'}
        generated=self.paseo_home/'airport/modules/codex/launcher.py'; generated.parent.mkdir(parents=True);generated.write_text('fixture')
        a.record['generatedFiles']=[str(generated)];setup.atomic_json(a.record_file,a.record)
        data=json.loads(self.config.read_text());data['agents']['providers']['codex']['command']=str(generated);setup.atomic_json(self.config,data)
        (self.paseo_home/'paseo.pid').unlink();self.events.unlink()
        self.assertEqual(self.execute('uninstall')[0],0)
        self.assertEqual(json.loads(self.config.read_text())['agents']['providers']['codex']['command'],'original-command')
        self.assertFalse(generated.exists());self.assertFalse(any('restart' in c or 'set' in c for c in self.calls()))
        self.assertTrue((self.paseo_home/'owner/vault.json').exists())

    def test_revision_conflict_preserves_newer_policy(self):
        self.execute('install');a=setup.Airport();old=copy.deepcopy(a.policy)
        newer=copy.deepcopy(old);newer['notifications']['phoneNotifications']=True
        save_owner(a.policy_file,'policy',newer,old['revision'])
        with self.assertRaisesRegex(RuntimeError,'revision 충돌'):
            save_owner(a.policy_file,'policy',old,old['revision'])
        self.assertTrue(read_owner(a.policy_file,'policy')['notifications']['phoneNotifications'])
        self.assertEqual(a.policy_file.stat().st_mode & 0o777,0o600)

    def test_refresh_does_not_enable_or_reconcile_and_logs_skip(self):
        self.execute('install');data=json.loads(self.config.read_text());data['plugins']['role-workflow']['enabled']=False
        data['daemon']['relay']['enabled']=False;setup.atomic_json(self.config,data)
        a=setup.Airport();policy=read_owner(a.policy_file,'policy');policy['decisions']['core']={'date':'2026-01-01','value':{'daemon':{'relay':{'enabled':True}}}};save_owner(a.policy_file,'policy',policy,policy['revision'])
        before=self.config.read_bytes();owner=a.policy_file.read_bytes();self.events.unlink()
        self.assertEqual(self.execute('refresh')[0],0)
        self.assertEqual(self.config.read_bytes(),before);self.assertEqual(a.policy_file.read_bytes(),owner)
        self.assertFalse(any('reload' in c or 'set' in c for c in self.calls()))
        self.assertIn('skipped',(self.paseo_home/'airport/logs/refresh.jsonl').read_text())

    def test_secret_redaction_and_stable_launchd_path(self):
        self.execute('install','--with-auto-update')
        with mock.patch.dict(os.environ,{'PATH':'/temporary/agent/bin:/usr/bin'}):
            a=setup.Airport();generated=setup.launch_plist(a.config,str(self.bin/'node'),self.home)
            self.assertNotIn('/temporary',generated['EnvironmentVariables']['PATH'])
            self.assertEqual(generated['EnvironmentVariables']['PASEO_HOME'],str(self.paseo_home))
        code,result=self.execute('check','--json');self.assertEqual(code,0)
        self.assertNotIn('do-not-print-fixture',json.dumps(result))
        self.assertEqual(json.loads(self.config.read_text())['agents']['providers']['codex']['env']['PRIVATE_TOKEN'],'do-not-print-fixture')
        rows=setup.differences({'env':{'TOKEN':'private-a'}},{'env':{'TOKEN':'private-b'}},'지시서')
        self.assertNotIn('private-',json.dumps(rows))
        file=self.home/'Library/LaunchAgents'/(setup.AUTO_UPDATE_LABEL+'.plist')
        value=plistlib.loads(file.read_bytes());value['KeepAlive']=True;file.write_bytes(plistlib.dumps(value))
        self.assertEqual(self.execute('check')[0],1)

    def test_modules_from_manifest_and_uninstall_generated_only(self):
        self.execute('install');a=setup.Airport();p=copy.deepcopy(a.policy)
        p['decisions']['modules']={'claude-launcher':{'enabled':True,'date':'2026-01-01'}}
        save_owner(a.policy_file,'policy',p,p['revision']);self.execute('install')
        launcher=self.paseo_home/'airport/modules/claude-launcher/launcher.py'
        self.assertTrue(launcher.is_file());self.assertEqual(self.execute('check')[0],0)
        launcher.chmod(0o600);self.assertEqual(self.execute('check')[0],1)
        self.execute('refresh');self.assertEqual(self.execute('check')[0],0)
        keep=self.paseo_home/'claude-home/auth.json';keep.parent.mkdir();keep.write_text('keep')
        self.execute('uninstall');self.assertFalse(launcher.exists());self.assertEqual(keep.read_text(),'keep')

    def test_profile_respects_policy_and_preserves_top_level_siblings(self):
        self.execute('install','--profile','desktop');self.execute('install','--profile','server')
        a=setup.Airport();self.assertEqual(a.profile(),'desktop')
        desktop=json.loads(setup.desktop_file(self.home).read_text())
        self.assertTrue(desktop['settings']['daemon']['manageBuiltInDaemon'])
        self.assertIn('providers',json.loads(self.config.read_text())['agents'])
        self.assertEqual(json.loads(self.legacy.read_text()),json.loads(self.legacy_before))

    def test_busy_registration_is_refused_and_backup_precedes_owner_creation(self):
        folder=self.paseo_home/'role-workflow';folder.mkdir();(folder/'state.json').write_text(json.dumps({'workflows':[{'status':'active','number':7,'pending':{'stage':'sending'}}]}))
        before=self.snapshot()
        with self.assertRaisesRegex(RuntimeError,'진행 중'):self.execute('install')
        self.assertEqual(self.snapshot(),before)
        (folder/'state.json').write_text('{"workflows":[]}');self.execute('install')
        backups=list((self.home/'Library/Application Support/paseo-public/backups').glob('install-*'))
        self.assertEqual(len(backups),1);self.assertTrue((backups[0]/'config.json').exists());self.assertFalse((backups[0]/'owner').exists())

    def test_purge_owner_requires_explicit_option_and_backup(self):
        self.execute('install');before=len(list((self.home/'Library/Application Support/paseo-public/backups').iterdir()))
        self.execute('uninstall','--purge-owner');self.assertFalse((self.paseo_home/'owner').exists())
        backups=list((self.home/'Library/Application Support/paseo-public/backups').iterdir());self.assertEqual(len(backups),before+1)
        self.assertTrue(any((p/'owner/policy.json').exists() for p in backups))

    def test_generated_cleanup_preserves_current_and_live_references(self):
        folder=self.paseo_home/'role-workflow';(folder/'rules').mkdir(parents=True);(folder/'guides').mkdir()
        current='98db81136f1d'
        (self.root/'plugin/role-workflow/server/rules-content.ts').write_text('export const RULES_VERSION = "'+current+'";')
        for name in (current,'old-live','old-dead'):(folder/'rules'/name).mkdir()
        guide=folder/'guides/live.txt';guide.write_text('fixture');dead=folder/'guides/dead.txt';dead.write_text('fixture')
        (folder/'state.json').write_text(json.dumps({'workflows':[{'status':'active','rules':str(folder/'rules/old-live')}]}))
        agents=self.paseo_home/'agents';agents.mkdir();(agents/'a.json').write_text(json.dumps({'prompt':str(guide)}))
        rows=setup.generated_cleanup(self.home)
        self.assertEqual(set(rows),{folder/'rules/old-dead',dead})
        (agents/'a.json').write_text('broken')
        self.assertEqual(setup.generated_cleanup(self.home),[])

    def test_doctor_security_only_checks_item_presence_and_never_value(self):
        self.execute('install');a=setup.Airport();vault=copy.deepcopy(a.vault)
        vault['keychain']={'claude':{'service':'fixture-service','account':'fixture-account'}}
        save_owner(a.vault_file,'vault',vault,vault['revision']);self.events.unlink()
        self.execute('doctor')
        security=[c for c in self.calls() if c[0]=='security'];self.assertEqual(len(security),1);self.assertNotIn('-w',security[0])
        self.assertNotIn('-g',security[0])

    def test_foreign_registration_requires_explicit_flag_and_never_remove(self):
        data=json.loads(self.config.read_text());data['plugins']['role-workflow']={'source':'directory','path':'/fixture/foreign','enabled':True};setup.atomic_json(self.config,data)
        before=self.snapshot()
        with self.assertRaisesRegex(RuntimeError,'이미 등록'):self.execute('install')
        self.assertEqual(self.snapshot(),before)
        self.execute('install','--replace-registration')
        self.assertFalse(any('remove' in c or 'plugin' in c and 'install' in c for c in self.calls()))
        self.assertTrue(any('plugins' in c and 'set' in c for c in self.calls()))

    def test_invalid_policy_refresh_logs_failure_without_repair(self):
        self.execute('install');file=self.paseo_home/'owner/policy.json';file.write_text('{broken')
        with self.assertRaisesRegex(RuntimeError,'사장 칸 오류'):self.execute('refresh')
        self.assertEqual(file.read_text(),'{broken')
        self.assertIn('failed',(self.paseo_home/'airport/logs/refresh.jsonl').read_text())

    def test_launchagent_template_is_rendered_checked_and_refreshed_from_manifest(self):
        label='io.github.jinoisfree.paseo-public.fixture'
        folder=self.root/'modules/fixture';folder.mkdir()
        template=plistlib.dumps({'Label':label,'EnvironmentVariables':{'PATH':'__PATH__','PASEO_HOME':'__PASEO_HOME__'},'ProgramArguments':['__PYTHON__','__INSTALL_ROOT__/fixture.py']})
        (folder/'job.plist.in').write_bytes(template)
        (folder/'module.json').write_text(json.dumps({'id':'fixture','description':'fixture','requires':[], 'installationImpact':[], 'installs':[{'source':'modules/fixture/job.plist.in','target':'$LAUNCH_AGENTS/'+label+'.plist'}], 'vaultKeys':[], 'policyKeys':[]}))
        self.execute('install');a=setup.Airport();p=copy.deepcopy(a.policy)
        p['decisions']['modules']={'fixture':{'enabled':True,'date':'2026-01-01'}};save_owner(a.policy_file,'policy',p,p['revision'])
        self.execute('install');file=self.home/'Library/LaunchAgents'/(label+'.plist')
        self.assertTrue(file.is_file());self.assertEqual(self.execute('check')[0],0)
        self.assertTrue(any('bootstrap' in c and str(file) in c for c in self.calls()))
        file.write_text('broken');self.assertEqual(self.execute('check')[0],1)
        self.execute('refresh');self.assertEqual(self.execute('check')[0],0)
        self.execute('uninstall');self.assertFalse(file.exists())

    def test_foreign_updater_is_preserved_before_any_install_write(self):
        file=self.home/'Library/LaunchAgents'/(setup.AUTO_UPDATE_LABEL+'.plist');file.parent.mkdir(parents=True)
        file.write_bytes(plistlib.dumps({'ProgramArguments':['python','/other/scripts/auto-update.py']}))
        before=self.snapshot()
        with self.assertRaisesRegex(RuntimeError,'다른 저장소'):self.execute('install','--with-auto-update')
        self.assertEqual(self.snapshot(),before)

    def test_version_reads_real_node_and_product_formats(self):
        # Real Node prints "v26.10.0"; a leading word boundary rejected it on the first live install.
        original=setup.run
        try:
            for output,expected in [('v26.10.0\n','26.10.0'),('0.15.3\n','0.15.3'),('2.1.287 (Claude Code)\n','2.1.287'),('codex-cli 0.163.0\n','0.163.0'),('v1.2.3.4\n',None)]:
                setup.run=lambda command,home,check=True,capture=True,output=output:subprocess.CompletedProcess(command,0,output,'')
                self.assertEqual(setup.version(['node','--version'],self.home),expected,output)
        finally: setup.run=original

    def test_unsupported_node_stops_before_owner_or_backup_write(self):
        # C30: app versions outside 0.15.x warn and proceed; Node's minimum remains mandatory.
        for executable,version in [(self.bin/'node','v20.0.0')]:
            original=executable.read_text();executable.write_text('#!'+sys.executable+'\nprint("'+version+'")\n')
            before=self.snapshot()
            with self.assertRaisesRegex(RuntimeError,'22 이상'):self.execute('install')
            self.assertEqual(self.snapshot(),before)
            executable.write_text(original)

    def test_install_command_failure_retains_backup_and_owner(self):
        original=setup.run
        def fail(command,home,**kwargs):
            if 'set' in command: raise RuntimeError('fixture config failure')
            return original(command,home,**kwargs)
        before=self.config.read_bytes()
        with mock.patch.object(setup,'run',side_effect=fail):
            with self.assertRaisesRegex(RuntimeError,'fixture config failure'):self.execute('install')
        self.assertEqual(self.config.read_bytes(),before)
        self.assertTrue((self.paseo_home/'owner/policy.json').exists())
        backups=list((self.home/'Library/Application Support/paseo-public/backups').glob('install-*'))
        self.assertEqual((backups[0]/'config.json').read_bytes(),before)

    def test_legacy_auto_update_only_uninstall_preserves_registration(self):
        self.execute('install','--with-auto-update');before=self.config.read_bytes()
        self.execute('uninstall','--with-auto-update')
        self.assertEqual(self.config.read_bytes(),before)
        self.assertFalse((self.home/'Library/LaunchAgents'/(setup.AUTO_UPDATE_LABEL+'.plist')).exists())
        self.assertTrue((self.paseo_home/'owner/policy.json').exists())

    def test_C20_old_updater_install_refuses_every_legacy_trace_without_writing(self):
        source=Path(__file__).with_name('setup.py')
        for trace in ('registration','state','legacy','agent'):
            with self.subTest(trace=trace),tempfile.TemporaryDirectory() as directory:
                home=Path(directory);ph=home/'paseo';ph.mkdir()
                if trace=='registration': (ph/'config.json').write_text(json.dumps({'plugins':{'role-workflow':{'enabled':True}}}))
                if trace=='state':
                    (ph/'role-workflow').mkdir();(ph/'role-workflow/state.json').write_text('{}')
                if trace=='legacy':
                    file=home/'.config/paseo-public/config.json';file.parent.mkdir(parents=True);file.write_text('{}')
                if trace=='agent':
                    file=home/'Library/LaunchAgents/io.github.jinoisfree.paseo-public.fixture.plist';file.parent.mkdir(parents=True);file.write_bytes(plistlib.dumps({}))
                before={str(p):(p.read_bytes(),p.stat().st_mtime_ns,p.stat().st_ino) for p in home.rglob('*') if p.is_file()}
                env={**os.environ,'HOME':str(home),'PASEO_HOME':str(ph),'PASEO_PUBLIC_CONFIG':str(home/'.config/paseo-public/config.json')}
                result=subprocess.run([sys.executable,'-B',str(source),'install'],env=env,capture_output=True,text=True)
                self.assertEqual(result.returncode,2,result.stderr);self.assertIn('--profile server|desktop',result.stdout)
                self.assertEqual({str(p):(p.read_bytes(),p.stat().st_mtime_ns,p.stat().st_ino) for p in home.rglob('*') if p.is_file()},before)
                self.assertEqual(self.calls(),[])  # Includes fake npm: no dependency install or CLI probe.
                self.assertFalse((ph/'owner').exists())
                self.assertFalse((ph/'airport').exists())

    def test_C20_only_new_home_defaults_to_desktop(self):
        a=setup.Airport();self.legacy.unlink();self.config.write_text('{}')
        self.assertEqual(a.profile(installing=True),'desktop')
        self.assertEqual(a.profile('server',installing=True),'server')

    def test_same_path_new_commit_install_activates_once_for_policy_migration(self):
        actual_version=setup.version;head=['a'*40]
        def version(command,home,**kwargs):
            return head[0] if command[0]=='git' else actual_version(command,home,**kwargs)
        with mock.patch.object(setup,'version',side_effect=version):
            self.execute('install');self.events.unlink()
            head[0]='b'*40
            self.assertEqual(self.execute('check')[0],1)
            self.execute('install')
            self.assertEqual(sum(c[1:3]==['plugin','reload'] for c in self.calls()),1)
            self.assertEqual(self.execute('check')[0],0)
            self.events.unlink();self.execute('install')
            self.assertFalse(any(c[1:3]==['plugin','reload'] for c in self.calls()))


    def test_c37_dry_run_reports_every_install_refusal_without_writing(self):
        (self.paseo_home/'paseo.pid').unlink()
        agent=self.home/'Library/LaunchAgents'/(setup.AUTO_UPDATE_LABEL+'.plist');agent.parent.mkdir(parents=True,exist_ok=True)
        agent.write_bytes(plistlib.dumps({'Label':setup.AUTO_UPDATE_LABEL,'ProgramArguments':['python3','/other/scripts/auto-update.py']}))
        before=self.snapshot()
        code,result=self.execute('install','--with-auto-update','--dry-run')
        self.assertEqual(code,2)
        self.assertEqual({b['key'] for b in result['blockers']},{'daemon','autoUpdate'})
        self.assertEqual(self.snapshot(),before)
        with self.assertRaisesRegex(RuntimeError,'Paseo를 먼저 실행'):
            self.execute('install','--with-auto-update')

    def test_c37_replace_registration_takes_over_a_foreign_auto_update_and_keeps_it_in_the_backup(self):
        agent=self.home/'Library/LaunchAgents'/(setup.AUTO_UPDATE_LABEL+'.plist');agent.parent.mkdir(parents=True,exist_ok=True)
        foreign=plistlib.dumps({'Label':setup.AUTO_UPDATE_LABEL,'ProgramArguments':['python3','/other/scripts/auto-update.py']})
        agent.write_bytes(foreign)
        with self.assertRaisesRegex(RuntimeError,'--replace-registration'):
            self.execute('install','--with-auto-update')
        self.assertEqual(agent.read_bytes(),foreign)
        code,result=self.execute('install','--with-auto-update','--replace-registration')
        self.assertEqual(code,0,result)
        self.assertEqual(setup.auto_update_agent_state(self.home,self.root),'installed')
        self.assertEqual((Path(result['backup'])/'LaunchAgents'/agent.name).read_bytes(),foreign)

    def test_c37_continuing_owner_is_told_which_equipment_is_not_granted(self):
        code,result=self.execute('install')
        self.assertEqual(code,0)
        self.assertTrue(any('자동 허가하지 않았습니다' in n and 'codex-launcher' in n for n in result['notices']))
        grants=next(c for c in self.execute('doctor','--json')[1]['checks'] if c['key']=='equipment.grants')
        self.assertFalse(grants['ok']);self.assertFalse(grants['blocking'])

    def test_c37_install_creates_the_codex_home_it_points_the_provider_at(self):
        self.execute('enable','codex-launcher')
        code,result=self.execute('install')
        self.assertEqual(code,0,result)
        codex_home=Path(json.loads(self.config.read_text())['agents']['providers']['codex']['env']['CODEX_HOME'])
        self.assertTrue(codex_home.is_dir());self.assertEqual(codex_home.stat().st_mode&0o777,0o700)

    def test_c37_variant_b_adopts_a_daemon_started_outside_launchd(self):
        a=setup.Airport();a.module_config=lambda:{'moduleVariants':{'daemon-service':'B'}}
        samples=iter([None,None,41]);owned={'parent':7}
        def stop(*args,**kwargs): owned['parent']=41
        with mock.patch.object(setup,'agent_pid',side_effect=lambda *_:next(samples,41)), \
             mock.patch.object(setup,'daemon_parent',side_effect=lambda *_:owned['parent']), \
             mock.patch.object(setup,'daemon_running',return_value=True), \
             mock.patch.object(setup.time,'sleep'), mock.patch.object(a,'command',side_effect=stop) as command:
            a.adopt_daemon(['daemon-service'])
        command.assert_called_once_with('daemon','stop')
        with mock.patch.object(setup,'agent_pid',return_value=41), mock.patch.object(setup,'daemon_parent',return_value=41), \
             mock.patch.object(setup,'daemon_running',return_value=True), mock.patch.object(a,'command') as command:
            a.adopt_daemon(['daemon-service'])
        command.assert_not_called()

if __name__=='__main__':
    unittest.main()
