# Mac 수락 시험(C32)

앱을 설치한 macOS 계정에서 저장소의 의존성을 `npm ci`로 준비한 뒤 실행합니다.
앱 CLI는 별도로 설치하지 않습니다. Node.js 22 이상·Python 3.12 이상·Claude CLI가 필요합니다.
로그인·키체인 값 조회·운영 설정 변경은 하지 않습니다.

```sh
python3 -B scripts/acceptance/run.py --output test-results/phase3/acceptance
# 앱 위치가 다를 때
python3 -B scripts/acceptance/run.py --app /Applications/Paseo.app
```

다른 Mac의 3.5차에도 같은 명령을 사용하고 verification.json과 명령별 로그를 보관합니다.
결과에는 해당 Mac의 경로가 들어가므로 커밋하지 않습니다.

시험은 차례대로 실행하며 중복 실행하지 않습니다. `--only lifecycle|ab|update|claude`로 개별 재현할 수 있습니다.
기본 포트 6799부터 6803까지 사용하며 6767은 거부합니다. `--port`로 빈 시작 포트를 바꿀 수 있습니다.
기존 시험 라벨이 발견되면 덮지 않고 중단합니다.

- lifecycle: 실제 앱 CLI로 Claude만/Codex만/둘 다 구성에서 install→check→refresh→enable/disable→uninstall.
  제품 CLI는 인증·네트워크 없는 가짜이며 실제 데몬 카탈로그와 플러그인의 C9 함수를 함께 검사합니다. 제품 0개 거부도 확인합니다.
- ab: 실제 설비 A/B 템플릿의 홈·라벨만 격리해 launchd에 등록합니다. supervisor PID는 격리 홈의 상태·PID 파일·worker 부모 PID로 검증한 뒤 SIGKILL합니다.
  A는 실제 watchdog 1회, B는 기본 KeepAlive로 재기동을 측정합니다. 기본 launchd throttle도 그대로 둡니다.
- update: 금고의 가짜 앱 0.15.4/실제 CLI 링크로 실제 update-watch를 호출합니다. 앱 업데이트 자체를 재현한 것은 아닙니다.
- claude: 임시 HOME/CLAUDE_CONFIG_DIR, 토큰 변수 제거, macOS sandbox로 키체인 파일·Security 서비스 접근을 차단하고 `claude -p 'ok'`를 60초 관측합니다.
  타임아웃이면 해당 명령의 프로세스 그룹을 종료합니다. stdout/stderr·종료 코드·시간을 남기며 로그인하지 않습니다.

설비의 runner는 명령을 실제 실행하되 kickstart 목적지만 시험 라벨로 제한하고 데스크톱 알림은 증거에 기록합니다.
운영 public daemon-service 라벨로 전달하지 않습니다. 시험용 plist는 임시 홈에 두고 운영 LaunchAgents 폴더를 건드리지 않습니다.
모든 종료 경로에서 bootout·격리 데몬 stop·포트/PID/라벨 잔재 검사를 수행합니다. 정리 실패 시 임시 홈을 보존하고 실패로 반환합니다.
운영 config·owner·desktop-settings·LaunchAgents의 해시/메타데이터와 PID 파일의 해시·PID 값을 전후 비교합니다.
PID 파일의 mtime은 본체 heartbeat로 주기적으로 바뀌므로 비교하지 않습니다.
