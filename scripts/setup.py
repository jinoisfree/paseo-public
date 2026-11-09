#!/usr/bin/env python3
"""공항 조립·갱신·읽기 전용 검사. 개인값은 owner, 생성물은 airport가 소유한다."""
import argparse
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import time
from xml.sax.saxutils import escape
sys.dont_write_bytecode = True
from public_runtime import (ROOT, AUTO_UPDATE_LABEL, paseo_home, config_path,
    load_config, node_executable, app_path, busy_workflows, verify_plugin_entries,
    auto_update_agent_state, auto_update_agent_installed)
from owner_store import atomic_bytes, atomic_json, read_owner, save_owner, today
from airport_schema import validate_schema, SCHEMAS
from equipment import plan as equipment_plan
from claude_home import desired as claude_desired

sys.path.insert(0, str(ROOT/'modules'))
from launcher_runtime import tested_version, warn_version

PREFIX = 'io.github.jinoisfree.paseo-public.'
STABLE_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']


def stable_path(node, python, home=None):
    # C36/F4: ~/.local/bin is Claude Code's default install location; it goes last so system tools win.
    user_bin = [str(Path(home)/'.local/bin')] if home else []
    return os.pathsep.join(dict.fromkeys([str(Path(node).parent), str(Path(python).parent), *STABLE_PATHS, *user_bin]))


def run(command, home, *, check=True, capture=True):
    env = os.environ.copy()
    env.update(HOME=str(home), PASEO_HOME=str(paseo_home(home)), PYTHONDONTWRITEBYTECODE='1')
    env.pop('PASEO_HOST', None)
    try:
        result = subprocess.run(list(map(str, command)), cwd=ROOT, env=env, capture_output=capture, text=True, timeout=3600 if Path(str(command[0])).name == 'npm' else 30)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f'명령 시간 초과: {Path(str(command[0])).name}') from error
    if check and result.returncode:
        # CLI output may contain secrets; keep it out of terminal, JSON and refresh logs.
        raise RuntimeError(f'명령 실패: {Path(str(command[0])).name} (종료 코드 {result.returncode})')
    return result


def cli_path(config):
    # Product-owned CLI only. A PATH installation is diagnosed, never selected.
    bundled = app_path(config)/'Contents/Resources/bin/paseo'
    if not bundled.is_absolute() or not bundled.is_file():
        raise RuntimeError('Paseo 앱 내장 CLI를 찾지 못했습니다. 앱을 설치하고 금고 paths.app을 확인하세요.')
    return bundled


def verify_cli(paseo, home):
    result = run([paseo, '--version'], home, check=False)
    version = re.search(r'(?<![\d.])(\d+)\.(\d+)\.(\d+)(?![\d.])', result.stdout or '')
    if result.returncode or not version:
        raise RuntimeError('Paseo 앱 CLI 버전을 읽지 못했습니다. 앱 설치를 확인하세요.')
    warn_version(version[0], paseo_home(home), notify=lambda message: run(
        ['/usr/bin/osascript', '-e', 'display notification '+json.dumps(message)+' with title "Paseo 호환성"'], home, check=False))


def read_paseo(home):
    file = paseo_home(home)/'config.json'
    return json.loads(file.read_text()) if file.exists() else {}


def same_plugin(entry, root=None):
    return (isinstance(entry, dict) and entry.get('source') == 'directory' and
            Path(entry.get('path', '')).resolve() == ((root or ROOT)/'plugin/role-workflow').resolve())


def merge(base, overlay):
    result = copy.deepcopy(base)
    for key, value in overlay.items():
        result[key] = merge(result.get(key, {}) if isinstance(result.get(key), dict) else {}, value) if isinstance(value, dict) else copy.deepcopy(value)
    return result


def differences(expected, actual, source, prefix='', strict=False):
    rows = []
    if isinstance(expected, dict):
        for key, value in expected.items():
            rows += differences(value, actual.get(key) if isinstance(actual, dict) else None, source, f'{prefix}.{key}' if prefix else key, strict)
        if strict and isinstance(actual, dict):
            rows += [{'key': f'{prefix}.{key}', 'expected': '없음', 'actual': '<추가 항목>', 'source': source} for key in actual.keys() - expected.keys()]
    elif expected != actual or type(expected) is not type(actual):
        secret = bool(re.search(r'token|secret|password|authorization|keychain|credential|api.?key|endpoint|command|env(?:\.|$)', prefix, re.I))
        mismatched = type(expected) is not type(actual) and actual is not None
        rows.append({'key': prefix, 'expected': '<가림>' if secret else expected,
                     'actual': '<가림>' if secret else '<형식 불일치>' if mismatched else actual, 'source': source})
    return rows


def desktop_file(home):
    return home/'Library/Application Support/Paseo/desktop-settings.json'


def read_json(file, default=None):
    return json.loads(file.read_text()) if file.exists() else copy.deepcopy(default if default is not None else {})


def launch_plist(config, node, home):
    python = config.get('python', sys.executable)
    values = {'__PYTHON__': python, '__REPOSITORY__': str(ROOT), '__HOME__': str(home),
              '__PATH__': stable_path(node, python, home), '__APP__': str(app_path(config)),
              '__PASEO_HOME__': str(paseo_home(home)), '__LOGS__': str(paseo_home(home)/'airport/logs'),
              '__CONFIG__': str(config_path())}
    content = (ROOT/'launchd/auto-update.plist.in').read_text()
    for key, value in values.items():
        content = content.replace(key, escape(str(value)))
    return plistlib.loads(content.encode())


def install_agent(label, generated, home):
    if not label.startswith(PREFIX):
        raise RuntimeError('공항 소유가 아닌 LaunchAgent입니다.')
    file = home/'Library/LaunchAgents'/(label+'.plist')
    job = plistlib.loads(generated)
    for key in ('StandardOutPath', 'StandardErrorPath'):
        if job.get(key): Path(job[key]).parent.mkdir(parents=True, exist_ok=True)
    if file.exists() and file.read_bytes() == generated and file.stat().st_mode & 0o777 == 0o600:
        # C36/F6: an unchanged file whose job was unloaded must be loaded again, not reported as an error.
        if not agent_loaded(label, home):
            bootstrap_agent(file, label, home)
        return
    if file.exists():
        run(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{label}'], home, check=False)
        wait_unloaded(label, home)
    atomic_bytes(file, generated)
    bootstrap_agent(file, label, home)


LAUNCHD_WAIT_SECONDS = 30
LAUNCHD_POLL_SECONDS = 1
BOOTSTRAP_ATTEMPTS = 5
DAEMON_ADOPT_SECONDS = 60


def agent_loaded(label, home):
    return run(['/bin/launchctl', 'print', f'gui/{os.getuid()}/{label}'], home, check=False).returncode == 0


def wait_unloaded(label, home):
    # bootout returns before launchd finishes tearing a KeepAlive job down; bootstrapping then fails with 5.
    deadline = time.monotonic() + LAUNCHD_WAIT_SECONDS
    while agent_loaded(label, home) and time.monotonic() < deadline:
        time.sleep(LAUNCHD_POLL_SECONDS)


def bootstrap_agent(file, label, home):
    # C36/F5: retry the transient launchd I/O error so a reload never leaves the job (and the daemon) unloaded.
    for attempt in range(BOOTSTRAP_ATTEMPTS):
        result = run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', file], home, check=False)
        if result.returncode == 0 or agent_loaded(label, home):
            break
        time.sleep(LAUNCHD_POLL_SECONDS * (attempt + 1))
    run(['/bin/launchctl', 'print', f'gui/{os.getuid()}/{label}'], home)


def agent_pid(label, home):
    result = run(['/bin/launchctl', 'print', f'gui/{os.getuid()}/{label}'], home, check=False)
    match = re.search(r'^\s*pid = (\d+)\s*$', result.stdout or '', re.M) if result.returncode == 0 else None
    return int(match[1]) if match else None


def daemon_parent(home):
    try:
        pid = read_json(paseo_home(home)/'paseo.pid')['pid']
    except (OSError, KeyError, ValueError, TypeError):
        return None
    parent = run(['/bin/ps', '-o', 'ppid=', '-p', str(pid)], home, check=False).stdout.strip()
    return int(parent) if parent.isdigit() else None


def daemon_running(home):
    try:
        pid = read_json(paseo_home(home)/'paseo.pid')['pid']
        if type(pid) is not int or pid <= 0:
            return False
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, KeyError, ValueError, TypeError):
        return False


def backup(home):
    folder = home/'Library/Application Support/paseo-public/backups'/('install-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    files = [(paseo_home(home)/'config.json', 'config.json'), (desktop_file(home), 'desktop-settings.json')]
    owner = paseo_home(home)/'owner'
    if owner.exists():
        files += [(f, 'owner/'+str(f.relative_to(owner))) for f in owner.rglob('*') if f.is_file()]
    folder.mkdir(parents=True, mode=0o700)
    for file, name in files:
        if file.exists():
            atomic_bytes(folder/name, file.read_bytes())
    return folder


def module_files(ids, home, config=None):
    """Resolve only declared files within repository and airport install root."""
    rows = []
    config = load_config() if config is None else config
    install_root = paseo_home(home)/'airport'
    for module_id in ids:
        if not re.fullmatch(r'[a-z][a-z0-9-]*', module_id):
            raise RuntimeError('설비 id 형식이 올바르지 않습니다.')
        manifest = ROOT/'modules'/module_id/'module.json'
        if not manifest.is_file():
            raise RuntimeError(f'설비 명세가 없습니다: {module_id}. 설비 배포를 먼저 완료하세요.')
        data = read_json(manifest)
        validate_schema(data, read_json(SCHEMAS/'module.schema.json'))
        if data['id'] != module_id:
            raise RuntimeError('설비 id가 디렉터리와 다릅니다.')
        for item in data['installs']:
            if item.get('variant') and item['variant'] != config.get('moduleVariants', {}).get(module_id, data.get('defaultVariant', 'A')):
                continue
            source = (ROOT/item['source']).resolve()
            target = Path(item['target'].replace('$INSTALL_ROOT', str(install_root)).replace('$LAUNCH_AGENTS', str(home/'Library/LaunchAgents'))).resolve()
            owned_agent = target.parent == (home/'Library/LaunchAgents').resolve() and target.name.startswith(PREFIX) and target.suffix == '.plist'
            if not source.is_relative_to(ROOT.resolve()) or not (target.is_relative_to(install_root.resolve()) or owned_agent):
                raise RuntimeError('설비 설치 경로가 소유 범위를 벗어납니다.')
            content = source.read_bytes()
            if source.name.endswith('.in'):
                node = node_executable(config)
                python = config.get('python', sys.executable)
                replacements = {'__HOME__': str(home), '__PASEO_HOME__': str(paseo_home(home)),
                    '__INSTALL_ROOT__': str(install_root), '__REPOSITORY__': str(ROOT),
                    '__NODE__': node, '__PYTHON__': python, '__PATH__': stable_path(node, python, home), '__APP__': str(app_path(config))}
                text = content.decode()
                for key, value in replacements.items():
                    text = text.replace(key, escape(value) if target.suffix == '.plist' else value)
                if re.search(r'__[A-Z_]+__', text):
                    raise RuntimeError('설비 틀에 해석하지 못한 변수가 있습니다.')
                content = text.encode()
            if owned_agent:
                generated = plistlib.loads(content)
                if generated.get('Label') != target.stem:
                    raise RuntimeError('설비 plist 라벨과 파일명이 다릅니다.')
            rows.append({'source': source, 'target': target, 'content': content, 'mode': 0o700 if source.suffix == '.py' else 0o600})
    return rows


def generated_cleanup(home):
    """Delete only proven-unreferenced generated rules/guides; uncertainty retains everything."""
    directory = paseo_home(home)/'role-workflow'
    state_file = directory/'state.json'
    if not state_file.exists():
        return []
    try:
        state = read_json(state_file)
        workflows = state['workflows']
        if not isinstance(workflows, list) or any(not isinstance(w, dict) for w in workflows):
            return []
        current = re.search(r'export const RULES_VERSION = "([a-f0-9]+)"', (ROOT/'plugin/role-workflow/server/rules-content.ts').read_text())
        if not current:
            return []
        live = [w for w in workflows if w.get('status') != 'archived']
        references = json.dumps(live, ensure_ascii=False)
        # Prompts live in core agent records, not necessarily in workflow state.
        # Read every non-archived agent record; malformed/unreadable evidence retains all.
        for record in (paseo_home(home)/'agents').rglob('*.json'):
            agent = read_json(record)
            if not isinstance(agent, dict):
                return []
            if not agent.get('archived', False) or record.stem in references:
                references += json.dumps(agent, ensure_ascii=False)
        # With live workflows but no core records we cannot prove absence of references.
        if live and not (paseo_home(home)/'agents').exists():
            return []
        rows = []
        for folder in ('rules', 'guides'):
            for file in (directory/folder).glob('*'):
                if folder == 'rules' and file.name == current[1]:
                    continue
                if file.name in references or str(file) in references:
                    continue
                rows.append(file)
        return rows
    except (OSError, ValueError, KeyError):
        return []


class ProfileRequired(RuntimeError):
    """Old updater calls must stop before their first write, with a distinct exit code."""


class Airport:
    def __init__(self, home=None):
        self.home = Path(home or Path.home())
        self.directory = paseo_home(self.home)
        self.policy_file = self.directory/'owner/policy.json'
        self.vault_file = self.directory/'owner/vault.json'
        self.policy = read_owner(self.policy_file, 'policy')
        self.vault = read_owner(self.vault_file, 'vault')
        self.record_file = self.directory/'airport/install.json'
        self.record = read_json(self.record_file)
        self.config = load_config()
        self.recommended = read_json(ROOT/'plugin/role-workflow/shared/presets/recommended.json')
        self.fresh = not self.legacy_installation()
        self.replacing_auto_update = False

    def decision(self, key, default=None):
        return self.policy['decisions'].get(key, {}).get('value', default)

    def legacy_installation(self):
        return bool(read_paseo(self.home).get('plugins', {}).get('role-workflow') or
                    (self.directory/'role-workflow/state.json').exists() or config_path().exists() or
                    (self.home/'.config/paseo-public/config.json').exists() or
                    list((self.home/'Library/LaunchAgents').glob(PREFIX+'*.plist')))

    def profile(self, option=None, *, installing=False):
        choice = self.decision('profile') or option
        if choice:
            return choice
        if installing and self.legacy_installation():
            raise ProfileRequired('기존 설치의 운영 프로필 결정이 없습니다. ./install.sh --profile server|desktop 으로 명시하세요.')
        return 'desktop'

    def expected(self, option=None):
        profile = self.recommended['profiles'][self.profile(option)]
        core = merge(self.recommended['core'], self.decision('core', {}))
        desktop = merge(profile['desktopSettings'], self.decision('desktopSettings', {}))
        keep = self.decision('keepRunningAfterQuit')
        if keep is not None:
            desktop = merge(desktop, {'daemon': {'keepRunningAfterQuit': keep}})
        modules = [m['id'] for m in self.module_plan(option) if m['install']]
        providers = {}
        if 'claude-home' in modules:
            providers['claude'] = {'env': {'CLAUDE_CONFIG_DIR': str(self.directory/'claude-home')}}
        for product in ('claude', 'codex'):
            if product+'-launcher' in modules:
                providers.setdefault(product, {})['command'] = [self.tools()[1], str(self.directory/'airport/modules'/f'{product}-launcher/launcher.py')]
                if product == 'codex':
                    providers[product]['env'] = {'CODEX_HOME': core.get('agents', {}).get('providers', {}).get('codex', {}).get('env', {}).get('CODEX_HOME', str(self.directory/'codex-home'))}
        if providers:
            core = merge(core, {'agents': {'providers': providers}})
        return core, {'settings': desktop}, modules

    def module_plan(self, option=None):
        return equipment_plan(ROOT, self.home, read_paseo(self.home), self.recommended, self.policy, self.profile(option), self.fresh)

    def module_config(self):
        return {**self.config, 'moduleVariants': {m['id']: m['variant'] for m in self.module_plan()}}

    def set_archive(self, root=None, days=None, dry_run=False):
        """Owner decision for archive-rotate: where (e.g. an external SSD) and after how many days."""
        if root is not None and not Path(root).expanduser().is_absolute():
            raise RuntimeError('보관 위치는 절대경로여야 합니다.')
        if days is not None and days < 1:
            raise RuntimeError('보관 기준 일수는 1 이상이어야 합니다.')
        policy = copy.deepcopy(self.policy)
        decision = {**policy['decisions'].get('archiveRotate', {}), 'date': today()}
        if root is not None: decision['root'] = str(Path(root).expanduser())
        if days is not None: decision['days'] = days
        policy['decisions']['archiveRotate'] = decision
        if not dry_run:
            self.policy = save_owner(self.policy_file, 'policy', policy, self.policy['revision'])
        return {'archiveRotate': decision, 'dryRun': dry_run}

    def set_module(self, module_id, enabled, variant=None, dry_run=False):
        if not module_id or not re.fullmatch(r'[a-z][a-z0-9-]*', module_id):
            raise RuntimeError('알 수 없는 설비입니다.')
        manifest = ROOT/'modules'/module_id/'module.json'
        if not manifest.is_file():
            raise RuntimeError('알 수 없는 설비입니다: '+module_id)
        data = read_json(manifest)
        validate_schema(data, read_json(SCHEMAS/'module.schema.json'))
        if data['id'] != module_id:
            raise RuntimeError('설비 id가 디렉터리와 다릅니다.')
        policy = copy.deepcopy(self.policy)
        grants = policy['decisions'].setdefault('modules', {})
        grant = {**grants.get(module_id, {}), 'enabled': enabled, 'date': today()}
        if variant: grant['variant'] = variant
        grants[module_id] = grant
        if not dry_run:
            self.policy = save_owner(self.policy_file, 'policy', policy, self.policy['revision'])
        return {'module': module_id, 'decision': grant, 'dryRun': dry_run,
                'instruction': 'install을 실행하면 적용됩니다.'}

    def remove_disabled_modules(self, keep_rows, *, files_only=False):
        """C31/C17: restore opt-outs and dependent jobs, retaining shared and unowned files."""
        disabled = [name for name, grant in self.policy['decisions'].get('modules', {}).items() if not grant['enabled']]
        selected = {row['id'] for row in self.module_plan() if row['install']}
        disabled = sorted(set(disabled) | {row['id'] for row in self.record.get('equipment', []) if row['install'] and row['id'] not in selected})
        if not disabled: return
        if files_only:
            keep = {str(row['target']) for row in keep_rows}
            installed = self.record.setdefault('generatedFiles', [])
            files = {str(row['target']): row['target'] for row in module_files(disabled, self.home, self.module_config())
                     if str(row['target']) in installed and str(row['target']) not in keep}
            agents = (self.home/'Library/LaunchAgents').resolve()
            # Stop dependent jobs before their supervisor, and all jobs before shared code removal.
            for file in sorted(files.values(), key=lambda f: (f.parent != agents, f.stem == PREFIX+'daemon-service')):
                if file.parent == agents and file.exists():
                    run(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{file.stem}'], self.home, check=False)
                file.unlink(missing_ok=True)
                installed.remove(str(file))
            atomic_json(self.record_file, self.record)
            return
        account = read_paseo(self.home)
        before = copy.deepcopy(account.get('agents', {}))
        providers = account.get('agents', {}).get('providers', {})
        commands = self.record.get('providerCommands', {})
        environments = self.record.get('providerEnvironment', {})
        for product in ('claude', 'codex'):
            provider = providers.get(product, {})
            if product+'-launcher' in disabled and product in commands:
                path = str(self.directory/'airport/modules'/f'{product}-launcher/launcher.py')
                if path in (provider.get('command') or []):
                    previous = commands[product]
                    if previous is None: provider.pop('command', None)
                    else: provider['command'] = previous
                commands.pop(product)
            keys = []
            if product == 'claude' and 'claude-home' in disabled: keys.append('CLAUDE_CONFIG_DIR')
            if product == 'codex' and 'codex-launcher' in disabled: keys.append('CODEX_HOME')
            for key in keys:
                record = environments.get(product, {}).pop(key, None)
                env = provider.get('env', {})
                if record and env.get(key) == record['installed']:
                    if record['before'] is None: env.pop(key, None)
                    else: env[key] = record['before']
        # Restore the command before deleting its executable; preserve subsequent user edits.
        if account.get('agents', {}) != before:
            self.command('daemon', 'config', 'set', 'agents', json.dumps(account['agents']))
        if 'claude-home' in disabled:
            self.restore_claude()
            for key in ('claudeSettingsBefore', 'claudeSettingsHash', 'claudeSkillLinks'):
                self.record.pop(key, None)
        atomic_json(self.record_file, self.record)

    def tools(self):
        node = node_executable(self.config)
        python = self.config.get('python') or os.environ.get('PASEO_PUBLIC_PYTHON') or sys.executable
        python = Path(python).expanduser()
        if not python.is_absolute() or not python.is_file() or not os.access(python, os.X_OK):
            raise RuntimeError('금고 paths.python은 실행 가능한 절대 경로여야 합니다.')
        return node, str(python), cli_path(self.config)

    def command(self, *args, check=True):
        return run([cli_path(self.config), *args, '--home', self.directory], self.home, check=check)

    def ensure_idle(self):
        busy = busy_workflows(self.home)
        if busy:
            raise RuntimeError('진행 중인 작업이 있어 변경을 중단합니다: '+', '.join(map(str, busy)))

    def dependencies(self):
        lock = hashlib.sha256((ROOT/'package-lock.json').read_bytes()).hexdigest()
        if lock != self.record.get('dependenciesLock') or not (ROOT/'node_modules/.bin/tsx').exists():
            node = self.tools()[0]
            npm = Path(node).parent/'npm'
            if not npm.is_file():
                npm = Path(shutil.which('npm') or '/missing/npm')
            run([npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], self.home)
        self.record['dependenciesLock'] = lock

    def install_modules(self, rows):
        installed = self.record.setdefault('generatedFiles', [])
        for row in rows:
            target = row['target']
            if not target.exists() or target.read_bytes() != row['content'] or target.stat().st_mode & 0o777 != row['mode']:
                if target.parent == (self.home/'Library/LaunchAgents').resolve():
                    install_agent(target.stem, row['content'], self.home)
                else:
                    atomic_bytes(target, row['content'], row['mode'])
            if str(target) not in installed:
                installed.append(str(target))

    def agents(self, auto_update=False):
        # Enabled jobs are recorded as installer output, not in the owner's decisions.
        if auto_update or auto_update_agent_installed(self.home, ROOT):
            self.record['autoUpdate'] = True
        if self.record.get('autoUpdate'):
            if auto_update_agent_state(self.home, ROOT) == 'foreign' and not self.replacing_auto_update:
                raise RuntimeError('다른 저장소의 자동 업데이트가 등록돼 있어 변경하지 않습니다.')
            node, python, _ = self.tools()
            (self.directory/'airport/logs/auto-update').mkdir(parents=True, exist_ok=True)
            install_agent(AUTO_UPDATE_LABEL, plistlib.dumps(launch_plist({**self.config, 'python': python}, node, self.home), sort_keys=False), self.home)

    def install_blockers(self, args):
        """C37: every refusal install would raise, read without writing so dry-run reports the same set."""
        blockers = []
        def add(key, message): blockers.append({'key': key, 'message': message})
        entry = read_paseo(self.home).get('plugins', {}).get('role-workflow')
        if entry and not same_plugin(entry) and not args.replace_registration:
            add('registration', '다른 경로에 이미 등록돼 있습니다. --replace-registration으로 전환하세요.')
        if sys.version_info < (3, 12):
            add('python', 'Python 3.12 이상이 필요합니다.')
        try:
            node_version = version([self.tools()[0], '--version'], self.home)
        except RuntimeError as error:
            add('tools', str(error))
        else:
            if not node_version or int(node_version.split('.')[0]) < 22:
                add('node', 'Node.js 22 이상이 필요합니다.')
        if not daemon_running(self.home):
            add('daemon', '이 계정에서 Paseo를 먼저 실행하세요.')
        busy = busy_workflows(self.home)
        if busy:
            add('busy', '진행 중인 작업이 있어 변경을 중단합니다: '+', '.join(map(str, busy)))
        if args.with_auto_update and auto_update_agent_state(self.home, ROOT) == 'foreign' and not args.replace_registration:
            add('autoUpdate', '다른 저장소의 자동 업데이트가 이미 등록돼 있습니다. --replace-registration으로 교체하세요.')
        return blockers

    def ungranted_notice(self, option=None):
        # C37: a continuing owner is never granted equipment silently; say what the profile recommends.
        grants = self.policy['decisions'].get('modules', {})
        missing = [] if self.fresh else [m for m in self.recommended['profiles'][self.profile(option)]['modules'] if m not in grants]
        return ['기존 설치를 이어받아 프로필 권장 설비를 자동 허가하지 않았습니다: '+', '.join(missing)+
                '. 쓰려면 setup.py enable <설비> 후 install을 다시 실행하세요.'] if missing else []

    def install(self, args):
        self.profile(args.profile, installing=True)
        core, desktop, ids = self.expected(args.profile)
        rows = module_files(ids, self.home, self.module_config())  # Validate all sources before the first write.
        node, python, paseo = self.tools()
        verify_cli(paseo, self.home)
        blockers = self.install_blockers(args)
        if blockers:
            raise RuntimeError(blockers[0]['message'])
        replacing = args.with_auto_update and auto_update_agent_state(self.home, ROOT) == 'foreign'
        saved = backup(self.home)
        if replacing:
            # C37: the other clone's job is kept for rollback; install_agent then boots it out and overwrites it.
            agent = self.home/'Library/LaunchAgents'/(AUTO_UPDATE_LABEL+'.plist')
            (saved/'LaunchAgents').mkdir(parents=True, exist_ok=True)
            shutil.copy2(agent, saved/'LaunchAgents'/agent.name)
            self.replacing_auto_update = True
        policy = copy.deepcopy(self.policy)
        if self.fresh:
            grants = policy['decisions'].setdefault('modules', {})
            for module_id in self.recommended['profiles'][self.profile(args.profile)]['modules']:
                grants.setdefault(module_id, {'enabled': True, 'date': today()})
        policy['decisions'].setdefault('profile', {'value': self.profile(args.profile), 'date': today()})
        for key in ('phoneNotifications', 'phoneNotificationEndpoint'):
            if key in self.config:
                policy['notifications'].setdefault(key, self.config[key])
        self.policy = save_owner(self.policy_file, 'policy', policy, self.policy['revision'])
        vault = copy.deepcopy(self.vault)
        vault['paths'] = {**vault.get('paths', {}), 'node': node, 'python': python, 'app': str(app_path(self.config))}
        self.vault = save_owner(self.vault_file, 'vault', vault, self.vault['revision'])
        self.config.update(self.vault['paths'])
        self.remove_disabled_modules(rows)
        account = read_paseo(self.home)
        self.dependencies()
        self.capture_providers(core, account)
        codex_home = core.get('agents', {}).get('providers', {}).get('codex', {}).get('env', {}).get('CODEX_HOME')
        if codex_home:
            # C37: Codex refuses a missing CODEX_HOME, and the daemon keeps that failure until restart.
            Path(codex_home).expanduser().mkdir(parents=True, exist_ok=True, mode=0o700)
        if 'claude-home' in ids:
            self.assemble_claude()
        agent_directory = (self.home/'Library/LaunchAgents').resolve()
        self.install_modules([row for row in rows if row['target'].parent != agent_directory])
        atomic_json(self.record_file, self.record)
        # CLI supports top-level objects; preserve unrelated nested fields in each object.
        for key, value in core.items():
            actual = read_paseo(self.home).get(key)
            expected = merge(actual if isinstance(actual, dict) else {}, value) if isinstance(value, dict) else value
            if actual != expected:
                self.command('daemon', 'config', 'set', key, json.dumps(expected))
        current_desktop = read_json(desktop_file(self.home), {'version': 1, 'settings': {}})
        adjusted = merge(current_desktop, desktop)
        if adjusted != current_desktop:
            atomic_json(desktop_file(self.home), adjusted)
        account = read_paseo(self.home)
        plugins = copy.deepcopy(account.get('plugins', {}))
        desired = {'source': 'directory', 'path': str(ROOT/'plugin/role-workflow'), 'enabled': True}
        desired_plugins = {**plugins, 'role-workflow': desired}
        if 'codex-usage' in ids:
            desired_plugins['codex-usage'] = {'source': 'directory', 'path': str(ROOT/'plugin/codex-usage'), 'enabled': True}
        if self.policy['decisions'].get('modules', {}).get('codex-usage', {}).get('enabled') is False:
            usage = desired_plugins.get('codex-usage', {})
            if usage.get('source') == 'directory' and Path(usage.get('path', '')).resolve() == (ROOT/'plugin/codex-usage').resolve():
                desired_plugins.pop('codex-usage')
        changed_registration = plugins != desired_plugins
        if changed_registration:
            self.ensure_idle()
            self.command('daemon', 'config', 'set', 'plugins', json.dumps(desired_plugins))
            self.command('daemon', 'restart')
            verify_registration(paseo, self.home)
        activated = version(['git', 'rev-parse', 'HEAD'], self.home, raw=True)
        if not changed_registration and activated and self.record.get('activatedCommit') != activated:
            self.ensure_idle()
            for plugin_id in ['role-workflow', *(['codex-usage'] if 'codex-usage' in ids else [])]:
                self.command('plugin', 'reload', plugin_id)
                verify_registration(paseo, self.home, plugin_id=plugin_id)
        if changed_registration and 'codex-usage' in ids:
            verify_registration(paseo, self.home, plugin_id='codex-usage')
        if activated: self.record['activatedCommit'] = activated
        self.install_modules([row for row in rows if row['target'].parent == agent_directory])
        # A variant B bootout can stop the daemon: finish every CLI mutation first.
        self.agents(args.with_auto_update)
        self.adopt_daemon(ids)
        self.remove_disabled_modules(rows, files_only=True)
        self.record['equipment'] = self.module_plan()
        atomic_json(self.record_file, self.record)
        checked = self.check()
        if checked['differences']:
            raise RuntimeError('설치 후 check 차이가 남았습니다. check --json과 설치 백업을 확인하세요.')
        return {'backup': str(saved), 'profile': self.profile(), 'equipment': self.module_plan(), 'notices': self.notices()+self.ungranted_notice()}

    def adopt_daemon(self, ids):
        """C37: variant B's `daemon run` exits while a daemon started elsewhere holds the home; hand it over once idle."""
        if 'daemon-service' not in ids or self.module_config()['moduleVariants'].get('daemon-service') != 'B':
            return
        label = PREFIX+'daemon-service'
        job = agent_pid(label, self.home)
        if not daemon_running(self.home) or (job and daemon_parent(self.home) == job):
            return
        self.ensure_idle()
        self.command('daemon', 'stop')
        deadline = time.monotonic() + DAEMON_ADOPT_SECONDS
        while time.monotonic() < deadline:
            job = agent_pid(label, self.home)
            if job and daemon_running(self.home) and daemon_parent(self.home) == job:
                return
            time.sleep(LAUNCHD_POLL_SECONDS)
        raise RuntimeError(f'데몬 서비스가 데몬을 넘겨받지 못했습니다. launchctl print gui/{os.getuid()}/{label}로 확인하세요.')

    def capture_providers(self, core, actual):
        for provider, desired in core.get('agents', {}).get('providers', {}).items():
            original = actual.get('agents', {}).get('providers', {}).get(provider, {})
            if 'command' in desired:
                self.record.setdefault('providerCommands', {}).setdefault(provider, original.get('command'))
            for key,value in desired.get('env', {}).items():
                entry = self.record.setdefault('providerEnvironment', {}).setdefault(provider, {}).setdefault(key, {'before': original.get('env', {}).get(key)})
                entry['installed'] = value
        atomic_json(self.record_file, self.record)  # Recovery data must precede config changes.

    def assemble_claude(self):
        settings, links = claude_desired(ROOT, self.home, self.directory, self.policy)
        folder = self.directory/'claude-home'
        file = folder/'settings.json'
        if 'claudeSettingsBefore' not in self.record:
            self.record['claudeSettingsBefore'] = file.read_text() if file.exists() else None
        generated = (json.dumps(settings, ensure_ascii=False, indent=2)+'\n').encode()
        self.record['claudeSettingsHash'] = hashlib.sha256(generated).hexdigest()
        atomic_json(self.record_file, self.record)
        if not file.exists() or file.read_bytes() != generated:
            atomic_bytes(file, generated)
        targets = self.record.setdefault('claudeSkillLinks', {})
        wanted = {str(folder/'skills'/name) for name in links}
        for name, target in list(targets.items()):
            link = Path(name)
            if name not in wanted and link.is_symlink() and str(link.readlink()) == target:
                link.unlink();targets.pop(name)
        for name, source in links.items():
            link = folder/'skills'/name
            link.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if link.is_symlink() and link.resolve() == source.resolve(): continue
            if link.is_symlink() and str(link) in targets and str(link.readlink()) == targets[str(link)]:
                link.unlink()
            elif link.exists() or link.is_symlink():
                raise RuntimeError('분리 홈 스킬의 기존 항목과 충돌합니다. 지시서를 확인하세요.')
            link.symlink_to(source);targets[str(link)] = str(source)
        atomic_json(self.record_file, self.record)

    def restore_claude(self):
        file = self.directory/'claude-home/settings.json'
        if file.exists() and hashlib.sha256(file.read_bytes()).hexdigest() == self.record.get('claudeSettingsHash'):
            previous = self.record.get('claudeSettingsBefore')
            if previous is None: file.unlink()
            else: atomic_bytes(file, previous.encode())
        for name,target in self.record.get('claudeSkillLinks', {}).items():
            link = Path(name)
            if link.is_symlink() and str(link.readlink()) == target: link.unlink()

    def notices(self):
        return ['권장 권한: Codex full-access, Claude bypassPermissions.',
                '권장 relay는 켜짐입니다.', '권장 직원 profiles.json은 본체에서 직접 추가하세요. 자동 추가하지 않습니다.',
                '사람이 1회 할 일은 doctor 출력을 확인하세요.']

    def refresh(self):
        entry = read_paseo(self.home).get('plugins', {}).get('role-workflow')
        if not same_plugin(entry):
            raise RuntimeError('등록 경로가 달라 refresh를 건너뜁니다.')
        self.ensure_idle()
        rows = module_files(self.expected()[2], self.home, self.module_config())
        verify_cli(cli_path(self.config), self.home)
        self.dependencies()
        # New runtimes may read their installed manifest as soon as a job starts.
        agent_directory = (self.home/'Library/LaunchAgents').resolve()
        self.install_modules([row for row in rows if row['target'].parent != agent_directory])
        if 'claude-home' in self.expected()[2]:
            self.assemble_claude()
        self.install_modules([row for row in rows if row['target'].parent == agent_directory])
        self.record['equipment'] = self.module_plan()
        self.agents()
        for file in generated_cleanup(self.home):
            if file.is_dir():
                shutil.rmtree(file)
            else:
                file.unlink()
        account = read_paseo(self.home)
        fully_active = True
        ids = self.expected()[2]
        for plugin_id in ('role-workflow', 'codex-usage'):
            plugin = account.get('plugins', {}).get(plugin_id, {})
            owned = plugin.get('source') == 'directory' and Path(plugin.get('path', '')).resolve() == (ROOT/'plugin'/plugin_id).resolve()
            if not owned: continue
            if plugin.get('enabled') is False or account.get('pluginsEnabled') is False or (plugin_id == 'codex-usage' and plugin_id not in ids):
                fully_active = False
                self.refresh_event('skipped', '꺼 두었거나 허가하지 않은 플러그인 reload를 건너뜁니다: '+plugin_id)
                continue
            self.command('plugin', 'reload', plugin_id)
            verify_registration(cli_path(self.config), self.home, 'refresh', plugin_id)
        if fully_active:
            activated = version(['git', 'rev-parse', 'HEAD'], self.home, raw=True)
            if activated: self.record['activatedCommit'] = activated
        atomic_json(self.record_file, self.record)
        return {'refreshed': True}

    def refresh_event(self, result, message):
        file = self.directory/'airport/logs/refresh.jsonl'
        file.parent.mkdir(parents=True, exist_ok=True)
        with file.open('a') as out:
            out.write(json.dumps({'at': datetime.datetime.now().isoformat(), 'result': result, 'message': message}, ensure_ascii=False)+'\n')
        # Native local notification; policy controls whether phone delivery is requested.
        try:
            run(['/usr/bin/osascript', '-e', 'display notification '+json.dumps(message)+' with title "Paseo refresh"'], self.home, check=False)
            if self.policy['notifications'].get('phoneNotifications'):
                self.phone_notification(message)
        except (OSError, ValueError):
            with file.open('a') as out:
                out.write(json.dumps({'result': 'notification-failed'})+'\n')

    def phone_notification(self, message):
        # Expo protocol is the same as the plugin notifier; credentials never enter logs.
        from urllib.request import Request, urlopen
        subscriptions = read_json(self.directory/'push-tokens.json', {}).get('subscriptions', [])
        tokens = [s['token'] for s in subscriptions if isinstance(s, dict) and isinstance(s.get('token'), str) and isinstance(s.get('expiresAt'), str) and s['expiresAt'] > datetime.datetime.now(datetime.timezone.utc).isoformat()]
        payload = [{'to': token if isinstance(token, str) else token.get('token'),
                    'title': 'Paseo refresh', 'body': message} for token in tokens]
        endpoint = self.policy['notifications'].get('phoneNotificationEndpoint')
        if payload and endpoint and endpoint.startswith('https://'):
            with urlopen(Request(endpoint, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'}), timeout=10) as response:
                response.read()

    def check(self):
        core, desktop, ids = self.expected()
        account = read_paseo(self.home)
        rows = differences(core, account, '명세서 ⊕ 지시서', 'config')
        rows += differences(desktop, read_json(desktop_file(self.home)), '프로필 ⊕ 지시서', 'desktopSettings')
        entry = account.get('plugins', {}).get('role-workflow')
        current = version(['git', 'rev-parse', 'HEAD'], self.home, raw=True)
        if same_plugin(entry) and current and self.record.get('activatedCommit') != current:
            rows += differences(current, self.record.get('activatedCommit'), '설치 상태', 'installation.activatedCommit')
        if not same_plugin(entry):
            rows.append({'key': 'plugins.role-workflow', 'expected': str(ROOT/'plugin/role-workflow'), 'actual': entry.get('path') if isinstance(entry, dict) else None, 'source': '시설'})
        if isinstance(entry, dict) and entry.get('enabled') is not True:
            rows += differences(True, entry.get('enabled'), '시설', 'plugins.role-workflow.enabled')
        for kind, file in [('policy', self.policy_file), ('vault', self.vault_file)]:
            if not file.exists():
                rows.append({'key': f'owner.{kind}', 'expected': '있음', 'actual': '없음', 'source': '사장 칸'})
        try:
            for row in module_files(ids, self.home, self.module_config()):
                actual = row['target'].read_bytes() if row['target'].exists() else None
                if actual != row['content'] or row['target'].stat().st_mode & 0o777 != row['mode']:
                    rows.append({'key': str(row['target']), 'expected': '명세서와 일치', 'actual': '없음 또는 다름', 'source': '설비'})
        except RuntimeError as error:
            rows.append({'key': 'modules', 'expected': ids, 'actual': str(error), 'source': '설비'})
        if self.record.get('autoUpdate') or (self.home/'Library/LaunchAgents'/(AUTO_UPDATE_LABEL+'.plist')).exists():
            node, python, _ = self.tools()
            expected = launch_plist({**self.config, 'python': python}, node, self.home)
            file = self.home/'Library/LaunchAgents'/(AUTO_UPDATE_LABEL+'.plist')
            try:
                actual = plistlib.loads(file.read_bytes())
            except (OSError, ValueError):
                actual = None
            rows += differences(expected, actual, 'LaunchAgent 틀', 'launchd.auto-update', strict=True)
        if 'codex-usage' in ids:
            usage = account.get('plugins', {}).get('codex-usage', {})
            rows += differences({'source':'directory','path':str(ROOT/'plugin/codex-usage'),'enabled':True}, usage, '설비', 'plugins.codex-usage')
        if 'claude-home' in ids:
            desired_settings, links = claude_desired(ROOT, self.home, self.directory, self.policy)
            rows += differences(desired_settings, read_json(self.directory/'claude-home/settings.json'), '명세서 ⊕ 지시서', 'claudeHome.settings', strict=True)
            for name, source in links.items():
                link = self.directory/'claude-home/skills'/name
                if not link.is_symlink() or link.resolve() != source.resolve():
                    rows.append({'key': 'claudeHome.skills.'+name, 'expected': '선택한 스킬 링크', 'actual': '없음 또는 다름', 'source': '본체 스킬/지시서'})
        return {'equipment': self.module_plan(), 'airportCommit': version(['git', 'rev-parse', 'HEAD'], self.home, raw=True),
                'versions': self.versions(), 'profile': self.profile(), 'differences': rows}

    def versions(self):
        try:
            paseo = cli_path(self.config)
            app_version = version([paseo, '--version'], self.home)
        except RuntimeError:
            app_version = None
        result = {'app': app_version}
        for product in ('claude', 'codex'):
            cli = shutil.which(product)
            result[product] = version([cli, '--version'], self.home) if cli else None
        return result

    def doctor(self, *, caskroom_prefixes=('/opt/homebrew', '/usr/local')):
        checks = []
        def add(key, ok, instruction, manual=False, blocking=True):
            checks.append({'key': key, 'ok': bool(ok), 'manual': manual, 'instruction': instruction, 'blocking': blocking, 'severity': 'error' if blocking else 'warning'})
        versions = self.versions()
        add('app.cli', bool(versions['app']), '앱 내장 CLI를 확인하세요.', True)
        add('app.compatibility', tested_version(versions['app']), '검증 범위는 0.15.x입니다. 범위 밖에서도 실행을 계속합니다.', blocking=False)
        app = app_path(self.config)
        try:
            info = plistlib.loads((app/'Contents/Info.plist').read_bytes())
            add('app.bundle', bool(info.get('CFBundleShortVersionString')), 'Paseo 앱 번들을 확인하세요.')
        except (OSError, ValueError):
            add('app.bundle', False, 'Paseo 앱 번들을 확인하세요.')
        path_cli = shutil.which('paseo')
        add('path.oldCli', not path_cli or Path(path_cli).resolve() == (app/'Contents/Resources/bin/paseo').resolve(), 'PATH의 옛 CLI를 정리하세요. 앱 CLI만 사용합니다.')
        add('shell.path', all(Path(p).is_absolute() for p in os.environ.get('PATH', '').split(os.pathsep)), '셸 PATH의 빈 항목·상대 경로를 확인하세요.')
        add('products.cli', any(versions[k] for k in ('claude', 'codex')), 'Claude Code 또는 Codex CLI를 설치하세요.', True)
        credential = self.vault.get('keychain', {}).get('claude')
        if credential:
            found = run(['/usr/bin/security', 'find-generic-password', '-s', credential['service'], '-a', credential['account']], self.home, check=False)
            add('keychain.claude', found.returncode == 0, '선택한 키체인 항목을 등록하거나 분리 홈에서 로그인하세요.', True)
        add('claude.login', (self.directory/'claude-home/.claude.json').is_file(), '분리 Claude 홈에서 로그인·온보딩을 1회 완료하세요.', True)
        add('codex.login', (self.directory/'codex-home/auth.json').is_file(), 'Paseo Codex 홈에서 로그인하세요.', True)
        account = read_paseo(self.home)
        usable = []
        if daemon_running(self.home):
            try:
                catalog = json.loads(self.command('provider', 'ls', '--json', check=False).stdout)
                providers = catalog if isinstance(catalog, list) else catalog.get('providers', [])
                for provider in providers:
                    name = provider.get('provider', provider.get('id'))
                    if name in ('claude', 'codex') and provider.get('enabled') is not False and (provider.get('available') or provider.get('status') == 'available'):
                        result = json.loads(self.command('provider', 'models', name, '--json', check=False).stdout)
                        models = result if isinstance(result, list) else result.get('models', [])
                        if any(model.get('isSelectable') is not False for model in models):
                            usable.append(name)
            except (OSError, ValueError, RuntimeError):
                pass  # Explicit failed check below; never claim an unobserved catalog is usable.
        add('models.catalog', bool(usable), '본체 제공자 화면에서 모델 사용 가능 여부를 확인하세요.', True)
        add('core.skills', account.get('agents', {}).get('skills', {}).get('selection', {}).get('mode') == 'all', '본체 스킬을 설치·선택하고 Claude 분리 홈 링크를 확인하세요.', True)
        add('daemon.account', daemon_running(self.home), '이 계정의 Paseo 데몬을 실행하세요.', True)
        # A TCP bind probe checks the configured local port, without starting a service.
        import socket
        listen = account.get('listen', account.get('daemon', {}).get('listen', '127.0.0.1:6767'))
        match = re.search(r':(\d+)$', listen) if isinstance(listen, str) else None
        if match:
            with socket.socket() as probe:
                probe.settimeout(0.2)
                occupied = probe.connect_ex(('127.0.0.1', int(match[1]))) == 0
            add('port.conflict', not occupied or daemon_running(self.home), '다른 계정 데몬의 포트 점유 여부를 확인하세요.')
        # Running brew can populate HOME caches even for `list`; read its cask receipts instead.
        metadata_roots = [Path(prefix)/'Caskroom/paseo/.metadata' for prefix in caskroom_prefixes]
        metadata_roots = [directory for directory in metadata_roots if directory.is_dir()]
        recorded = set()
        for metadata in metadata_roots:
            recorded.update(directory.name for directory in metadata.iterdir() if directory.is_dir())
            receipt = metadata/'INSTALL_RECEIPT.json'
            for file in [*metadata.glob('*/**/Casks/*.json'), receipt]:
                try:
                    data = read_json(file)
                except (OSError, ValueError):
                    continue
                if not isinstance(data, dict):
                    continue
                if file == receipt:
                    data = data.get('source', {})
                value = data.get('version') if isinstance(data, dict) else None
                if isinstance(value, str) and value.strip():
                    recorded.add(value.strip())
        if metadata_roots:
            if recorded:
                add('brew.cask', versions['app'] in recorded, 'brew cask 기록과 앱 버전을 확인하세요.')
            else:
                add('brew.cask', False, 'Homebrew 기록에서 앱 버전을 확인할 수 없습니다. 앱 버전과 설치 기록을 직접 확인하세요.', blocking=False)
        from public_runtime import auto_update_data
        state = read_json(auto_update_data(self.config)/'state.json')
        success = state.get('lastSuccessAt') or (state.get('finishedAt') if state.get('result') == 'updated' else None)
        add('autoUpdate.lastSuccess', bool(success), '자동 업데이트 마지막 성공 시각을 확인하세요: '+str(success or '없음'))
        for module in self.module_plan():
            add('equipment.'+module['id'], not module['conflicts'], module['reason'])
        ungranted = self.ungranted_notice()
        add('equipment.grants', not ungranted, ungranted[0] if ungranted else '프로필 권장 설비의 허가 결정이 있습니다.', blocking=False)
        if 'claude-home' in self.expected()[2]:
            config_home = account.get('agents', {}).get('providers', {}).get('claude', {}).get('env', {}).get('CLAUDE_CONFIG_DIR')
            add('claude.home.env', config_home == str(self.directory/'claude-home'), '제공자 CLAUDE_CONFIG_DIR을 분리 홈과 맞추세요.')
            _, links = claude_desired(ROOT, self.home, self.directory, self.policy)
            core_skills = read_json(ROOT/'plugin/role-workflow/shared/presets/claude-home/skills.json')
            add('claude.home.coreSkills', all((self.home/'.claude/skills'/name).is_dir() for name in core_skills), '앱 설정 → 호스트 → 오케스트레이션 스킬에서 Paseo 스킬을 1회 설치하세요.', True)
            unknown = [p.name for p in (self.home/'.claude/skills').glob('paseo*') if p.is_dir() and p.name not in core_skills]
            add('claude.home.newSkills', not unknown, '새 본체 스킬이 있으면 공항 스킬 명세를 갱신하세요.')
            add('claude.home.skills', all((self.directory/'claude-home/skills'/name).is_symlink() for name in links), '분리 홈 스킬 링크가 없습니다. 스킬을 설치한 뒤 setup.py refresh를 실행하세요.')
        return {'checks': checks, 'equipment': self.module_plan(), 'versions': versions, 'notices': self.notices()}

    def remove_auto_update(self):
        # Preserve the existing opt-out flag's narrow meaning.
        file = self.home/'Library/LaunchAgents'/(AUTO_UPDATE_LABEL+'.plist')
        if auto_update_agent_installed(self.home, ROOT):
            run(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{AUTO_UPDATE_LABEL}'], self.home, check=False)
            file.unlink()
        if self.record_file.exists():
            self.record['autoUpdate'] = False
            atomic_json(self.record_file, self.record)
        return {'autoUpdateRemoved': True, 'pluginPreserved': True}

    def uninstall(self, purge=False):
        self.ensure_idle()
        account = read_paseo(self.home)
        plugins = copy.deepcopy(account.get('plugins', {}))
        changed = False
        usage = plugins.get('codex-usage', {})
        if isinstance(usage, dict) and usage.get('path') and Path(usage['path']).resolve() == (ROOT/'plugin/codex-usage').resolve():
            plugins.pop('codex-usage');account['plugins'] = plugins;changed = True
        if same_plugin(plugins.get('role-workflow')):
            plugins.pop('role-workflow')
            account['plugins'] = plugins
            changed = True
        # Restore provider commands before deleting the installed launchers.
        originals = self.record.get('providerCommands', {})
        for provider, command in originals.items():
            entry = account.get('agents', {}).get('providers', {}).get(provider, {})
            current = entry.get('command')
            if current and str(self.directory/'airport') in json.dumps(current):
                if command is None:
                    entry.pop('command', None)
                else:
                    entry['command'] = command
                changed = True
        for provider, keys in self.record.get('providerEnvironment', {}).items():
            env = account.get('agents', {}).get('providers', {}).get(provider, {}).get('env', {})
            for key, record in keys.items():
                if env.get(key) == record['installed']:
                    if record['before'] is None: env.pop(key, None)
                    else: env[key] = record['before']
                    changed = True
        self.restore_claude()
        if changed:
            if daemon_running(self.home):
                for key in ('agents', 'plugins'):
                    if key in account:
                        self.command('daemon', 'config', 'set', key, json.dumps(account[key]))
                self.command('daemon', 'restart')
            else:
                atomic_json(self.directory/'config.json', account)
        for file in (self.home/'Library/LaunchAgents').glob(PREFIX+'*.plist'):
            run(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{file.stem}'], self.home, check=False)
            file.unlink()
        for name in self.record.get('generatedFiles', []):
            file = Path(name).resolve()
            if not file.is_relative_to((self.directory/'airport').resolve()) and not (file.parent == (self.home/'Library/LaunchAgents').resolve() and file.name.startswith(PREFIX)):
                raise RuntimeError('설비 삭제 경로가 소유 범위를 벗어납니다.')
            file.unlink(missing_ok=True)
        if purge and (self.directory/'owner').exists():
            backup(self.home)
            shutil.rmtree(self.directory/'owner')
        self.record_file.unlink(missing_ok=True)
        return {'uninstalled': True, 'ownerPreserved': not purge}


def version(command, home, raw=False):
    try:
        result = run(command, home, check=False)
        if result.returncode:
            return None
        # Node prints a v prefix (v26.10.0), so a word boundary cannot precede the digits.
        found = re.search(r'(?<![\d.])\d+\.\d+\.\d+(?![\d.])', result.stdout or '')
        return result.stdout.strip() if raw else found[0] if found else None
    except OSError:
        return None


def verify_registration(paseo, home, after='install', plugin_id='role-workflow'):
    for attempt in range(5):
        result = run([paseo, 'plugin', 'ls', plugin_id, '--json', '--home', paseo_home(home)], home, check=False)
        try:
            if result.returncode:
                raise ValueError()
            verify_plugin_entries(json.loads(result.stdout), ROOT, after, plugin_id)
            return
        except (ValueError, RuntimeError):
            if attempt == 4:
                raise RuntimeError('플러그인 등록 확인 실패. 사장 칸은 보존되며 설치 백업으로 복구할 수 있습니다.')
            time.sleep(1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'refresh', 'check', 'doctor', 'uninstall', 'enable', 'disable', 'archive'])
    parser.add_argument('module', nargs='?')
    parser.add_argument('--variant', choices=['A', 'B'])
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--profile', choices=['server', 'desktop'])
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--with-auto-update', action='store_true')
    parser.add_argument('--replace-registration', action='store_true')
    parser.add_argument('--purge-owner', action='store_true')
    parser.add_argument('--root', help='archive 전용: 기록 보관 절대경로(예: 외장 SSD)')
    parser.add_argument('--days', type=int, help='archive 전용: 보관 기준 일수')
    args = parser.parse_args(argv)
    if (args.root or args.days) and args.action != 'archive':
        parser.error('--root·--days는 archive 전용입니다.')
    if (args.action in ('enable', 'disable')) != bool(args.module):
        parser.error('enable·disable에는 설비 id가 필요하며 다른 동작에는 쓰지 않습니다.')
    if args.variant and args.action != 'enable':
        parser.error('--variant는 enable 전용입니다.')
    if args.replace_registration and args.action != 'install':
        parser.error('--replace-registration은 install 전용입니다.')
    if args.purge_owner and (args.action != 'uninstall' or args.with_auto_update):
        parser.error('--purge-owner는 전체 uninstall 전용입니다.')
    try:
        airport = Airport()
    except RuntimeError:
        if args.action == 'refresh' and not args.dry_run:
            # Even an unreadable policy must leave a failure log; never repair the owner file here.
            file = paseo_home()/'airport/logs/refresh.jsonl'
            file.parent.mkdir(parents=True, exist_ok=True)
            with file.open('a') as out:
                out.write(json.dumps({'result': 'failed', 'message': '사장 칸 형식 오류'})+'\n')
            run(['/usr/bin/osascript', '-e', 'display notification "사장 칸 형식 오류로 refresh 실패" with title "Paseo refresh"'], Path.home(), check=False)
        raise
    if args.action == 'install':
        try:
            airport.profile(args.profile, installing=True)
        except ProfileRequired as error:
            print(json.dumps({'error': str(error), 'exitCode': 2}, ensure_ascii=False))
            return 2
    if args.action == 'archive':
        result = airport.set_archive(args.root, args.days, args.dry_run)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.action in ('enable', 'disable'):
        if not args.dry_run and os.geteuid() == 0:
            raise RuntimeError('sudo 없이 실행하세요.')
        result = airport.set_module(args.module, args.action == 'enable', args.variant, args.dry_run)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.dry_run:
        result = {'action': args.action, 'dryRun': True, 'profile': airport.profile(args.profile),
                  'equipment': airport.module_plan(args.profile), 'cleanup': [str(p) for p in generated_cleanup(airport.home)],
                  'notices': airport.notices()+(airport.ungranted_notice(args.profile) if args.action == 'install' else []),
                  'blockers': airport.install_blockers(args) if args.action == 'install' else [],
                  'steps': {'install': ['백업', '금고·지시서 revision 비교', '본체 상위 객체 맞춤', '등록 변경 시 데몬 재시작', '설비 설치'],
                            'refresh': ['lock 변경 시 npm ci', '설비 틀 재생성', '미참조 생성물 정리', '켜진 플러그인만 reload'],
                            'uninstall': ['provider command 원복', '등록·공항 LaunchAgent·생성물 제거', '사장 칸 보존' if not args.purge_owner else '백업 뒤 사장 칸 삭제'],
                            'check': ['기대값과 실제 파일 비교'], 'doctor': ['읽기 전용 점검']}[args.action]}
        if args.action == 'uninstall' and args.with_auto_update:
            result['steps'] = ['이 clone의 자동 업데이트 LaunchAgent만 해제', '플러그인·사장 칸 보존']
        code = 2 if result['blockers'] else 0
    elif args.action == 'check':
        result = airport.check()
        code = int(bool(result['differences']))
    elif args.action == 'doctor':
        result = airport.doctor()
        code = int(any(not row['ok'] and row.get('blocking', True) for row in result['checks']))
    else:
        if os.geteuid() == 0:
            raise RuntimeError('sudo 없이 실행하세요.')
        if args.action == 'refresh':
            try:
                result = airport.refresh()
            except (OSError, ValueError, RuntimeError):
                airport.refresh_event('failed', 'refresh 실패: 등록·지시서·설비와 로그를 확인하세요.')
                raise
        else:
            result = airport.install(args) if args.action == 'install' else airport.remove_auto_update() if args.with_auto_update else airport.uninstall(args.purge_owner)
        code = 0
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return code


if __name__ == '__main__':
    try:
        sys.exit(main())
    except RuntimeError as error:
        if '--json' in sys.argv:
            print(json.dumps({'error': str(error)}, ensure_ascii=False))
        else:
            print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, subprocess.CalledProcessError):
        print('공항 작업 실패: 설정 형식·등록 경로·revision·설비와 설치 백업을 확인하세요.', file=sys.stderr)
        sys.exit(1)
