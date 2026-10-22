# Adapted for the portable paseo-public distribution.
"""Exercise installer preflight and rollback without changing a real app."""
import contextlib

import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
import errno
import io
import json
import pathlib
import plistlib
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

INSTALLER = pathlib.Path(__file__).with_name('install-pushed-fold.py')


class InstallerFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        self.app = self.root/'Paseo.app'
        (self.app/'Contents').mkdir(parents=True)
        (self.app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString': '0.11.4'}))
        self.dist = self.root/'dist'
        self.web = self.dist/'_expo/static/js/web'
        self.web.mkdir(parents=True)
        (self.web/'index-new.js').write_text('sidebar-project-pushed-')
        self.page('/_expo/static/js/web/index-new.js')

    def page(self, src):
        (self.dist/'index.html').write_text(f'<script src="{src}" defer></script>')


class InstallerPreflight(InstallerFixture):
    def check(self, success):
        result = subprocess.run([sys.executable, str(INSTALLER), '--app', str(self.app), '--dist', str(self.dist), '--backup-root', str(self.root/'backups')], capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        self.assertFalse((self.root/'backups').exists())

    def test_fresh_package(self):
        self.check(True)

    def test_other_app_version_is_refused(self):
        (self.app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString': '0.11.2'}))
        self.check(False)

    def test_old_unused_bundle_after_reextract(self):
        (self.web/'index-old.js').write_text('old version')
        self.check(True)

    def test_unused_valid_bundle_cannot_mask_invalid_active_bundle(self):
        (self.web/'index-old.js').write_text('old version')
        self.page('/_expo/static/js/web/index-old.js')
        self.check(False)

    def test_missing_active_bundle(self):
        self.page('/_expo/static/js/web/index-missing.js')
        self.check(False)

    def test_no_entry(self):
        (self.dist/'index.html').write_text('<html></html>')
        self.check(False)

    def test_external_entry(self):
        self.page('https://example.invalid/_expo/static/js/web/index-new.js')
        self.check(False)

    def test_escaping_entry(self):
        (self.root/'index-outside.js').write_text('sidebar-project-pushed-')
        self.page('../index-outside.js')
        self.check(False)


class InstallerMutation(InstallerFixture):
    def setUp(self):
        super().setUp()
        self.backups = self.root/'external-volume/backups'
        self.renderer = self.app/'Contents/Resources/app-dist'
        self.renderer.mkdir(parents=True)
        (self.renderer/'index.html').write_text('original renderer')
        (self.app/'Contents/Resources/app.asar').write_text('protected server bytes')
        (self.app/'Contents/MacOS').mkdir()
        (self.app/'Contents/MacOS/Paseo').write_text('original executable')
        (self.app/'Contents/_CodeSignature').mkdir()
        self.seal(self.app)
        self.original = self.files(self.app)
        self.temporary = [
            self.renderer.with_name('app-dist.pushed-fold-new'),
            self.renderer.with_name('app-dist.pushed-fold-old'),
            self.app.with_name('.Paseo.app.pushed-fold-restore'),
            self.app.with_name('.Paseo.app.pushed-fold-failed'),
        ]

    def files(self, path):
        return {str(p.relative_to(path)): p.read_bytes() for p in path.rglob('*') if p.is_file()}

    def seal(self, app):
        resources = {p: data.hex() for p, data in self.files(app).items()
                     if p != 'Contents/_CodeSignature/CodeResources'}
        (app/'Contents/_CodeSignature/CodeResources').write_text(json.dumps(resources, sort_keys=True))

    def verify(self, app, command):
        try:
            recorded = json.loads((app/'Contents/_CodeSignature/CodeResources').read_text())
        except (OSError, ValueError):
            raise subprocess.CalledProcessError(1, command)
        actual = {p: data.hex() for p, data in self.files(app).items()
                  if p != 'Contents/_CodeSignature/CodeResources'}
        if actual != recorded:
            raise subprocess.CalledProcessError(1, command)

    def execute(self, *, fail_sign_on=None, fail_staging_copy=False, fail_promotion=False,
                restore=None, fail_restore_promotion=False):
        self.commands = []
        self.cross_device_attempts = []
        sign_calls = 0
        real_rename = pathlib.Path.rename

        def rename(source, destination):
            destination = pathlib.Path(destination)
            source_external = source.is_relative_to(self.root/'external-volume')
            destination_external = destination.is_relative_to(self.root/'external-volume')
            if source_external != destination_external:
                self.cross_device_attempts.append((source, destination))
                raise OSError(errno.EXDEV, 'simulated cross-device rename')
            if fail_promotion and source == self.temporary[0] and destination == self.renderer:
                raise OSError('simulated renderer promotion failure')
            if fail_restore_promotion and source == self.temporary[2] and destination == self.app:
                raise OSError('simulated app promotion failure')
            return real_rename(source, destination)

        def run(command, **kwargs):
            nonlocal sign_calls
            command = [str(arg) for arg in command]
            self.commands.append(command)
            if command[0] in ('/bin/cp', '/usr/bin/ditto'):
                source, destination = map(pathlib.Path, command[-2:])
                if fail_staging_copy and destination == self.temporary[0]:
                    destination.mkdir()
                    (destination/'partial').write_text('interrupted copy')
                    raise subprocess.CalledProcessError(1, command)
                shutil.copytree(source, destination, symlinks=True, dirs_exist_ok=True)
            elif command[0] == '/usr/bin/codesign':
                app = pathlib.Path(command[-1])
                if '--force' in command:
                    sign_calls += 1
                    (app/'Contents/MacOS/Paseo').write_text('new executable signature')
                    if sign_calls == fail_sign_on:
                        (app/'Contents/_CodeSignature/CodeResources').write_text('partial signature')
                        raise subprocess.CalledProcessError(1, command)
                    self.seal(app)
                else:
                    self.verify(app, command)
            else:
                raise AssertionError(command)
            return subprocess.CompletedProcess(command, 0)

        argv = [str(INSTALLER), '--app', str(self.app), '--dist', str(self.dist),
                '--backup-root', str(self.backups), '--apply']
        if restore:
            argv.extend(['--restore', str(restore)])
        output = io.StringIO()
        error = None
        with mock.patch.object(sys, 'argv', argv), \
             mock.patch.object(pathlib.Path, 'rename', rename), \
             mock.patch.object(subprocess, 'run', side_effect=run), \
             contextlib.redirect_stdout(output):
            try:
                runpy.run_path(str(INSTALLER), run_name='__main__')
            except (SystemExit, subprocess.CalledProcessError, OSError) as caught:
                error = caught
        self.output = output.getvalue()
        return error

    def backup(self):
        records = list(self.backups.glob('*/installation.json'))
        self.assertEqual(len(records), 1)
        return records[0].parent

    def assert_clean(self):
        self.assertTrue(all(not p.exists() and not p.is_symlink() for p in self.temporary))
        self.assertEqual(self.cross_device_attempts, [])

    def test_apply_with_external_backup_seals_final_tree_and_preserves_original(self):
        self.assertIsNone(self.execute(), self.output)
        backup = self.backup()
        self.assertEqual(self.files(backup/'Paseo.app'), self.original)
        self.assertEqual(self.files(backup/'previous-renderer'), {'index.html': b'original renderer'})
        self.assertEqual(self.files(self.renderer), self.files(self.dist))
        for file in ('Contents/Resources/app.asar', 'Contents/Info.plist'):
            self.assertEqual((self.app/file).read_bytes(), self.original[file])
        # This detects sealing an in-app old renderer and then deleting it without resealing.
        self.verify(self.app, ['verify final installed tree'])
        self.assert_clean()

    def test_partial_signing_failure_restores_full_app_across_backup_volume(self):
        error = self.execute(fail_sign_on=1)
        self.assertIsInstance(error, subprocess.CalledProcessError)
        self.assertEqual(self.files(self.app), self.original)
        backup = self.backup()
        self.assertEqual(self.files(backup/'Paseo.app'), self.original)
        self.assertEqual((backup/'failed-app/Contents/MacOS/Paseo').read_text(), 'new executable signature')
        self.verify(self.app, ['verify restored app'])
        self.assert_clean()

    def test_final_signing_failure_restores_app_after_old_renderer_was_archived(self):
        self.assertIsInstance(self.execute(fail_sign_on=2), subprocess.CalledProcessError)
        self.assertEqual(self.files(self.app), self.original)
        self.assertEqual(self.files(self.backup()/'previous-renderer'), {'index.html': b'original renderer'})
        self.verify(self.app, ['verify restored app'])
        self.assert_clean()

    def test_partial_staging_copy_is_cleaned_without_changing_original(self):
        self.assertIsInstance(self.execute(fail_staging_copy=True), subprocess.CalledProcessError)
        self.assertEqual(self.files(self.app), self.original)
        self.assertFalse((self.backup()/'failed-app').exists())
        self.assert_clean()

    def test_renderer_promotion_failure_restores_same_volume_old_directory(self):
        self.assertIsInstance(self.execute(fail_promotion=True), OSError)
        self.assertEqual(self.files(self.app), self.original)
        self.assertFalse((self.backup()/'failed-app').exists())
        self.assert_clean()

    def test_existing_temporary_paths_abort_before_any_mutation(self):
        for path in self.temporary:
            with self.subTest(path=path.name):
                path.mkdir()
                before = self.files(self.app)
                error = self.execute()
                self.assertIsInstance(error, SystemExit)
                self.assertEqual(self.commands, [])
                self.assertEqual(self.files(self.app), before)
                self.assertTrue(path.exists())
                self.assertFalse(self.backups.exists())
                path.rmdir()

    def test_dangling_temporary_symlink_also_aborts_without_mutation(self):
        path = self.temporary[1]
        path.symlink_to(self.root/'missing')
        self.assertIsInstance(self.execute(), SystemExit)
        self.assertTrue(path.is_symlink())
        self.assertEqual(self.commands, [])
        self.assertFalse(self.backups.exists())

    def restore_fixture(self):
        saved = self.root/'external-volume/saved'
        shutil.copytree(self.app, saved/'Paseo.app')
        (saved/'installation.json').write_text(json.dumps({'app': str(self.app)}))
        (saved/'Paseo.app/Contents/Resources/app-dist/index.html').write_text('older renderer')
        self.seal(saved/'Paseo.app')
        return saved

    def test_explicit_restore_with_external_backup(self):
        saved = self.restore_fixture()
        self.assertIsNone(self.execute(restore=saved), self.output)
        self.assertEqual(self.files(self.app), self.files(saved/'Paseo.app'))
        self.assertEqual(self.files(self.backup()/'replaced-app'), self.original)
        self.assert_clean()

    def test_failed_full_app_promotion_returns_displaced_app(self):
        saved = self.restore_fixture()
        self.assertIsInstance(self.execute(restore=saved, fail_restore_promotion=True), OSError)
        self.assertEqual(self.files(self.app), self.original)
        self.assert_clean()


if __name__ == '__main__':
    unittest.main()
