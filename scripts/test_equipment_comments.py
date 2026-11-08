"""C35: retained volume/Hermes comments must not masquerade as Paseo watchdog actions."""
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from equipment import conflicts

ROOT=Path(__file__).resolve().parents[1]


class EquipmentCommentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name)
        agents=self.home/'Library/LaunchAgents';agents.mkdir(parents=True)
        self.script=self.home/'mixed-watchdog.sh'
        (agents/'fixture-watchdog.plist').write_bytes(plistlib.dumps({'Label':'fixture-watchdog','ProgramArguments':['/bin/zsh',str(self.script)]}))
        self.manifest=json.loads((ROOT/'modules/paseo-watchdog/module.json').read_text())

    def test_retained_full_line_comments_are_not_running_plugin_reload_logic(self):
        self.script.write_text('#!/bin/zsh\n  # paseo volume guard prevents plugin reload hangs\n# plugin reload documentation\necho "volume healthy"\n')
        self.assertEqual(conflicts(self.manifest,self.home,{}),[])

    def test_real_reload_code_still_blocks_even_after_comments_are_removed(self):
        self.script.write_text('#!/bin/zsh\n# unrelated documentation\npaseo plugin reload fixture\n')
        self.assertEqual([x['kind'] for x in conflicts(self.manifest,self.home,{})],['script-content'])

    def test_hash_inside_a_command_is_preserved_as_executable_content(self):
        self.script.write_text('printf "%s" "# paseo plugin reload fixture"\n')
        self.assertEqual([x['kind'] for x in conflicts(self.manifest,self.home,{})],['script-content'])
