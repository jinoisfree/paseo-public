"""Paseo 전용 설비 실행. 다른 도구의 프로세스·인증·기록에는 손대지 않는다."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import socket
import shutil
import subprocess
import sys
import tempfile
import time
from launcher_runtime import paseo_cli, find_cli, app_version, warn_version

PREFIX = 'io.github.jinoisfree.paseo-public.'
# C36/F1: module ids map explicitly to methods; ids with dashes never derive a method name.
TASKS = {'daemon-service': 'daemon_service', 'update-watch': 'update_watch',
         'paseo-watchdog': 'watchdog', 'archive-rotate': 'archive_rotate'}
NOTIFY_INTERVAL = 3600
RECHECK_SECONDS = 10
READY_DEADLINE = 60       # fake-clock seconds to wait for the restarted daemon to report the app version
READY_POLL = 2
READY_MAX_ATTEMPTS = 120  # guard against a frozen injected clock
STATUS_TIMEOUT = 10
VERIFY_TIMEOUT = 120
VERIFY_FILE = 'airport/runtime/update-verify.json'


def port_open(host, port, timeout=2):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


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
    def __init__(self, home=None, runner=None, now=time.time, sleep=time.sleep, probe=port_open, daemon_plist=None):
        self.home = Path(home or os.environ.get('PASEO_HOME', Path.home()/'.paseo'))
        self.sleep = sleep
        self.probe = probe
        self.daemon_plist = Path(daemon_plist or Path(os.environ.get('HOME') or Path.home())/'Library/LaunchAgents'/f'{PREFIX}daemon-service.plist')
        self.owner = read(self.home/'owner/policy.json')
        self.vault = read(self.home/'owner/vault.json')
        self.now = now
        self.runner = runner or subprocess.run
        self.app = Path(self.vault.get('paths', {}).get('app', os.environ.get('PASEO_APP', '/Applications/Paseo.app')))
        self.cli = paseo_cli(self.app, validate_version=False)

    def command(self, *args, check=True, timeout=120):
        env = dict(os.environ);env.pop('PASEO_HOST', None);env['PASEO_HOME'] = str(self.home)
        result = self.runner([self.cli, *args, '--home', str(self.home)], capture_output=True, text=True, timeout=timeout, env=env)
        if check and result.returncode:
            raise RuntimeError('Paseo 설비 명령 실패(내용은 비밀 보호를 위해 출력하지 않습니다).')
        return result

    def event(self, task, result, **details):
        file = self.home/'airport/logs'/f'{task}.jsonl'
        file.parent.mkdir(parents=True, exist_ok=True)
        with file.open('a') as out:
            out.write(json.dumps({'at': self.now(), 'result': result, **details})+'\n')

    def notify(self, message, key=None):
        if key:
            # C36/F3: a repeating failure notifies once per key per hour; every run is still logged.
            file = self.home/'airport/runtime/notifications.json'
            sent = read(file)
            if self.now() - sent.get(key, 0) < NOTIFY_INTERVAL:
                self.event('notification', 'suppressed', key=key);return
            sent[key] = self.now();atomic(file, sent)
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

    def owns_daemon_service(self):
        try:
            job = plistlib.loads(self.daemon_plist.read_bytes())
        except (OSError, ValueError, plistlib.InvalidFileException):
            return False
        home = (job.get('EnvironmentVariables') or {}).get('PASEO_HOME')
        return bool(home) and Path(home).expanduser().resolve() == self.home.resolve()

    def kickstart(self):
        # The label is global to the macOS account: restart it only when it serves the checked home.
        if not self.owns_daemon_service():
            self.event('daemon-service', 'home-mismatch', home=str(self.home))
            raise RuntimeError('daemon-service가 이 PASEO_HOME을 관리하지 않아 재시작하지 않습니다.')
        # Only the public daemon service, never an app or another user's process.
        result = self.runner(['/bin/launchctl', 'kickstart', '-k', f'gui/{os.getuid()}/{PREFIX}daemon-service'], capture_output=True, text=True, timeout=120)
        if result.returncode: raise RuntimeError('공항 데몬 설비 kickstart 실패')

    def daemon_variant(self):
        explicit = self.owner.get('decisions', {}).get('modules', {}).get('daemon-service', {}).get('variant')
        return explicit or read(Path(__file__).parent/'daemon-service/module.json')['defaultVariant']

    def daemon_service(self):
        self.supported()
        variant = self.daemon_variant()
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
        if actual != version:
            if self.busy():
                self.event('update-watch', 'busy');self.notify('작업 전송·압축 중이라 Paseo 버전 전환을 보류했습니다.', key='update-watch:busy');return
            # B's KeepAlive would race a separate stop with kickstart and restart twice.
            if self.daemon_variant() == 'A':
                self.command('daemon', 'stop')
            self.kickstart()
            self.event('update-watch', 'restarted', appVersion=version, daemonVersion=actual)
            self.notify('업데이트된 Paseo 데몬 supervisor를 다시 시작했습니다.')
            if not self.wait_ready(version):
                self.event('update-watch', 'verify-deferred', appVersion=version);return
        commit = read(self.home/'airport/install.json').get('activatedCommit')
        previous = read(self.home/VERIFY_FILE)
        if previous.get('ok') is True and self.same_pair(previous, version, commit):
            self.event('update-watch', 'current');return
        self.verify(version, commit, previous)

    @staticmethod
    def same_pair(record, version, commit):
        return record.get('appVersion') == version and record.get('activatedCommit') == commit

    def wait_ready(self, version):
        """True once status reports the app version; any failed or odd response counts as not ready yet."""
        deadline = self.now() + READY_DEADLINE
        for _ in range(READY_MAX_ATTEMPTS):
            try:
                data = json.loads(self.command('daemon', 'status', '--json', check=False, timeout=STATUS_TIMEOUT).stdout)
            except (OSError, ValueError, subprocess.SubprocessError, TypeError):
                data = None
            if isinstance(data, dict) and data.get('daemonVersion') == version:
                return True
            if self.now() >= deadline:
                return False
            self.sleep(READY_POLL)
        return False

    def clone_setup(self):
        entry = read(self.home/'config.json').get('plugins', {}).get('role-workflow')
        path = entry.get('path') if isinstance(entry, dict) else None
        if not isinstance(path, str) or not path:
            return None
        script = Path(path).parents[1]/'scripts/setup.py'
        return script if script.is_file() else None

    def setup_failures(self, script, name):
        """Keys only: stdout bodies never reach events, records or notifications."""
        env = {k: v for k, v in os.environ.items() if k != 'PASEO_HOST'}
        env.update(HOME=os.environ.get('HOME') or str(Path.home()), PASEO_HOME=str(self.home), PYTHONDONTWRITEBYTECODE='1')
        try:
            result = self.runner([sys.executable, str(script), name, '--json'], capture_output=True, text=True, timeout=VERIFY_TIMEOUT, env=env)
            data = json.loads(result.stdout)
            if not isinstance(data, dict):
                raise ValueError('shape')
            if name == 'check':
                return [str(row['key']) for row in data['differences']]
            return [str(row['key']) for row in data['checks'] if row.get('ok') is False and row.get('blocking')]
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            return [name+':error']

    def verify(self, version, commit, previous):
        script = self.clone_setup()
        if script is None:
            failing = ['clone:unavailable']
        else:
            failing = sorted(set(self.setup_failures(script, 'check') + self.setup_failures(script, 'doctor')))
        ok = not failing
        atomic(self.home/VERIFY_FILE, {'appVersion': version, 'daemonVersion': version, 'activatedCommit': commit, 'ok': ok, 'failing': failing, 'at': self.now()})
        self.event('update-watch', 'verified', appVersion=version, ok=ok, failing=failing)
        if not ok and not (previous.get('ok') is False and self.same_pair(previous, version, commit)):
            self.notify(f'Paseo {version} 세팅 점검 실패 {len(failing)}건: {", ".join(failing[:3])}. setup.py check·doctor로 확인하세요.')

    def listen(self):
        value = str(read(self.home/'config.json').get('daemon', {}).get('listen') or '127.0.0.1:6767')
        host, _, port = value.rpartition(':')
        return (host.strip('[]') or '127.0.0.1', int(port)) if port.isdigit() else None

    def alive(self):
        status = self.command('daemon', 'status', '--json', check=False)
        try:
            data = json.loads(status.stdout) if not status.returncode else {}
        except ValueError:
            data = {}
        if isinstance(data, dict) and (data.get('workerPid') or data.get('pid')):
            return 'status'
        listen = self.listen()
        # An unreadable listen address is not evidence of death; never restart on it.
        if listen is None:
            return 'listen-unknown'
        return 'port' if self.probe(*listen) else None

    def watchdog(self):
        self.supported()
        evidence = self.alive()
        if evidence != 'status':
            # C36/F2: status failure alone never restarts every conversation; the port and a recheck must agree.
            if evidence is None:
                self.sleep(RECHECK_SECONDS)
                evidence = self.alive()
            if evidence is None:
                self.kickstart();self.event('paseo-watchdog', 'daemon-restarted', reason='status-port-recheck');return
            self.event('paseo-watchdog', 'status-unavailable', evidence=evidence);return
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

    def archive_root(self):
        decision = self.owner.get('decisions', {}).get('archiveRotate', {})
        return Path(decision['root']).expanduser() if decision.get('root') else self.home/'archive'

    def archive_rotate(self):
        days = self.owner.get('decisions', {}).get('archiveRotate', {}).get('days')
        if days is None:
            # The installed preset copy is read only when the owner left the retention unset.
            days = read(Path(__file__).parent.parent/'presets/recommended.json')['equipment']['archiveRotate']['afterDays']
        cutoff = self.now() - days*86400
        root = self.archive_root()
        parts = root.parts
        # An owner-chosen external volume may be unmounted; never create the missing mount point on the boot disk.
        if len(parts) > 2 and parts[1] == 'Volumes' and not os.path.ismount(os.path.join('/', parts[1], parts[2])):
            self.event('archive-rotate', 'destination-unavailable', root=str(root))
            self.notify('기록 보관 위치(외장 볼륨)가 연결돼 있지 않아 보관을 건너뜁니다.', key='archive-rotate:destination')
            return
        for product in ('claude-home', 'codex-home'):
            base = self.home/product
            directory = base/('projects' if product == 'claude-home' else 'sessions')
            suffixes = ('*.jsonl', '*.json') if product == 'codex-home' else ('*.jsonl',)
            for pattern in suffixes:
                for source in directory.rglob(pattern):
                    if source.is_symlink() or not source.is_file() or source.stat().st_mtime >= cutoff: continue
                    target = root/product/source.relative_to(base)
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
            getattr(service, TASKS[task])()
        return 0
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError, subprocess.SubprocessError):
        if service:
            service.event(task, 'failed');service.notify('Paseo 설비 실행에 실패했습니다. 설비 로그를 확인하세요.', key=f'failed:{task}')
        print('Paseo 설비 실패: 앱·지시서·설비 로그를 확인하세요.', file=sys.stderr)
        return 1
