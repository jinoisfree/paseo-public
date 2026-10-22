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
같은 버전의 접기와 점검은 자동 반복하지 않습니다.
접기 실패를 수정한 후에만 수동으로 재시도하세요.

```sh
python3 scripts/auto-reapply-fold.py --force-version <현재앱버전>
```

`directory-search-symlink-*.patch`는 이전 앱 검색 보완의 참고용입니다.
자동 재적용에는 포함하지 않으며 현재는 플러그인의 폴더 열기를 사용합니다.
맥북 등 다른 기기의 로컬 renderer는 별도로 관리해야 합니다.

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
python3 -m unittest -v scripts/test_auto_reapply_fold.py scripts/test_install_pushed_fold.py scripts/test_setup.py scripts/test_privacy_scan.py
python3 scripts/privacy_scan.py --staged
```

Playwright 브라우저는 개발 테스트에만 필요합니다.
배포 파일에는 운영 로그·백업·빌드·사용자 설정·계정 인증 파일·node_modules를 넣지 않습니다.
테스트의 `example.invalid` 주소와 루프백 주소는 가상 입력입니다.

## 라이선스

Apache-2.0입니다. Paseo 파생 패치의 원저작권과 변경 사항은 `NOTICE`를 확인하세요.
