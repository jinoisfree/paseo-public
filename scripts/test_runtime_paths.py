"""Portable and development paths are selected through private repository profiles."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parent))
import public_runtime as runtime


class RuntimePaths(unittest.TestCase):
    def test_development_profile_preserves_legacy_operating_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/'checkout';root.mkdir()
            config=Path(temporary)/'config.json'
            values={'dataDir':str(root/'automation/data'),'logsDir':str(root/'automation/logs'),
                    'backupDir':str(root/'backups')}
            config.write_text(json.dumps({'profiles':{str(root):values}}))
            with mock.patch.dict(os.environ,{'PASEO_PUBLIC_CONFIG':str(config)}),mock.patch.object(runtime,'ROOT',root):
                selected=runtime.load_config()
                self.assertEqual(runtime.data_root(selected),root/'automation/data')
                self.assertEqual(runtime.logs_root(selected),root/'automation/logs')
                self.assertEqual(runtime.backup_root(selected),root/'backups')
            with mock.patch.dict(os.environ,{'PASEO_PUBLIC_CONFIG':str(config)}),mock.patch.object(runtime,'ROOT',root/'other'):
                self.assertNotIn('dataDir',runtime.load_config())

    def test_no_profile_uses_user_data_defaults(self):
        self.assertEqual(runtime.backup_root({}),runtime.data_root({})/'backups')


if __name__=='__main__':unittest.main()
