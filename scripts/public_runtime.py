"""Portable paths for the public distribution; no state is created on import."""
import json
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
LABEL = 'io.github.jinoisfree.paseo-public.fold-reapply'


def config_path():
    return Path(os.environ.get('PASEO_PUBLIC_CONFIG', Path.home()/'.config/paseo-public/config.json')).expanduser()


def load_config():
    file = config_path()
    if not file.exists():
        return {}
    value = json.loads(file.read_text())
    if not isinstance(value, dict):
        raise ValueError('The paseo-public configuration must be a JSON object')
    profile = value.get("profiles", {}).get(str(ROOT), {})
    if not isinstance(profile, dict):
        raise ValueError("The repository runtime profile must be an object")
    return {**value, **profile}


def data_root(config=None):
    config = load_config() if config is None else config
    return Path(config.get('dataDir', Path.home()/'Library/Application Support/paseo-public')).expanduser()


def logs_root(config=None):
    config = load_config() if config is None else config
    return Path(config.get('logsDir', Path.home()/'Library/Logs/paseo-public')).expanduser()


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


def build_root(config=None):
    config = load_config() if config is None else config
    return Path(config.get('buildDir', data_root(config)/'build')).expanduser()


def installer_dist(version, config=None):
    config = load_config() if config is None else config
    template = config.get('distTemplate')
    return Path(template.format(version=version)).expanduser() if template else data_root(config)/f'build/paseo-{version}/packages/app/dist'
