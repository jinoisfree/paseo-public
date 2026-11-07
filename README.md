# paseo-public

Paseo용 한국어 개발 워크플로 플러그인입니다.
이 저장소에서 플러그인과 공용 스크립트를 직접 개발하고 배포합니다.

## 기능

- 설치 보강: 다른 경로(사본)의 `role-workflow` 등록은 `--replace-registration`으로 백업·복원을
  갖추고 전환하며, 앱 안의 CLI를 먼저 쓰고 권한 없는 PATH 링크는 경고합니다. 설치 뒤 플러그인과
  자동 업데이트의 실제 상태를 확인하고, 자동 업데이트는 등록 불일치를 한 번 알립니다.
- 선택 기능: 매일 자동 업데이트(`./install.sh --with-auto-update`). `origin/main`을
  ff-only로 갱신하고 실패하면 이전 커밋을 복원·재설치합니다. 비활성 작업은 업데이트를
  막지 않으며, 바쁨으로 연속 건너뛰면 알립니다.
- 일시 오류 자동 재개가 무관한 턴이나 일시 차단 뒤에도 유지되고, 실제로 실행 가능한
  재시도만 표시합니다.
- 일반개발·연합개발 작업 연결, 인계, 진행 상태, 컨텍스트 압축과 푸시 승인 화면.
- 푸시는 화면 승인으로만: 에이전트 셸의 `git push`는 기본 차단되고, 사용자가 `/push`에서 승인한
  대상만 플러그인이 푸시합니다.
- 연합개발 구현 담당은 기본으로 별도 Git worktree에서 일하고, 검증·푸시된 커밋만 작업 폴더에
  빨리 감기로 반영합니다.
- 새 대화는 실제 변경을 시작하기 전에 일반개발·연합개발을 묻고(질문·조사는 바로 답함), 연합개발의 구현 제품·모델·추론은
  플러그인 화면에서 고릅니다. 일반개발도 최초 대화가 기획·설계·검증을 유지합니다.
- 질문과 작은 변경은 필요한 규칙만 읽도록 지침 부담을 줄였습니다.
- 실행 중인 구현 대화에 사용자가 끼어들거나 오류 뒤 직접 이어가도 연합개발이 멈추거나
  같은 지시를 다시 보내지 않습니다.
- 연합개발의 일시 오류를 자동 재개합니다. 자동 작업 설정의 **일시 오류 자동 재개**
  (`autoResumeTransient`, 기본 켜짐)에서 끌 수 있습니다.
- 같은 저장소의 다른 작업을 기다리면 제목·대시보드에 대기 원인을 표시합니다.
- Claude 실행 모델은 선호 모델을 먼저 두고 계열별로 제안합니다. 기본 목록에 Sonnet 5.5가 포함됩니다.
- 사이드바와 커맨드 센터의 **폴더 열기**: 심볼릭 링크 루트 아래 새 폴더도 찾습니다.

## 설치

macOS, Node.js 22 이상과 npm, Python 3.12 이상, 실행 중인 Paseo 0.15.x가 필요합니다.
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
기존 작업이 끝난 뒤 아래 문제 해결 절의 `--replace-registration`으로 전환하세요.

다른 macOS 계정에서도 그 계정으로 로그인해 설치합니다.
Paseo 계정 홈, 자격 증명, 작업 상태는 각 계정의 `~/.paseo`를 사용하며 공유하지 않습니다.
**폴더 열기**의 기본 루트는 `~/paseo-work`입니다.
다른 폴더를 쓰려면 자동 작업 설정의 ‘폴더 열기 루트’를 바꾸세요.

### 문제 해결

**‘다른 경로의 role-workflow가 이미 등록돼 있습니다’로 중단될 때**
`.git` 없는 이전 사본이나 다른 저장소가 등록된 경우입니다. 먼저 충돌 내용을 확인합니다.
`registrationConflict`에 등록된 source·path와 분류가 나오며 이 단계는 아무것도 바꾸지 않습니다.

```sh
./install.sh --dry-run
```

진행 중인 작업이 없으면 같은 명령에 `--replace-registration`을 붙여 이 저장소로 전환합니다.
`--with-auto-update` 등 다른 옵션도 그대로 함께 씁니다.

```sh
./install.sh --replace-registration
```

데몬이 실행 중이어야 하고, 지시 전송·압축 중인 작업이 있으면 작업 번호와 함께 중단합니다.
전환 전에 `~/.paseo/config.json`을 데이터 폴더의 `backups/registration-<시각>.json`에
백업하며, 실패하면 이전 경로를 다시 등록합니다. 이전 사본 폴더는 지우지 않으니 확인 후 직접 정리하세요.
옵션 없이는 자동으로 전환하지 않습니다.

**`paseo` 명령이 출력 없이 실패할 때**
설치기는 앱 안의 CLI(`Paseo.app/Contents/Resources/bin/paseo`)를 먼저 쓰고 `--version`으로 확인합니다.
자동으로 찾은 CLI 경로는 `config.json`에 저장하지 않습니다. 직접 넣은 `paseo` 값은 그대로 두되,
그 값이 앱 안의 CLI를 가리키거나 읽을 수 없는 링크이면 앱 안의 CLI를 대신 씁니다.
PATH의 `paseo`가 다른 계정 소유의 권한 없는 심볼릭 링크이면 터미널에서 출력 없이 종료 1로
끝날 수 있어, 설치기가 경고 한 줄을 출력합니다(`--dry-run`은 `pathCliWarning`에 표시).
설치기는 그 파일을 고치지 않습니다. 링크 소유 계정에서 경고의 `chmod -h 755 <경로>`를 실행하거나,
`~/.config/paseo-public/config.json`의 `paseo`에 사용할 CLI 경로를 지정하세요.

**자동 업데이트가 동작하는지 확인할 때**

```sh
python3 scripts/auto-update.py --check
```

- `registrationMatches`가 `false`이면 `registeredPath`가 이 저장소가 아닙니다.
  위 `--replace-registration`으로 전환해야 자동 업데이트가 건너뛰지 않습니다.
- `agentInstalled`가 `false`이면 이 저장소의 자동 업데이트 LaunchAgent가 없습니다.
  `./install.sh --with-auto-update`로 등록하세요. 설치 마지막 줄에도 실제 등록 상태가
  `등록됨`·`미등록`·`다른 저장소에 등록됨`으로 표시됩니다.
- `skipReason`이 `null`이 아니면 지금 업데이트를 건너뛰는 이유입니다
  (`branch`, `dirty`, `daemon-stopped`, `foreign-plugin`).
- `--check`는 원격을 읽기만 하며 fetch나 파일 변경을 하지 않습니다.

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
등록 경로 불일치 알림에는 등록된 경로와 `./install.sh --replace-registration --with-auto-update`
해결 명령이 들어 있고, 같은 경로로 계속 건너뛰는 동안에는 반복하지 않습니다.
다른 결과나 다른 경로가 나오면 다시 알립니다.

자동 업데이트 예약만 해제하려면 다음 명령을 실행하세요. 플러그인 등록과
작업 데이터는 유지합니다. 옵션 없는 `./uninstall.sh`는 기존처럼 전체 등록을 해제합니다.

```sh
./uninstall.sh --with-auto-update --dry-run
./uninstall.sh --with-auto-update
```

## 사이드바 접기 기능 제거

이전 버전의 사이드바 접기 패치와 자동 재적용(`--with-fold-reapply`, `--fold-reapply-system`)은
제거했습니다. 접기 설치는 Paseo 앱을 ad hoc으로 재서명해서 앱 안 자동 업데이트를 막고,
외장 볼륨 같은 macOS 개인정보 보호 권한을 잃게 만들었습니다.
`./install.sh`와 `./uninstall.sh`는 이 저장소가 등록했던 사용자 접기 감시
(`io.github.jinoisfree.paseo-public.fold-reapply`)를 자동으로 해제합니다.
`sudo`로 등록한 시스템 감시가 있었다면 직접 해제하세요.

```sh
sudo launchctl bootout system/io.github.jinoisfree.paseo-public.fold-reapply
sudo rm /Library/LaunchDaemons/io.github.jinoisfree.paseo-public.fold-reapply.plist
```

이미 재서명된 앱은 공식 Paseo 앱을 다시 설치해야 원래 서명과 자동 업데이트가 돌아옵니다.
`directory-search-symlink-*.patch`는 이전 앱 검색 보완의 참고용이며 설치에 쓰지 않습니다.

## 사용자 설정과 데이터

설정 파일은 `~/.config/paseo-public/config.json`입니다.
설치기는 감지한 실행 파일 경로를 계정별로 저장합니다.
Node.js는 PATH의 `node` 또는 설정의 `node`를 사용합니다.
필요하면 `PASEO_PUBLIC_NODE`, `PASEO_PUBLIC_PYTHON`, `PASEO_PUBLIC_CONFIG`로 지정할 수 있습니다.
고정된 Homebrew Cellar 버전 경로는 필요하지 않습니다.

- 자동 업데이트 상태·등록 백업: `~/Library/Application Support/paseo-public`
- 자동화 명령 로그·launchd 로그: `~/Library/Logs/paseo-public`
- launchd 등록(자동 업데이트를 켠 경우): `~/Library/LaunchAgents/io.github.jinoisfree.paseo-public.auto-update.plist`
- 작업과 인계 상태: Paseo가 관리하는 계정별 `~/.paseo/role-workflow`

`dataDir`, `logsDir`, `app`, `paseo`, `node` 설정으로 경로를 바꿀 수 있습니다.
개발 저장소에서 같은 코드를 사용하는 경우 `profiles`의 저장소 절대경로 키 아래에
`dataDir`, `logsDir`, `backupDir`를 설정할 수 있습니다.
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

## 등록 해제

```sh
./uninstall.sh --dry-run
./uninstall.sh
```

이 저장소에 해당하는 플러그인과 launchd 등록만 해제합니다.
사용자 설정, 작업, 인계, 로그, 백업은 삭제하지 않습니다.
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
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/privacy_scan.py --staged
```

Playwright 브라우저는 개발 테스트에만 필요합니다.
GitHub Actions(`.github/workflows/check.yml`)가 푸시와 PR마다 macOS·Node 22에서 위 검사와
생성 규칙 동기화 여부를 확인합니다. 개인 차단 목록은 CI에 없으므로 공용 패턴만 검사합니다.

실제 Paseo 데몬 검증은 수동으로 실행합니다. `npm run e2e`는 임시 `PASEO_HOME`과 무작위 포트로
데몬을 따로 띄우고, 이 체크아웃의 플러그인을 설치해 가짜 Claude 모델과 대화시킵니다.
실제 계정·사용량을 쓰지 않으며 사용 중인 데몬과 설정은 건드리지 않습니다. 기본 CLI는
`/Applications/Paseo.app/Contents/Resources/bin/paseo`이고 `--paseo <경로>`로 바꿀 수 있습니다.
실패하면 실행 폴더(로그·`results.json`)를 남기며 `--keep`으로 성공 때도 남깁니다.
배포 파일에는 운영 로그·백업·빌드·사용자 설정·계정 인증 파일·node_modules를 넣지 않습니다.
테스트의 `example.invalid` 주소와 루프백 주소는 가상 입력입니다.

## 라이선스

Apache-2.0입니다. Paseo 파생 패치의 원저작권과 변경 사항은 `NOTICE`를 확인하세요.
