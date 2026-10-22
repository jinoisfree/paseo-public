#!/usr/bin/env python3
"""Account-local installer. Dry runs never change files or contact Paseo."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
from xml.sax.saxutils import escape
from public_runtime import ROOT, LABEL, load_config, config_path, data_root, logs_root, node_executable, app_path


def run(command, home, *, check=True, capture=False):
    env = os.environ.copy()
    env['PASEO_HOME'] = str(home/'.paseo')
    env.pop('PASEO_HOST', None)
    env['PATH'] = str(Path(node_executable()).parent)+os.pathsep+env.get('PATH', '')
    return subprocess.run(list(map(str, command)), cwd=ROOT, env=env, check=check,
                          capture_output=capture, text=True)


def cli_path(config):
    value = config.get('paseo') or shutil.which('paseo')
    candidate = Path(value).expanduser() if value else app_path(config)/'Contents/Resources/bin/paseo'
    if value and not candidate.is_absolute():
        candidate = Path(shutil.which(str(candidate)) or str(candidate))
    if not candidate.is_file():
        raise RuntimeError('Paseo CLI를 찾지 못했습니다. Paseo 설치 후 config.json의 paseo 경로를 확인하세요.')
    return candidate


def read_paseo(home):
    file = home/'.paseo/config.json'
    return json.loads(file.read_text()) if file.exists() else {}


def same_plugin(entry):
    return entry.get('source') == 'directory' and Path(entry.get('path', '')).resolve() == (ROOT/'plugin/role-workflow').resolve()


def launch_plist(config, node, home):
    values = {'__PYTHON__':config.get('python') or os.environ.get('PASEO_PUBLIC_PYTHON') or shutil.which('python3') or sys.executable,'__REPOSITORY__':str(ROOT),'__HOME__':str(home),
              '__PATH__':str(Path(node).parent)+os.pathsep+os.environ.get('PATH','/usr/bin:/bin'),
              '__APP__':str(app_path(config)),'__PASEO_HOME__':str(home/'.paseo'),
              '__LOGS__':str(logs_root(config)), '__CONFIG__':str(config_path())}
    text = (ROOT/'launchd/fold-reapply.plist.in').read_text()
    for key,value in values.items():
        text = text.replace(key,escape(value))
    return plistlib.loads(text.encode())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install','uninstall'])
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--with-fold-reapply', action='store_true')
    args = parser.parse_args(argv)
    if sys.version_info < (3,12):
        raise RuntimeError('Python 3.12 이상이 필요합니다.')
    home = Path.home()
    config = load_config()
    node = node_executable(config)
    version = subprocess.check_output([node,'--version'],text=True).strip()
    if int(version.lstrip('v').split('.')[0]) < 22:
        raise RuntimeError('Node.js 22 이상이 필요합니다.')
    paseo = cli_path(config)
    account = read_paseo(home)
    entry = account.get('plugins',{}).get('role-workflow')
    plist = home/'Library/LaunchAgents'/(LABEL+'.plist')
    plan = {'action':args.action,'home':str(home),'plugin':str(ROOT/'plugin/role-workflow'),
            'node':node,'python':sys.executable,'paseo':str(paseo),'config':str(config_path()),
            'data':str(data_root(config)),'logs':str(logs_root(config)),
            'withFoldReapply':args.with_fold_reapply,'dryRun':args.dry_run}
    if entry and not same_plugin(entry) and args.action == 'install':
        raise RuntimeError('다른 경로의 role-workflow가 이미 등록돼 있습니다. 현재 작업이 끝난 뒤 기존 등록을 확인하세요.')
    print(json.dumps(plan,ensure_ascii=False,indent=2))
    if args.dry_run:
        print('DRY RUN: npm 의존성/플러그인 등록/launchd 변경 없음. 계정의 데이터는 보존합니다.')
        return 0
    command = lambda *arguments: [paseo,*arguments,'--home',home/'.paseo']
    if args.action == 'uninstall':
        if entry and same_plugin(entry):
            run(command('plugin','remove','role-workflow'),home)
        if plist.exists():
            current = plistlib.loads(plist.read_bytes())
            if str(ROOT/'scripts/auto-reapply-fold.py') in current.get('ProgramArguments',[]):
                run(['/bin/launchctl','bootout',f'gui/{os.getuid()}/{LABEL}'],home,check=False)
                plist.unlink()
        print('등록 해제 완료. 설정·워크플로·빌드·백업·로그는 삭제하지 않았습니다.')
        return 0
    if not (home/'.paseo/paseo.pid').exists():
        raise RuntimeError('이 계정에서 Paseo를 먼저 실행하세요. 설치기는 데몬을 시작하거나 재시작하지 않습니다.')
    if args.with_fold_reapply:
        app = app_path(config)
        if not app.exists() or app.stat().st_uid != os.getuid():
            raise RuntimeError('공용 앱 자동 재적용은 앱 소유 계정 한 곳에서만 등록하세요.')
        conflict = run(['/bin/launchctl','print',f'gui/{os.getuid()}/com.jino.paseo-fold-reapply'],home,check=False,capture=True)
        if conflict.returncode == 0:
            raise RuntimeError('기존 접기 감시 에이전트가 있습니다. 중복 등록하지 않습니다.')
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
    if not entry:
        run(command('plugin','install',ROOT/'plugin/role-workflow'),home)
    elif entry.get('enabled') is False:
        run(command('plugin','enable','role-workflow'),home)
    # An existing same-path registration is retained without interrupting active tasks.
    config.update(node=node,python=os.environ.get('PASEO_PUBLIC_PYTHON') or shutil.which('python3') or sys.executable,paseo=str(paseo),dependenciesLock=lock)
    config.setdefault('phoneNotifications',False)
    config_path().parent.mkdir(parents=True,exist_ok=True)
    config_path().write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
    config_path().chmod(0o600)
    if args.with_fold_reapply:
        data_root(config).mkdir(parents=True,exist_ok=True)
        logs_root(config).mkdir(parents=True,exist_ok=True)
        generated = plistlib.dumps(launch_plist(config,node,home),sort_keys=False)
        if not plist.exists() or plist.read_bytes() != generated:
            if plist.exists():
                run(['/bin/launchctl','bootout',f'gui/{os.getuid()}/{LABEL}'],home,check=False)
            plist.parent.mkdir(parents=True,exist_ok=True)
            plist.write_bytes(generated)
            run(['/bin/launchctl','bootstrap',f'gui/{os.getuid()}',plist],home)
    print('설치 완료. 폴더 열기는 사이드바/커맨드 센터에서 사용할 수 있습니다.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError,ValueError,subprocess.CalledProcessError) as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
