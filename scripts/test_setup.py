"""Exercise account installation through command doubles, never a real daemon."""
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
import contextlib

sys.path.insert(0,str(Path(__file__).resolve().parent))
spec=importlib.util.spec_from_file_location('public_setup',Path(__file__).with_name('setup.py'))
setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name)/'account';self.home.mkdir()
        self.root=Path(self.temp.name)/'checkout';self.root.mkdir()
        self.paseo=self.root/'paseo';self.paseo.write_text('fixture')
        self.node=self.root/'node';self.node.write_text('fixture');self.node.chmod(0o755)
        (self.root/'package-lock.json').write_text('{}')
        (self.root/'launchd').mkdir()
        (self.root/'launchd/fold-reapply.plist.in').write_bytes((Path(__file__).resolve().parents[1]/'launchd/fold-reapply.plist.in').read_bytes())
        self.config=self.home/'.config/paseo-public/config.json'
        self.commands=[]
        self.env=mock.patch.dict(os.environ,{'HOME':str(self.home),'PASEO_PUBLIC_CONFIG':str(self.config),'PASEO_PUBLIC_NODE':str(self.node)})
        self.env.start();self.addCleanup(self.env.stop)
        self.patches=[mock.patch.object(setup,'ROOT',self.root),mock.patch.object(setup,'cli_path',return_value=self.paseo),
                      mock.patch.object(setup.subprocess,'check_output',return_value='v26.0.0\n'),mock.patch.object(setup,'run',side_effect=self.fake_run)]
        for patch in self.patches:patch.start();self.addCleanup(patch.stop)

    def fake_run(self,command,home,**kwargs):
        args=list(map(str,command));self.commands.append(args)
        if 'install' in args:
            config=json.loads((self.home/'.paseo/config.json').read_text())
            config.setdefault('plugins',{})['role-workflow']={'source':'directory','path':str(self.root/'plugin/role-workflow'),'enabled':True}
            (self.home/'.paseo/config.json').write_text(json.dumps(config))
        if 'remove' in args:
            config=json.loads((self.home/'.paseo/config.json').read_text());config['plugins'].pop('role-workflow')
            (self.home/'.paseo/config.json').write_text(json.dumps(config))
        return subprocess.CompletedProcess(args,0,stdout='',stderr='')

    def ready(self,enabled=True):
        (self.home/'.paseo').mkdir()
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
        self.assertEqual(plist['StandardOutPath'],str(self.home/'logs & data/stdout.log'))
        self.assertEqual(plist['WorkingDirectory'],str(self.home))
        self.assertNotIn('__',json.dumps(plist))

    def test_dry_run_has_no_writes_or_daemon_commands(self):
        before=sorted(str(path.relative_to(self.home)) for path in self.home.rglob('*'))
        self.assertEqual(self.execute('install','--dry-run','--with-fold-reapply'),0)
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


if __name__=='__main__':unittest.main()
