# 설비 틀

1차 산출물이며 설치기에 연결하지 않는다. `module.json`은 공용 module.schema.json으로 검증한다.
실행기는 토큰·CLI만 선택한다. 제공자 env의 홈·권한·모델은 바꾸지 않는다.
Claude에는 금고에서 선택한 `PASEO_CLAUDE_KEYCHAIN_SERVICE`·`PASEO_CLAUDE_KEYCHAIN_ACCOUNT`를 전달한다.
제품 내장 CLI, Homebrew(Apple silicon·Intel), PATH 순으로 찾으며 없으면 한국어 오류를 낸다.
Paseo는 `PASEO_APP`(기본 `/Applications/Paseo.app`) 내장 CLI만 쓴다.
계정 전환은 명시적인 `use`만 수행하며, 템플릿이나 이 문서를 읽는 것으로 설치·로그인·재시작은 일어나지 않는다.

manifest의 target은 후속 설치기의 `$INSTALL_ROOT` 기준이다. 같은 공용 런타임 파일은 한 번 설치한다.
현재 실행 예: `python3 modules/claude-launcher/launcher.py --version`.
