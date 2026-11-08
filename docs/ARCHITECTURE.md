# Paseo 공항 구조

모든 개발의 구조 기준이다. 공항은 누구나 같은 시설·도구 집행·매뉴얼·권장 프로필 목록을 배포하고,
사장은 금고·지시서·명부·사물함을 가진다. 본체가 제공하는 칸의 수명이 이 원칙에 맞으면 본체가 원본이다.
업데이트·플러그인 제거가 사장 자료를 지우는 칸은 원본으로 쓰지 않는다.

본체는 Paseo 앱·데몬·내장 CLI, Claude Code, Codex CLI다. 직원은 에이전트 프로필이고 직책은 planner·executor다.
연합개발은 별도 대화 두 개이며 provider/model이 같으면 단일 모델 검증이다.
사장 홈은 `$PASEO_HOME`(기본 `~/.paseo`), 현장은 프로젝트 저장소다.
현장의 `AGENTS.md`·`paseo.json`은 현장이 원본이다. 시설의 승인된 Git 동작 외에 공항은 이를 읽기만 한다.

## 칸

원형 12칸(시설·도구 집행·서가·명세서·금고·지시서·명부·사장 매뉴얼·사물함·시간표·설치 상태·격납고)을
Paseo 본체 칸과 함께 대응시킨다. 기계용 원본은 [소유표](../plugin/role-workflow/shared/presets/ownership.json)다.

| 칸 | 일반 형태 → Paseo 대입 | 원본 위치 |
| --- | --- | --- |
| 본체 설정 | 제공자 command/env·프로필·스킬·등록·worktrees.root | `$PASEO_HOME/config.json` |
| 본체 데스크톱 설정 | 데몬 관리·종료 뒤 유지·업데이트 채널 | 앱 Application Support의 desktop-settings.json |
| 본체 런타임·로그·화면 상태 | PID·로그·첨부·창·Local Storage·IndexedDB | 사장 홈·앱 Application Support·Logs |
| 본체 신원·비밀 | 서버 ID·키쌍·자격·푸시 토큰·config 비밀 | 사장 홈·본체 설정 |
| 본체 설치 기록 | 패키지 관리자의 앱 기록 | Homebrew |
| 공항 시설 | 엔진·대시보드·설치기·refresh | plugin/role-workflow、scripts |
| 시설 런타임 생성물 | rules 해시별 사본·guides·push guard | 사장 홈의 role-workflow |
| 시설 설비 | 실행기·계정 전환·사용량·데몬·감시·인증 유지·보관 | modules |
| 직원 도구 집행 | 위험 행동 확인·통제 | 시설 |
| 매뉴얼 서가 | 역할 규칙 | plugin/role-workflow/rules |
| 공용 명세서 | 권장 설정·본체 키·프로필 틀·운영 프로필 | plugin/role-workflow/shared/presets |
| 사장 금고 | 키체인 참조·계정 이름·도구 경로·백업 위치 | `$PASEO_HOME/owner/vault.json` |
| 사장 지시서 | 설비 허가·시각·알림·프로필·권장값 차이·folderRoots | `$PASEO_HOME/owner/policy.json` |
| 직원 명부 | 실제 에이전트 프로필 | 본체 daemon.agentProfiles |
| 사장 매뉴얼 | 개인 스킬 | 제품 스킬 폴더의 사장 항목 |
| 사장 셸 | PATH·함수 | 사장 홈의 셸 설정 |
| 직원 사물함 | 작업·보관·프로젝트 기억·인계·증거·세션·auth | 사장 홈·제품 홈 |
| 운항 시간표 | 설비 틀 + 사장이 정한 시각 | ~/Library/LaunchAgents |
| 설치 상태 | 의존성 잠금·업데이트 상태·설비 로그 | $PASEO_HOME/airport |
| 정비 격납고 | 백업·개인 차단 목록·작업 설계·정비 증거 | 비공개 |

프로필 JSON은 추가할 때 확인하는 틀이며 실제 명부를 덮지 않는다.
Claude 직원은 `$PASEO_HOME/claude-home`, Codex는 `$PASEO_HOME/codex-home`에서 일한다.
개인 Claude 홈과 섞지 않고 본체 스킬·사장 매뉴얼은 선택한 링크로 연결한다.
제품 세션·auth는 사물함, 키체인 항목을 찾는 이름은 금고다.
같은 Mac의 다른 macOS 계정도 별도 사장이다. 앱은 공유할 수 있어도 홈·포트·세션은 다르다.
외부 자동화·사용량 앱·VPN은 경계 밖 의존이며 접점을 doctor로 점검한다.

## 원칙

1. 먼저 칸을 정한다. 두 번째 원본을 만들지 않는다.
2. 새 코드는 직책 키를 쓴다. 기존 제품별 분기는 별도 범위다.
3. 권장값 원본은 shared/presets 하나다. 스키마 검증한 값을 계약 기본값으로 쓴다.
4. 파일은 한 칸에만 속한다. state.settings는 지시서로 옮기고 엔진이 쓰는 projects 기억은 사물함에 둔다.
5. 조립 결과를 손으로 고치지 않는다. --check는 차이와 고칠 원본 칸을 안내한다.
6. 켜진 제품이 0개면 연합개발을 비활성화한다.
7. 위험 행동은 시설이 집행한다. 집행 없는 등급표를 만들지 않는다. 현재 집행 범위는 Git push뿐이다. full-access/bypassPermissions에서는 권한 요청 훅을 전제로 삼을 수 없다.
8. 계정·모델은 자동 선택하지 않는다. 계정별 모델 ID는 권장 틀에만 두고 실행 기본값에 넣지 않는다.
9. 수명이 맞는 본체 칸을 우선한다. 제거 때 삭제되고 서버에서 쓸 수 없는 plugin-settings는 지시서 원본으로 쓰지 않는다.
10. 동적 config 키는 상위 객체 전체를 읽고 공항 소유 하위 키만 바꿔 `paseo daemon config set`으로 쓴다. 잠금이 없어 전후 --check가 필요하다. 비밀이 가려진 get 대신 파일로 비교한다. plugins 변경에는 데몬 재시작이 필요하다. Codex shell_environment_policy는 공항 소유가 아니다.
11. 운영은 내장 디스크의 별도 clone을 등록하고 origin/main 자동 업데이트를 받는다. 개발 원본을 운영에 등록하지 않는다.
12. 자동 업데이트는 refresh다. 공항 파일·시설 생성물만 갱신하고 본체 config·지시서를 맞추거나 꺼 둔 플러그인을 다시 켜지 않는다. 건너뜀·실패는 알린다.

## 동일과 한계

같아야 하는 것은 공항 커밋·규칙·권장 설정·본체 권장 키·실행기·설비·사용 가능한 권장 직원 틀이다.
금고·지시서·개인 스킬·기록·화면·셸은 사람마다 다르다. 설치는 백업 후 권장값으로 맞추고 지시서 차이만 유지한다.
권한 권장은 full-access/bypassPermissions이고 설치 시 고지한다.
세팅 지문은 공항 커밋 + --check 차이 0 + --doctor 통과 + 인벤토리 분류 안 됨 0이다.
앱·제품 CLI는 각자 업데이트하므로 같은 본체 버전에서의 동일이다. 지문에 세 제품 버전을 기록한다.
못 쓰는 모델은 사용자가 고르고 지시서에 차이를 남긴다. CPU·Homebrew·macOS 차이는 감지한다.
listen 포트를 강제하지 않고 충돌을 점검한다. 다른 Mac의 깨끗한 계정에서 설치·지문 비교·실제 연합개발 왕복이 필수 수락 게이트다.
최종 운영은 설치된 공항·사장 칸·사물함·본체만 남긴다. 옛 실행기·미러·병행 사본·잔재는 0, 롤백 백업 삭제는 다른 Mac 수락 뒤다.

사람이 1회 할 일: 앱·제품 CLI 설치, 구독 로그인·키체인 토큰, macOS 권한, 휴대폰 페어링,
앱 Host → Skills 최초 설치, server 자동 로그인, Claude 분리 홈 대화형 로그인. doctor는 안내하며 계정을 대신 고르지 않는다.
Paseo CLI는 앱 내장본 하나를 절대경로로 부른다. 공항은 CLI를 별도 설치하지 않는다.
server는 외부 데몬·업데이트 감시·Paseo 전용 watchdog, desktop은 앱 소유 데몬이다.
전역 Claude 인증 유지 작업은 다른 도구도 사용하므로 교체하지 않는다.

## 단계 경계와 새 기능 점검표

설치기 install은 백업 → 사장 칸 → 본체 권장 상위 객체 → 등록 → 설비 → 고지를 수행한다.
금고 paths는 도구 경로, 지시서 decisions.profile은 날짜 있는 운영 프로필 선택이다. desktop-settings는 본체의 version/settings 형식을 따른다.
check·doctor는 파일을 쓰지 않는다. refresh는 본체·지시서와 꺼진 등록을 건드리지 않고 의존성·설비·켜진 플러그인·검증된 미참조 생성물만 갱신한다.
uninstall은 command 원복 뒤 설비를 지우고 사장 칸·사물함을 보존한다. --purge-owner만 백업 뒤 사장 칸을 지운다.
앱 설정·LaunchAgent·백업은 macOS 계정 Library, 공항 설치 상태·설비 생성물은 $PASEO_HOME/airport가 소유한다.
설비·분리 홈 조립은 module.json과 지시서 허가로 수행한다. 기존 설치는 명시적 profile이 있어야 조립하고, 기존 비공항 설비와 충돌하면 설치하지 않는다. 다른 Mac 수락·실제 설비 교체·잔재 제거는 후속 단계다. 현재 설정은 owner/policy.json을 읽고 state.settings는 롤백용 동결 사본이다.

- 소유 칸·공식 원본·쓰기 주체·수명을 정했는가?
- 본체 칸과 중복되거나 파일 하나가 두 칸에 걸치는가?
- 공개 권장값·금고·날짜 있는 지시서 차이·사물함이 분리됐는가?
- 설치·check·doctor·refresh·제거·롤백에서 보존과 삭제 주체가 정해졌는가?
- 계정·모델·개인 경로를 공개 코드에 넣거나 자동 선택하는가?
- CLI는 앱 내장 절대경로이며 개발과 운영은 별도인가?
- 새 키를 소유표에 넣고 분류 안 됨·잔재 수와 지문으로 확인했는가?
