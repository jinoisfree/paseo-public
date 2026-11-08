import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { materializeRules } from "../server/rules.ts";
import { RULES, RULES_VERSION } from "../server/rules-content.ts";
import { composePrompt } from "../server/roles.ts";
import { generalPrompt } from "../server/start-guide.ts";
import { modeSelectPrompt, stripManagedBlocks, pushApprovalPrompt } from "../server/protocol.ts";

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-rules-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function contents(readme) {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(RULES).map(async (name) => [
        name,
        await readFile(path.join(path.dirname(readme), name), "utf8"),
      ]),
    ),
  );
}

test("materialization publishes complete versioned rules without touching other data", async (t) => {
  const dir = await directory(t);
  await writeFile(path.join(dir, "state.json"), "sentinel");
  const readme = await materializeRules(dir);
  assert.equal(readme, path.join(dir, "rules", RULES_VERSION, "README.md"));
  assert.deepEqual(await contents(readme), RULES);
  assert.equal(await readFile(path.join(dir, "state.json"), "utf8"), "sentinel");
  assert.deepEqual(await readdir(path.join(dir, "rules")), [RULES_VERSION]);
});

test("matching materialization preserves file and directory identity and timestamps", async (t) => {
  const dir = await directory(t);
  const readme = await materializeRules(dir);
  const before = await Promise.all([
    stat(readme, { bigint: true }),
    stat(path.dirname(readme), { bigint: true }),
  ]);
  assert.equal(await materializeRules(dir), readme);
  const after = await Promise.all([
    stat(readme, { bigint: true }),
    stat(path.dirname(readme), { bigint: true }),
  ]);
  assert.deepEqual(
    after.map(({ ino, mtimeNs }) => [ino, mtimeNs]),
    before.map(({ ino, mtimeNs }) => [ino, mtimeNs]),
  );
});

test("corrupted or missing rule files are repaired as a complete version", async (t) => {
  const dir = await directory(t);
  const readme = await materializeRules(dir);
  await writeFile(readme, "corrupt");
  await rm(path.join(path.dirname(readme), "20-implementation.md"));
  assert.equal(await materializeRules(dir), readme);
  assert.deepEqual(await contents(readme), RULES);
  assert.deepEqual(await readdir(path.join(dir, "rules")), [RULES_VERSION]);
});

test("concurrent materialization shares publication and leaves no staging directories", async (t) => {
  const dir = await directory(t);
  const paths = await Promise.all(Array.from({ length: 12 }, () => materializeRules(dir)));
  assert.ok(paths[0]);
  assert.ok(paths.every((value) => value === paths[0]));
  assert.deepEqual(await contents(paths[0]), RULES);
  assert.deepEqual(await readdir(path.join(dir, "rules")), [RULES_VERSION]);
});

test("write failure logs an error and omits only the rules block", async (t) => {
  const dir = await directory(t);
  await writeFile(path.join(dir, "rules"), "blocked");
  const log = t.mock.method(console, "error", () => {});
  const readme = await materializeRules(dir);
  assert.equal(readme, null);
  assert.equal(log.mock.callCount(), 1);
  assert.match(log.mock.calls[0].arguments[0], /규칙 문서 비치 실패/);
  const prompt = composePrompt("claude", "project", { automated: true, rulesReadme: readme });
  assert.doesNotMatch(prompt, /<paseo-agent-rules-v1>/);
  assert.match(prompt, /<paseo-role-workflow-v1>/);
  assert.match(prompt, /<paseo-automation-v1>/);
});

test("both federated roles receive one ungated path-only rules block on every composition", async (t) => {
  const readme = await materializeRules(await directory(t));
  for (const role of ["plan", "execute"]) {
    const parts = { role, automated: true, mode: modeSelectPrompt("claude"), rulesReadme: readme };
    const prompt = composePrompt("claude", "project", parts);
    assert.equal(composePrompt("claude", prompt, parts), prompt);
    assert.equal(prompt.split("<paseo-agent-rules-v1>").length - 1, 1);
    const block = /<paseo-agent-rules-v1>([^]*?)<\/paseo-agent-rules-v1>/.exec(prompt)[1];
    assert.ok(block.includes(JSON.stringify(readme)));
    assert.doesNotMatch(block, /연합개발 전용/);
    assert.equal(await readFile(readme, "utf8"), RULES["README.md"]);
    assert.ok(prompt.indexOf("<paseo-agent-rules-v1>") < prompt.indexOf("<paseo-mode-select-v1>"));
    assert.doesNotMatch(prompt, /핵심 수학 알고리즘|판정 보고는 다음 작업의 인계 문서/);
    assert.doesNotMatch(stripManagedBlocks(prompt), /paseo-agent-rules/);
  }
});

test("general prompts receive and replace the same ungated rules block", async (t) => {
  const dir = await directory(t);
  const readme = await materializeRules(dir);
  const prompt = await generalPrompt(dir, "project", "guide", pushApprovalPrompt(), readme);
  assert.equal(await generalPrompt(dir, prompt, "guide", pushApprovalPrompt(), readme), prompt);
  assert.equal(prompt.split("<paseo-agent-rules-v1>").length - 1, 1);
  assert.ok(prompt.includes(JSON.stringify(readme)));
  assert.ok(prompt.indexOf("<paseo-agent-rules-v1>") < prompt.indexOf("<paseo-general-v1>"));
  assert.doesNotMatch(
    prompt,
    /連合|\[연합개발 전용\]|<paseo-role-workflow-v1>|<paseo-automation-v1>/,
  );
});

// AC-4/5: composed instructions use the same stage policy as the materialized rules.
test('lightweight reading and record policy remains consistent in injected prompts', async t => {
 const readme=await materializeRules(await directory(t));
 const {composeCurrentPrompt}=await import('../server/roles.ts');
 const {SCREEN_SELECTION_PROMPT}=await import('../server/executor-selection.ts');
 const prompt=composeCurrentPrompt('codex','','undecided',readme,SCREEN_SELECTION_PROMPT, '');
 assert.match(prompt,/질문·설명 요청에는 note로 답/);
 // The mode question is never skipped while undecided, even for questions.
 assert.match(prompt,/첫 응답 전에 질문 도구로 진행 방식을 단독 질문한다\. 질문·설명·읽기 전용 조사 요청이어도 생략하지 않는다/);
 assert.match(RULES['README.md'],/요청 종류와 관계없이 첫 응답 전에 진행 방식을 묻는다/);
 assert.match(RULES['00-common.md'],/요청 종류와 관계없이 첫 응답 전에/);
 assert.match(prompt,/현재 단계 상세/);assert.match(prompt,/무변경 상세 문서 전체 재독은 강제하지/);
 assert.doesNotMatch(prompt,/진행 방식·구현 담당 선택 없이|plan: 00-common.md, 10-planning.md, 30-verification.md/);
 assert.match(RULES['README.md'],/기획·설계.*10-planning.md/);
 assert.match(RULES['README.md'],/최종 검토.*30-verification.md/);
 assert.match(RULES['00-common.md'],/별도 spec\/design\/tasks\/ADR 파일을 강제하지/);
 assert.match(RULES['10-planning.md'],/일반 변경의 사전 별도 검토는 일률 의무가 아니다/);
 // PARALLEL-SUBAGENTS AC-7: preserve the planning, execution and review boundaries.
 assert.match(RULES['10-planning.md'],/갈래별로 담당 파일\(갈래끼리 겹치지 않음\), 선행 관계, 난이도\(단순\/보통\/어려움\), 완료 조건을 적는다/);
 assert.match(RULES['10-planning.md'],/계획에는 모델 이름을 적지 않는다/);
 // Additional handoff 2, AC-11: require an explicit parallelism decision and criteria.
 assert.match(RULES['10-planning.md'],/작업 분할 때 병렬 후보 여부를 반드시 판단하고/);
 assert.match(RULES['10-planning.md'],/인계서 9번에 `병렬 갈래: 있음` 또는 `병렬 갈래: 없음\(이유\)` 중 하나를 적는다/);
 assert.match(RULES['10-planning.md'],/경미 변경도 생략하지 않는다/);
 assert.match(RULES['10-planning.md'],/`있음`은 갈래가 3개 이상이고, 갈래끼리 담당 파일이 겹치지 않으며, 각 갈래를 따로 시험하고 완료를 확인할 수 있을 때만 적는다/);
 assert.match(RULES['10-planning.md'],/한 갈래의 결과를 다른 갈래가 쓰면 선행 관계로 적는다/);
 assert.match(RULES['10-planning.md'],/^9\. 작업 범위·금지 범위·선행 작업·병렬 갈래\(있음\/없음과 이유, STEP 6\)$/m);
 // Additional handoff 3, AC-14: require verifiable reasons for declining parallelism.
 assert.match(RULES['10-planning.md'],/여러 TASK가 공통 기반\(공유 함수·자료 구조 등\)을 쓴다는 이유만으로 `없음`이라 하지 않는다/);
 assert.match(RULES['10-planning.md'],/기반 TASK를 선행으로 두고 나머지 TASK로 다시 판단한다/);
 assert.match(RULES['10-planning.md'],/파일 겹침은 STEP 6 첫 문단의 TASK별 영향 파일로 대조한다/);
 assert.match(RULES['10-planning.md'],/`없음`의 이유에는 걸린 기준\(갈래 3개 미만 \/ 파일 겹침 \/ 따로 시험 불가 \/ 경미 변경\)과 구체 근거를 적는다/);
 assert.match(RULES['10-planning.md'],/예: `없음\(파일 겹침: approval\.py를 TASK-3·4가 수정\)`/);
 assert.match(RULES['20-implementation.md'],/계획에 독립 갈래가 있고 실행 도구가 하위 에이전트 병렬 실행을 지원할 때만/);
 assert.match(RULES['20-implementation.md'],/갈래가 2개 이하이거나, 변경이 작거나, 한 파일에 몰리면 직접 구현한다/);
 assert.match(RULES['20-implementation.md'],/지원하지 않는 도구에서는 차례대로 직접 구현한다/);
 assert.match(RULES['20-implementation.md'],/하위 에이전트의 모델·추론은 기본적으로 구현 담당과 같게 한다/);
 assert.match(RULES['20-implementation.md'],/단순 갈래만 낮출 수 있으며, 구현 담당보다 높이지 않는다/);
 assert.match(RULES['20-implementation.md'],/도구가 개별 지정을 지원하지 않으면 기본값\(구현 담당과 동일\)을 쓴다/);
 assert.match(RULES['20-implementation.md'],/구현 담당이 전체 diff를 직접 읽어 담당 파일 밖 변경과 갈래 간 충돌을 확인하고, 전체 시험을 직접 실행한다/);
 assert.match(RULES['20-implementation.md'],/하위 에이전트 보고만으로 검증을 기록하지 않는다/);
 assert.match(RULES['20-implementation.md'],/커밋은 구현 담당만 한다/);
 assert.match(RULES['00-common.md'],/구현 담당이 쓴 하위 에이전트도 구현 참여로 보며, 모델이 달라도 교차 모델 검증으로 세지 않는다/);
 assert.match(RULES['30-verification.md'],/고위험 변경.*다른 모델이 검증하기 전까지 완료로 판정하지/);
 assert.match(RULES['40-paseo-role-workflow.md'],/승인한 뒤 플러그인이 실행하고 원격 해시까지 확인한다\. 에이전트는 git push를 직접 실행하지 않으며/);
});

test('screen selection prompt carries no questions while contract4 titles stay exact', async () => {
 const {EXECUTOR_QUESTIONS}=await import('../shared/executor-selection.ts');
 const {SCREEN_SELECTION_PROMPT,selectionQuestions}=await import('../server/executor-selection.ts');
 assert.match(SCREEN_SELECTION_PROMPT,/플러그인 화면에서 고른다/);
 assert.ok(SCREEN_SELECTION_PROMPT.length<400);
 for (const q of Object.values(EXECUTOR_QUESTIONS)) {
  assert.ok(!SCREEN_SELECTION_PROMPT.includes(q.question));
  // Contract4 conversations keep answering through their original exact titles.
  assert.ok(RULES['40-paseo-role-workflow.md'].includes('`'+q.question+'`'));
  assert.equal(selectionQuestions({questions:[{title:q.question}]}).length,1);
  assert.deepEqual(selectionQuestions({questions:[{title:q.question+' (설명)'}]}),[]);
 }
});

// The agent treats a mode as answered only in the forms the plugin recognizes (shared/mode-request.ts).
test('the first-reply mode question is skipped only for exact choices the plugin recognizes', async () => {
 const {composeCurrentPrompt}=await import('../server/roles.ts');
 const {requestedMode}=await import('../shared/mode-request.ts');
 const prompt=composeCurrentPrompt('claude','','undecided',null,'','');
 assert.match(prompt,/'연합개발 테스트'처럼 방식 이름이 들어간 그 밖의 요청도 질문 도구로 묻는다/);
 assert.doesNotMatch(prompt,/첫 사용자 요청에 방식을 명시한 경우만 이미 답한 것으로 인정한다/);
 for (const text of ['연합개발','연합개발로 진행해줘','일반개발로 해줘']) assert.notEqual(requestedMode(text),null,text);
 assert.equal(requestedMode('연합개발 테스트'),null);
});


test("AC-11: subagents stay in the executor folder and shared resource checks have one owner", () => {
  const implementation = RULES["20-implementation.md"];
  assert.ok(implementation.includes("하위 에이전트는 구현 담당의 작업 폴더(worktree로 배치됐으면 그 worktree 경로)에서만 일하며, 별도 워크스페이스·폴더를 만들지 않는다."));
  assert.ok(implementation.includes("실제 데몬 e2e처럼 포트·데몬을 쓰는 공유 자원 검사는 구현 담당이 한 번만 실행한다."));
  assert.ok(!RULES["40-paseo-role-workflow.md"].includes("하위 에이전트는 구현 담당의 작업 폴더"), "subagent folder policy has one original");
});

test("AC-15: workflow rules require merge, retest and review before approval, distinct from rejection bypasses", () => {
  const rules = RULES["40-paseo-role-workflow.md"];
  assert.ok(rules.includes("로컬 HEAD와 원격 추적 tip이 대상 커밋의 조상인지 읽기 전용으로 확인한다"));
  assert.ok(rules.includes("최신 기준 브랜치를 worktree 브랜치에 merge·충돌 정리·전체 시험 재실행하도록 보완 plan을 지시하고 결과를 재검증한 커밋을 pushTargets로 쓴다"));
  assert.ok(rules.includes("계획 담당이 사용자에게 input으로 묻는다"));
  const push = rules.split("## 4. 푸시")[1].split("## 5.")[0];
  assert.ok(push.includes("푸시 거절 뒤 pull·rebase·merge로 우회하지 않고 사용자 결정을 받는다. 이는 푸시 승인 전에 계획된 merge 보완과 구별한다."));
  assert.ok(push.includes("플러그인은 merge·rebase·force를 직접 실행하지 않는다"));
});


test("AC-206: design records automatic interactions and verification checks defaults and unprocessed fake arguments", () => {
  assert.ok(RULES["10-planning.md"].includes("새 기능이 기존 자동 동작(보관·고정·푸시·압축·알림 등)과 같은 자원을 다루면, 그 상호작용과 단일 책임 위치를 설계에 적는다"));
  assert.ok(RULES["30-verification.md"].includes("기본 설정 시나리오 검증 여부를 확인하고, 시험 대역의 인자 가공 여부를 확인한다"));
});
