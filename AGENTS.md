# 작업 지침

<!-- handoff-rule:v1 -->
## 도구 간 인계 (Paseo ↔ Codex 앱)

- 한 작업 폴더는 한 번에 한 도구만 쓴다. 다른 도구가 작업 중이면 같은 폴더를 수정하지 않는다.
- 시작할 때 `HANDOFF.md`(없으면 건너뜀), `git status`, `git log -5`를 읽고 이어받는다.
- 끝낼 때와 도구를 바꾸기 전에 `HANDOFF.md`를 갱신한다. 커밋하지 않은 변경은 파일 목록과 이유를 거기에 적는다.
- `HANDOFF.md`는 로컬 전용(`.git/info/exclude`)이므로 커밋하지 않는다. 커밋과 푸시는 이 저장소의 기존 규칙을 따르고, 푸시는 사용자 승인 없이 하지 않는다.

## 개발 원본과 검증

- 이 저장소에서 role-workflow 플러그인과 공용 스크립트·패치를 직접 개발한다. 개인 설정과 실행 데이터는 저장소 밖에서 읽는다.
- 준비: `npm install`, `git config core.hooksPath .githooks`.
- 검사: `npm test`, `npm run typecheck`, `python3 -m unittest discover -s scripts -p 'test_*.py'`.
- 규칙 문서를 고치면 `cd plugin/role-workflow && npm run rules:sync`로 생성 모듈을 갱신한다.
- 개인정보 검사는 `.githooks/pre-commit`이 `python3 scripts/privacy_scan.py --staged`로 실행한다. 개인 차단 목록은 `PASEO_PUBLIC_DENY_FILE` 또는 `~/.config/paseo-public/sync-deny.txt`에만 둔다.
- 커밋 후 저장소·원격·브랜치·전체 해시와 검증 결과를 제시하고 푸시 승인을 기다린다.
