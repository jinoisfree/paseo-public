"""실행기 공용 경계: 제품 CLI 탐색과 키체인 토큰 전달만 담당한다."""
import json
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


def paseo_cli(app=None, *, validate_version=True):
    """Paseo는 앱 내장 CLI만 허용한다. PATH의 구버전 CLI로 대체하지 않는다."""
    vault = owner_vault()
    app = Path(app or vault.get('paths', {}).get('app') or os.environ.get('PASEO_APP', '/Applications/Paseo.app'))
    cli = app / 'Contents/Resources/bin/paseo'
    if not cli.is_absolute() or not cli.is_file() or not os.access(cli, os.X_OK):
        raise ValueError('Paseo 앱 내장 CLI가 없습니다. Paseo 앱 경로를 확인하세요.')
    info = app/'Contents/Info.plist'
    if validate_version and (not info.is_file() or not re.fullmatch(r'0\.15\.\d+(?:[-+].*)?', plistlib.loads(info.read_bytes()).get('CFBundleShortVersionString', ''))):
        raise ValueError('Paseo 지원 범위는 0.15.x입니다. 앱 설치·업데이트와 공항 호환성을 확인하세요.')
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
