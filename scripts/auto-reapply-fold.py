#!/usr/bin/env python3
# Adapted for the portable paseo-public distribution.
"""Rebuild only the pushed-fold renderer after a stable local Paseo update.

Adapted for paseo-public. State, logs and backups live in the user data directory. Never restarts Paseo or its daemon.
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

from public_runtime import ROOT, load_config, data_root, logs_root, node_executable, app_path, build_root, backup_root
PLUGIN_WAIT_SECONDS = 600
VERSION = re.compile(r'^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$')


def stamp():
    return datetime.datetime.now().astimezone().isoformat()


def digest(file):
    with Path(file).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def app_snapshot(app):
    info = app/'Contents/Info.plist'
    version = plistlib.loads(info.read_bytes())['CFBundleShortVersionString']
    if not VERSION.fullmatch(version):
        raise ValueError('Unsupported app version: '+version)
    return {'version': version, 'plist': digest(info),
            'asar': digest(app/'Contents/Resources/app.asar'),
            'executable': digest(app/'Contents/MacOS/Paseo')}


def active_bundle(dist):
    scripts = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', (dist/'index.html').read_text())
    matches = [src for src in scripts if re.search(r'/index-[^/]+\.js(?:\?.*)?$', src)]
    if len(matches) != 1:
        raise ValueError('Expected one active index bundle')
    bundle = (dist/matches[0].split('?', 1)[0].lstrip('/')).resolve()
    if not bundle.is_relative_to(dist.resolve()):
        raise ValueError('Bundle escapes app-dist')
    if 'sidebar-project-pushed-' not in bundle.read_text():
        raise ValueError('Active bundle does not contain pushed-fold')
    return {'name': bundle.name, 'sha256': digest(bundle)}


@contextlib.contextmanager
def lock_file(file):
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


class Automation:
    def __init__(self, args):
        self.args = args
        self.root = args.root.resolve()
        self.config = load_config()
        self.node_bin = str(Path(node_executable(self.config)).parent)
        self.state_dir = (args.data_root or data_root(self.config)).resolve()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.log_root = (args.data_root/'logs') if args.data_root else logs_root(self.config)
        self.log_root.mkdir(parents=True, exist_ok=True)
        self.state_file = self.state_dir/'state.json'
        self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {
            'schemaVersion': 1, 'appliedVersion': None, 'attempts': {}}
        self.log = None
        self.command_number = 0

    def save(self):
        temporary = self.state_file.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.state, ensure_ascii=False, indent=2)+'\n')
        temporary.replace(self.state_file)

    def record(self, **value):
        value = {'at': stamp(), **value}
        print(json.dumps(value, ensure_ascii=False), flush=True)
        if self.log:
            with (self.log/'events.jsonl').open('a') as output:
                output.write(json.dumps(value, ensure_ascii=False)+'\n')

    def command(self, command, cwd=None, capture=False, timeout=3600):
        command = list(map(str, command))
        self.command_number += 1
        log = self.log/f'{self.command_number:02d}-{Path(command[0]).name}.log'
        env = os.environ.copy()
        env.update(PATH=self.node_bin+os.pathsep+env.get('PATH', ''), EXPO_NO_TELEMETRY='1', PASEO_WEB_PLATFORM='electron', CI='1')
        started = time.monotonic()
        with log.open('x') as output:
            output.write('cwd: '+str(cwd or self.root)+'\ncommand: '+json.dumps(command)+'\n')
            output.flush()
            result = subprocess.run(command, cwd=cwd or self.root, env=env, stdout=subprocess.PIPE if capture else output,
                                    stderr=output, text=True, timeout=timeout)
            if capture:
                output.write(result.stdout)
            output.write('\nexitCode: '+str(result.returncode)+'\n')
        self.record(command=command, cwd=str(cwd or self.root), exitCode=result.returncode,
                    elapsedSeconds=round(time.monotonic()-started, 3), logPath=str(log))
        if result.returncode:
            raise RuntimeError(f'Command failed ({result.returncode}); see {log}')
        return result.stdout if capture else None

    def notify(self, message):
        self.record(notification=message)
        # Same macOS notification mechanism used by the existing local watchdog.
        script = 'display notification '+json.dumps(message, ensure_ascii=False)+' with title "Paseo 접기 자동 재적용"'
        # A system job has no Aqua session. Notification delivery is best effort.
        try:
            result = subprocess.run(['/usr/bin/osascript', '-e', script], capture_output=True,
                                    text=True, timeout=10)
            self.record(notificationExitCode=result.returncode, notificationError=result.stderr.strip())
        except (OSError, subprocess.TimeoutExpired) as error:
            self.record(notificationSkipped=type(error).__name__)

    def probe_plugin(self, version, timeout):
        command = [self.root/'node_modules/.bin/tsx',
                   self.root/'scripts/check-role-workflow.mts', version]
        return json.loads(self.command(command, capture=True, timeout=timeout))

    def check_plugin(self, version):
        checks = self.state.setdefault('pluginChecks', {})
        if version in checks and checks[version].get('status') != 'deferred':
            return checks[version]
        entry = {'status': 'checking', 'startedAt': stamp(), 'logDirectory': str(self.log)}
        checks[version] = entry
        self.save()  # Only an explicitly deferred check is automatically repeated.
        started = time.monotonic()
        deadline = started + PLUGIN_WAIT_SECONDS
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    output = {'status': 'failed', 'summary': '새 버전 데몬 대기 시간이 10분을 넘었습니다.'}
                    break
                try:
                    output = self.probe_plugin(version, min(15, remaining))
                except subprocess.TimeoutExpired:
                    output = {'status': 'waiting', 'summary': '데몬 연결 응답을 기다리고 있습니다.'}
                if output.get('status') != 'waiting':
                    if output.get('status') not in ('passed', 'failed', 'deferred'):
                        raise ValueError('Invalid plugin probe status')
                    if output['status'] == 'passed' and output.get('daemonVersion') != version:
                        raise ValueError('Plugin probe checked a different daemon version')
                    break
                remaining = deadline - time.monotonic()
                if remaining > 0:
                    time.sleep(min(10, remaining))
        except Exception:
            output = {'status': 'failed', 'summary': '플러그인 점검 명령을 실행하지 못했습니다. 로그를 확인하세요.'}
        entry.update(output, finishedAt=stamp(), elapsedSeconds=round(time.monotonic()-started, 3))
        self.save()
        self.record(pluginCheck=entry, version=version)
        return entry

    def finish_update(self, version, entry):
        plugin = self.check_plugin(version)
        entry.pop('pluginCheckPending', None)
        self.save()
        fold_ok = entry.get('status') == 'applied'
        if fold_ok:
            message = f'Paseo {version} 접기 재적용 완료, Cmd+R'
        else:
            message = f'Paseo {version} 접기 재적용 실패. 로그: {self.log}. 수동 확인 후 --force-version {version}'
        if plugin.get('status') == 'deferred':
            self.record(result='plugin check deferred; retry on next invocation', version=version)
            if not fold_ok:
                self.notify(message)  # The independent fold failure still needs attention.
            return 0 if fold_ok else 1
        if plugin.get('status') == 'passed':
            message += '\nrole-workflow 플러그인 점검 정상'
        else:
            summary = plugin.get('summary', '이전 점검이 중단되어 결과를 확인하지 못했습니다.')
            message += f'\nPaseo {version}: role-workflow 플러그인 점검 실패 — {summary}'
        self.notify(message)
        return 0 if fold_ok and plugin.get('status') == 'passed' else 1

    def prepare_source(self, version):
        url = f'https://github.com/getpaseo/paseo/archive/refs/tags/v{version}.tar.gz'
        archive_dir = self.state_dir/'archives'
        archive_dir.mkdir(exist_ok=True)
        archive = archive_dir/f'v{version}.tar.gz'
        if self.args.source_archive:
            # Explicit official archive cache, useful for repeatable dry-runs.
            archive = self.args.source_archive.resolve()
        elif not archive.exists():
            request = urllib.request.Request(url, headers={'User-Agent': 'paseo-fold-reapply'})
            pending = archive.with_suffix('.download')
            try:
                with urllib.request.urlopen(request, timeout=120) as response, pending.open('wb') as output:
                    shutil.copyfileobj(response, output)
                pending.replace(archive)
            finally:
                pending.unlink(missing_ok=True)
        build = self.state_dir/'build' if self.args.data_root else build_root(self.config)
        build.mkdir(parents=True, exist_ok=True)
        attempt = Path(tempfile.mkdtemp(prefix=version+'-', dir=build))
        with tarfile.open(archive, 'r:gz') as source:
            # Allow official internal symlinks; reject traversal and special files.
            members = source.getmembers()
            expected = 'paseo-'+version
            for member in members:
                parts = Path(member.name).parts
                if not parts or parts[0] != expected or '..' in parts or Path(member.name).is_absolute():
                    raise ValueError('Unsafe/unexpected archive path: '+member.name)
                if member.issym() or member.islnk():
                    target = Path(member.linkname) if member.islnk() else Path(member.name).parent/member.linkname
                    normalized = Path(os.path.normpath(target))
                    if normalized.is_absolute() or not normalized.parts or normalized.parts[0] != expected:
                        raise ValueError('Archive link escapes source: '+member.name)
                elif not member.isdir() and not member.isfile():
                    raise ValueError('Archive special file is not supported: '+member.name)
            source.extractall(attempt, members=members, filter='data')
        directory = attempt/expected
        if json.loads((directory/'package.json').read_text())['version'] != version:
            raise ValueError('Official archive package version does not match target')
        self.record(officialSource=url, archive=str(archive), archiveSha256=digest(archive), source=str(directory))
        return directory

    def apply_patch(self, source):
        def key(file):
            version = file.stem.removeprefix('sidebar-pushed-fold-')
            return tuple(map(int, version.split('.')))
        patches = [file for file in (self.root/'patches').glob('sidebar-pushed-fold-*.patch')
                   if re.fullmatch(r'sidebar-pushed-fold-\d+\.\d+\.\d+\.patch', file.name)]
        if not patches:
            raise ValueError('No pushed-fold patch found')
        patch = max(patches, key=key)
        self.command(['git', 'apply', '--check', patch], source)
        self.command(['git', 'apply', patch], source)
        self.record(patch=str(patch), patchSha256=digest(patch), directorySearchIncluded=False)
        return patch

    def build(self, source):
        for command in [['npm', 'ci', '--ignore-scripts'], ['npm', 'run', 'postinstall'], ['npm', 'run', 'build:app-deps']]:
            self.command(command, source)
        app = source/'packages/app'
        self.command(['npm', 'test', '--', '--project', 'unit',
                      'src/components/sidebar/sidebar-projection.test.ts',
                      'src/components/sidebar/sidebar-workspace-title.test.ts',
                      'src/hooks/sidebar-workspaces-view-model.test.ts',
                      'src/hooks/use-sidebar-workspace-entries.test.ts'], app)
        self.command(['npm', 'run', 'typecheck'], app)
        changed = ['packages/app/src/components/sidebar/'+name for name in [
            'pushed-workspaces.ts', 'use-pushed-workspaces.ts', 'sidebar-group-toggle-row.tsx',
            'sidebar-projection.ts', 'sidebar-projection.test.ts', 'sidebar-model.tsx', 'sidebar-status-list.tsx']]
        changed += ['packages/app/src/stores/sidebar-pushed-store.ts', 'packages/app/src/components/sidebar-workspace-list.tsx']
        self.command(['npm', 'run', 'lint', '--', *changed], source)
        self.command(['npm', 'exec', 'expo', 'export', '--', '--platform', 'web'], app)
        active_bundle(app/'dist')
        return app/'dist'

    def run(self):
        with lock_file(self.state_dir/'run.lock') as locked:
            if not locked:
                self.record(result='locked; no action')
                return 0
            # Reload under the lock; another completed process may have updated it.
            if self.state_file.exists():
                self.state = json.loads(self.state_file.read_text())
            try:
                before = app_snapshot(self.args.app)
            except (OSError, ValueError, KeyError) as error:
                self.record(result='app not ready; deferred', detail=str(error))
                return 0
            version = self.args.version or before['version']
            if not VERSION.fullmatch(version):
                raise ValueError('Invalid version')
            if self.args.version and not self.args.dry_run and version != before['version']:
                raise ValueError('Target version differs from installed app')
            if self.args.record_current:
                if before['version'] != self.args.record_current:
                    raise ValueError('Current version does not match --record-current')
                self.log = Path(tempfile.mkdtemp(prefix='record-current-', dir=self.log_root))
                self.command(['/usr/bin/codesign', '--verify', '--deep', '--strict', self.args.app])
                bundle = active_bundle(self.args.app/'Contents/Resources/app-dist')
                self.state['appliedVersion'] = version
                self.state['attempts'][version] = {'status': 'applied', 'at': stamp(), 'recordedExisting': True,
                                                   'snapshot': before, 'bundle': bundle}
                self.save()
                self.record(result='recorded existing applied renderer', version=version, bundle=bundle)
                return 0
            if not self.args.force_version and not self.args.dry_run and (
                version == self.state.get('appliedVersion') or version in self.state['attempts']
            ):
                previous = self.state['attempts'].get(version, {})
                if previous.get('pluginCheckPending') or self.state.get('pluginChecks', {}).get(version, {}).get('status') == 'deferred':
                    self.log = Path(tempfile.mkdtemp(prefix=version+'-plugin-', dir=self.log_root))
                    return self.finish_update(version, previous)
                self.record(result='already applied/attempted; no action', version=version)
                return 0
            if self.args.force_version and self.args.force_version != version:
                raise ValueError('--force-version must equal target version')
            self.log = Path(tempfile.mkdtemp(prefix=version+('-dry-' if self.args.dry_run else '-'), dir=self.log_root))
            # Wait only for new versions. Unchanged/success/failed versions return immediately.
            time.sleep(self.args.stable_seconds)
            try:
                stable = app_snapshot(self.args.app)
            except (OSError, ValueError, KeyError):
                stable = None
            if stable != before:
                self.record(result='app is changing; deferred without attempt', version=version)
                return 0
            entry = {'status': 'building', 'startedAt': stamp(), 'logDirectory': str(self.log)}
            if not self.args.dry_run:
                entry['pluginCheckPending'] = True
                self.state['attempts'][version] = entry
                self.save()  # A crash counts as an attempt; retry needs --force-version.
            try:
                self.command(['/usr/bin/codesign', '--verify', '--deep', '--strict', self.args.app])
                source = self.prepare_source(version)
                patch = self.apply_patch(source)
                dist = self.build(source)
                bundle = active_bundle(dist)
                entry.update(source=str(source), patch=str(patch), bundle=bundle)
                if app_snapshot(self.args.app) != before:
                    raise RuntimeError('App changed during build; installation refused')
                installer = [sys.executable, str(self.root/'scripts/install-pushed-fold.py'),
                             '--app', str(self.args.app), '--version', version, '--dist', str(dist),
                             '--backup-root', str((self.state_dir/'backups' if self.args.data_root else backup_root(self.config))/('auto-pushed-fold-'+version))]
                if self.args.dry_run:
                    # The installer version guard still runs against a harmless temporary app fixture.
                    with tempfile.TemporaryDirectory(prefix='preflight-', dir=self.log) as temporary:
                        fixture = Path(temporary)/'Paseo.app'
                        (fixture/'Contents').mkdir(parents=True)
                        (fixture/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString': version}))
                        preview = installer.copy()
                        preview[preview.index('--app')+1] = str(fixture)
                        self.command(preview)
                    entry.update(status='dry-run-passed', finishedAt=stamp())
                    (self.log/'result.json').write_text(json.dumps(entry, indent=2)+'\n')
                    self.record(result='dry-run passed; installation not executed', version=version, **entry)
                    return 0
                target_patch = self.root/'patches'/f'sidebar-pushed-fold-{version}.patch'
                if not target_patch.exists():
                    shutil.copy2(patch, target_patch)
                elif target_patch.read_bytes() != patch.read_bytes():
                    raise RuntimeError('Existing target patch differs; installation refused')
                self.command(installer)
                # Check again immediately before the only app mutation.
                if app_snapshot(self.args.app) != before:
                    raise RuntimeError('App changed before installation; refused')
                self.command(installer+['--apply'])  # Once only; the installer owns rollback.
                after = app_snapshot(self.args.app)
                if (after['version'], after['plist'], after['asar']) != (before['version'], before['plist'], before['asar']):
                    raise RuntimeError('Protected app content changed; inspect installer backup (no automatic retry)')
                self.command(['/usr/bin/codesign', '--verify', '--deep', '--strict', self.args.app])
                if active_bundle(self.args.app/'Contents/Resources/app-dist') != bundle:
                    raise RuntimeError('Installed active bundle differs from build')
                report = json.loads(self.command([sys.executable, self.root/'scripts/diagnose-pushed-fold.py'], capture=True))
                diagnosed = next((app for app in report['apps'] if app['app'] == str(self.args.app)), None)
                if not diagnosed or not diagnosed.get('bundles') or not all(item.get('pushedFold') for item in diagnosed['bundles']):
                    raise RuntimeError('Pushed-fold diagnostic did not confirm the active app')
                entry.update(status='applied', finishedAt=stamp(), snapshot=after)
                self.state['appliedVersion'] = version
                self.save()
                (self.log/'result.json').write_text(json.dumps(entry, indent=2)+'\n')
            except Exception as error:
                entry.update(status='failed', finishedAt=stamp(), error=str(error))
                if not self.args.dry_run:
                    self.save()
                (self.log/'result.json').write_text(json.dumps(entry, indent=2)+'\n')
                self.record(result='failed; no retry', version=version, detail=str(error))
                if self.args.dry_run:
                    self.notify(f'Paseo {version} 접기 드라이런 실패. 로그: {self.log}')
                    return 1
            # Check plugins even when the independent fold build/installation failed.
            return self.finish_update(version, entry)


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--app', type=Path, default=app_path())
    parser.add_argument('--data-root', type=Path, help='Override the user data directory')
    parser.add_argument('--version', help='Target official version; differing live version allowed only with --dry-run')
    parser.add_argument('--dry-run', action='store_true', help='Patch/test/build/preflight only; never install or mark attempted')
    parser.add_argument('--force-version', help='Explicit retry of this installed version, even after failure')
    parser.add_argument('--record-current', metavar='VERSION', help='Record an already verified patched installation')
    parser.add_argument('--stable-seconds', type=float, default=30, help='Stable app fingerprint wait before a new attempt')
    parser.add_argument('--source-archive', type=Path, help='Explicit cached official tag archive (dry-run only)')
    args = parser.parse_args(argv)
    if args.stable_seconds < 0:
        parser.error('--stable-seconds must be nonnegative')
    if args.source_archive and not args.dry_run:
        parser.error('--source-archive is dry-run only')
    return args


if __name__ == '__main__':
    sys.exit(Automation(arguments()).run())
