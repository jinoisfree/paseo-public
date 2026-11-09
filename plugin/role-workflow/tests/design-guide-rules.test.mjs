import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES } from "../server/rules-content.ts";

test("AC-1/2: design guide has one short original and stage links", () => {
 const guide = RULES['15-design-guide.md'];
 assert.ok(guide.trimEnd().split('\n').length <= 90);
 for (const text of ['소유 칸','공식 원본','쓰기 주체','수명','gh search repos|code|issues','GET','웹 검색','선택지 2~4개','파일로 쓰지 않음','개발 안 함','일반개발·개발 안 함','라이선스']) assert.ok(guide.includes(text), text);
 for (const file of ['README.md','00-common.md','10-planning.md','40-paseo-role-workflow.md']) assert.ok(RULES[file].includes('15-design-guide'),file);
 assert.match(RULES['00-common.md'],/신규 계약6\(계약5 \+ 브레인스토밍·첫 계획 승인\)/);
 assert.match(RULES['40-paseo-role-workflow.md'],/신규 등록은 계약7, 계약5 이하는 기존 동작/);
});

// v3.6 restored specification: protect the entire manual rather than only its title.
test("AC-2: restored foundation, research and discussion requirements", () => {
 const guide=RULES['15-design-guide.md'];
 for(const text of ['외부 기술·도구 선택','2회 이상','최소 근간','완성 상태 한 문장 + 칸 표','①','⑨ 날짜 붙은 결정','칸 / 원본 위치 / 둘 것 / 두지 않을 것 / 쓰기 주체 / 수명','기계로 검사','AGENTS.md 맨 위','근간 개정안','실제 소비자','쿼리 10개 이하','표현 6~10개','원조를 한 단계 추적','직접 해당/인접/일부/방치','그대로 쓰기/포크/기여/직접 구현/추가 조사','URL@전체 커밋','LICENSE 파일 확인','학습 지식은 가설','결과가 없다고 새롭다고 판단하지','코드는 복사하지 않고','하위 에이전트','최대 4개','의존 항목은 다음 차례','결정 요약 양식','위험도 1차 판단','(a)','(b)','(c)','답을 기다리는 질문','오픈소스로 충분','좋네요','그냥 해줘','REQ·AC','plan`은 쓰지 않는다']) assert.ok(guide.includes(text),text);
 assert.doesNotMatch(guide,/한 번에 중요한 결정 하나/);
});
