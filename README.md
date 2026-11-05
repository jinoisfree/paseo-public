# paseo-public

Paseo용 한국어 개발 워크플로 플러그인과 macOS 접기 패치 관리 도구입니다.
이 저장소에서 플러그인과 공용 스크립트를 직접 개발하고 배포합니다.

## 기능

- 선택 기능: 매일 자동 업데이트(`./install.sh --with-auto-update`). `origin/main`을
  ff-only로 갱신하고 실패하면 이전 커밋을 복원·재설치합니다. 비활성 작업은 업데이트를
  막지 않으며, 바쁨으로 연속 건너뛰면 알립니다.
- 일시 오류 자동 재개가 무관한 턴이나 일시 차단 뒤에도 유지되고, 실제로 실행 가능한
  재시도만 표시합니다.
- 일반개발·연합개발 작업 연결, 인계, 진행 상태, 컨텍스트 압축과 푸시 승인 화면.
- 새 대화는 첫 응답 전에 일반개발·연합개발을 묻고, 연합개발의 구현 제품·모델·추론은
  플러그인 화면에서 고릅니다. 일반개발도 최초 대화가 기획·설계·검증을 유지합니다.
- 질문과 작은 변경은 필요한 규칙만 읽도록 지침 부담을 줄였습니다.
- 실행 중인 구현 대화에 사용자가 끼어들거나 오류 뒤 직접 이어가도 연합개발이 멈추거나
  같은 지시를 다시 보내지 않습니다.
- 연합개발의 일시 오류를 자동 재개합니다. 자동 작업 설정의 **일시 오류 자동 재개**
  (`autoResumeTransient`, 기본 켜짐)에서 끌 수 있습니다.
- 같은 저장소의 다른 작업을 기다리면 제목·대시보드에 대기 원인을 표시합니다.
- Claude 실행 모델은 선호 모델을 먼저 두고 계열별로 제안합니다. 기본 목록에 Sonnet 5.5가 포함됩니다.
- 사이드바와 커맨드 센터의 **폴더 열기**: 심볼릭 링크 루트 아래 새 폴더도 찾습니다.
- 선택 기능: Paseo 업데이트 후 푸시 완료 작업 접기 renderer를 다시 빌드·설치하고 알립니다.
- 업데이트 후 새 버전 데몬을 최대 10분 기다려 플러그인과 폴더 RPC를 점검합니다.
  자동 점검은 데몬을 재시작하거나 플러그인을 재로드하지 않습니다.

## 설치

macOS, Node.js 22 이상과 npm, Python 3.12 이상, 실행 중인 Paseo가 필요합니다.
플러그인은 서버와 연결된 앱 안에서 실행되는 신뢰된 코드입니다.

저장소를 내려받은 폴더에서 실행합니다.

```sh
./install.sh --dry-run
./install.sh
```

설치기는 필요한 npm 의존성을 설치하고, 현재 계정의 Paseo CLI로
`role-workflow` 디렉터리 플러그인을 등록합니다. 플러그인 기능이 꺼져 있으면
Paseo의 설정 명령으로 켜고 실행 중인 데몬에 설정을 다시 읽힙니다.
앱이나 데몬 프로세스를 재시작하지 않습니다.

같은 경로에서 다시 실행하면 기존 등록과 설정을 유지합니다.
다른 경로의 `role-workflow`가 이미 있으면 덮어쓰지 않고 중단합니다.
기존 작업이 끝난 뒤 등록 경로를 먼저 확인하세요.

다른 macOS 계정에서도 그 계정으로 로그인해 설치합니다.
Paseo 계정 홈, 자격 증명, 작업 상태는 각 계정의 `~/.paseo`를 사용하며 공유하지 않습니다.
**폴더 열기**의 기본 루트는 `~/paseo-work`입니다.
다른 폴더를 쓰려면 자동 작업 설정의 ‘폴더 열기 루트’를 바꾸세요.

## 선택: 매일 자동 업데이트

사용 계정의 저장소에서 다음과 같이 설치합니다. 맥북 등 다른 Mac에서도
그 기기의 사용 계정으로 로그인해 같은 명령을 실행하세요.
**코드를 직접 수정하는 개발 원본 계정에는 이 옵션을 설치하지 마세요.**
옵션 없이 설치하면 자동 업데이트는 등록되지 않습니다.

```sh
./install.sh --with-auto-update --dry-run
./install.sh --with-auto-update
python3 scripts/auto-update.py --check
```

계정별 LaunchAgent가 매일 **로컬 시각 04:30**에 `origin/main` 최신 커밋을
확인합니다. 태그나 앱 버전 기준이 아닙니다. 로그인 직후에는 실행하지 않습니다.
04:30에 잠들어 있었다면 launchd가 깨어난 뒤 놓친 실행을 한 번 수행합니다.
이때 네트워크가 연결되지 않아 fetch에 실패하면 기록만 남기고 다음 날 다시 확인합니다.
`--check`는 원격과 현재 커밋·업데이트 필요 여부만 출력하며 fetch나 파일 변경을 하지 않습니다.

다른 실행이 진행 중이거나, main 브랜치가 아니거나, 추적 파일에 수정·스테이징이
있거나, 원격 조회 실패·최신 상태·로컬 커밋의 갈라짐이면 건너뜁니다.
현재 계정의 Paseo 데몬이 실행 중이고 플러그인이 이 저장소 경로로 등록돼 있어야 합니다.
상태가 `active`인 워크플로가 지시를 전송 중이거나 압축 중이면 10분 간격으로
3회 더 확인한 뒤 계속 바쁘면 그날은 건너뜁니다. 일시정지·오류·사용자 입력 대기·
완료 작업에 남은 전송·압축 표시는 바쁨으로 보지 않습니다. 워크플로 상태 파일에는 쓰지 않습니다.
하루 1회 예약 실행에서 바쁨으로 연속 3회 건너뛰면 원인이 된 작업 번호와 함께
한 번 알립니다. 연속 횟수는 자동 업데이트 상태 파일에 보존하며, 바쁨이 아닌
결과가 나오면 0으로 초기화합니다.

업데이트는 `git merge --ff-only origin/main` → 의존성·등록 설치 → 플러그인
재로드 → 활성 상태 확인 순서로 진행합니다. 앱이나 데몬은 재시작하지 않습니다.
실패하면 `git reset --keep`으로 이전 커밋을 복원하고 다시 설치·재로드합니다.
사용자 변경 때문에 복원이 거부되거나 롤백도 실패하면 강제로 덮어쓰지 않고 알립니다.
같은 저장소를 수동으로 수정·설치하는 동안에는 예약을 해제해 두세요.

결과는 `dataDir/auto-update/state.json`, 명령 로그는 `logsDir/auto-update/`에
남습니다. 기본 위치는 각각 `~/Library/Application Support/paseo-public`과
`~/Library/Logs/paseo-public` 아래입니다. 성공(이전→이후 커밋), 로컬 커밋 갈라짐,
등록 경로 불일치, 실패·롤백 때 macOS 알림을 보냅니다. 최신·일시적 건너뜀에는
알리지 않습니다. 바쁨의 연속 3회 건너뜀은 위 안내대로 알리며,
알림 전달 실패는 업데이트 결과를 바꾸지 않습니다.

자동 업데이트 예약만 해제하려면 다음 명령을 실행하세요. 플러그인 등록과
작업 데이터는 유지합니다. 옵션 없는 `./uninstall.sh`는 기존처럼 전체 등록을 해제합니다.

```sh
./uninstall.sh --with-auto-update --dry-run
./uninstall.sh --with-auto-update
```

## 선택: 접기 자동 재적용

```sh
./install.sh --with-fold-reapply
```

`/Applications/Paseo.app` 같은 공용 앱은 여러 계정에서 같은 파일을 사용합니다.
자동 재적용은 **앱을 소유한 계정 한 곳에서만** 설치하세요.
설치기는 앱 소유 계정을 확인하고 기존 접기 감시 에이전트와 중복 등록하지 않습니다.
다른 계정은 플러그인만 설치하면 됩니다.

사용자 launchd가 앱 버전 변경과 하루 1회 점검으로 업데이트를 감지합니다.
공식 Paseo 태그 소스를 받고 접기 패치만 적용한 뒤 단위 테스트, 타입 검사,
린트, Electron용 웹 빌드를 통과하면 앱 전체를 백업합니다.
그다음 renderer를 교체하고 ad hoc 재서명·검증합니다.
`app.asar`와 `Info.plist`의 내용은 변경하지 않습니다.
완료 알림 후 Paseo에서 **Cmd+R**을 누르세요.
재서명된 앱은 앱 안 자동 업데이트로 교체되지 않습니다. Homebrew cask로 설치했다면
`brew upgrade --cask paseo`로 업데이트하세요. 바뀐 앱을 감지해 접기를 다시 적용합니다.

플러그인은 `>=0.10.2` 범위로 버전 상한을 두지 않습니다.
실제 검증한 앱 소스는 0.11.4와 0.12.0이며, 0.13.0은 공식 소스 기준 접기 빌드(dry-run)와
플러그인 타입 검사·테스트를 확인했습니다. 미래 API 변경은 업데이트 후 점검으로 확인합니다.
접기 패치는 대상 버전 이하에서 가장 높은 버전의 것을 사용합니다.
접기 빌드가 실패해도 플러그인 점검은 따로 수행하고 결과를 알립니다.
같은 버전의 접기는 자동 반복하지 않습니다. 단, 같은 버전을 다시 설치해 앱 파일이
바뀌면 다시 적용합니다. 플러그인 점검은 소유 계정의 데몬이
없으면 `deferred`로 미루고, 다음 실행에서 현재 버전 점검만 다시 합니다.
연기 중에는 점검 실패 알림을 보내지 않으며, 점검이 끝나면 버전별로 결과를 유지합니다.
접기 실패를 수정한 후에만 수동으로 재시도하세요.

```sh
python3 scripts/auto-reapply-fold.py --force-version <현재앱버전>
```

`directory-search-symlink-*.patch`는 이전 앱 검색 보완의 참고용입니다.
자동 재적용에는 포함하지 않으며 현재는 플러그인의 폴더 열기를 사용합니다.
맥북 등 다른 기기의 로컬 renderer는 별도로 관리해야 합니다.

## 선택: 로그인 없이 접기 감시

소유 계정이 로그아웃해 있거나 다른 계정만 로그인해 있어도 감시하려면
앱 소유 계정에서 먼저 `./install.sh`로 플러그인과 의존성을 설치한 뒤 실행하세요.

```sh
./install.sh --fold-reapply-system --dry-run
sudo ./install.sh --fold-reapply-system
```

sudo 모드는 **시스템 감시만** 등록합니다. `/Library/LaunchDaemons`의 job은
앱 소유 계정을 `UserName`으로 사용하고 그 계정의 HOME·Paseo·설정을 사용합니다.
빌드·서명은 root가 아닌 앱 소유 계정 권한으로 실행합니다.
기존 같은 저장소의 LaunchAgent는 설정 데이터 안에 백업하고 해제합니다.
다른 접기 감시가 있으면 먼저 그 감시의 설치기로 전환하거나 해제하세요.
사용자 감시와 시스템 감시는 함께 등록하지 않습니다.

저장소나 Python이 있는 볼륨이 아직 없으면 시스템 `/bin/sh`가 정상 종료합니다.
`StartOnMount`로 마운트 시 다시 실행하며 앱 변경 감시와 하루 1회 실행도 유지합니다.
WorkingDirectory와 로그 경로는 로그인 없이 접근할 수 있는 로컬 홈에 두세요.
암호화된 볼륨이 잠겨 있으면 잠금 해제·마운트 후 실행됩니다.
GUI 알림 실패·10초 시간 초과는 기록만 남기고 빌드/설치 결과를 바꾸지 않습니다.
서명은 키체인 인증서가 필요 없는 ad hoc 방식이며 빌드는 `CI=1`을 사용합니다.
자동화의 접기 알림은 macOS 방식이며, GUI가 없을 때 전달은 보장하지 않습니다.
결과는 상태와 로그에 남고, 소유 계정 데몬 점검이 연기됐다면 후속 점검 후 알립니다.

시스템 감시를 되돌리면 백업된 LaunchAgent가 복원됩니다.
소유 계정이 로그아웃 상태면 다음 로그인 때 LaunchAgent가 로드됩니다.

```sh
./uninstall.sh --fold-reapply-system --dry-run
sudo ./uninstall.sh --fold-reapply-system
```

플러그인 등록·사용자 데이터·앱 renderer는 이 모드에서 지우거나 바꾸지 않습니다.
다른 계정의 플러그인은 각 계정에서 따로 설치합니다.

## 사용자 설정과 데이터

설정 파일은 `~/.config/paseo-public/config.json`입니다.
설치기는 감지한 실행 파일 경로를 계정별로 저장합니다.
Node.js는 PATH의 `node` 또는 설정의 `node`를 사용합니다.
필요하면 `PASEO_PUBLIC_NODE`, `PASEO_PUBLIC_PYTHON`, `PASEO_PUBLIC_CONFIG`로 지정할 수 있습니다.
고정된 Homebrew Cellar 버전 경로는 필요하지 않습니다.

- 자동화 상태·다운로드·빌드·백업: `~/Library/Application Support/paseo-public`
- 자동화 명령 로그·launchd 로그: `~/Library/Logs/paseo-public`
- launchd 등록: `~/Library/LaunchAgents/io.github.jinoisfree.paseo-public.fold-reapply.plist`
- 작업과 인계 상태: Paseo가 관리하는 계정별 `~/.paseo/role-workflow`

`dataDir`, `logsDir`, `app`, `paseo`, `node` 설정으로 경로를 바꿀 수 있습니다.
개발 저장소에서 같은 코드를 사용하는 경우 `profiles`의 저장소 절대경로 키 아래에
`dataDir`, `logsDir`, `buildDir`, `backupDir`, `distTemplate`, `pluginPath`를 설정할 수 있습니다.
이 값은 사용자 설정 파일에만 보관하며 공개 저장소에 넣지 않습니다.
설정에는 필요할 때만 본인 경로를 넣고 저장소에 복사하지 마세요.

휴대폰 알림은 기본으로 꺼져 있습니다. 본인이 Paseo에서 알림 수신을 설정한 뒤
설정 파일에 다음 공개 Expo 서비스 주소와 명시적 동의를 넣어야 전송합니다.
토큰은 Paseo가 계정 홈에서 관리하며 이 저장소에는 포함하지 않습니다.

```json
{
  "phoneNotifications": true,
  "phoneNotificationEndpoint": "https://exp.host/--/api/v2/push/send"
}
```

macOS의 접기 결과 알림은 위 휴대폰 설정과 별개입니다.

## 등록 해제

```sh
./uninstall.sh --dry-run
./uninstall.sh
```

이 저장소에 해당하는 플러그인과 launchd 등록만 해제합니다.
사용자 설정, 작업, 인계, 로그, 빌드, 백업, 현재 앱 renderer는 삭제하거나 되돌리지 않습니다.
Paseo가 실행 중인 상태에서 플러그인 등록을 해제하세요.

## 개발

플러그인과 공용 스크립트·패치의 원본은 이 저장소입니다. 개인 설정·백업은 별도로 관리합니다.
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
python3 -m unittest -v scripts/test_auto_reapply_fold.py scripts/test_install_pushed_fold.py scripts/test_setup.py scripts/test_privacy_scan.py scripts/test_fold_daemon_setup.py
python3 scripts/privacy_scan.py --staged
```

Playwright 브라우저는 개발 테스트에만 필요합니다.
배포 파일에는 운영 로그·백업·빌드·사용자 설정·계정 인증 파일·node_modules를 넣지 않습니다.
테스트의 `example.invalid` 주소와 루프백 주소는 가상 입력입니다.

## 라이선스

Apache-2.0입니다. Paseo 파생 패치의 원저작권과 변경 사항은 `NOTICE`를 확인하세요.
