"""Exercise account installation through command doubles, never a real daemon."""
import importlib.util
import io
import json
import os
import plistlib
import pwd
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import contextlib

sys.path.insert(0,str(Path(__file__).resolve().parent))
spec=importlib.util.spec_from_file_location('public_setup',Path(__file__).with_name('setup.py'))
setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)
original_cli_path=setup.cli_path


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name)/'account';self.home.mkdir()
        self.root=Path(self.temp.name)/'checkout';self.root.mkdir()
        self.paseo=self.root/'paseo';self.paseo.write_text('fixture')
        self.node=self.root/'node';self.node.write_text('fixture');self.node.chmod(0o755)
        (self.root/'package-lock.json').write_text('{}')
        (self.root/'launchd').mkdir()
        (self.root/'launchd/auto-update.plist.in').write_bytes((Path(__file__).resolve().parents[1]/'launchd/auto-update.plist.in').read_bytes())
        self.config=self.home/'.config/paseo-public/config.json'
        self.commands=[];self.reads=[];self.version_code=0;self.version_out='0.15.2';self.version_error='';self.launchctl_code=0;self.ls_override=None;self.fail_install=False;self.hook=None
        self.env=mock.patch.dict(os.environ,{'HOME':str(self.home),'PASEO_PUBLIC_CONFIG':str(self.config),'PASEO_PUBLIC_NODE':str(self.node)})
        self.env.start();self.addCleanup(self.env.stop)
        self.patches=[mock.patch.object(setup,'ROOT',self.root),mock.patch.object(setup.time,'sleep'),mock.patch.object(setup,'cli_path',return_value=self.paseo),
                      mock.patch.object(setup.subprocess,'check_output',return_value='v26.0.0\n'),mock.patch.object(setup,'run',side_effect=self.fake_run)]
        for patch in self.patches:patch.start();self.addCleanup(patch.stop)

    def fake_run(self,command,home,**kwargs):
        args=list(map(str,command))
        # Read-only probes are kept apart so tests can assert that nothing was mutated.
        if args[1:2]==['--version'] or args[1:3]==['plugin','ls'] or args[1:2]==['print']:
            self.reads.append(args)
            if args[1:2]==['--version']:return subprocess.CompletedProcess(args,self.version_code,stdout=self.version_out,stderr=self.version_error)
            if args[1:2]==['print']:return subprocess.CompletedProcess(args,self.launchctl_code,stdout='',stderr='no such service')
            if self.ls_override is not None:return subprocess.CompletedProcess(args,0,stdout=json.dumps(self.ls_override),stderr='')
            entry=json.loads((self.home/'.paseo/config.json').read_text()).get('plugins',{}).get('role-workflow')
            listing=[{'id':'role-workflow','enabled':True,'status':'running','path':entry['path']}] if entry else []
            return subprocess.CompletedProcess(args,0,stdout=json.dumps(listing),stderr='')
        self.commands.append(args)
        if self.hook:self.hook(args)
        if 'install' in args and 'plugin' in args:
            if self.fail_install and str(self.root/'plugin/role-workflow') in args:
                raise subprocess.CalledProcessError(1,args)
            config=json.loads((self.home/'.paseo/config.json').read_text())
            config.setdefault('plugins',{})['role-workflow']={'source':'directory','path':args[args.index('install')+1],'enabled':True}
            (self.home/'.paseo/config.json').write_text(json.dumps(config))
        if 'remove' in args:
            config=json.loads((self.home/'.paseo/config.json').read_text());config.get('plugins',{}).pop('role-workflow',None)
            (self.home/'.paseo/config.json').write_text(json.dumps(config))
        return subprocess.CompletedProcess(args,0,stdout='',stderr='')

    def ready(self,enabled=True):
        (self.home/'.paseo').mkdir(exist_ok=True)
        (self.home/'.paseo/paseo.pid').write_text('{}')
        (self.home/'.paseo/config.json').write_text(json.dumps({'pluginsEnabled':enabled}))

    def execute(self,*arguments):
        with contextlib.redirect_stdout(io.StringIO()):return setup.main(arguments)

    def test_configured_node_expands_the_account_home(self):
        from public_runtime import node_executable, data_root
        self.assertEqual(node_executable({'node':str(self.node)}),str(self.node))
        self.assertEqual(data_root({}),self.home/'Library/Application Support/paseo-public')
        with mock.patch.dict(os.environ,{'PASEO_PUBLIC_NODE':'~/tools/node'}):
            (self.home/'tools').mkdir();node=self.home/'tools/node';node.write_text('fixture');node.chmod(0o755)
            self.assertEqual(node_executable({}),str(node))

    def test_launchd_template_preserves_custom_config_and_xml_paths(self):
        config={'logsDir':str(self.home/'logs & data'),'app':str(self.home/'Applications/Paseo.app')}
        plist=setup.launch_plist(config,str(self.node),self.home)
        self.assertEqual(plist['EnvironmentVariables']['PASEO_PUBLIC_CONFIG'],str(self.config))
        self.assertEqual(plist['StandardOutPath'],str(self.home/'logs & data/auto-update/stdout.log'))
        self.assertEqual(plist['WorkingDirectory'],str(self.home))
        self.assertNotIn('__',json.dumps(plist))

    def test_fold_options_were_removed(self):
        for arguments in (('install','--with-fold-reapply'),('install','--fold-reapply-system','--dry-run')):
            with self.subTest(arguments=arguments),contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):setup.main(arguments)
        self.assertFalse((Path(__file__).resolve().parents[1]/'launchd/fold-reapply.plist.in').exists())

    def test_install_and_uninstall_retire_this_checkouts_legacy_fold_watcher(self):
        agents=self.home/'Library/LaunchAgents';agents.mkdir(parents=True)
        legacy=agents/(setup.LEGACY_FOLD_LABEL+'.plist')
        foreign=plistlib.dumps({'ProgramArguments':['python3','/other/scripts/auto-reapply-fold.py']})
        legacy.write_bytes(foreign)
        self.ready();self.assertEqual(self.execute('install'),0)
        self.assertEqual(legacy.read_bytes(),foreign)  # another checkout's watcher is left alone
        for action in ('install','uninstall'):
            with self.subTest(action=action):
                legacy.write_bytes(plistlib.dumps({'ProgramArguments':['python3',str(self.root/'scripts/auto-reapply-fold.py')]}))
                self.commands.clear();self.assertEqual(self.execute(action),0)
                self.assertFalse(legacy.exists())
                self.assertTrue(any('bootout' in command and f'gui/{os.getuid()}/{setup.LEGACY_FOLD_LABEL}' in command for command in self.commands))

    def test_dry_run_has_no_writes_or_daemon_commands(self):
        before=sorted(str(path.relative_to(self.home)) for path in self.home.rglob('*'))
        self.assertEqual(self.execute('install','--dry-run'),0)
        self.assertEqual(sorted(str(path.relative_to(self.home)) for path in self.home.rglob('*')),before)
        self.assertEqual(self.commands,[])

    def test_install_is_account_local_and_repeated_registration_is_skipped(self):
        self.ready()
        self.assertEqual(self.execute('install'),0)
        install=next(command for command in self.commands if 'install' in command)
        self.assertIn(str(self.home/'.paseo'),install)
        (self.root/'node_modules/.bin').mkdir(parents=True);(self.root/'node_modules/.bin/tsx').write_text('fixture')
        self.commands.clear();self.assertEqual(self.execute('install'),0);self.assertEqual(self.commands,[])
        self.assertEqual(json.loads(self.config.read_text())['phoneNotifications'],False)

    def test_global_switch_uses_native_configuration_reload_not_restart(self):
        self.ready(enabled=False)
        self.assertEqual(self.execute('install'),0)
        self.assertTrue(any(command[1:6]==['daemon','config','set','pluginsEnabled','true'] for command in self.commands))
        self.assertFalse(any('restart' in command or 'stop' in command for command in self.commands))

    def test_foreign_registration_is_not_replaced(self):
        self.ready()
        file=self.home/'.paseo/config.json';file.write_text(json.dumps({'pluginsEnabled':True,'plugins':{'role-workflow':{'source':'directory','path':str(self.root/'other'),'enabled':True}}}))
        before=file.read_bytes()
        with self.assertRaisesRegex(RuntimeError,'이미 등록'):self.execute('install')
        self.assertEqual(file.read_bytes(),before);self.assertEqual(self.commands,[])

    def test_uninstall_removes_registration_but_keeps_user_data(self):
        self.ready();self.execute('install')
        data=self.home/'Library/Application Support/paseo-public';data.mkdir(parents=True)
        (data/'state.json').write_text('keep')
        self.commands.clear();self.assertEqual(self.execute('uninstall'),0)
        self.assertTrue(any('remove' in command for command in self.commands))
        self.assertEqual((data/'state.json').read_text(),'keep');self.assertTrue(self.config.exists())

    def test_auto_update_calendar_and_account_paths(self):
        config={'logsDir':str(self.home/'logs & data')}
        spec=setup.launch_plist(config,str(self.node),self.home)
        self.assertEqual(spec['Label'],'io.github.jinoisfree.paseo-public.auto-update')
        self.assertEqual(spec['StartCalendarInterval'],{'Hour':4,'Minute':30})
        self.assertIs(spec['RunAtLoad'],False)
        self.assertNotIn('StartInterval',spec)
        self.assertEqual(spec['ProgramArguments'][1],str(self.root/'scripts/auto-update.py'))
        self.assertEqual(spec['EnvironmentVariables']['HOME'],str(self.home))
        self.assertEqual(spec['EnvironmentVariables']['PASEO_HOME'],str(self.home/'.paseo'))
        self.assertEqual(spec['StandardOutPath'],str(self.home/'logs & data/auto-update/stdout.log'))
        self.assertNotIn('__',json.dumps(spec))

    def test_auto_update_dry_install_and_uninstall_do_not_write_or_contact_daemon(self):
        before=sorted(str(path.relative_to(self.home)) for path in self.home.rglob('*'))
        self.assertEqual(self.execute('install','--with-auto-update','--dry-run'),0)
        self.assertEqual(self.execute('uninstall','--with-auto-update','--dry-run'),0)
        self.assertEqual(sorted(str(path.relative_to(self.home)) for path in self.home.rglob('*')),before)
        self.assertEqual(self.commands,[])

    def test_auto_update_install_is_opt_in_and_identical_plist_is_not_rewritten(self):
        self.ready();self.execute('install')
        plist=self.home/'Library/LaunchAgents'/ (setup.AUTO_UPDATE_LABEL+'.plist')
        self.assertFalse(plist.exists())
        self.execute('install','--with-auto-update')
        before=plist.stat().st_mtime_ns
        self.assertEqual(plistlib.loads(plist.read_bytes())['StartCalendarInterval'],{'Hour':4,'Minute':30})
        (self.root/'node_modules/.bin').mkdir(parents=True)
        (self.root/'node_modules/.bin/tsx').write_text('fixture')
        self.commands.clear();self.execute('install','--with-auto-update')
        self.assertEqual(plist.stat().st_mtime_ns,before)
        self.assertEqual(self.commands,[])

    def test_auto_update_only_uninstall_keeps_plugin_registration_and_data(self):
        self.ready();self.execute('install','--with-auto-update')
        account=self.home/'.paseo/config.json';before=account.read_bytes()
        workflow=self.home/'.paseo/role-workflow/state.json'
        workflow.parent.mkdir();workflow.write_text('keep')
        self.commands.clear();self.execute('uninstall','--with-auto-update')
        self.assertEqual(account.read_bytes(),before)
        self.assertEqual(workflow.read_text(),'keep')
        self.assertFalse((self.home/'Library/LaunchAgents'/(setup.AUTO_UPDATE_LABEL+'.plist')).exists())
        self.assertEqual(len(self.commands),1)
        self.assertIn('bootout',self.commands[0])

    def test_full_uninstall_also_removes_auto_update_agent(self):
        self.ready();self.execute('install','--with-auto-update')
        self.commands.clear();self.execute('uninstall')
        self.assertFalse((self.home/'Library/LaunchAgents'/(setup.AUTO_UPDATE_LABEL+'.plist')).exists())
        self.assertTrue(any('remove' in command for command in self.commands))
        self.assertTrue(any('bootout' in command for command in self.commands))

    def test_foreign_auto_update_agent_is_neither_overwritten_nor_removed(self):
        self.ready()
        plist=self.home/'Library/LaunchAgents'/(setup.AUTO_UPDATE_LABEL+'.plist')
        plist.parent.mkdir(parents=True)
        content=plistlib.dumps({'ProgramArguments':['python3','/other/scripts/auto-update.py']})
        plist.write_bytes(content)
        with self.assertRaisesRegex(RuntimeError,'다른 저장소'):
            self.execute('install','--with-auto-update')
        self.execute('uninstall','--with-auto-update')
        self.assertEqual(plist.read_bytes(),content)
        self.assertEqual(self.commands,[])

    def capture(self,*arguments):
        output=io.StringIO()
        with contextlib.redirect_stdout(output):
            try:return setup.main(arguments),output.getvalue(),None
            except RuntimeError as error:return None,output.getvalue(),str(error)

    def register(self,path,source='directory'):
        file=self.home/'.paseo/config.json'
        file.write_text(json.dumps({'pluginsEnabled':True,'plugins':{'role-workflow':{'source':source,'path':str(path),'enabled':True}}}))
        return file.read_bytes()

    def old_copy(self,git=False,name='old'):
        old=self.home/'releases'/name;(old/'plugin/role-workflow').mkdir(parents=True,exist_ok=True)
        if git:(old/'.git').mkdir(exist_ok=True)
        return old/'plugin/role-workflow'

    def test_conflict_message_has_path_kind_and_resolution_command(self):
        self.ready()
        cases={'missing-path':(self.root/'gone','directory','path 없음'),'copy-without-git':(self.old_copy(),'directory','.git 없는 사본'),
               'other-git-repo':(self.old_copy(git=True,name='repo'),'directory','다른 git 저장소'),'not-directory':(self.root/'x','npm','directory가 아님')}
        for kind,(path,source,label) in cases.items():
            with self.subTest(kind=kind):
                before=self.register(path,source)
                code,_,error=self.capture('install','--with-auto-update')
                self.assertIsNone(code)
                self.assertIn(str(path),error);self.assertIn(label,error);self.assertIn(f'source={source}',error)
                self.assertIn('./install.sh --replace-registration --with-auto-update',error)
                self.assertEqual((self.home/'.paseo/config.json').read_bytes(),before)
        self.assertEqual(self.commands,[]);self.assertEqual([c for c in self.reads if c[1]=='plugin'],[])

    def test_dry_run_reports_conflict_and_exit_status(self):
        self.ready();old=self.old_copy();before=self.register(old)
        code,text,error=self.capture('install','--dry-run')
        self.assertIsNone(code);self.assertIn('replace-registration',error)
        plan=json.loads(text)
        self.assertEqual(plan['registrationConflict'],{'source':'directory','path':str(old),'kind':'copy-without-git'})
        self.assertIs(plan['replaceRegistration'],False)
        code,text,error=self.capture('install','--dry-run','--replace-registration')
        self.assertEqual((code,error),(0,None))
        plan=json.loads(text[:text.index('DRY RUN')]);self.assertIs(plan['replaceRegistration'],True)
        self.assertEqual(plan['registrationConflict']['kind'],'copy-without-git')
        self.assertEqual(self.commands,[]);self.assertEqual(self.reads,[])
        self.assertEqual((self.home/'.paseo/config.json').read_bytes(),before)

    def test_replace_option_is_install_only(self):
        for arguments in (('uninstall','--replace-registration'),('uninstall','--replace-registration','--dry-run')):
            with self.subTest(arguments=arguments),contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):setup.main(arguments)

    def test_replacement_is_refused_without_daemon_or_when_workflows_are_busy(self):
        self.ready();old=self.old_copy();before=self.register(old)
        (self.home/'.paseo/paseo.pid').unlink()
        with self.assertRaisesRegex(RuntimeError,'Paseo를 먼저 실행'):self.execute('install','--replace-registration')
        (self.home/'.paseo/paseo.pid').write_text('{}')
        state=self.home/'.paseo/role-workflow/state.json';state.parent.mkdir()
        state.write_text(json.dumps({'workflows':[{'status':'active','number':17,'plan':{'compaction':'busy'}},
                                                   {'status':'paused','number':3,'plan':{'compaction':'busy'}}]}))
        with self.assertRaisesRegex(RuntimeError,'#17'):self.execute('install','--replace-registration')
        self.assertEqual(self.commands,[]);self.assertEqual((self.home/'.paseo/config.json').read_bytes(),before)
        self.assertFalse((self.home/'Library/Application Support/paseo-public/backups').exists())

    def test_replacement_backs_up_removes_installs_then_verifies(self):
        self.ready();old=self.old_copy();before=self.register(old)
        backups=self.home/'Library/Application Support/paseo-public/backups'
        seen=[]
        self.hook=lambda args:seen.append((args[1:3],[file.read_bytes() for file in backups.glob('registration-*.json')])) if args[1:3]==['plugin','remove'] else None
        code,text,error=self.capture('install','--replace-registration')
        self.assertEqual((code,error),(0,None))
        self.assertEqual([call[1:3] for call in self.commands if call[1]=='plugin'],[['plugin','remove'],['plugin','install']])
        self.assertEqual(seen[0],(['plugin','remove'],[before]))  # backup exists before removal
        (backup,)=backups.glob('registration-*.json');self.assertEqual(backup.stat().st_mode&0o777,0o600)
        self.assertEqual([c for c in self.commands if c[1:3]==['plugin','install']][0][3],str(self.root/'plugin/role-workflow'))
        self.assertEqual(json.loads((self.home/'.paseo/config.json').read_text())['plugins']['role-workflow']['path'],str(self.root/'plugin/role-workflow'))
        self.assertEqual([call[1:3] for call in self.reads if call[1]=='plugin'],[['plugin','ls']]*2)
        self.assertTrue(old.exists());self.assertIn(str(old),text)  # never deleted, only reported
        self.assertIn('자동 업데이트: 미등록',text.splitlines()[-1]);self.assertIn(str(self.root/'plugin/role-workflow'),text.splitlines()[-1])

    def test_failed_replacement_reinstalls_the_previous_path(self):
        for failure in ('install','verify'):
            with self.subTest(failure=failure):
                self.commands.clear();self.reads.clear()
                self.ready();old=self.old_copy();before=self.register(old)
                self.fail_install=failure=='install'
                self.ls_override=[{'id':'role-workflow','enabled':True,'status':'error','path':str(self.root/'plugin/role-workflow')}] if failure=='verify' else None
                with self.assertRaises(RuntimeError) as caught:self.execute('install','--replace-registration')
                message=str(caught.exception)
                self.assertIn('등록 전환 실패',message);self.assertIn(f'이전 등록({old})을 다시 설치',message);self.assertIn('registration-',message)
                self.assertEqual(self.commands[-1][1:4],['plugin','install',str(old)])
                self.ls_override=None
                self.assertEqual(json.loads((self.home/'.paseo/config.json').read_text())['plugins']['role-workflow']['path'],str(old))

    def test_failed_replacement_without_previous_path_says_so(self):
        self.ready();self.register(self.root/'gone');self.fail_install=True
        with self.assertRaisesRegex(RuntimeError,'복원하지 못했습니다'):self.execute('install','--replace-registration')

    def test_cli_prefers_config_then_app_bundle_then_path(self):
        app=self.home/'Paseo.app';bundled=app/'Contents/Resources/bin/paseo';bundled.parent.mkdir(parents=True);bundled.write_text('x')
        other=self.home/'bin/paseo';other.parent.mkdir();other.write_text('x')
        with mock.patch.object(setup.shutil,'which',return_value=str(other)):
            self.assertEqual(original_cli_path({'app':str(app)}),bundled)
            self.assertEqual(original_cli_path({'app':str(app),'paseo':str(other)}),other)
            bundled.unlink()
            self.assertEqual(original_cli_path({'app':str(app)}),other)
        with mock.patch.object(setup.shutil,'which',return_value=None),self.assertRaisesRegex(RuntimeError,'CLI를 찾지 못했습니다'):
            original_cli_path({'app':str(app)})

    def test_cli_version_failure_explains_link_permissions_and_dry_run_skips_it(self):
        self.ready();self.version_code=1
        with self.assertRaises(RuntimeError) as caught:self.execute('install')
        message=str(caught.exception)
        self.assertIn(str(self.paseo),message);self.assertIn('종료 코드 1',message);self.assertIn('chmod -h 755',message);self.assertIn('ls -l',message)
        self.assertEqual(self.commands,[])
        self.reads.clear();self.assertEqual(self.execute('install','--dry-run'),0);self.assertEqual(self.reads,[])
        with mock.patch.object(setup,'run',side_effect=PermissionError('denied')),self.assertRaisesRegex(RuntimeError,'denied'):
            setup.verify_cli(self.paseo,self.home)

    def test_cli_older_than_supported_paseo_stops_before_changes(self):
        self.ready();self.version_out='0.10.2\n'
        with self.assertRaises(RuntimeError) as caught:self.execute('install')
        message=str(caught.exception)
        self.assertIn('0.10.2',message);self.assertIn('0.15',message);self.assertIn('Contents/Resources/bin/paseo',message)
        self.assertEqual(self.commands,[])
        self.version_out='paseo 0.16.0';self.commands.clear()
        self.assertEqual(self.execute('install','--dry-run'),0)

    def test_post_install_verification_failure_is_reported(self):
        self.ready()
        for listing in ([],[{'id':'role-workflow','enabled':False,'status':'running','path':str(self.root/'plugin/role-workflow')}],
                        [{'id':'role-workflow','enabled':True,'status':'running','path':str(self.root/'other')}]):
            with self.subTest(listing=listing):
                self.ls_override=listing
                with self.assertRaisesRegex(RuntimeError,'등록 확인 실패'):self.execute('install')

    def test_auto_update_agent_must_be_loaded(self):
        self.ready()
        code,text,error=self.capture('install','--with-auto-update')
        self.assertEqual((code,error),(0,None));self.assertIn('자동 업데이트: 등록됨',text.splitlines()[-1])
        self.assertEqual(self.reads[-1],['/bin/launchctl','print',f'gui/{os.getuid()}/{setup.AUTO_UPDATE_LABEL}'])
        self.launchctl_code=113
        with self.assertRaisesRegex(RuntimeError,'LaunchAgent가 로드돼 있지 않습니다\\(113\\)'):self.execute('install','--with-auto-update')

    def link(self,name,target):
        place=self.home/name;place.mkdir(parents=True,exist_ok=True)
        (place/'paseo').symlink_to(target)
        return place/'paseo'

    def unreadable(self,link):
        real=os.readlink
        def readlink(path,*arguments,**keywords):
            if str(path)==str(link):raise PermissionError(13,'Permission denied')
            return real(path,*arguments,**keywords)
        return mock.patch.object(setup.os,'readlink',side_effect=readlink)

    def bundle(self):
        app=self.home/'Paseo.app';bundled=app/'Contents/Resources/bin/paseo';bundled.parent.mkdir(parents=True,exist_ok=True)
        bundled.write_text('x');return app,bundled

    def test_detected_cli_is_not_saved_and_user_value_is_kept(self):
        self.ready();self.assertEqual(self.execute('install'),0)
        self.assertNotIn('paseo',json.loads(self.config.read_text()))
        self.config.write_text(json.dumps({'paseo':'/custom/paseo','note':1}))
        self.assertEqual(self.execute('install'),0)
        saved=json.loads(self.config.read_text())
        self.assertEqual((saved['paseo'],saved['note']),('/custom/paseo',1))

    def test_links_to_the_bundle_or_unreadable_links_are_replaced_by_the_bundle(self):
        app,bundled=self.bundle();other=self.home/'custom';other.write_text('x')
        to_bundle=self.link('a',bundled);unreadable=self.link('b',other);readable=self.link('c',other)
        with mock.patch.object(setup.shutil,'which',return_value=None):
            self.assertEqual(original_cli_path({'app':str(app),'paseo':str(to_bundle)}),bundled)
            with self.unreadable(unreadable):
                self.assertEqual(original_cli_path({'app':str(app),'paseo':str(unreadable)}),bundled)
            self.assertEqual(original_cli_path({'app':str(app),'paseo':str(readable)}),readable)  # a user's own link is respected
            self.assertEqual(original_cli_path({'app':str(app),'paseo':str(other)}),other)  # so is a plain executable
        with mock.patch.object(setup.shutil,'which',return_value=str(unreadable)),self.unreadable(unreadable):
            self.assertEqual(original_cli_path({'app':str(app)}),bundled)
        with self.unreadable(unreadable):  # without a bundle there is nothing to substitute
            self.assertEqual(original_cli_path({'app':str(self.home/'none.app'),'paseo':str(unreadable)}),unreadable)

    def test_unreadable_path_link_warns_but_install_continues_and_dry_run_reports_it(self):
        self.ready();link=self.link('bin',self.paseo)
        with mock.patch.dict(os.environ,{'PATH':str(link.parent)+os.pathsep+os.environ['PATH']}),self.unreadable(link):
            errors=io.StringIO()
            with contextlib.redirect_stderr(errors):self.assertEqual(self.execute('install'),0)
            text=errors.getvalue();self.assertEqual(len(text.splitlines()),1)
            owner=pwd.getpwuid(link.lstat().st_uid).pw_name
            for part in (str(link),owner,'출력 없이 실패할 수 있습니다',f'chmod -h 755 {link}'):self.assertIn(part,text)
            code,output,error=self.capture('install','--dry-run')
            self.assertEqual((code,error),(0,None))
            self.assertIn(str(link),json.loads(output[:output.index('DRY RUN')])['pathCliWarning'])
        with mock.patch.dict(os.environ,{'PATH':str(link.parent)}):  # readable link: no warning
            self.assertIsNone(setup.path_cli_warning())
        with mock.patch.dict(os.environ,{'PATH':str(self.home/'nowhere')}):
            self.assertIsNone(setup.path_cli_warning())

    def test_summary_reflects_the_actual_auto_update_agent(self):
        self.ready()
        agent=self.home/'Library/LaunchAgents'/(setup.AUTO_UPDATE_LABEL+'.plist')
        def summary(*arguments):
            code,text,error=self.capture(*arguments);self.assertEqual((code,error),(0,None));return text.splitlines()[-1]
        self.assertIn('자동 업데이트: 미등록',summary('install'))
        self.assertIn('자동 업데이트: 등록됨',summary('install','--with-auto-update'))
        self.assertIn('자동 업데이트: 등록됨',summary('install'))  # still registered although the option was not given
        agent.write_bytes(plistlib.dumps({'ProgramArguments':['python3','/other/scripts/auto-update.py']}))
        self.assertIn('자동 업데이트: 다른 저장소에 등록됨',summary('install'))


if __name__=='__main__':unittest.main()
