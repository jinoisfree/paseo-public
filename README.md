# paseo-public

Paseo용 한국어 개발 워크플로 플러그인과 macOS 접기 패치 관리 도구입니다.
공개 저장소 이름은 `jinoisfree/paseo-public`입니다.

## 기능

- 일반개발·연합개발 작업 연결, 인계, 진행 상태, 컨텍스트 압축과 푸시 승인 화면.
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

플러그인은 `>=0.10.2` 범위로 버전 상한을 두지 않습니다.
실제 검증한 앱 소스는 0.11.4와 0.12.0이며, 미래 API 변경은 업데이트 후 점검으로 확인합니다.
접기 빌드가 실패해도 플러그인 점검은 따로 수행하고 결과를 알립니다.
같은 버전의 접기는 자동 반복하지 않습니다. 플러그인 점검은 소유 계정의 데몬이
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

## 개발 검사

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm test
npm run typecheck
python3 -m unittest -v scripts/test_auto_reapply_fold.py scripts/test_install_pushed_fold.py scripts/test_setup.py scripts/test_privacy_scan.py scripts/test_fold_daemon_setup.py
python3 scripts/privacy_scan.py --staged
```

Playwright 브라우저는 개발 테스트에만 필요합니다.
배포 파일에는 운영 로그·백업·빌드·사용자 설정·계정 인증 파일·node_modules를 넣지 않습니다.
테스트의 `example.invalid` 주소와 루프백 주소는 가상 입력입니다.

## 라이선스

Apache-2.0입니다. Paseo 파생 패치의 원저작권과 변경 사항은 `NOTICE`를 확인하세요.
