"""C32: acceptance safety boundaries, real timeout cleanup, token-free launch environment."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
spec=importlib.util.spec_from_file_location('airport_acceptance',Path(__file__).parent/'acceptance/run.py')
acceptance=importlib.util.module_from_spec(spec);spec.loader.exec_module(acceptance)


class AcceptanceTests(unittest.TestCase):
    def test_operating_home_and_port_and_symlink_alias_are_rejected(self):
        for path,port in [(acceptance.REAL_HOME,6799),(acceptance.REAL_HOME/'.paseo',6799),(acceptance.REAL_HOME/'.paseo/test',6799),(Path('/tmp/fixture'),6767)]:
            with self.assertRaises(RuntimeError):acceptance.require_scope(path,port)
        with tempfile.TemporaryDirectory() as temp:
            alias=Path(temp)/'alias';alias.symlink_to(acceptance.REAL_HOME/'.paseo')
            with self.assertRaises(RuntimeError):acceptance.require_scope(alias,6799)
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp)/'not-created'
            for port in (6764,65534):
                with self.assertRaises(RuntimeError):acceptance.Acceptance(out,Path('/missing.app'),port)
                self.assertFalse(out.exists())
        for folder in [acceptance.REAL_HOME/'Library/LaunchAgents',acceptance.REAL_HOME/'Library/Application Support/Paseo']:
            with self.assertRaises(RuntimeError):acceptance.Acceptance(folder,Path('/Applications/Paseo.app'),6799)

    def test_isolated_environment_never_inherits_auth_or_daemon_overrides(self):
        with mock.patch.dict(os.environ,{'CLAUDE_CODE_OAUTH_TOKEN':'fixture','ANTHROPIC_API_KEY':'fixture','OPENAI_API_KEY':'fixture','CODEX_HOME':'/other','PASEO_HOST':'127.0.0.1:6767'}):
            env=acceptance.clean_env(Path('/tmp/fixture-home'),Path('/tmp/fixture-home/.paseo'),6799)
        for key in ['CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_HOME','PASEO_HOST']:
            self.assertNotIn(key,env)
        self.assertEqual(env['PASEO_HOME'],'/tmp/fixture-home/.paseo')
        self.assertEqual(env['PASEO_LISTEN'],'127.0.0.1:6799')
        self.assertEqual(env['PASEO_RELAY_ENABLED'],'false')

    def test_service_adapter_refuses_operating_or_arbitrary_launchd_labels(self):
        a=object.__new__(acceptance.Acceptance)
        with self.assertRaisesRegex(RuntimeError,'라벨'):a.service({},acceptance.PREFIX+'daemon-service',[])
        with self.assertRaisesRegex(RuntimeError,'라벨'):a.service({},'unrelated',[])

    def test_timeout_kills_spawned_process_group_and_preserves_output(self):
        with tempfile.TemporaryDirectory() as temp:
            a=object.__new__(acceptance.Acceptance);a.out=Path(temp);a.commands=[]
            command=[sys.executable,'-c','import subprocess,sys,time; p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"]); print(p.pid,flush=True);time.sleep(30)']
            with self.assertRaises(subprocess.TimeoutExpired):a.run(command,timeout=.3)
            self.assertEqual(a.commands[0]['exitCode'],124)
            pid=int((a.out/'command-000.stdout').read_text().strip())
            # A killed child may briefly remain as a zombie until launchd reaps it.
            state=subprocess.run(['/bin/ps','-p',str(pid),'-o','stat='],capture_output=True,text=True)
            self.assertTrue(state.returncode!=0 or state.stdout.strip().startswith('Z'))
