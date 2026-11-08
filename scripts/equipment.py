"""설비 허가·충돌 판정. 읽기 전용 계획은 설치/검사/doctor가 함께 쓴다."""
import json
from pathlib import Path
import plistlib
import re
import shlex

PREFIX = 'io.github.jinoisfree.paseo-public.'


def conflicts(manifest, home, account):
    found = []
    for file in (home/'Library/LaunchAgents').glob('*.plist'):
        if file.stem.startswith(PREFIX):
            continue
        try:
            job = plistlib.loads(file.read_bytes())
        except (OSError, ValueError):
            found.append({'kind': 'unreadable-agent', 'path': str(file)})
            continue
        if str(job.get('Label', file.stem)).startswith(PREFIX):
            continue
        args = job.get('ProgramArguments', [])
        text = ' '.join(map(str, args))
        for rule in manifest.get('conflicts', []):
            match = False
            if rule['kind'] == 'paseo-command':
                try:
                    words = [word for arg in args for word in shlex.split(str(arg))]
                except ValueError:
                    words = []
                for i, word in enumerate(words):
                    if Path(word).name == 'paseo' and any(words[j:j+len(sequence)] == sequence for sequence in rule['commands'] for j in range(i+1, len(words))):
                        match = True
            elif rule['kind'] == 'watch-app':
                match = any(str(p).endswith('/Paseo.app/Contents/Info.plist') for p in job.get('WatchPaths', []))
            elif rule['kind'] == 'script-content':
                for arg in args:
                    candidate = Path(str(arg)).expanduser()
                    if candidate.is_absolute() and candidate.suffix in ('.sh', '.py', '') and candidate.is_file():
                        try:
                            body = candidate.read_text()
                            match = match or all(re.search(pattern, body) for pattern in rule['patterns'])
                        except (OSError, UnicodeError):
                            pass
            if match:
                found.append({'kind': rule['kind'], 'path': str(file)})
    for rule in manifest.get('conflicts', []):
        if rule['kind'] == 'plugin-source':
            for key, entry in account.get('plugins', {}).items():
                if key == 'codex-usage':
                    continue
                try:
                    body = (Path(entry.get('path', ''))/'index.server.ts').read_text()
                    if all(re.search(pattern, body) for pattern in rule['patterns']):
                        found.append({'kind': 'plugin-source', 'plugin': key})
                except (OSError, TypeError):
                    pass
        if rule['kind'] == 'provider-command':
            value = account.get('agents', {}).get('providers', {}).get(rule['provider'], {}).get('command')
            if value and PREFIX not in str(value) and '/airport/modules/' not in str(value):
                words = value if isinstance(value, list) else shlex.split(str(value))
                if any(Path(str(word)).suffix in ('.sh', '.py') for word in words):
                    found.append({'kind': 'provider-command', 'provider': rule['provider']})
    return found


def plan(root, home, account, recommended, policy, profile, fresh):
    grants = policy['decisions'].get('modules', {})
    wanted = set(recommended['profiles'][profile]['modules']) | set(grants)
    result = []
    for module_id in sorted(wanted):
        file = root/'modules'/module_id/'module.json'
        manifest = json.loads(file.read_text()) if file.exists() else {}
        grant = grants.get(module_id, {})
        allowed = grant.get('enabled', fresh and module_id in recommended['profiles'][profile]['modules'])
        blocked = conflicts(manifest, home, account)
        reason = '기존 구현과 충돌하여 설치 안 함' if blocked else '설비 허가 없음' if not allowed else '설치'
        result.append({'id': module_id, 'enabled': bool(allowed), 'variant': grant.get('variant', 'A'),
                       'install': bool(allowed and not blocked), 'reason': reason, 'conflicts': blocked})
    daemon = next((m for m in result if m['id'] == 'daemon-service'), None)
    if not daemon or not daemon['install']:
        for module in result:
            if module['id'] in ('update-watch', 'paseo-watchdog') and module['install']:
                module['install'] = False
                module['reason'] = 'daemon-service 설치가 허가되지 않아 설치 안 함'
    return result
