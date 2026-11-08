"""실행기 공용 경계: 제품 CLI 탐색과 키체인 토큰 전달만 담당한다."""
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
    for candidate in [*candidates, *(str(Path(root) / 'bin' / product) for root in brew_roots)]:
        file = Path(candidate)
        if file.is_absolute() and file.is_file() and os.access(file, os.X_OK):
            return str(file)
    found = shutil.which(product, path=path)
    if found:
        return str(Path(found).absolute())
    raise ValueError(f'{product} 실행 파일이 없습니다. 제품 앱 또는 CLI를 설치하고 경로를 확인하세요.')


def paseo_cli(app=None):
    """Paseo는 앱 내장 CLI만 허용한다. PATH의 구버전 CLI로 대체하지 않는다."""
    app = Path(app or os.environ.get('PASEO_APP', '/Applications/Paseo.app'))
    cli = app / 'Contents/Resources/bin/paseo'
    if not cli.is_absolute() or not cli.is_file() or not os.access(cli, os.X_OK):
        raise ValueError('Paseo 앱 내장 CLI가 없습니다. Paseo 앱 경로를 확인하세요.')
    return str(cli)


def launch(product, args):
    cli = find_cli(product)
    env = dict(os.environ)
    if product == 'claude':
        service = env.get('PASEO_CLAUDE_KEYCHAIN_SERVICE')
        account = env.get('PASEO_CLAUDE_KEYCHAIN_ACCOUNT')
        if not service or not account:
            raise ValueError('금고에서 선택한 Claude 키체인 서비스·계정 이름을 전달해야 합니다.')
        try:
            token = subprocess.run(['/usr/bin/security', 'find-generic-password', '-s', service,
                                    '-a', account, '-w'], capture_output=True, text=True, check=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            raise ValueError('Claude 키체인 토큰을 읽을 수 없습니다. 로그인과 키체인 권한을 확인하세요.') from None
        if not token:
            raise ValueError('Claude 키체인 토큰이 비어 있습니다.')
        env.pop('ANTHROPIC_API_KEY', None)
        env.pop('ANTHROPIC_AUTH_TOKEN', None)
        env['CLAUDE_CODE_OAUTH_TOKEN'] = token
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
