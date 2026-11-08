# paseo-public

Paseo용 한국어 개발 워크플로 플러그인입니다.
이 저장소에서 플러그인과 공용 스크립트를 직접 개발하고 배포합니다.

## 기능

- Paseo 0.15.x에서 검증했습니다. 서버 이벤트를 `addHook`으로 등록합니다. 검증 범위 밖의 앱 버전은
  경고만 남기며 설치·실행을 계속합니다. 호환성 알림은 버전마다 한 번이고 기록은 `$PASEO_HOME/airport/runtime/`에 둡니다.
- 설치 보강: 다른 경로(사본)의 `role-workflow` 등록은 `--replace-registration`으로 백업·복원을
  갖추고 전환하며, 앱 안의 CLI를 쓰고 doctor에서 PATH의 별도 CLI를 점검합니다. 설치 뒤 플러그인과
  자동 업데이트의 실제 상태를 확인하고, 자동 업데이트는 등록 불일치를 한 번 알립니다.
- 선택 기능: 매일 자동 업데이트(`./install.sh --with-auto-update`). `origin/main`을
  ff-only로 갱신하고 실패하면 이전 커밋을 복원·refresh합니다. 비활성 작업은 업데이트를
  막지 않으며, 바쁨으로 연속 건너뛰면 알립니다.
- 일시 오류 자동 재개가 무관한 턴이나 일시 차단 뒤에도 유지되고, 실제로 실행 가능한
  재시도만 표시합니다.
- 일반개발·연합개발 작업 연결, 인계, 진행 상태, 컨텍스트 압축과 푸시 승인 화면.
- 푸시는 화면 승인으로만: 에이전트 셸의 `git push`는 기본 차단되고, 사용자가 `/push`에서 승인한
  대상만 플러그인이 푸시합니다.
- 연합개발 구현 담당은 기본으로 같은 워크스페이스의 탭에서 일합니다. 같은 저장소에 미완료 작업이
  겹칠 때만 별도 작업 공간(Git worktree)과 앞 작업을 기다리기 중에서 고릅니다.
- 새 대화는 첫 응답 전에 일반개발·연합개발을 묻고, 모델이 묻지 않으면 대화에 진행 방식 선택
  카드를 띄웁니다. 연합개발의 구현 제품·모델·추론은 플러그인 화면에서 고릅니다. 일반개발도 최초
  대화가 기획·설계·검증을 유지합니다.
- 사용 한도 자동 재개는 왕복·응답 한도를 다시 채우지 않고, 한도에 닿으면 직접 재개를 안내합니다.
- 질문과 작은 변경은 필요한 규칙만 읽도록 지침 부담을 줄였습니다.
- 실행 중인 구현 대화에 사용자가 끼어들거나 오류 뒤 직접 이어가도 연합개발이 멈추거나
  같은 지시를 다시 보내지 않습니다.
- 연합개발의 일시 오류를 자동 재개합니다. 자동 작업 설정의 **일시 오류 자동 재개**
  (`autoResumeTransient`, 기본 켜짐)에서 끌 수 있습니다.
- 같은 저장소의 다른 작업을 기다리면 제목·대시보드에 대기 원인을 표시합니다.
- Claude 실행 모델은 선호 모델을 먼저 두고 계열별로 제안합니다. 기본 목록에 Sonnet 5.5가 포함됩니다.
- 사이드바와 커맨드 센터의 **폴더 열기**: 심볼릭 링크 루트 아래 새 폴더도 찾습니다.

## 설치

macOS, Node.js 22 이상과 npm, Python 3.12 이상, 실행 중인 Paseo 앱이 필요합니다(검증 버전 0.15.x).
운영은 개발 폴더와 별도의 내장 디스크 clone을 사용합니다. 앱·제품 설치, 로그인과 macOS 권한은 사람이 1회 처리합니다.

```sh
./install.sh --dry-run
./install.sh --profile desktop
python3 scripts/setup.py check --json
python3 scripts/setup.py doctor
```

설치기는 config·desktop-settings·사장 칸을 `~/Library/Application Support/paseo-public/backups/install-<시각>/`에
백업하고, 권장값에 지시서 차이를 합쳐 본체의 상위 객체 단위로 맞춥니다. 관련 없는 키는 보존합니다.
다른 경로에 등록돼 있으면 `--replace-registration`을 명시해야 합니다. 등록 전환은 `config set plugins`와
데몬 worker 재시작으로 하며, 지시 전송·압축 중에는 중단합니다. 플러그인을 remove하지 않아 사장 자료를 보존합니다.
같은 옵션은 다른 clone의 자동 업데이트 LaunchAgent도 교체하며, 교체 전 plist를 설치 백업의 `LaunchAgents/`에 남깁니다.
install dry-run은 실제 install이 거부할 사유(등록 경로·Python·Node·데몬 미실행·진행 중 작업·다른 clone의 자동 업데이트)를
`blockers`로 모두 보여 주고, 하나라도 있으면 종료 2입니다.
Codex 실행기를 설치하면 제공자가 가리키는 `CODEX_HOME` 폴더(권장 `$PASEO_HOME/codex-home`)를 0700으로 만듭니다.
권장 직원은 [profiles.json](plugin/role-workflow/shared/presets/profiles.json)을 본체 화면에서 추가하도록 제안만 합니다.
권장 권한은 Codex `full-access`, Claude `bypassPermissions`이며 relay는 켜짐입니다.

`--profile server|desktop`은 처음 설치할 때 선택합니다(기본 desktop). 이후에는 지시서 `decisions.profile`의 날짜 있는 선택이 우선합니다.
server 설비는 daemon-service(기본 B: foreground+KeepAlive, 선택 A: start+감시), update-watch, paseo-watchdog입니다.
기본 variant는 module.json에서 읽으며 지시서의 명시된 variant가 우선합니다. update-watch는 B에서 kickstart -k 한 번, A에서는 stop → kickstart로 교체합니다.
archive-rotate는 오래된 제품 세션을 `$PASEO_HOME/archive`에 보관한 뒤 원본을 옮깁니다(권장 30일).
공통 설비는 Claude 분리 홈·실행기, Codex 실행기·계정 도구·사용량 플러그인입니다. 계정 이름은 금고의 codexAccounts에 직접 적습니다.

기존 등록·state·옛 공용 설정·공항 LaunchAgent 중 하나라도 있는데 profile 결정이 없으면 인자 없는 install은 **쓰기 전에 종료 2**로 멈춥니다.
`./install.sh --profile server|desktop`으로 명시하세요. 새 홈에서만 desktop과 프로필 권장 설비를 기본으로 허가합니다.
기존 홈에서는 설비를 자동 허가하지 않으며, 허가 결정이 없는 프로필 권장 설비를 install 알림과 doctor `equipment.grants`(경고)로 알려 줍니다. `enable`·`disable`은 지시서 `decisions.modules`에 날짜와 revision을 기록하고, 이어지는 install이 적용합니다.
같은 기능의 비공항 설비가 발견되면 허가돼 있어도 설치하지 않고 dry-run·check·doctor에 사유를 표시합니다.
4차 설비 교체는 `enable` → 충돌 확인 → 기존 설비 정리 → `install` 순서로 하나씩 진행합니다.
daemon-service B를 설치할 때 launchd 밖에서 띄운 데몬이 이미 있으면, 진행 중 작업이 없을 때 그 데몬을 멈춰 작업이 넘겨받게 합니다.

```sh
python3 scripts/setup.py enable daemon-service --variant B --dry-run
python3 scripts/setup.py enable daemon-service --variant B
./install.sh --profile server --dry-run
# 충돌로 표시된 기존 설비를 확인하고 해제한 뒤
./install.sh --profile server
# 공항 설비를 해제할 때
python3 scripts/setup.py disable daemon-service
./install.sh --profile server
```

허가 후에도 충돌하면 '허가됨·충돌로 미설치'로 표시합니다. disable 뒤 install은 그 설비의 공항 설치물과
공항이 바꾼 설정만 원복하며, 다른 설비의 공유 파일·인증·사장 자료는 보존합니다. A/B 실제 재기동 수락은 별도 시험입니다.

Claude 설정은 명세서 `presets/claude-home/settings.json`에 날짜 있는 `decisions.claudeHome.settings` 차이를 합칩니다.
본체 스킬과 `decisions.claudeHome.manuals`에서 고른 매뉴얼만 분리 홈에 링크합니다. 제공자 env의 CLAUDE_CONFIG_DIR도 같은 절대경로를 씁니다.
금고에 선택한 키체인 항목이 없으면 실행기는 토큰 없이 분리 홈 로그인을 쓰며 안내합니다. 전역 Claude 홈의 인증 유지 작업은 바꾸지 않습니다.

`check --json`은 공항 커밋·앱/제품 버전·차이(키, 기대값, 실제값, 원본 칸)를 출력합니다. 차이 0이면 종료 0,
있으면 1입니다. 비밀 값은 가립니다. `doctor`는 읽기 전용으로 CLI·로그인·키체인 항목 존재·모델·스킬·포트·cask 기록·업데이트를
점검하고, 사람이 할 일을 안내합니다. 막는 문제가 있으면 종료 1입니다. 버전 호환성 경고만으로는 종료 1이 되지 않습니다. 모든 동작은 `--dry-run`을 지원합니다.

### 사장 칸과 데이터

- 금고: `$PASEO_HOME/owner/vault.json`의 도구 경로·키체인 참조. 토큰 값은 넣지 않습니다.
- 지시서: `$PASEO_HOME/owner/policy.json`의 권장값 차이·날짜 있는 결정·알림.
- 설치 기록·설비 생성물·로그: `$PASEO_HOME/airport/`.
- 작업·인계·규칙 생성물: `$PASEO_HOME/role-workflow/`.
- macOS 앱 설정과 LaunchAgent는 각 계정의 Library 아래에 둡니다.

`PASEO_HOME` 기본값은 `~/.paseo`입니다. 옛 `~/.config/paseo-public/config.json`과 `PASEO_PUBLIC_CONFIG`는
읽기 전용 이관 출처입니다. 저장소별 profiles를 전역 키에 다시 저장하지 않습니다. 사장 칸은 0600 원자적 쓰기와 revision 충돌 검사를 씁니다.
본체 명부·계정·스킬·기록은 자동 선택하거나 덮지 않습니다.

### 자동 업데이트와 refresh

```sh
./install.sh --with-auto-update --dry-run
./install.sh --with-auto-update
python3 scripts/auto-update.py --check
python3 scripts/setup.py refresh --dry-run
python3 scripts/setup.py refresh
```

자동 업데이트는 로그인 직후 실행하지 않고 로컬 04:30에 `origin/main`을 확인합니다. `--check`는 fetch나 파일 쓰기를 하지 않습니다.
main·깨끗한 작업 트리·실행 중인 데몬·현재 clone과 일치하는 등록을 확인하고 ff-only 뒤 `setup.py refresh`를 실행합니다.
지시 전송·압축 중이면 10분 간격으로 3회 더 확인합니다. 3회 연속 예약 건너뜀은 알립니다.
실패하면 `git reset --keep`과 이전 버전 refresh로 복구하며, 사용자 변경을 강제로 덮지 않습니다.

refresh는 lock이 바뀌면 npm ci, 켜진 플러그인 reload, 설비 틀 재생성, 참조가 없는 rules·guides 정리만 합니다.
본체 설정·지시서는 맞추지 않으며 꺼 둔 플러그인은 켜지 않습니다. 현재 규칙 해시와 비보관 작업·본체 에이전트의 참조는 보존하고,
참조를 확인할 수 없으면 정리를 보류합니다. 정리 대상은 dry-run에 표시합니다. 건너뜀·실패는 로그와 지시서의 알림 설정으로 알립니다.
launchd PATH에는 node·python 디렉터리와 안정된 시스템 경로만 넣습니다.

### 제거와 롤백

```sh
./uninstall.sh --dry-run
./uninstall.sh
# 사장 칸까지 지우려는 경우에만(삭제 전 백업)
./uninstall.sh --purge-owner
```

`./uninstall.sh --with-auto-update`는 기존처럼 이 clone의 자동 업데이트 예약만 해제합니다.
옵션 없는 제거는 공항 등록·공개 라벨의 LaunchAgent·설비 생성물을 제거합니다. 실행기를 지우기 전에 공항이 바꾼 provider command를 원복합니다.
데몬이 꺼져 있으면 config 파일을 원자적으로 고칩니다. 사장 칸·사물함·작업·로그·백업은 보존합니다.
설치 실패 시 출력된 백업의 본체 설정을 복원하고 이전 운영 clone으로 다시 등록하세요. 자동으로 plugin remove를 실행하지 않습니다.
이관 이전 버전으로 롤백하면 이관 후 policy에서 바꾼 설정은 이전 버전에 반영되지 않습니다.
옛 접기 감시는 제거 시 공항 라벨 범위에서 정리합니다. 앱을 과거에 재서명했다면 공식 앱을 다시 설치하세요.

## 개발

플러그인과 공용 스크립트의 원본은 이 저장소입니다. 개인 설정·백업은 별도로 관리합니다.
커밋 전 훅은 Git index의 파일을 개인정보 검사하며, 개인 차단 목록은 저장소 밖에 둡니다.
`PASEO_PUBLIC_DENY_FILE`을 지정하거나 기본 `~/.config/paseo-public/sync-deny.txt`를 사용할 수 있습니다.
목록 파일이 없으면 기본 검사를 실행합니다. 푸시는 대상 커밋에 대한 사용자 승인 후 실행합니다.

```sh
npm install
git config core.hooksPath .githooks
npx playwright install chromium
npm test
npm run typecheck
(cd plugin/role-workflow && npm run rules:sync)
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/privacy_scan.py --staged
```

Playwright 브라우저는 개발 테스트에만 필요합니다.
GitHub Actions(`.github/workflows/check.yml`)가 푸시와 PR마다 macOS·Node 22에서 위 검사와
생성 규칙 동기화 여부를 확인합니다. 개인 차단 목록은 CI에 없으므로 공용 패턴만 검사합니다.

실제 Paseo 데몬 검증은 수동으로 실행합니다. `npm run e2e`는 임시 `PASEO_HOME`과 무작위 포트로
데몬을 따로 띄우고, 이 체크아웃의 플러그인을 설치해 가짜 모델(Claude Messages·Codex Responses)과 대화시킵니다.
설치된 Codex CLI가 가짜 모델 제공자를 쓰도록 임시 `CODEX_HOME`을 만듭니다.
실제 계정·사용량을 쓰지 않으며 사용 중인 데몬과 설정은 건드리지 않습니다. 기본 CLI는
`/Applications/Paseo.app/Contents/Resources/bin/paseo`이고 `--paseo <경로>`로 바꿀 수 있습니다.
실패하면 실행 폴더(로그·`results.json`)를 남기며 `--keep`으로 성공 때도 남깁니다.
배포 파일에는 운영 로그·백업·빌드·사용자 설정·계정 인증 파일·node_modules를 넣지 않습니다.
테스트의 `example.invalid` 주소와 루프백 주소는 가상 입력입니다.

## 라이선스

Apache-2.0입니다. Paseo 파생 코드의 원저작권과 변경 사항은 `NOTICE`를 확인하세요.

공항 구조와 각 설정의 소유 경계는 [구조 기준](docs/ARCHITECTURE.md)을 따릅니다.

설정 원본은 `$PASEO_HOME/owner/policy.json`입니다. 기존 state.settings는 1회 이관 뒤 롤백용으로 동결됩니다.
옛 코드로 롤백하면 이관 이후 설정 변경이 사라집니다. 상세는 [플러그인 지시서 안내](plugin/role-workflow/README.md#사장-지시서와-롤백)를 확인하세요.
