"""실행기 공용 경계: 제품 CLI 탐색과 키체인 토큰 전달만 담당한다."""
import json
import datetime
import fcntl
import tempfile
import plistlib
import re
import os
from pathlib import Path
import shutil
import subprocess
import sys

PRODUCT_CANDIDATES = {
    'claude': ('/Applications/Claude.app/Contents/Resources/claude',),
    'codex': ('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
              '/Applications/Codex.app/Contents/Resources/codex'),
}


def find_cli(product, bundled=None, brew_roots=('/opt/homebrew', '/usr/local'), path=None):
    """내장 → Homebrew → PATH. 찾은 결과는 항상 절대경로다."""
    candidates = PRODUCT_CANDIDATES[product] if bundled is None else bundled
    local = [str(Path.home()/'.local/bin/claude')] if product == 'claude' else []
    for candidate in [*candidates, *local, *(str(Path(root) / 'bin' / product) for root in brew_roots)]:
        file = Path(candidate)
        if file.is_absolute() and file.is_file() and os.access(file, os.X_OK):
            return str(file)
    found = shutil.which(product, path=path)
    if found:
        return str(Path(found).absolute())
    raise ValueError(f'{product} 실행 파일이 없습니다. 제품 앱 또는 CLI를 설치하고 경로를 확인하세요.')


def tested_version(version):
    return bool(re.fullmatch(r'0\.15\.\d+(?:[-+].*)?', version or ''))


def app_version(app):
    try:
        value = plistlib.loads((Path(app)/'Contents/Info.plist').read_bytes()).get('CFBundleShortVersionString', '')
        return value if isinstance(value, str) and re.fullmatch(r'[0-9A-Za-z.+-]{1,80}', value) else 'unknown'
    except (OSError, ValueError):
        return 'unknown'


def warn_version(version, home=None, notify=None):
    """C30: compatibility is advisory. Share an atomic once-per-version receipt across jobs."""
    if tested_version(version):
        return
    message = f'Paseo {version}: 검증 범위 0.15.x 밖입니다. 실행은 계속하며 공항 호환성을 확인하세요.'
    directory = Path(home or os.environ.get('PASEO_HOME', Path.home()/'.paseo'))/'airport/runtime'
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (directory/'version-warnings.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            file = directory/'version-warnings.json'
            try:
                versions = json.loads(file.read_text()) if file.exists() else {}
                if not isinstance(versions, dict): versions = {}
            except ValueError:
                versions = {}
            if version in versions:
                return
            versions[version] = {'date': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'warning': message}
            fd, temporary = tempfile.mkstemp(dir=directory, prefix='.version-warnings-')
            try:
                with os.fdopen(fd, 'w') as out:
                    os.fchmod(out.fileno(), 0o600)
                    json.dump(versions, out, ensure_ascii=False)
                    out.flush(); os.fsync(out.fileno())
                os.replace(temporary, file)
            finally:
                if os.path.exists(temporary): os.unlink(temporary)
            print(message, file=sys.stderr)
            if notify:
                notify(message)
            else:
                subprocess.run(['/usr/bin/osascript', '-e', 'display notification '+json.dumps(message)+' with title "Paseo 호환성"'], capture_output=True, timeout=10)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        # A failed warning receipt/notification must never stop the daemon or updater.
        print('Paseo 호환성 경고 기록·알림 실패. 실행을 계속합니다.', file=sys.stderr)


def paseo_cli(app=None, *, validate_version=True):
    """Paseo는 앱 내장 CLI만 허용한다. PATH의 구버전 CLI로 대체하지 않는다."""
    vault = owner_vault()
    app = Path(app or vault.get('paths', {}).get('app') or os.environ.get('PASEO_APP', '/Applications/Paseo.app'))
    cli = app / 'Contents/Resources/bin/paseo'
    if not cli.is_absolute() or not cli.is_file() or not os.access(cli, os.X_OK):
        raise ValueError('Paseo 앱 내장 CLI가 없습니다. Paseo 앱 경로를 확인하세요.')
    if validate_version:
        warn_version(app_version(app))
    return str(cli)


def owner_vault():
    home = Path(os.environ.get('PASEO_HOME', Path.home()/'.paseo'))
    file = home/'owner/vault.json'
    return json.loads(file.read_text()) if file.exists() else {}


def launch(product, args):
    cli = find_cli(product)
    env = dict(os.environ)
    if product == 'claude':
        credential = owner_vault().get('keychain', {}).get('claude', {})
        service = credential.get('service') or env.get('PASEO_CLAUDE_KEYCHAIN_SERVICE')
        account = credential.get('account') or env.get('PASEO_CLAUDE_KEYCHAIN_ACCOUNT')
        token = None
        if service and account:
            try:
                result = subprocess.run(['/usr/bin/security', 'find-generic-password', '-s', service,
                                         '-a', account, '-w'], capture_output=True, text=True, check=False)
            except OSError:
                raise ValueError('Claude 키체인 조회를 실행할 수 없습니다. 권한을 확인하세요.') from None
            if result.returncode not in (0, 44):
                raise ValueError('Claude 키체인 조회가 거부됐습니다. 키체인 권한을 확인하세요.')
            token = result.stdout.strip() if result.returncode == 0 else None
        env.pop('ANTHROPIC_API_KEY', None)
        env.pop('ANTHROPIC_AUTH_TOKEN', None)
        env.pop('CLAUDE_CODE_OAUTH_TOKEN', None)
        env.setdefault('CLAUDE_CONFIG_DIR', str(Path(env.get('PASEO_HOME', Path.home()/'.paseo'))/'claude-home'))
        if token:
            env['CLAUDE_CODE_OAUTH_TOKEN'] = token
        else:
            print('Claude 키체인 항목이 없어 토큰 없이 분리 홈 로그인을 사용합니다. 필요하면 해당 홈에서 1회 로그인하세요.', file=sys.stderr)
    else:
        env.pop('OPENAI_API_KEY', None)
        env.pop('CODEX_API_KEY', None)
    # 홈·모델·권한·설정 조립은 제공자 env와 후속 설치기가 맡는다.
    os.execve(cli, [cli, *args], env)


def main(product):
    try:
        launch(product, sys.argv[1:])
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0
