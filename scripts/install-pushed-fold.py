#!/usr/bin/env python3
# Adapted for the portable paseo-public distribution.
"""Apply the tested sidebar renderer to its matching Paseo version without restarting its daemon."""
import argparse, json, pathlib, plistlib, subprocess, tempfile, datetime, shutil
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote
from public_runtime import ROOT, data_root, app_path, backup_root, installer_dist
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app', type=pathlib.Path, default=app_path())
# A renderer is built and verified per app version; never install one onto another version.
parser.add_argument('--version', default='0.11.4', help='Paseo version the renderer was built from')
parser.add_argument('--dist', type=pathlib.Path)
parser.add_argument('--backup-root', type=pathlib.Path, default=backup_root())
parser.add_argument('--apply', action='store_true')
parser.add_argument('--restore', type=pathlib.Path, help='Restore renderer and signature files from an installation backup')
args=parser.parse_args()
args.dist = args.dist or installer_dist(args.version)
app=args.app.resolve()
resources=app/'Contents/Resources'
staged=resources/'app-dist.pushed-fold-new'
previous=resources/'app-dist.pushed-fold-old'
replacement=app.with_name('.'+app.name+'.pushed-fold-restore')
displaced=app.with_name('.'+app.name+'.pushed-fold-failed')
temporary_paths=(staged,previous,replacement,displaced)
if args.apply:
    for path in temporary_paths:
        if path.exists() or path.is_symlink():
            raise SystemExit(f'Unexpected existing temporary path: {path}. No changes made.')
def run(*cmd): subprocess.run([str(x) for x in cmd],check=True)
version=plistlib.loads((app/'Contents/Info.plist').read_bytes())['CFBundleShortVersionString']
if version != args.version: raise SystemExit(f'Requires Paseo {args.version}; found {version}. No changes made.')
if args.restore:
    backup=args.restore.resolve()
    manifest=json.loads((backup/'installation.json').read_text())
    if manifest['app'] != str(app): raise SystemExit('Backup belongs to another app path.')
    source=backup/'Paseo.app/Contents/Resources/app-dist'
else:
    source=args.dist.resolve()
if not (source/'index.html').is_file(): raise SystemExit('Renderer index.html missing.')
if not args.restore:
    # Extracting an update over an older download leaves unused hashed bundles.
    # Validate the entry actually loaded by index.html, not every index-*.js file.
    class Scripts(HTMLParser):
        def __init__(self):
            super().__init__()
            self.sources = []
        def handle_starttag(self, tag, attrs):
            if tag == 'script':
                src = dict(attrs).get('src')
                if src: self.sources.append(src)
    page = Scripts()
    page.feed((source/'index.html').read_text())
    bundles = []
    for src in page.sources:
        url = urlsplit(src)
        relative = pathlib.PurePosixPath(unquote(url.path).lstrip('/'))
        if relative.name.startswith('index-') and relative.suffix == '.js':
            bundle = (source/relative).resolve()
            if url.scheme or url.netloc or source not in bundle.parents:
                raise SystemExit('Renderer entry must be a local file inside the dist directory.')
            bundles.append(bundle)
    if len(bundles) != 1:
        raise SystemExit('Expected one renderer entry referenced by index.html.')
    if not bundles[0].is_file() or 'sidebar-project-pushed-' not in bundles[0].read_text():
        raise SystemExit(f'Pushed-fold renderer missing or invalid: {bundles[0]}')
print(json.dumps({'app':str(app),'version':version,'renderer':str(source),'apply':args.apply,'restore':bool(args.restore)},ensure_ascii=False))
if not args.apply: raise SystemExit(0)
# Clone the entire installed app before any mutation, including its original signature.
args.backup_root.mkdir(parents=True,exist_ok=True)
backup=pathlib.Path(tempfile.mkdtemp(prefix='pushed-fold-install-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-',dir=args.backup_root))
run('/bin/cp','-cR',app,backup/'Paseo.app')
(backup/'installation.json').write_text(json.dumps({'app':str(app),'version':version,'source':str(source),'time':datetime.datetime.now().isoformat()},indent=2))
def restore_full(original, displaced):
    # All renames stay beside the app; only copies may cross into the backup volume.
    if replacement.exists() or replacement.is_symlink():
        raise RuntimeError(f'Unexpected restore directory: {replacement}')
    if displaced.exists() or displaced.is_symlink():
        raise RuntimeError(f'Unexpected displaced directory: {displaced}')
    try:
        run('/bin/cp','-cR',original,replacement)
        run('/usr/bin/codesign','--verify','--deep','--strict',replacement)
        app.rename(displaced)
        try:
            replacement.rename(app)
        except BaseException:
            displaced.rename(app)
            raise
    except BaseException:
        if replacement.exists(): shutil.rmtree(replacement)
        raise
    run('/usr/bin/ditto',displaced,backup/('replaced-app' if args.restore else 'failed-app'))
    shutil.rmtree(displaced)

def sign_and_verify():
    run('/usr/bin/codesign','--force','--deep','--sign','-','--options','0','--preserve-metadata=entitlements','--timestamp=none',app)
    run('/usr/bin/codesign','--verify','--deep','--strict',app)

if args.restore:
    restore_full(args.restore.resolve()/'Paseo.app',displaced)
else:
    old=resources/'app-dist'
    signature_started=False
    try:
        run('/usr/bin/ditto',source,staged)
        old.rename(previous)
        staged.rename(old)
        signature_started=True
        sign_and_verify()
        run('/usr/bin/ditto',previous,backup/'previous-renderer')
        shutil.rmtree(previous)
        # Removing an in-bundle backup changes sealed resources. Seal the final
        # tree again after archiving it, then verify the actual installed layout.
        sign_and_verify()
    except BaseException:
        needs_full_restore=signature_started
        try:
            if previous.exists():
                if old.exists():
                    old.rename(staged)
                    shutil.rmtree(staged)
                previous.rename(old)
            if staged.exists(): shutil.rmtree(staged)
            if not needs_full_restore:
                run('/usr/bin/codesign','--verify','--deep','--strict',app)
        except BaseException:
            needs_full_restore=True
        # codesign can update the executable and nested signatures before failing;
        # restoring only app-dist cannot undo those changes.
        if needs_full_restore:
            restore_full(backup/'Paseo.app',displaced)
        print(f'Installation failed; original app restored. Evidence: {backup}')
        raise
print(f'Applied. Backup: {backup}. Reload the Paseo window (Cmd+R). No daemon restart was performed.')
