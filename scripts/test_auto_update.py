"""Real temporary Git repositories and a fake CLI; no production daemon or launchd."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0,str(Path(__file__).resolve().parent))
spec=importlib.util.spec_from_file_location('auto_update',Path(__file__).with_name('auto-update.py'))
auto=importlib.util.module_from_spec(spec);spec.loader.exec_module(auto)

FAKE = '''import json, os, subprocess, sys
from pathlib import Path
root=Path(os.environ['AUTO_TEST_ROOT'])
events=Path(os.environ['AUTO_TEST_EVENTS'])
mode=os.environ.get('AUTO_TEST_MODE','')
command='setup' if Path(sys.argv[0]).name=='setup.py' else sys.argv[2]
with events.open('a') as out:
 out.write(json.dumps({'command':command,'args':sys.argv[1:],'version':(root/'version.txt').read_text()})+'\\n')
calls=[json.loads(line) for line in events.read_text().splitlines()]
count=sum(row['command']==command for row in calls)
if command=='setup' and mode=='install-once' and count==1: sys.exit(1)
if command=='reload' and (mode=='reload-always' or (mode in ('reload-once','rollback-keep') and count==1)):
 if mode=='rollback-keep': (root/'version.txt').write_text('user edit')
 sys.exit(1)
if command=='ls':
 if count==1 and mode=='invalid-shape-once':
  print('[null]'); sys.exit(0)
 entry={'id':'role-workflow','enabled':True,'status':'running','path':str(root/'plugin/role-workflow')}
 if count==1:
  if mode=='bad-status-once': entry['status']='error'
  if mode=='disabled-once': entry['enabled']=False
  if mode=='error-once': entry['error']='failed to load'
  if mode=='foreign-once': entry['path']=str(root/'other')
 print(json.dumps([entry]))
'''


class AutoUpdateTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.base=Path(temporary.name).resolve()
        self.origin=self.base/'origin.git'
        self.seed=self.base/'seed'
        self.root=self.base/'checkout'
        self.git(self.base,'init','--bare',self.origin)
        self.git(self.base,'init','-b','main',self.seed)
        self.git(self.seed,'config','user.name','Fixture')
        self.git(self.seed,'config','user.email','fixture@example.invalid')
        (self.seed/'scripts').mkdir();(self.seed/'scripts/setup.py').write_text(FAKE)
        (self.seed/'plugin/role-workflow').mkdir(parents=True)
        (self.seed/'plugin/role-workflow/entry').write_text('fixture')
        (self.seed/'version.txt').write_text('old')
        self.git(self.seed,'add','.');self.git(self.seed,'commit','-m','old')
        self.git(self.seed,'remote','add','origin',self.origin)
        self.git(self.seed,'push','origin','main')
        self.git(self.origin,'symbolic-ref','HEAD','refs/heads/main')
        self.git(self.base,'clone',self.origin,self.root)
        self.git(self.root,'config','user.name','Fixture')
        self.git(self.root,'config','user.email','fixture@example.invalid')
        self.previous=self.git(self.root,'rev-parse','HEAD')
        (self.seed/'version.txt').write_text('new')
        self.git(self.seed,'commit','-am','new');self.git(self.seed,'push','origin','main')
        self.target=self.git(self.seed,'rev-parse','HEAD')
        self.home=self.base/'account';(self.home/'.paseo/role-workflow').mkdir(parents=True)
        self.workflow=self.home/'.paseo/role-workflow/state.json'
        self.workflow.write_text(json.dumps({'workflows':[]}))
        self.workflow_before=self.workflow.read_bytes()
        self.write_account()
        (self.home/'.paseo/paseo.pid').write_text(json.dumps({'pid':os.getpid()}))
        self.cli=self.base/'paseo'
        self.cli.write_text('#!'+sys.executable+'\n'+FAKE);self.cli.chmod(0o755)
        self.events=self.base/'events.jsonl'
        self.config={'paseo':str(self.cli),'dataDir':str(self.base/'data'),'logsDir':str(self.base/'logs')}
        env=mock.patch.dict(os.environ,{'HOME':str(self.home),'PASEO_PUBLIC_NODE':'/bin/sh',
                                      'AUTO_TEST_ROOT':str(self.root),'AUTO_TEST_EVENTS':str(self.events),'AUTO_TEST_MODE':''})
        env.start();self.addCleanup(env.stop)
        self.notifications=[]
        patch=mock.patch.object(auto.Updater,'notify',side_effect=self.notifications.append)
        patch.start();self.addCleanup(patch.stop)
        self.notify_patch=patch
        self.addCleanup(self.assert_workflow_preserved)

    def git(self,cwd,*args):
        return subprocess.check_output(['git',*map(str,args)],cwd=cwd,stderr=subprocess.DEVNULL,text=True).strip()

    def write_account(self,foreign=False):
        (self.home/'.paseo/config.json').write_text(json.dumps({'pluginsEnabled':True,'plugins':{
            'role-workflow':{'source':'directory','path':str(self.root/('other' if foreign else 'plugin/role-workflow')),'enabled':True}}}))

    def assert_workflow_preserved(self):
        self.assertEqual(self.workflow.read_bytes(),self.workflow_before)

    def updater(self):
        return auto.Updater(self.root,self.home,self.config)

    def execute(self,updater=None):
        with contextlib.redirect_stdout(io.StringIO()):
            result=(updater or self.updater()).run()
        state_file=auto.auto_update_data(self.config)/'state.json'
        return result,json.loads(state_file.read_text()) if state_file.exists() else None

    def calls(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []

    def test_AC11_fast_forward_installs_reloads_and_checks_plugin(self):
        result,state=self.execute()
        self.assertEqual(result,0);self.assertEqual(state['result'],'updated')
        self.assertEqual(state['previousCommit'],self.previous)
        self.assertEqual(state['afterCommit'],self.target)
        self.assertEqual(self.git(self.root,'rev-parse','HEAD'),self.target)
        self.assertEqual([row['command'] for row in self.calls()],['setup','reload','ls'])
        self.assertTrue(all(row['version']=='new' for row in self.calls()))
        self.assertIn(str(self.home/'.paseo'),self.calls()[1]['args'])
        self.assertEqual(len(self.notifications),1)
        self.assertIn(self.previous[:7]+' → '+self.target[:7],self.notifications[0])
        self.assertTrue(list(Path(state['logDirectory']).glob('*-git.log')))

    def test_AC09_skip_conditions_do_not_install_or_reload(self):
        for condition in ('branch','dirty','staged','fetch-failed','up-to-date','diverged','daemon-stopped','foreign-plugin'):
            with self.subTest(condition=condition):
                # Each subcase uses the same old checkout and restores only fixture mutations.
                self.git(self.root,'checkout','main')
                self.git(self.root,'reset','--keep',self.previous)
                self.write_account()
                (self.home/'.paseo/paseo.pid').write_text(json.dumps({'pid':os.getpid()}))
                self.git(self.root,'remote','set-url','origin',self.origin)
                if condition=='branch': self.git(self.root,'checkout','-B','topic')
                if condition in ('dirty','staged'):
                    (self.root/'version.txt').write_text('local')
                    if condition=='staged': self.git(self.root,'add','version.txt')
                if condition=='fetch-failed': self.git(self.root,'remote','set-url','origin',self.base/'offline.git')
                if condition=='up-to-date': self.git(self.root,'fetch','origin','main');self.git(self.root,'merge','--ff-only','origin/main')
                if condition=='diverged':
                    (self.root/'local').write_text('local');self.git(self.root,'add','local');self.git(self.root,'commit','-m','local')
                if condition=='daemon-stopped': (self.home/'.paseo/paseo.pid').unlink()
                if condition=='foreign-plugin': self.write_account(foreign=True)
                before=self.git(self.root,'rev-parse','HEAD')
                result,state=self.execute()
                self.assertEqual(result,0)
                self.assertEqual(state['reason'],'dirty' if condition=='staged' else condition)
                self.assertEqual(self.git(self.root,'rev-parse','HEAD'),before)
                self.assertEqual(self.calls(),[])
                if condition in ('dirty','staged'):
                    self.assertEqual((self.root/'version.txt').read_text(),'local')
                    self.git(self.root,'restore','--staged','--worktree','version.txt')
                self.assertEqual(len(self.notifications),1 if condition in ('diverged','foreign-plugin') else 0)
                self.notifications.clear()

    def test_AC09_existing_dead_pid_is_skipped(self):
        (self.home/'.paseo/paseo.pid').write_text(json.dumps({'pid':99999999}))
        result,state=self.execute()
        self.assertEqual((result,state['reason']),(0,'daemon-stopped'))
        self.assertEqual(self.calls(),[])

    def test_AC09_network_timeout_after_wake_is_a_quiet_fetch_skip(self):
        updater=self.updater()
        actual=updater.command
        def command(args,**kwargs):
            if list(args)[:2]==['git','fetch']:
                raise RuntimeError('network timeout after wake')
            return actual(args,**kwargs)
        with mock.patch.object(updater,'command',side_effect=command):
            result,state=self.execute(updater)
        self.assertEqual((result,state['reason']),(0,'fetch-failed'))
        self.assertEqual(self.calls(),[]);self.assertEqual(self.notifications,[])
        self.assertEqual(self.git(self.root,'rev-parse','HEAD'),self.previous)

    def test_AC09_lock_contender_only_records_its_own_log(self):
        folder=auto.auto_update_data(self.config);folder.mkdir(parents=True)
        state=folder/'state.json';state.write_text('owner state')
        with auto.lock_file(folder/'run.lock'):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(self.updater().run(),0)
        self.assertEqual(json.loads(output.getvalue())['reason'],'locked')
        self.assertEqual(state.read_text(),'owner state')
        self.assertEqual(self.calls(),[]);self.assertEqual(self.notifications,[])

    def test_AC09_untracked_personal_files_are_preserved(self):
        (self.root/'personal.txt').write_text('keep')
        self.assertEqual(self.execute()[0],0)
        self.assertEqual((self.root/'personal.txt').read_text(),'keep')

    def test_AC10_busy_waits_three_times_then_skips_without_writing_workflow(self):
        for field in ('sending','plan','execute'):
            with self.subTest(field=field):
                w={'pending':{'stage':'sending'}} if field=='sending' else {field:{'compaction':'busy'}}
                w.update(status='active',number=17)
                (auto.auto_update_data(self.config)/'state.json').unlink(missing_ok=True)
                self.workflow.write_text(json.dumps({'workflows':[w]}));self.workflow_before=self.workflow.read_bytes()
                with mock.patch.object(auto,'sleep') as sleep:
                    result,state=self.execute()
                self.assertEqual((result,state['reason']),(0,'busy'))
                self.assertEqual(sleep.call_args_list,[mock.call(600)]*3)
                self.assertEqual(self.calls(),[]);self.assertEqual(self.notifications,[])

    def test_AC10_work_that_finishes_during_wait_is_updated(self):
        self.workflow.write_text(json.dumps({'workflows':[{'status':'active','number':17,'pending':{'stage':'sending'}}]}))
        def finish(_):
            self.workflow.write_bytes(self.workflow_before)  # Simulated daemon, not the updater.
        with mock.patch.object(auto,'sleep',side_effect=finish) as sleep:
            result,state=self.execute()
        self.assertEqual((result,state['result']),(0,'updated'))
        sleep.assert_called_once_with(600)

    def test_AC10_checkout_change_during_wait_is_not_overwritten(self):
        self.workflow.write_text(json.dumps({'workflows':[{'status':'active','number':17,'plan':{'compaction':'busy'}}]}))
        def changed(_):
            self.workflow.write_bytes(self.workflow_before)
            (self.root/'version.txt').write_text('user edit')
        with mock.patch.object(auto,'sleep',side_effect=changed):
            result,state=self.execute()
        self.assertEqual((result,state['reason']),(0,'dirty'))
        self.assertEqual((self.root/'version.txt').read_text(),'user edit')
        self.assertEqual(self.calls(),[])

    def test_AC10_malformed_workflow_state_fails_closed(self):
        self.workflow.write_text('{broken');self.workflow_before=self.workflow.read_bytes()
        result,state=self.execute()
        self.assertEqual((result,state['result']),(1,'failed'))
        self.assertEqual(self.git(self.root,'rev-parse','HEAD'),self.previous)
        self.assertEqual(self.calls(),[]);self.assertEqual(len(self.notifications),1)

    def test_V3_1_inactive_markers_do_not_block_update(self):
        for status in ('paused','error','needs_input','completed'):
            for marker in ('sending','plan','execute'):
                with self.subTest(status=status,marker=marker):
                    self.git(self.root,'reset','--keep',self.previous)
                    self.events.unlink(missing_ok=True);self.notifications.clear()
                    w={'status':status,'number':17}
                    if marker=='sending': w['pending']={'stage':'sending'}
                    else: w[marker]={'compaction':'orphaned'}
                    self.workflow.write_text(json.dumps({'workflows':[w,{'status':'active','number':42}]}))
                    self.workflow_before=self.workflow.read_bytes()
                    with mock.patch.object(auto,'sleep') as sleep:
                        result,state=self.execute()
                    self.assertEqual((result,state['result']),(0,'updated'))
                    self.assertEqual(self.git(self.root,'rev-parse','HEAD'),self.target)
                    self.assertEqual([row['command'] for row in self.calls()],['setup','reload','ls'])
                    sleep.assert_not_called()
                    self.assert_workflow_preserved()

    def test_V3_1_third_busy_skip_notifies_once_with_all_workflow_numbers(self):
        self.workflow.write_text(json.dumps({'workflows':[
            {'status':'active','number':17,'pending':{'stage':'sending'}},
            {'status':'active','number':42,'plan':{'compaction':'busy'}},
            {'status':'active','number':55,'execute':{'compaction':'busy'}},
            {'status':'paused','number':99,'pending':{'stage':'sending'}},
        ]}));self.workflow_before=self.workflow.read_bytes()
        with mock.patch.object(auto,'sleep'):
            for count in range(1,5):
                result,state=self.execute()  # A fresh process object must reload the saved streak.
                self.assertEqual((result,state['reason']),(0,'busy'))
                self.assertEqual(state.get('busyStreak'),count)
                self.assertEqual(state.get('busyWorkflows'),[17,42,55])
                self.assertEqual(len(self.notifications),1 if count>=3 else 0)
        for number in (17,42,55): self.assertIn(f'#{number}',self.notifications[0])
        self.assertNotIn('#99',self.notifications[0])
        self.assertEqual(self.calls(),[])

    def test_V3_1_non_busy_skip_resets_the_streak_and_allows_a_fresh_warning(self):
        self.workflow.write_text(json.dumps({'workflows':[{'status':'active','number':17,'pending':{'stage':'sending'}}]}))
        self.workflow_before=self.workflow.read_bytes()
        with mock.patch.object(auto,'sleep'):
            for _ in range(2): self.execute()
            self.git(self.root,'remote','set-url','origin',self.base/'offline.git')
            result,state=self.execute()
            self.assertEqual((result,state['reason']),(0,'fetch-failed'))
            self.assertEqual(state.get('busyStreak'),0)
            self.assertEqual(self.notifications,[])
            self.git(self.root,'remote','set-url','origin',self.origin)
            for count in range(1,4):
                _,state=self.execute()
                self.assertEqual(state.get('busyStreak'),count)
                self.assertEqual(len(self.notifications),1 if count==3 else 0)

    def test_V3_1_success_and_failure_reset_the_streak(self):
        for outcome in ('updated','failed'):
            with self.subTest(outcome=outcome):
                self.git(self.root,'reset','--keep',self.previous)
                folder=auto.auto_update_data(self.config);folder.mkdir(parents=True,exist_ok=True)
                (folder/'state.json').write_text(json.dumps({'result':'skipped','reason':'busy','busyStreak':2}))
                self.workflow.write_text('{broken' if outcome=='failed' else json.dumps({'workflows':[]}))
                self.workflow_before=self.workflow.read_bytes()
                result,state=self.execute()
                self.assertEqual(state['result'],outcome)
                self.assertEqual(state.get('busyStreak'),0)
                self.assertEqual(result,1 if outcome=='failed' else 0)

    def test_AC12_install_reload_or_verification_failure_rolls_back(self):
        for failure in ('install-once','reload-once','bad-status-once','disabled-once','error-once','foreign-once','invalid-shape-once'):
            with self.subTest(failure=failure):
                self.git(self.root,'reset','--keep',self.previous)
                self.events.unlink(missing_ok=True);self.notifications.clear()
                with mock.patch.dict(os.environ,{'AUTO_TEST_MODE':failure}):
                    result,state=self.execute()
                self.assertEqual(result,1);self.assertEqual(state['rollback'],'succeeded')
                self.assertEqual(state['afterCommit'],self.previous)
                self.assertEqual(self.git(self.root,'rev-parse','HEAD'),self.previous)
                self.assertEqual(self.calls()[-3:][0]['command'],'setup')
                self.assertEqual([row['command'] for row in self.calls()[-3:]],['setup','reload','ls'])
                self.assertTrue(all(row['version']=='old' for row in self.calls()[-3:]))
                self.assertEqual(len(self.notifications),1)

    def test_AC12_reset_keep_refuses_to_discard_a_user_edit(self):
        with mock.patch.dict(os.environ,{'AUTO_TEST_MODE':'rollback-keep'}):
            result,state=self.execute()
        self.assertEqual((result,state['rollback']),(1,'failed'))
        self.assertEqual((self.root/'version.txt').read_text(),'user edit')
        self.assertEqual(self.git(self.root,'rev-parse','HEAD'),self.target)
        self.assertEqual(len(self.notifications),1)
        logs=''.join(p.read_text() for p in Path(state['logDirectory']).glob('*-git.log'))
        self.assertIn('"reset", "--keep"',logs);self.assertNotIn('--hard',logs)

    def test_AC12_rollback_reload_failure_is_reported(self):
        with mock.patch.dict(os.environ,{'AUTO_TEST_MODE':'reload-always'}):
            result,state=self.execute()
        self.assertEqual((result,state['rollback']),(1,'failed'))
        self.assertEqual(state['afterCommit'],self.previous)
        self.assertEqual(len(self.notifications),1)

    def test_AC13_notification_failure_does_not_change_update_result(self):
        self.notify_patch.stop()
        actual_run=subprocess.run
        def run(command,**kwargs):
            if str(command[0])=='/usr/bin/osascript':
                return subprocess.CompletedProcess(command,1,stdout='',stderr='no GUI session')
            return actual_run(command,**kwargs)
        with mock.patch.object(auto.subprocess,'run',side_effect=run):
            result,state=self.execute()
        self.assertEqual((result,state['result']),(0,'updated'))
        self.assertIn('no GUI session',(Path(state['logDirectory'])/'events.jsonl').read_text())

    def test_AC14_check_reads_remote_without_fetch_install_logs_or_state(self):
        before={str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with contextlib.redirect_stdout(io.StringIO()) as output, mock.patch.object(auto,'ROOT',self.root), mock.patch.object(auto,'load_config',return_value=self.config):
            self.assertEqual(auto.main(['--check']),0)
        data=json.loads(output.getvalue())
        self.assertEqual(data,{'currentCommit':self.previous,'remoteCommit':self.target,'updateNeeded':True})
        self.assertEqual({str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()},before)
        self.assertFalse((self.base/'data').exists());self.assertFalse((self.base/'logs').exists())
        self.assertEqual(self.calls(),[])


if __name__=='__main__':unittest.main()
