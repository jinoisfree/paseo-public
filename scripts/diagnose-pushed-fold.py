#!/usr/bin/env python3
# Adapted for the portable paseo-public distribution.
"""Read only: locate the running Paseo app, its version and sidebar patch."""
import datetime
import json
import pathlib
import plistlib
import re
import subprocess

from public_runtime import data_root, app_path
home = pathlib.Path.home()
apps = {app_path()}
try:
    lines = subprocess.check_output(['/bin/ps', '-axo', 'comm='], text=True).splitlines()
except subprocess.SubprocessError:
    lines = []
running = set()
for line in lines:
    match = re.match(r'(.+?\.app)/Contents/MacOS/Paseo$', line.strip())
    if match:
        running.add(pathlib.Path(match.group(1)))
apps.update(running)
reports = []
for app in sorted(apps):
    if not app.exists():
        continue
    report = {'app': str(app), 'running': app in running}
    try:
        report['version'] = plistlib.loads((app/'Contents/Info.plist').read_bytes()).get('CFBundleShortVersionString')
        dist = app/'Contents/Resources/app-dist'
        index = (dist/'index.html').read_text()
        # Check the bundle actually referenced by the page, not an unused file left behind.
        scripts = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', index)
        main = [src for src in scripts if re.search(r'/index-[^/]+\.js(?:\?.*)?$', src)]
        results = []
        for src in main:
            bundle = dist / src.split('?', 1)[0].lstrip('/')
            content = bundle.read_text()
            results.append({'file': bundle.name, 'pushedFold': 'sidebar-project-pushed-' in content, 'modifiedAt': datetime.datetime.fromtimestamp(bundle.stat().st_mtime).isoformat()})
        report['bundles'] = results
    except (OSError, ValueError) as error:
        report['error'] = str(error)
    reports.append(report)
backup_root = data_root()/'backups'
backups = []
if backup_root.is_dir():
    for file in sorted(backup_root.rglob('installation.json'))[-3:]:
        try:
            record = json.loads(file.read_text())
            backups.append({'time': record.get('time'), 'app': record.get('app')})
        except (OSError, ValueError):
            pass
print(json.dumps({'apps': reports, 'installationAttempts': backups}, ensure_ascii=False, indent=2))
