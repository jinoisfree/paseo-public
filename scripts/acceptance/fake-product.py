#!/usr/bin/env python3
"""Credential-free catalog double; no turns, files, credentials or network requests."""
import json
import sys
if '--version' in sys.argv:
    print('codex-cli 0.163.0' if 'codex' in sys.argv[0] else '2.1.287 (Claude Code)')
    sys.exit(0)
if 'app-server' in sys.argv:
    for line in sys.stdin:
        request = json.loads(line)
        if 'id' not in request: continue
        method = request.get('method')
        if method == 'initialize': result = {'userAgent': 'airport-acceptance'}
        elif method == 'model/list': result = {'data': [{'id':'gpt-5.4','model':'gpt-5.4','displayName':'Fixture','description':'Credential-free fixture','hidden':False,'supportedReasoningEfforts':[{'reasoningEffort':'medium','description':'Fixture'}],'defaultReasoningEffort':'medium','inputModalities':['text'],'supportsPersonality':False,'isDefault':True}], 'nextCursor':None}
        elif method == 'account/read': result = {'account':None,'requiresOpenaiAuth':False}
        else: result = {}
        print(json.dumps({'id':request['id'],'result':result}), flush=True)
    sys.exit(0)
print('수락 시험용 CLI는 대화를 실행하지 않습니다.', file=sys.stderr)
sys.exit(2)
