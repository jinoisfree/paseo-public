## 변경 요약

<!-- 무엇을 왜 바꾸었는지 적어 주세요. -->

## 공항 구조 점검

[공항 구조와 새 기능 점검표](https://github.com/jinoisfree/paseo-public/blob/main/docs/ARCHITECTURE.md#단계-경계와-새-기능-점검표)를 기준으로 확인합니다.

소유 칸·공식 원본:

- [ ] 소유 칸·공식 원본·쓰기 주체·수명을 정했는가?
- [ ] 본체 칸과 중복되거나 파일 하나가 두 칸에 걸치는가?
- [ ] 공개 권장값·금고·날짜 있는 지시서 차이·사물함이 분리됐는가?
- [ ] 설치·check·doctor·refresh·제거·롤백에서 보존과 삭제 주체가 정해졌는가?
- [ ] 계정·모델·개인 경로를 공개 코드에 넣거나 자동 선택하는가?
- [ ] CLI는 앱 내장 절대경로이며 개발과 운영은 별도인가?
- [ ] 새 키를 소유표에 넣고 분류 안 됨·잔재 수와 지문으로 확인했는가?

## 검증

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `python3 -m unittest discover -s scripts -p 'test_*.py'`
