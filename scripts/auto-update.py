#!/usr/bin/env python3
"""Update an opted-in account checkout from origin/main without restarting Paseo."""
import argparse
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from time import sleep

# A read-only --check must not create repository __pycache__ files either.
sys.dont_write_bytecode = True

from public_runtime import ROOT, AUTO_UPDATE_LABEL, load_config, auto_update_data, auto_update_logs, node_executable, busy_workflows, verify_plugin_entries, auto_update_agent_installed, paseo_home
from setup import cli_path, read_paseo, same_plugin

BUSY_INTERVAL = 600
BUSY_RECHECKS = 3
BUSY_NOTIFY_STREAK = 3


def stamp():
    return datetime.datetime.now().astimezone().isoformat()


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


class Updater:
    def __init__(self, root=None, home=None, config=None):
        self.root = (root or ROOT).resolve()
        self.home = home or Path.home()
        self.config = load_config() if config is None else config
        self.state_dir = auto_update_data(self.config)
        self.state_file = self.state_dir/'state.json'
        self.log = None
        self.sequence = 0
        self.state = {'startedAt': stamp(), 'previousCommit': None, 'targetCommit': None, 'afterCommit': None, 'busyStreak': 0, 'notifiedSkip': None}

    def command(self, command, *, check=True, timeout=120):
        command = list(map(str, command))
        env = os.environ.copy()
        env.update(HOME=str(self.home), PASEO_HOME=str(paseo_home(self.home)),
                   PATH=str(Path(node_executable(self.config)).parent)+os.pathsep+env.get('PATH', ''),
                   PYTHONDONTWRITEBYTECODE='1')
        env.pop('PASEO_HOST', None)
        env['GIT_OPTIONAL_LOCKS'] = '0'  # --check must not refresh the index
        self.sequence += 1
        log = self.log/f'{self.sequence:02d}-{Path(command[0]).name}.log' if self.log else None
        try:
            result = subprocess.run(command, cwd=self.root, env=env, capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as error:
            if log:
                log.write_text(json.dumps(command)+'\n'+str(error)+'\n')
            raise RuntimeError(f'Command could not finish: {command[0]}; log: {log}') from error
        if log:
            log.write_text('command: '+json.dumps(command)+'\ncwd: '+str(self.root)+'\n'+
                           result.stdout+result.stderr+'\nexitCode: '+str(result.returncode)+'\n')
        if check and result.returncode:
            raise RuntimeError(f'Command failed ({result.returncode}): {command[0]}; log: {log}')
        return result

    def git(self, *args, check=True):
        return self.command(['git', *args], check=check)

    def head(self):
        return self.git('rev-parse', 'HEAD').stdout.strip()

    def notify(self, message):
        script = 'display notification '+json.dumps(message, ensure_ascii=False)+' with title "Paseo 자동 업데이트"'
        try:
            result = subprocess.run(['/usr/bin/osascript', '-e', script], capture_output=True, text=True, timeout=10)
            self.event(notificationExitCode=result.returncode, notificationError=result.stderr)
        except (OSError, subprocess.TimeoutExpired) as error:
            self.event(notificationSkipped=str(error))

    def event(self, **values):
        value = {'at': stamp(), **values}
        if self.log:
            with (self.log/'events.jsonl').open('a') as output:
                output.write(json.dumps(value, ensure_ascii=False)+'\n')

    def finish(self, result, reason, *, notify=False, **values):
        busy = result == 'skipped' and reason == 'busy'
        message = reason
        if result == 'skipped' and reason == 'foreign-plugin':
            # Tell once per distinct mismatch; the same registered path does not repeat the notification.
            path = self.registered_path()
            mark = {'reason': reason, 'path': path}
            notify = self.state.get('notifiedSkip') != mark
            self.state['notifiedSkip'] = mark
            message = (f'role-workflow가 이 저장소가 아닌 {path or "알 수 없는 경로"}에 등록돼 있어 자동 업데이트를 건너뜁니다. '
                       '해결: ./install.sh --replace-registration --with-auto-update')
        else:
            self.state['notifiedSkip'] = None
        self.state['busyStreak'] = self.state['busyStreak'] + 1 if busy else 0
        self.state.update(result=result, reason=reason, finishedAt=stamp(), logDirectory=str(self.log), **values)
        if result == 'updated':
            self.state['lastSuccessAt'] = self.state['finishedAt']
        temporary = self.state_file.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.state, ensure_ascii=False, indent=2)+'\n')
        temporary.replace(self.state_file)
        self.event(**self.state)
        print(json.dumps(self.state, ensure_ascii=False))
        if busy and self.state['busyStreak'] == BUSY_NOTIFY_STREAK:
            notify = True
            workflows = ', '.join(f'#{number}' for number in self.state['busyWorkflows'])
            message = f'자동 업데이트를 바쁨으로 {BUSY_NOTIFY_STREAK}회 연속 건너뛰었습니다. 작업: {workflows}'
        if notify:
            self.notify(message+f'\n로그: {self.log}')
        return 1 if result == 'failed' else 0

    def daemon_running(self):
        try:
            pid = json.loads((paseo_home(self.home)/'paseo.pid').read_text())['pid']
            if type(pid) is not int or pid <= 0:
                return False
            os.kill(pid, 0)  # Existence probe only; never starts a daemon.
            return True
        except PermissionError:
            return True  # As in the existing daemon probe: EPERM still means it exists.
        except (OSError, ValueError, KeyError, TypeError, OverflowError):
            return False

    def safety(self):
        if self.git('branch', '--show-current').stdout.strip() != 'main':
            return 'branch'
        if self.git('status', '--porcelain', '--untracked-files=no').stdout.strip():
            return 'dirty'
        if not self.daemon_running():
            return 'daemon-stopped'
        account = read_paseo(self.home)
        if not isinstance(account, dict) or not isinstance(account.get('plugins', {}), dict):
            raise ValueError('Invalid Paseo registration; update refused')
        entry = account.get('plugins', {}).get('role-workflow', {})
        if not isinstance(entry, dict):
            raise ValueError('Invalid plugin registration; update refused')
        if not same_plugin(entry, self.root):
            return 'foreign-plugin'
        return None

    def busy(self):
        return busy_workflows(self.home)

    def install_reload(self):
        self.command([sys.executable, self.root/'scripts/setup.py', 'refresh'], timeout=3600)
        paseo = cli_path(self.config)
        result = self.command([paseo, 'plugin', 'ls', 'role-workflow', '--json', '--home', paseo_home(self.home)])
        entry = read_paseo(self.home).get('plugins', {}).get('role-workflow', {})
        if entry.get('enabled') is not False and read_paseo(self.home).get('pluginsEnabled') is not False:
            verify_plugin_entries(json.loads(result.stdout), self.root)

    def rollback(self, previous, target):
        # Do not reset another branch or a commit created by a concurrent user.
        if self.git('branch', '--show-current').stdout.strip() != 'main' or self.head() not in (previous, target):
            raise RuntimeError('Checkout changed concurrently; rollback refused')
        self.git('reset', '--keep', previous)
        self.install_reload()

    def check(self):
        # ls-remote reads the actual remote without changing local refs, FETCH_HEAD or logs.
        current = self.head()
        remote = self.git('ls-remote', 'origin', 'refs/heads/main').stdout.split()
        if len(remote) != 2 or not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', remote[0]) or remote[1] != 'refs/heads/main':
            raise RuntimeError('origin/main could not be read')
        account = read_paseo(self.home)
        plugins = account.get('plugins') if isinstance(account, dict) else None
        entry = plugins.get('role-workflow') if isinstance(plugins, dict) else None
        try:
            skip = self.safety()
        except ValueError:
            skip = 'invalid-registration'
        print(json.dumps({'currentCommit': current, 'remoteCommit': remote[0], 'updateNeeded': current != remote[0],
                          'registeredPath': entry.get('path') if isinstance(entry, dict) else None,
                          'registrationMatches': isinstance(entry, dict) and same_plugin(entry, self.root),
                          'agentInstalled': auto_update_agent_installed(self.home, self.root), 'skipReason': skip}, ensure_ascii=False))
        return 0

    def registered_path(self):
        try:
            account = read_paseo(self.home)
            entry = account.get('plugins', {}).get('role-workflow')
            return entry.get('path') if isinstance(entry, dict) else None
        except (OSError, ValueError, AttributeError):
            return None

    def run(self):
        self.state_dir.mkdir(parents=True, exist_ok=True)
        log_root = auto_update_logs(self.config)
        log_root.mkdir(parents=True, exist_ok=True)
        self.log = Path(tempfile.mkdtemp(prefix=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-'), dir=log_root))
        with lock_file(self.state_dir/'run.lock') as locked:
            if not locked:
                # The lock owner owns state.json. A contender records only its own run log.
                self.event(result='skipped', reason='locked')
                print(json.dumps({'result': 'skipped', 'reason': 'locked', 'logDirectory': str(self.log)}))
                return 0
            try:
                if self.state_file.exists():
                    saved = json.loads(self.state_file.read_text())
                    if not isinstance(saved, dict):
                        raise ValueError('Invalid updater state; update refused')
                    streak = saved.get('busyStreak', 0)
                    if type(streak) is not int or streak < 0:
                        raise ValueError('Invalid busy streak; update refused')
                    self.state['busyStreak'] = streak
                    skip = saved.get('notifiedSkip')
                    if skip is not None and not (isinstance(skip, dict) and isinstance(skip.get('reason'), str) and
                                                 (skip.get('path') is None or isinstance(skip['path'], str))):
                        raise ValueError('Invalid notified skip; update refused')
                    self.state['notifiedSkip'] = skip
                    success = saved.get('lastSuccessAt') or (saved.get('finishedAt') if saved.get('result') == 'updated' else None)
                    if success:
                        self.state['lastSuccessAt'] = success
                return self.update()
            except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
                return self.finish('failed', str(error), notify=True)

    def update(self):
        previous = self.head()
        self.state.update(previousCommit=previous, afterCommit=previous)
        reason = self.safety()
        if reason:
            return self.finish('skipped', reason, notify=reason == 'foreign-plugin')
        try:
            fetched = self.git('fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main', check=False)
        except RuntimeError as error:
            return self.finish('skipped', 'fetch-failed', detail=str(error))
        if fetched.returncode:
            return self.finish('skipped', 'fetch-failed')
        target = self.git('rev-parse', 'refs/remotes/origin/main').stdout.strip()
        self.state['targetCommit'] = target
        if previous == target:
            return self.finish('skipped', 'up-to-date')
        ancestor = self.git('merge-base', '--is-ancestor', previous, target, check=False)
        if ancestor.returncode == 1:
            return self.finish('skipped', 'diverged', notify=True)
        if ancestor.returncode:
            raise RuntimeError('Could not determine origin/main ancestry')
        for attempt in range(BUSY_RECHECKS + 1):
            workflows = self.busy()
            if not workflows:
                break
            self.event(busyCheck=attempt, busyWorkflows=workflows, retryAfterSeconds=BUSY_INTERVAL if attempt < BUSY_RECHECKS else None)
            if attempt == BUSY_RECHECKS:
                return self.finish('skipped', 'busy', busyWorkflows=workflows)
            sleep(BUSY_INTERVAL)
        reason = self.safety()
        if reason:
            return self.finish('skipped', reason, notify=reason == 'foreign-plugin')
        if self.head() != previous or self.git('rev-parse', 'refs/remotes/origin/main').stdout.strip() != target:
            return self.finish('skipped', 'checkout-changed')
        self.state.update(result='applying', logDirectory=str(self.log))
        pending = self.state_file.with_suffix('.tmp')
        pending.write_text(json.dumps(self.state, ensure_ascii=False, indent=2)+'\n')
        pending.replace(self.state_file)
        try:
            self.git('merge', '--ff-only', 'origin/main')
            self.install_reload()
        except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
            try:
                self.rollback(previous, target)
                return self.finish('failed', f'업데이트 실패, 이전 버전 복원: {error}', notify=True,
                                   rollback='succeeded', afterCommit=self.head())
            except (OSError, ValueError, KeyError, TypeError, RuntimeError) as rollback_error:
                return self.finish('failed', f'업데이트 실패: {error}; 롤백 실패: {rollback_error}', notify=True,
                                   rollback='failed', afterCommit=self.head())
        return self.finish('updated', f'Paseo 업데이트 완료 {previous[:7]} → {target[:7]}', notify=True, afterCommit=target)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='read current/remote commits without changing files')
    args = parser.parse_args(argv)
    updater = Updater()
    return updater.check() if args.check else updater.run()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
