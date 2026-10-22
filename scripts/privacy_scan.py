#!/usr/bin/env python3
"""Scan tracked/staged distribution files without printing matching secrets."""
import argparse
import ipaddress
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
EMAIL=re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')
IP=re.compile(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])')
SECRETS=re.compile(r'(?<![\w])(?:sk(?:-ant)?-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[a-z]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16}|Expo(?:nent)?PushToken\[[^\]]+\]|Bearer\s+[A-Za-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)')
PERSONAL_PATHS=re.compile('/'+'(?:Users|Volumes)/[^\s\"\'`]+')
LOCAL_HOST=re.compile(r'(?i)\b[A-Za-z0-9._-]+\.local\b')
EXCLUDED={'node_modules','evidence','backups','build','automation','icloud-PASEO','paseo-home','codex-home','__pycache__'}


def scan(text,deny=()):
    issues=[];allowed=[]
    for number,line in enumerate(text.splitlines(),1):
        for value in EMAIL.findall(line):
            domain=value.split('@',1)[1].lower()
            if domain.endswith('.invalid') or domain in ('example.com','example.org','example.net'):
                allowed.append({'line':number,'kind':'reserved-example-email','value':value})
            else: issues.append({'line':number,'kind':'email'})
        for value in IP.findall(line):
            try: address=ipaddress.ip_address(value)
            except ValueError: continue
            if address.is_loopback or address.is_unspecified:
                allowed.append({'line':number,'kind':'loopback-or-bind-address','value':value})
            else: issues.append({'line':number,'kind':'ip-address'})
        for kind,pattern in [('personal-path',PERSONAL_PATHS),('local-hostname',LOCAL_HOST),('credential-pattern',SECRETS)]:
            if pattern.search(line):issues.append({'line':number,'kind':kind})
        if any(value.casefold() in line.casefold() for value in deny if value):issues.append({'line':number,'kind':'private-deny-list'})
    return issues,allowed


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged',action='store_true')
    parser.add_argument('--deny-file',type=Path,help='Private newline-separated identifiers; keep outside the repository')
    args=parser.parse_args();deny=args.deny_file.read_text().splitlines() if args.deny_file else []
    names=subprocess.check_output(['git','ls-files','-z'],cwd=ROOT).decode().split('\0')
    issues=[];allowed=[];count=0
    for name in filter(None,names):
        file=Path(name)
        if any(part in EXCLUDED for part in file.parts) or file.name in ('CURRENT.txt','OPERATIONS.txt'):
            issues.append({'file':name,'kind':'excluded-file-in-index'});continue
        content=subprocess.check_output(['git','show',':'+name],cwd=ROOT) if args.staged else (ROOT/name).read_bytes()
        count+=1
        try:text=content.decode('utf8')
        except UnicodeDecodeError:
            issues.append({'file':name,'kind':'binary-file'});continue
        found,examples=scan(text,deny)
        issues.extend({'file':name,**entry} for entry in found)
        allowed.extend({'file':name,**entry} for entry in examples)
    print(json.dumps({'filesScanned':count,'issues':issues,'allowedExamples':allowed},ensure_ascii=False,indent=2))
    return 1 if issues or not count else 0


if __name__=='__main__':sys.exit(main())
