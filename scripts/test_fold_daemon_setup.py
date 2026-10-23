"""System installation tested using temporary paths and launchctl/install doubles."""
import contextlib
import grp
import importlib.util
import io
import os
from pathlib import Path
import plistlib
import pwd
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('fold_daemon_setup', Path(__file__).with_name('fold_daemon_setup.py'))
setup = importlib.util.module_from_spec(spec); spec.loader.exec_module(setup)


class DaemonSetupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.home = self.root/'account'; self.home.mkdir()
        self.system = self.root/'LaunchDaemons'; self.system.mkdir()
        real = pwd.getpwuid(os.getuid())
        self.owner = pwd.struct_passwd((real.pw_name, 'x', real.pw_uid, real.pw_gid, '', str(self.home), '/bin/sh'))
        self.job = {'Label':'example.fold', 'UserName':real.pw_name,
                    'GroupName':grp.getgrgid(real.pw_gid).gr_name,
                    'ProgramArguments':['/bin/sh','-c','exit 0','job',str(self.root/'scripts/auto-reapply-fold.py')],
                    'StandardOutPath':str(self.home/'logs/stdout.log'),'StandardErrorPath':str(self.home/'logs/stderr.log')}
        self.agent = self.home/'Library/LaunchAgents/example.fold.plist'
        self.agent.parent.mkdir(parents=True)
        self.agent.write_bytes(plistlib.dumps({**self.job, 'LimitLoadToSessionType':'Aqua'}))
        self.backup = self.root/'backup'
        self.calls = []; self.loaded = set()
        patches = [mock.patch.object(setup.pwd, 'getpwnam', return_value=self.owner),
                   mock.patch.object(setup.os, 'chown'), mock.patch.object(setup, 'command', side_effect=self.command)]
        for patch in patches: patch.start(); self.addCleanup(patch.stop)

    def command(self, args, *, dry=False, check=True):
        args = list(map(str, args)); self.calls.append((args, dry))
        code = 0
        if not dry:
            if args[0] == '/usr/bin/install': shutil.copy2(args[-2], args[-1])
            if args[1:2] == ['print']:
                code = 0 if args[-1] in self.loaded or args[-1].count('/') == 1 else 1
            if args[1:2] == ['bootstrap']:
                job = plistlib.loads(Path(args[-1]).read_bytes()); self.loaded.add(args[2]+'/'+job['Label'])
            if args[1:2] == ['bootout']: self.loaded.discard(args[-1])
        return subprocess.CompletedProcess(args, code, '', '')

    def deploy(self, action, dry=False):
        with contextlib.redirect_stdout(io.StringIO()):
            return setup.deploy(self.job, self.backup, action, dry=dry, system_dir=self.system)

    def test_system_shell_waits_for_volume_and_quotes_paths(self):
        root = Path(__file__).resolve().parents[1]
        source = root/'scripts/com.jino.paseo-fold-reapply.daemon.plist'
        if not source.exists():
            source = root/'launchd/fold-reapply.daemon.plist.in'
        spec = plistlib.loads(source.read_bytes())
        self.assertNotIn('LimitLoadToSessionType', spec)
        self.assertTrue(spec['StartOnMount'])
        args = spec['ProgramArguments'].copy()
        args[4] = str(self.root/'source with spaces/auto-reapply-fold.py')
        args[5] = sys.executable
        absent = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(absent.returncode, 0)
        self.assertIn('deferred', absent.stdout)
        file = Path(args[4]); file.parent.mkdir(); file.write_text('print("source ready")')
        ready = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(ready.returncode, 0)
        self.assertEqual(ready.stdout.strip(), 'source ready')
        args[5] = str(self.root/'missing-python')
        self.assertEqual(subprocess.run(args, capture_output=True).returncode, 0)

    def test_dry_run_needs_no_root_and_keeps_agent(self):
        before = self.agent.read_bytes()
        with mock.patch.object(setup.os, 'geteuid', return_value=501):
            self.assertEqual(self.deploy('install', dry=True), 0)
        self.assertEqual(self.agent.read_bytes(), before)
        self.assertFalse(self.backup.exists()); self.assertEqual(list(self.system.iterdir()), [])
        self.assertTrue(all(dry for args, dry in self.calls if args[0] != '/usr/bin/plutil'))

    def test_nonroot_apply_stops_before_commands_or_writes(self):
        with mock.patch.object(setup.os, 'geteuid', return_value=501), self.assertRaisesRegex(RuntimeError, 'sudo'):
            self.deploy('install')
        self.assertTrue(self.agent.exists()); self.assertEqual(self.calls, [])

    def test_install_moves_agent_and_uninstall_restores_it(self):
        before = self.agent.read_bytes(); gui = f'gui/{self.owner.pw_uid}'
        self.loaded.add(gui+'/example.fold')
        with mock.patch.object(setup.os, 'geteuid', return_value=0):
            self.assertEqual(self.deploy('install'), 0)
            self.assertFalse(self.agent.exists())
            self.assertEqual((self.backup/'LaunchAgent.plist').read_bytes(), before)
            self.assertIn('system/example.fold', self.loaded)
            self.assertNotIn(gui+'/example.fold', self.loaded)
            self.assertEqual(self.deploy('uninstall'), 0)
        self.assertEqual(self.agent.read_bytes(), before)
        self.assertFalse((self.system/'example.fold.plist').exists())
        self.assertIn(gui+'/example.fold', self.loaded)

    def test_repeated_install_keeps_running_job(self):
        with mock.patch.object(setup.os, 'geteuid', return_value=0):
            self.assertEqual(self.deploy('install'), 0)
            self.calls.clear()
            self.assertEqual(self.deploy('install'), 0)
        self.assertTrue(self.calls)
        self.assertTrue(all(args[1:2] == ['print'] for args, _ in self.calls))

    def test_unrelated_agent_is_never_replaced(self):
        self.agent.write_bytes(plistlib.dumps({'ProgramArguments':['other.py']}))
        with self.assertRaisesRegex(RuntimeError, 'unrelated'):
            self.deploy('install', dry=True)
        self.assertEqual(self.calls, [])

    def test_logged_out_owner_gets_agent_file_restored_without_bootstrap(self):
        self.backup.mkdir(); shutil.copy2(self.agent, self.backup/'LaunchAgent.plist'); self.agent.unlink()
        original = self.command
        def absent_gui(args, **kwargs):
            if list(map(str, args))[1:2] == ['print']:
                return subprocess.CompletedProcess(args, 1, '', '')
            return original(args, **kwargs)
        with mock.patch.object(setup, 'command', side_effect=absent_gui), mock.patch.object(setup.os, 'geteuid', return_value=0):
            self.assertEqual(self.deploy('uninstall'), 0)
        self.assertTrue(self.agent.exists())
        self.assertFalse(any(args[1:2] == ['bootstrap'] for args, _ in self.calls))


if __name__ == '__main__': unittest.main()
