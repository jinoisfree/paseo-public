import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PreCommitTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.repo = Path(self.scratch.name)
        (self.repo / 'scripts').mkdir()
        (self.repo / '.githooks').mkdir()
        shutil.copy2(ROOT / 'scripts/privacy_scan.py', self.repo / 'scripts/privacy_scan.py')
        shutil.copy2(ROOT / '.githooks/pre-commit', self.repo / '.githooks/pre-commit')
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        self.env = {**os.environ, 'HOME': str(self.repo)}
        self.env.pop('PASEO_PUBLIC_DENY_FILE', None)

    def check(self, content, expected, deny=None):
        (self.repo / 'sample.txt').write_text(content)
        subprocess.run(['git', 'add', 'sample.txt'], cwd=self.repo, check=True)
        env = dict(self.env)
        if deny is not None:
            env['PASEO_PUBLIC_DENY_FILE'] = str(deny)
        result = subprocess.run(['.githooks/pre-commit'], cwd=self.repo, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_missing_list_still_runs_the_default_scan(self):
        self.check('public documentation', 0)
        self.check('sk-' + 'A' * 32, 1)

    def test_default_private_deny_list_blocks_staged_content(self):
        deny = self.repo / '.config/paseo-public/sync-deny.txt'
        deny.parent.mkdir(parents=True)
        deny.write_text('private-marker')
        result = self.check('private-marker', 1)
        self.assertNotIn('private-marker', result.stdout)

    def test_environment_deny_list_is_used_when_present(self):
        deny = self.repo / 'custom-deny.txt'
        deny.write_text('custom-marker')
        self.check('custom-marker', 1, deny)
        self.check('public documentation', 0, deny)


if __name__ == '__main__':
    unittest.main()
