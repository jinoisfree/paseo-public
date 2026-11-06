#!/usr/bin/env python3
"""Account-local installer. Dry runs never change files or contact Paseo."""
import argparse
import pwd
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time
import datetime
from xml.sax.saxutils import escape
from public_runtime import ROOT, LEGACY_FOLD_LABEL, AUTO_UPDATE_LABEL, load_config, config_path, data_root, logs_root, auto_update_logs, node_executable, app_path, backup_root, busy_workflows, verify_plugin_entries, auto_update_agent_state


def run(command, home, *, check=True, capture=False):
    env = os.environ.copy()
    env['PASEO_HOME'] = str(home/'.paseo')
    env.pop('PASEO_HOST', None)
    env['PATH'] = str(Path(node_executable()).parent)+os.pathsep+env.get('PATH', '')
    return subprocess.run(list(map(str, command)), cwd=ROOT, env=env, check=check,
                          capture_output=capture, text=True)


def is_file(path):
    try:
        return path.is_file()
    except OSError:
        return False


def link_target(path):
    """None for a regular file, the resolved target for a readable link, False for an unreadable link."""
    try:
        if not path.is_symlink():
            return None
        os.readlink(path)
        return path.resolve()
    except OSError:
        return False


def cli_path(config):
    # The CLI inside the app wins over a PATH link, which may belong to another account and be unreadable.
    # Automatically detected paths are never saved, so a stale path cannot override this later.
    bundled = app_path(config)/'Contents/Resources/bin/paseo'
    value = config.get('paseo')
    if value:
        candidate = Path(value).expanduser()
        if not candidate.is_absolute():
            candidate = Path(shutil.which(str(candidate)) or str(candidate))
    elif is_file(bundled):
        return bundled
    else:
        candidate = Path(shutil.which('paseo') or str(bundled))
    if candidate != bundled and is_file(bundled):
        target = link_target(candidate)
        if target is False or (target is not None and target == bundled.resolve()):
            return bundled
    if not is_file(candidate):
        raise RuntimeError('Paseo CLI를 찾지 못했습니다. Paseo 설치 후 config.json의 paseo 경로를 확인하세요.')
    return candidate


def path_cli_warning():
    """A PATH `paseo` link this account cannot read makes the terminal command fail silently. File access only."""
    for directory in os.environ.get('PATH', '').split(os.pathsep):
        link = Path(directory or '.')/'paseo'
        try:
            if not link.is_symlink():
                if link.exists():
                    return None  # The first real `paseo` on PATH is not a link.
                continue
        except OSError:
            continue
        if link_target(link) is not False:
            return None
        try:
            uid = link.lstat().st_uid
            try:
                owner = pwd.getpwuid(uid).pw_name
            except KeyError:
                owner = str(uid)
        except OSError:
            owner = '알 수 없음'
        return (f'경고: PATH의 {link}는 이 계정에서 읽을 수 없는 심볼릭 링크입니다(소유자: {owner}). '
                f'터미널의 paseo 명령이 출력 없이 실패할 수 있습니다. 링크 소유 계정에서 `chmod -h 755 {link}`를 실행하세요. '
                '설치기는 이 파일을 수정하지 않으며 앱 안의 CLI로 설치합니다.')
    return None


def verify_cli(paseo, home):
    hint = (f'선택한 CLI: {paseo}\n다른 계정 소유 심볼릭 링크의 권한 때문일 수 있습니다. `ls -l {paseo}`로 확인하고 '
            '`chmod -h 755`로 고치거나 ~/.config/paseo-public/config.json의 paseo에 앱 안의 CLI '
            '(Paseo.app/Contents/Resources/bin/paseo) 경로를 지정하세요.')
    try:
        result = run([paseo, '--version'], home, check=False, capture=True)
    except OSError as error:
        raise RuntimeError(f'Paseo CLI를 실행하지 못했습니다: {error}\n{hint}') from error
    if result.returncode:
        output = ((result.stdout or '')+(result.stderr or '')).strip() or '출력 없음'
        raise RuntimeError(f'Paseo CLI --version이 종료 코드 {result.returncode}로 끝났습니다 ({output}).\n{hint}')


def read_paseo(home):
    file = home/'.paseo/config.json'
    return json.loads(file.read_text()) if file.exists() else {}


def same_plugin(entry, root=None):
    root = ROOT if root is None else root
    return entry.get('source') == 'directory' and Path(entry.get('path', '')).resolve() == (root/'plugin/role-workflow').resolve()


AGENT_LABELS = {'installed': '등록됨', 'foreign': '다른 저장소에 등록됨', 'missing': '미등록'}
CONFLICT_KINDS = {'not-directory': 'source가 directory가 아님', 'missing-path': 'path 없음',
                  'copy-without-git': '.git 없는 사본', 'other-git-repo': '다른 git 저장소'}


def registration_conflict(entry):
    source, path = entry.get('source'), entry.get('path')
    if source != 'directory':
        kind = 'not-directory'
    elif not path or not Path(path).expanduser().exists():
        kind = 'missing-path'
    else:
        place = Path(path).expanduser().resolve()
        kind = 'other-git-repo' if any((parent/'.git').exists() for parent in (place, *place.parents)) else 'copy-without-git'
    return {'source': source, 'path': path, 'kind': kind}


def conflict_message(conflict, options):
    command = ' '.join(['./install.sh', '--replace-registration', *options])
    return (f"다른 경로의 role-workflow가 이미 등록돼 있습니다: source={conflict['source']}, path={conflict['path']} "
            f"({CONFLICT_KINDS[conflict['kind']]}).\n진행 중인 작업이 없을 때 다음 명령으로 이 저장소로 전환하세요.\n  {command}")


def verify_registration(paseo, home, after='install'):
    result = None
    for attempt in range(5):
        result = run([paseo, 'plugin', 'ls', 'role-workflow', '--json', '--home', home/'.paseo'], home, check=False, capture=True)
        problem = None
        if result.returncode:
            problem = RuntimeError(f'plugin ls 실패({result.returncode}): {(result.stderr or "").strip()}')
        else:
            try:
                verify_plugin_entries(json.loads(result.stdout), ROOT, after)
                return
            except (ValueError, RuntimeError) as error:
                problem = error if isinstance(error, RuntimeError) else RuntimeError('plugin ls 출력을 해석하지 못했습니다.')
        if attempt < 4:
            time.sleep(1)  # A plugin that was just registered may still be starting.
    raise RuntimeError(f'플러그인 등록 확인 실패: {problem}')


def replace_registration(paseo, home, config, entry):
    """Swap a foreign registration for this checkout; any failure restores the previous path."""
    command = lambda *arguments: [paseo, *arguments, '--home', home/'.paseo']
    file = home/'.paseo/config.json'
    backup = backup_root(config)/('registration-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')
    backup.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(file.read_bytes())
    backup.chmod(0o600)
    try:
        run(command('plugin', 'remove', 'role-workflow'), home)
        if 'role-workflow' in read_paseo(home).get('plugins', {}):
            raise RuntimeError('plugin remove 뒤에도 role-workflow 등록이 남아 있습니다.')
        run(command('plugin', 'install', ROOT/'plugin/role-workflow'), home)
        verify_registration(paseo, home, 'replacement')
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        previous = entry.get('path')
        if previous and Path(previous).expanduser().exists():
            try:
                run(command('plugin', 'remove', 'role-workflow'), home, check=False)
                run(command('plugin', 'install', previous), home)
                restored = f'이전 등록({previous})을 다시 설치했습니다.'
            except (OSError, RuntimeError, subprocess.CalledProcessError) as restore_error:
                restored = f'이전 등록({previous}) 복원도 실패했습니다: {restore_error}'
        else:
            restored = '이전 path가 없어 복원하지 못했습니다.'
        raise RuntimeError(f'등록 전환 실패: {error}\n{restored}\n설정 백업: {backup}') from error
    return backup


def launch_plist(config, node, home):
    """The daily auto-update LaunchAgent; the only launchd job this installer registers."""
    values = {'__PYTHON__':config.get('python') or os.environ.get('PASEO_PUBLIC_PYTHON') or shutil.which('python3') or sys.executable,'__REPOSITORY__':str(ROOT),'__HOME__':str(home),
              '__PATH__':str(Path(node).parent)+os.pathsep+os.environ.get('PATH','/usr/bin:/bin'),
              '__APP__':str(app_path(config)),'__PASEO_HOME__':str(home/'.paseo'),
              '__LOGS__':str(logs_root(config)), '__CONFIG__':str(config_path())}
    text = (ROOT/'launchd/auto-update.plist.in').read_text()
    for key,value in values.items():
        text = text.replace(key,escape(value))
    return plistlib.loads(text.encode())


def remove_agent(label, script, home):
    plist = home/'Library/LaunchAgents'/(label+'.plist')
    if plist.exists():
        current = plistlib.loads(plist.read_bytes())
        if str(ROOT/'scripts'/script) in current.get('ProgramArguments', []):
            run(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{label}'], home, check=False)
            plist.unlink()


def install_agent(label, generated, home):
    plist = home/'Library/LaunchAgents'/(label+'.plist')
    if not plist.exists() or plist.read_bytes() != generated:
        if plist.exists():
            run(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{label}'], home, check=False)
        plist.parent.mkdir(parents=True, exist_ok=True)
        plist.write_bytes(generated)
        run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', plist], home)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install','uninstall'])
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--with-auto-update', action='store_true', help='daily 04:30 updater; with uninstall, remove only this agent')
    parser.add_argument('--replace-registration', action='store_true', help='install only: replace a foreign role-workflow registration with this checkout')
    args = parser.parse_args(argv)
    if args.replace_registration and args.action != 'install':
        parser.error('--replace-registration은 일반 install에서만 쓸 수 있습니다.')
    if sys.version_info < (3,12):
        raise RuntimeError('Python 3.12 이상이 필요합니다.')
    if os.geteuid() == 0 and not args.dry_run:
        raise RuntimeError('설치는 sudo 없이 실행하세요.')
    home = Path.home()
    config = load_config()
    node = node_executable(config)
    version = subprocess.check_output([node,'--version'],text=True).strip()
    if int(version.lstrip('v').split('.')[0]) < 22:
        raise RuntimeError('Node.js 22 이상이 필요합니다.')
    paseo = cli_path(config)
    if not args.dry_run:
        verify_cli(paseo, home)
    account = read_paseo(home)
    entry = account.get('plugins',{}).get('role-workflow')
    plan = {'action':args.action,'home':str(home),'plugin':str(ROOT/'plugin/role-workflow'),
            'node':node,'python':sys.executable,'paseo':str(paseo),'config':str(config_path()),
            'data':str(data_root(config)),'logs':str(logs_root(config)),
            'withAutoUpdate':args.with_auto_update,'dryRun':args.dry_run,
            'pathCliWarning':path_cli_warning()}
    conflict = registration_conflict(entry) if entry and not same_plugin(entry) and args.action == 'install' else None
    plan.update(registrationConflict=conflict, replaceRegistration=args.replace_registration)
    if conflict and not args.replace_registration:
        if args.dry_run:
            print(json.dumps(plan,ensure_ascii=False,indent=2))
        options = ['--with-auto-update'] if args.with_auto_update else []
        raise RuntimeError(conflict_message(conflict, options))
    print(json.dumps(plan,ensure_ascii=False,indent=2))
    if plan['pathCliWarning'] and not args.dry_run:
        print(plan['pathCliWarning'],file=sys.stderr)
    if args.dry_run:
        print('DRY RUN: npm 의존성/플러그인 등록/launchd 변경 없음. 계정의 데이터는 보존합니다.')
        return 0
    command = lambda *arguments: [paseo,*arguments,'--home',home/'.paseo']
    if args.action == 'uninstall':
        if not args.with_auto_update and entry and same_plugin(entry):
            run(command('plugin','remove','role-workflow'),home)
        remove_agent(AUTO_UPDATE_LABEL, 'auto-update.py', home)
        if not args.with_auto_update:
            remove_agent(LEGACY_FOLD_LABEL, 'auto-reapply-fold.py', home)
        print('등록 해제 완료. 설정·워크플로·빌드·백업·로그는 삭제하지 않았습니다.')
        return 0
    if not (home/'.paseo/paseo.pid').exists():
        raise RuntimeError('이 계정에서 Paseo를 먼저 실행하세요. 설치기는 데몬을 시작하거나 재시작하지 않습니다.')
    if conflict:
        busy = busy_workflows(home)
        if busy:
            raise RuntimeError('진행 중인 작업이 있어 등록을 전환하지 않습니다: '+', '.join(f'#{number}' for number in busy))
    if args.with_auto_update:
        updater = home/'Library/LaunchAgents'/(AUTO_UPDATE_LABEL+'.plist')
        if updater.exists() and str(ROOT/'scripts/auto-update.py') not in plistlib.loads(updater.read_bytes()).get('ProgramArguments', []):
            raise RuntimeError('다른 저장소의 자동 업데이트가 이미 등록돼 있습니다.')
    lock = hashlib.sha256((ROOT/'package-lock.json').read_bytes()).hexdigest()
    if not (ROOT/'node_modules/.bin/tsx').exists() or config.get('dependenciesLock') != lock:
        npm = Path(node).parent/'npm'
        if not npm.exists():
            npm = Path(shutil.which('npm') or '')
        if not npm.is_file():
            raise RuntimeError('npm을 찾지 못했습니다.')
        run([npm,'ci','--ignore-scripts','--no-audit','--no-fund'],home)
    # Native CLI persists the same directory-source shape used by Paseo itself.
    # This applies configuration to a running daemon; it does not restart it.
    if account.get('pluginsEnabled') is not True:
        run(command('daemon','config','set','pluginsEnabled','true'),home)
    replaced = None
    if conflict:
        replaced = replace_registration(paseo, home, config, entry)
    elif not entry:
        run(command('plugin','install',ROOT/'plugin/role-workflow'),home)
    elif entry.get('enabled') is False:
        run(command('plugin','enable','role-workflow'),home)
    # An existing same-path registration is retained without interrupting active tasks.
    config.update(node=node,python=os.environ.get('PASEO_PUBLIC_PYTHON') or shutil.which('python3') or sys.executable,dependenciesLock=lock)
    config.setdefault('phoneNotifications',False)
    config_path().parent.mkdir(parents=True,exist_ok=True)
    config_path().write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
    config_path().chmod(0o600)
    # The sidebar fold feature was removed; retire its watcher if this checkout registered one.
    remove_agent(LEGACY_FOLD_LABEL, 'auto-reapply-fold.py', home)
    if args.with_auto_update:
        auto_update_logs(config).mkdir(parents=True, exist_ok=True)
        install_agent(AUTO_UPDATE_LABEL, plistlib.dumps(launch_plist(config,node,home),sort_keys=False), home)
    verify_registration(paseo, home)
    if args.with_auto_update:
        agent = run(['/bin/launchctl','print',f'gui/{os.getuid()}/{AUTO_UPDATE_LABEL}'],home,check=False,capture=True)
        if agent.returncode:
            raise RuntimeError(f'자동 업데이트 LaunchAgent가 로드돼 있지 않습니다({agent.returncode}): {(agent.stderr or "").strip()}')
    print('설치 완료. 폴더 열기는 사이드바/커맨드 센터에서 사용할 수 있습니다.')
    if replaced:
        print(f'이전 등록({entry.get("path")})은 삭제하지 않았습니다. 확인 후 직접 정리하세요. 설정 백업: {replaced}')
    print(f'등록 경로: {ROOT/"plugin/role-workflow"} · 자동 업데이트: {AGENT_LABELS[auto_update_agent_state(home,ROOT)]}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError,RuntimeError,ValueError,subprocess.CalledProcessError) as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
