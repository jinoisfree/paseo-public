"""Portable paths for the public distribution; no state is created on import."""
import json
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
AUTO_UPDATE_LABEL = 'io.github.jinoisfree.paseo-public.auto-update'


def config_path():
    return Path(os.environ.get('PASEO_PUBLIC_CONFIG', Path.home()/'.config/paseo-public/config.json')).expanduser()


def paseo_home(home=None):
    return Path(os.environ.get('PASEO_HOME', Path(home or Path.home())/'.paseo')).expanduser()


def load_config():
    # Legacy file is a read-only migration source. Owner paths win once installed.
    file = config_path()
    value = json.loads(file.read_text()) if file.exists() else {}
    if not isinstance(value, dict):
        raise ValueError('The paseo-public configuration must be a JSON object')
    profile = value.get('profiles', {}).get(str(ROOT), {})
    if not isinstance(profile, dict):
        raise ValueError('The repository runtime profile must be an object')
    from owner_store import read_owner
    vault = read_owner(paseo_home()/'owner/vault.json', 'vault')
    return {**value, **profile, **vault.get('paths', {})}


def data_root(config=None):
    config = load_config() if config is None else config
    return Path(config.get('dataDir', paseo_home()/'airport')).expanduser()


def logs_root(config=None):
    config = load_config() if config is None else config
    return Path(config.get('logsDir', paseo_home()/'airport/logs')).expanduser()


def auto_update_data(config=None):
    return data_root(config)/'auto-update'


def auto_update_logs(config=None):
    return logs_root(config)/'auto-update'


def node_executable(config=None):
    config = load_config() if config is None else config
    value = os.environ.get('PASEO_PUBLIC_NODE') or config.get('node') or shutil.which('node')
    value = str(Path(value).expanduser()) if value else value
    if value and not Path(value).is_absolute():
        value = shutil.which(value)
    if not value or not Path(value).is_file() or not os.access(value, os.X_OK):
        raise RuntimeError('node was not found; put it on PATH or set node in the user configuration')
    return str(Path(value).absolute())


def app_path(config=None):
    config = load_config() if config is None else config
    if config.get('app'):
        return Path(config['app']).expanduser()
    local = Path.home()/'Applications/Paseo.app'
    return local if local.exists() else Path('/Applications/Paseo.app')


def backup_root(config=None):
    config = load_config() if config is None else config
    return Path(config.get('backupDir', data_root(config)/'backups')).expanduser()


def busy_workflows(home):
    """Numbers of active workflows that are sending an instruction or compacting."""
    file = paseo_home(home)/'role-workflow/state.json'
    if not file.exists():
        return []
    data = json.loads(file.read_text())
    workflows = data['workflows']
    if not isinstance(workflows, list):
        raise ValueError('Invalid workflow state; update refused')
    blocked = []
    for w in workflows:
        if not isinstance(w, dict):
            raise ValueError('Invalid workflow; update refused')
        if w.get('status') != 'active':
            continue
        if any(w.get(key) is not None and not isinstance(w[key], dict) for key in ('pending', 'plan', 'execute')):
            raise ValueError('Invalid workflow member; update refused')
        if ((w.get('pending') or {}).get('stage') == 'sending' or
                any((w.get(role) or {}).get('compaction') for role in ('plan', 'execute'))):
            blocked.append(w.get('number', w.get('id', '번호 미확인')))
    return blocked


def verify_plugin_entries(entries, root, after='reload', plugin_id='role-workflow'):
    """Check `plugin ls role-workflow --json` output for a clean registration from root."""
    if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
        raise RuntimeError(f'Expected one {plugin_id} plugin after {after}')
    entry = entries[0]
    if (entry.get('id') != plugin_id or entry.get('enabled') is not True or
            entry.get('status') != 'running' or entry.get('error') or
            Path(entry.get('path', '')).resolve() != (root/'plugin'/plugin_id).resolve()):
        raise RuntimeError(f'{plugin_id} is not running cleanly from this checkout')


def auto_update_agent_state(home, root):
    """'installed' for this checkout's LaunchAgent, 'foreign' for another checkout's, else 'missing'."""
    import plistlib
    plist = Path(home)/'Library/LaunchAgents'/(AUTO_UPDATE_LABEL+'.plist')
    try:
        arguments = plistlib.loads(plist.read_bytes()).get('ProgramArguments', [])
    except (OSError, ValueError, AttributeError):
        return 'missing'
    return 'installed' if str(Path(root)/'scripts/auto-update.py') in arguments else 'foreign'


def auto_update_agent_installed(home, root):
    return auto_update_agent_state(home, root) == 'installed'
