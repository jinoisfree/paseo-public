"""Install a launchd job as the app owner, without running build code as root.

Called by the sudo wrappers. Dry runs validate and print commands only.
"""
import argparse
import grp
import json
import os
from pathlib import Path
import plistlib
import pwd
import shlex
import shutil
import subprocess
import tempfile


def command(arguments, *, dry=False, check=True):
    arguments = list(map(str, arguments))
    print('+ '+shlex.join(arguments), flush=True)
    if dry:
        return subprocess.CompletedProcess(arguments, 0, '', '')
    result = subprocess.run(arguments, check=False, capture_output=True, text=True)
    if arguments[0] == '/usr/bin/plutil' and result.stdout:
        print(result.stdout.strip(), flush=True)
    if check and result.returncode:
        print(result.stdout, result.stderr, flush=True)
        raise subprocess.CalledProcessError(result.returncode, arguments, result.stdout, result.stderr)
    return result


def owned_directory(path, uid, gid):
    missing = []
    current = path
    while not current.exists():
        missing.append(current)
        current = current.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)
        os.chown(directory, uid, gid)


def deploy(spec, backup, action, *, dry=False, system_dir=None):
    label = spec['Label']
    owner = pwd.getpwnam(spec['UserName'])
    if owner.pw_uid == 0:
        raise RuntimeError('The app owner must be a regular account, not root.')
    group = grp.getgrnam(spec['GroupName']).gr_gid
    agent = Path(owner.pw_dir)/'Library/LaunchAgents'/(label+'.plist')
    target = (system_dir or Path('/Library/LaunchDaemons'))/(label+'.plist')
    saved = backup/'LaunchAgent.plist'
    expected_script = next(arg for arg in spec['ProgramArguments'] if arg.endswith('/scripts/auto-reapply-fold.py'))
    # Refuse to displace a different repository's job or overwrite a different backup.
    for file in (target, agent, saved):
        if file.exists():
            current = plistlib.loads(file.read_bytes())
            if expected_script not in current.get('ProgramArguments', []):
                raise RuntimeError('An unrelated launchd job/backup already exists: '+str(file))
    if action == 'uninstall' and saved.exists() and agent.exists():
        if saved.read_bytes() != agent.read_bytes():
            raise RuntimeError('The current LaunchAgent differs from the saved copy; refusing to overwrite it.')
    if agent.exists() and saved.exists() and agent.read_bytes() != saved.read_bytes():
        raise RuntimeError('The saved LaunchAgent differs; keep both files and inspect manually.')
    if not dry and os.geteuid() != 0:
        raise RuntimeError('Run this command with sudo; --dry-run works without sudo.')
    if not dry and action == 'install' and target.exists() and not agent.exists():
        if plistlib.loads(target.read_bytes()) == spec:
            status = command(['/bin/launchctl', 'print', 'system/'+label], check=False)
            if status.returncode == 0:
                print('System watcher is already registered with this configuration; no changes.')
                return 0
    with tempfile.TemporaryDirectory(prefix='paseo-daemon-plist-') as temporary:
        source = Path(temporary)/'job.plist'
        source.write_bytes(plistlib.dumps(spec, sort_keys=False))
        command(['/usr/bin/plutil', '-lint', source])  # Read-only validation, also in dry-run.
        print(json.dumps({'action':action, 'owner':owner.pw_name, 'uid':owner.pw_uid,
                          'destination':str(target), 'agentBackup':str(saved), 'plist':spec,
                          'dryRun':dry}, ensure_ascii=False, indent=2))
        gui = f'gui/{owner.pw_uid}'
        if action == 'install':
            if dry:
                command(['/bin/launchctl', 'bootout', gui+'/'+label], dry=True)
            elif command(['/bin/launchctl', 'print', gui+'/'+label], check=False).returncode == 0:
                command(['/bin/launchctl', 'bootout', gui+'/'+label])
            if agent.exists():
                print('Preserve LaunchAgent: '+str(agent)+' -> '+str(saved))
                if not dry:
                    owned_directory(backup, owner.pw_uid, group)
                    if not saved.exists():
                        shutil.copy2(agent, saved)
                        os.chown(saved, owner.pw_uid, group)
                    agent.unlink()  # Backup copy first; works across volumes.
            if not dry:
                for key in ('StandardOutPath', 'StandardErrorPath'):
                    owned_directory(Path(spec[key]).parent, owner.pw_uid, group)
                if command(['/bin/launchctl', 'print', 'system/'+label], check=False).returncode == 0:
                    command(['/bin/launchctl', 'bootout', 'system/'+label])
            command(['/usr/bin/install', '-o', 'root', '-g', 'wheel', '-m', '644', source, target], dry=dry)
            command(['/bin/launchctl', 'bootstrap', 'system', target], dry=dry)
            status = command(['/bin/launchctl', 'print', 'system/'+label], dry=dry)
        else:
            if dry or command(['/bin/launchctl', 'print', 'system/'+label], check=False).returncode == 0:
                command(['/bin/launchctl', 'bootout', 'system/'+label], dry=dry)
            print('Remove system registration: '+str(target))
            if not dry:
                target.unlink(missing_ok=True)
            if saved.exists():
                print('Restore LaunchAgent: '+str(saved)+' -> '+str(agent))
                if not dry:
                    owned_directory(agent.parent, owner.pw_uid, group)
                    shutil.copy2(saved, agent)
                    os.chown(agent, owner.pw_uid, group)
                if dry or command(['/bin/launchctl', 'print', gui], check=False).returncode == 0:
                    # A logged-out owner has no GUI domain. The restored file loads at next login.
                    command(['/bin/launchctl', 'bootstrap', gui, agent], dry=dry)
                else:
                    print('Owner GUI is absent; restored LaunchAgent will load at next login.')
            status = None
        if status and status.stdout:
            print('\n'.join(line for line in status.stdout.splitlines()
                            if any(key in line for key in ('state =', 'program =', 'last exit code', 'username ='))))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'uninstall'])
    parser.add_argument('--plist', required=True, type=Path)
    parser.add_argument('--backup', required=True, type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    try:
        return deploy(plistlib.loads(args.plist.read_bytes()), args.backup, args.action, dry=args.dry_run)
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
