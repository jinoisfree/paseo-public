"""Paseo 전용 설비 실행. 다른 도구의 프로세스·인증·기록에는 손대지 않는다."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from launcher_runtime import paseo_cli, find_cli, app_version, warn_version

PREFIX = 'io.github.jinoisfree.paseo-public.'


def read(file, default=None):
    try:
        return json.loads(Path(file).read_text())
    except FileNotFoundError:
        return {} if default is None else default


def atomic(file, value):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=file.parent, prefix='.'+file.name)
    try:
        with os.fdopen(fd, 'w') as out:
            os.fchmod(out.fileno(), 0o600)
            json.dump(value, out)
            out.flush(); os.fsync(out.fileno())
        os.replace(temporary, file)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


class Service:
    def __init__(self, home=None, runner=None, now=time.time):
        self.home = Path(home or os.environ.get('PASEO_HOME', Path.home()/'.paseo'))
        self.owner = read(self.home/'owner/policy.json')
        self.vault = read(self.home/'owner/vault.json')
        self.now = now
        self.runner = runner or subprocess.run
        self.app = Path(self.vault.get('paths', {}).get('app', os.environ.get('PASEO_APP', '/Applications/Paseo.app')))
        self.cli = paseo_cli(self.app, validate_version=False)

    def command(self, *args, check=True):
        env = dict(os.environ);env.pop('PASEO_HOST', None);env['PASEO_HOME'] = str(self.home)
        result = self.runner([self.cli, *args, '--home', str(self.home)], capture_output=True, text=True, timeout=120, env=env)
        if check and result.returncode:
            raise RuntimeError('Paseo 설비 명령 실패(내용은 비밀 보호를 위해 출력하지 않습니다).')
        return result

    def event(self, task, result, **details):
        file = self.home/'airport/logs'/f'{task}.jsonl'
        file.parent.mkdir(parents=True, exist_ok=True)
        with file.open('a') as out:
            out.write(json.dumps({'at': self.now(), 'result': result, **details})+'\n')

    def notify(self, message):
        try:
            self.runner(['/usr/bin/osascript', '-e', 'display notification '+json.dumps(message)+' with title "Paseo 설비"'], capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            self.event('notification', 'failed')

    def supported(self):
        version = app_version(self.app)
        # C30 supersedes C23's hard range gate: app updates must keep the supervisor alive.
        warn_version(version, self.home, notify=self.notify)
        return version

    def busy(self):
        state = read(self.home/'role-workflow/state.json', {'workflows': []})
        return any(w.get('status') == 'active' and ((w.get('pending') or {}).get('stage') == 'sending' or any((w.get(role) or {}).get('compaction') for role in ('plan', 'execute'))) for w in state['workflows'])

    def kickstart(self):
        # Only the public daemon service, never an app or another user's process.
        result = self.runner(['/bin/launchctl', 'kickstart', '-k', f'gui/{os.getuid()}/{PREFIX}daemon-service'], capture_output=True, text=True, timeout=120)
        if result.returncode: raise RuntimeError('공항 데몬 설비 kickstart 실패')

    def daemon_service(self):
        self.supported()
        variant = self.owner.get("decisions", {}).get("modules", {}).get("daemon-service", {}).get("variant", "A")
        args = ["start"] if variant == "A" else ["daemon", "run"]
        env = dict(os.environ);env.pop("PASEO_HOST", None);env["PASEO_HOME"] = str(self.home)
        os.execve(self.cli, [self.cli, *args, "--home", str(self.home)], env)

    def update_watch(self):
        version = self.supported()
        status = self.command('daemon', 'status', '--json', check=False)
        if status.returncode:
            self.event('update-watch', 'daemon-unavailable');return
        actual = json.loads(status.stdout).get('daemonVersion')
        if not actual:
            self.event('update-watch', 'version-unknown');return
        if actual == version:
            self.event('update-watch', 'current');return
        if self.busy():
            self.event('update-watch', 'busy');self.notify('작업 전송·압축 중이라 Paseo 버전 전환을 보류했습니다.');return
        self.command('daemon', 'stop')
        self.kickstart()
        self.event('update-watch', 'restarted', appVersion=version, daemonVersion=actual)
        self.notify('업데이트된 Paseo 데몬 supervisor를 다시 시작했습니다.')

    def watchdog(self):
        self.supported()
        status = self.command('daemon', 'status', '--json', check=False)
        if status.returncode or not (json.loads(status.stdout).get('workerPid') or json.loads(status.stdout).get('pid')):
            self.kickstart();self.event('paseo-watchdog', 'daemon-restarted');return
        listing = self.command('plugin', 'ls', '--json')
        history_file = self.home/'airport/runtime/plugin-reloads.json'
        history = read(history_file)
        now = self.now()
        configured = read(self.home/'config.json').get('plugins', {})
        for plugin in json.loads(listing.stdout):
            plugin_id = plugin.get('id', '')
            if not re.fullmatch(r'[A-Za-z0-9._-]+', plugin_id): continue
            # Built-in sources are app-owned; repair only enabled directory/npm user plugins.
            if plugin_id not in configured or configured[plugin_id].get('source') not in ('directory', 'npm') or plugin.get('source') == 'builtin' or not plugin.get('enabled') or plugin.get('status') not in ('failed', 'error'): continue
            recent = [t for t in history.get(plugin_id, []) if now-t < 3600]
            if len(recent) >= 3:
                self.event('paseo-watchdog', 'reload-limited', plugin=plugin_id);continue
            recent.append(now);history[plugin_id] = recent
            atomic(history_file, history)  # Count attempts even if reload fails.
            self.command('plugin', 'reload', plugin_id, check=False)
            self.event('paseo-watchdog', 'reload', plugin=plugin_id)
        for product in ('claude', 'codex'):
            try:
                find_cli(product);present=True
            except ValueError:
                present=False
            self.event('paseo-watchdog', 'binary', product=product, present=present)

    def archive_rotate(self):
        defaults = read(Path(__file__).parent.parent/'presets/recommended.json')
        days = self.owner.get('decisions', {}).get('archiveRotate', {}).get('days', defaults['equipment']['archiveRotate']['afterDays'])
        cutoff = self.now() - days*86400
        for product in ('claude-home', 'codex-home'):
            base = self.home/product
            directory = base/('projects' if product == 'claude-home' else 'sessions')
            suffixes = ('*.jsonl', '*.json') if product == 'codex-home' else ('*.jsonl',)
            for pattern in suffixes:
                for source in directory.rglob(pattern):
                    if source.is_symlink() or not source.is_file() or source.stat().st_mtime >= cutoff: continue
                    target = self.home/'archive'/product/source.relative_to(base)
                    if target.exists():
                        if target.read_bytes() != source.read_bytes():
                            self.event('archive-rotate', 'collision');continue
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                        # Copy and verify before removing a live record; never discard without archive.
                        shutil.copy2(source, target)
                    if source.read_bytes() == target.read_bytes():
                        source.unlink();self.event('archive-rotate', 'archived', product=product)


def main(task):
    service = None
    try:
        service = Service()
        grant = service.owner.get('decisions', {}).get('modules', {}).get(task, {})
        if not grant.get('enabled'):
            return 0
        lock = service.home/'airport/runtime'/f'{task}.lock'
        lock.parent.mkdir(parents=True, exist_ok=True)
        with lock.open('a') as handle:
            try: fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: return 0
            getattr(service, task.replace('-', '_'))()
        return 0
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError, subprocess.SubprocessError):
        if service:
            service.event(task, 'failed');service.notify('Paseo 설비 실행에 실패했습니다. 설비 로그를 확인하세요.')
        print('Paseo 설비 실패: 앱·지시서·설비 로그를 확인하세요.', file=sys.stderr)
        return 1
