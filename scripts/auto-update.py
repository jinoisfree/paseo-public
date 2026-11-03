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
import time

# A read-only --check must not create repository __pycache__ files either.
sys.dont_write_bytecode = True

from public_runtime import ROOT, load_config, auto_update_data, auto_update_logs, node_executable
from setup import cli_path, read_paseo, same_plugin

BUSY_INTERVAL = 600
BUSY_RECHECKS = 3


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
        self.state = {'startedAt': stamp(), 'previousCommit': None, 'targetCommit': None, 'afterCommit': None}

    def command(self, command, *, check=True, timeout=120):
        command = list(map(str, command))
        env = os.environ.copy()
        env.update(HOME=str(self.home), PASEO_HOME=str(self.home/'.paseo'),
                   PATH=str(Path(node_executable(self.config)).parent)+os.pathsep+env.get('PATH', ''),
                   PYTHONDONTWRITEBYTECODE='1')
        env.pop('PASEO_HOST', None)
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
        self.state.update(result=result, reason=reason, finishedAt=stamp(), logDirectory=str(self.log), **values)
        temporary = self.state_file.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.state, ensure_ascii=False, indent=2)+'\n')
        temporary.replace(self.state_file)
        self.event(**self.state)
        print(json.dumps(self.state, ensure_ascii=False))
        if notify:
            self.notify(reason+f'\n로그: {self.log}')
        return 1 if result == 'failed' else 0

    def daemon_running(self):
        try:
            pid = json.loads((self.home/'.paseo/paseo.pid').read_text())['pid']
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
        file = self.home/'.paseo/role-workflow/state.json'
        if not file.exists():
            return False
        data = json.loads(file.read_text())
        workflows = data['workflows']
        if not isinstance(workflows, list):
            raise ValueError('Invalid workflow state; update refused')
        for w in workflows:
            if not isinstance(w, dict):
                raise ValueError('Invalid workflow; update refused')
            if any(w.get(key) is not None and not isinstance(w[key], dict) for key in ('pending', 'plan', 'execute')):
                raise ValueError('Invalid workflow member; update refused')
            if (w.get('pending') or {}).get('stage') == 'sending':
                return True
            if any((w.get(role) or {}).get('compaction') for role in ('plan', 'execute')):
                return True
        return False

    def install_reload(self):
        self.command([sys.executable, self.root/'scripts/setup.py', 'install'], timeout=3600)
        paseo = cli_path(self.config)
        self.command([paseo, 'plugin', 'reload', 'role-workflow', '--home', self.home/'.paseo'])
        result = self.command([paseo, 'plugin', 'ls', 'role-workflow', '--json', '--home', self.home/'.paseo'])
        entries = json.loads(result.stdout)
        if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
            raise RuntimeError('Expected one role-workflow plugin after reload')
        entry = entries[0]
        if (entry.get('id') != 'role-workflow' or entry.get('enabled') is not True or
                entry.get('status') != 'running' or entry.get('error') or
                Path(entry.get('path', '')).resolve() != (self.root/'plugin/role-workflow').resolve()):
            raise RuntimeError('role-workflow is not running cleanly from this checkout')

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
        print(json.dumps({'currentCommit': current, 'remoteCommit': remote[0], 'updateNeeded': current != remote[0]}, ensure_ascii=False))
        return 0

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
            if not self.busy():
                break
            self.event(busyCheck=attempt, retryAfterSeconds=BUSY_INTERVAL if attempt < BUSY_RECHECKS else None)
            if attempt == BUSY_RECHECKS:
                return self.finish('skipped', 'busy')
            time.sleep(BUSY_INTERVAL)
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
