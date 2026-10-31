import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowEngine } from "../server/engine.ts";
import { decisionSchema, parseDecision } from "../shared/decision.ts";

const verdict = { path: "verdict.md", judgement: "완료", condition: "교차 모델" };
const decision = (status, extra = {}) => ({
  status,
  summary: "검토 결과",
  handoff: "작업 문서와 시험 확인",
  next: "구체적 수정 지시",
  ...extra,
});
const block = (d) => `<paseo-workflow>${JSON.stringify(d)}</paseo-workflow>`;

async function fixture(t, { contract = 2, mode = "federated", legacy = false } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "verdict-engine-"));
  const previous = Object.fromEntries(
    ["HOME", "PASEO_HOME", "XDG_CONFIG_HOME", "PASEO_ROLE_WORKFLOW_STATE_DIR"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env.HOME = process.env.PASEO_HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  delete process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
  const file = path.join(home, "state.json");
  const agents = new Map([
    [
      "planner",
      {
        id: "planner",
        workspaceId: "workspace",
        projectId: "project",
        cwd: home,
        title: "Task",
        status: "idle",
        permission: false,
        archived: false,
        usage: 0,
      },
    ],
  ]);
  const sent = [];
  const port = {
    inspect: async (id) => agents.get(id),
    projectName: async () => "Project",
    workspaceName: async () => "Task",
    rename: async () => {},
    history: async () => ({ text: "", key: "", messageIds: [], failed: null }),
    send: async (id, prompt, messageId) => {
      sent.push({ id, prompt, messageId });
      agents.get(id).status = "running";
    },
    create: async (w, role, member) => {
      agents.set(member.id, { ...agents.get("planner"), id: member.id });
      return "workspace";
    },
  };
  let engine = new WorkflowEngine(file, port);
  await engine.enroll(agents.get("planner"), { provider: "claude" }, {}, mode, true, contract);
  if (legacy) {
    await engine.close();
    const db = JSON.parse(await readFile(file, "utf8"));
    for (const key of ["contract", "completeRepairs", "verdict", "verdictIssue"])
      delete db.workflows[0][key];
    await writeFile(file, JSON.stringify(db));
    engine = new WorkflowEngine(file, port);
  }
  t.after(async () => {
    await engine.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  let turn = 0;
  return {
    home,
    file,
    sent,
    view: async () => (await engine.list()).workflows[0],
    state: async () => JSON.parse(await readFile(file, "utf8")).workflows[0],
    report: async (text, agentId = "planner") => {
      agents.get(agentId).status = "idle";
      await engine.ended(agentId, `turn-${++turn}`, text, null, "Original goal");
    },
    restart: async () => {
      await engine.close();
      engine = new WorkflowEngine(file, port);
    },
  };
}

test("decision verdict accepts the approved fields and rejects invalid values and unknown root fields", () => {
  assert.deepEqual(parseDecision(block(decision("complete", { verdict }))).verdict, verdict);
  assert.ok(
    decisionSchema.safeParse(decision("complete")).success,
    "optional for old conversations",
  );
  for (const invalid of [
    { ...verdict, path: "" },
    { ...verdict, path: "x".repeat(1001) },
    { ...verdict, judgement: "통과" },
    { ...verdict, condition: "independent" },
    { path: "verdict.md" },
  ]) {
    assert.throws(() => parseDecision(block(decision("complete", { verdict: invalid }))));
  }
  assert.throws(() => parseDecision(block(decision("complete", { verdict, unknown: true }))));
});

test("contract 2 requests missing verdict once then accepts an existing relative report and persists it", async (t) => {
  const f = await fixture(t);
  await f.report("작업상태: 완료\n" + block(decision("complete")));
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].prompt, /완료 판정 정보가 없거나 맞지 않습니다\(판정 없음\)/);
  assert.match(f.sent[0].prompt, /작업을 다시 하지 말고/);
  assert.equal((await f.view()).status, "active");
  await writeFile(path.join(f.home, "verdict.md"), "검증 판정 보고");
  await f.report(block(decision("complete", { verdict })));
  assert.equal((await f.view()).status, "completed");
  assert.equal((await f.view()).verdict.status, "완료");
  const stored = (await f.state()).verdict;
  assert.deepEqual({ ...stored, recordedAt: undefined }, { ...verdict, recordedAt: undefined });
  assert.ok(Number.isFinite(Date.parse(stored.recordedAt)));
  await f.restart();
  assert.deepEqual((await f.view()).verdict, {
    status: "완료",
    path: "verdict.md",
    condition: "교차 모델",
    recordedAt: stored.recordedAt,
    reason: "",
  });
  assert.equal(f.sent.length, 1);
});

test("a second missing verdict completes with a durable nonblocking missing-verdict notice", async (t) => {
  const f = await fixture(t);
  await f.report(block(decision("complete")));
  await f.restart();
  await f.report(block(decision("complete")));
  assert.equal(f.sent.length, 1);
  assert.equal((await f.view()).status, "completed");
  assert.equal((await f.view()).verdict.status, "판정 없음");
  assert.match((await f.view()).detail, /판정 없음/);
  assert.equal((await f.state()).completeRepairs, 0);
});

for (const [name, update, reason] of [
  ["partial judgement", { judgement: "부분 완료" }, "판정이 부분 완료"],
  ["missing report path", { path: "missing/verdict.md" }, "판정 보고 경로 없음"],
])
  test(`contract 2 repairs ${name} once then completes with a mismatch warning`, async (t) => {
    const f = await fixture(t);
    const incomplete = { ...verdict, ...update };
    await f.report(block(decision("complete", { verdict: incomplete })));
    assert.equal(f.sent.length, 1);
    assert.ok(f.sent[0].prompt.includes(reason));
    await f.report(block(decision("complete", { verdict: incomplete })));
    assert.equal(f.sent.length, 1);
    assert.equal((await f.view()).status, "completed");
    assert.equal((await f.view()).verdict.status, "판정 불일치");
    assert.ok((await f.view()).detail.includes(`판정 불일치: ${reason}`));
  });

test("legacy workflows default to contract 1 and complete without a verdict request", async (t) => {
  const f = await fixture(t, { legacy: true });
  await f.report(block(decision("complete")));
  assert.equal((await f.state()).contract, 1);
  assert.equal((await f.view()).status, "completed");
  assert.equal((await f.view()).verdict, null);
  assert.equal(f.sent.length, 0);
});

test("verdict retry and malformed-block repair counters are independent", async (t) => {
  const f = await fixture(t);
  await f.report(block(decision("complete")));
  await f.report("상태 블록 없는 응답");
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].prompt, /작업 상태 블록을 읽지 못했습니다/);
  assert.equal((await f.state()).repairs, 1);
  assert.equal((await f.state()).completeRepairs, 1);
  await f.report(block(decision("complete")));
  assert.equal((await f.view()).status, "completed");
  assert.equal((await f.view()).verdict.status, "판정 없음");
  assert.equal(f.sent.length, 2);
});

test("non-complete decisions store a verdict without gating or checking its path", async (t) => {
  const f = await fixture(t);
  await f.report(
    block(
      decision("input", {
        verdict: {
          ...verdict,
          judgement: "미완료",
          path: "not-created.md",
          condition: "단일 모델",
        },
      }),
    ),
  );
  assert.equal((await f.view()).status, "needs_input");
  assert.equal((await f.view()).verdict.status, "미완료");
  assert.equal((await f.view()).verdict.condition, "단일 모델");
  assert.equal((await f.state()).completeRepairs, 0);
  assert.equal(f.sent.length, 0);
});

test("an existing absolute verdict path completes immediately and a planner side-complete uses the same gate", async (t) => {
  const f = await fixture(t);
  await f.report(block(decision("plan")));
  const executor = f.sent[0].id;
  assert.notEqual(executor, "planner");
  await f.report(block(decision("complete")));
  assert.equal(f.sent[1].id, "planner");
  assert.match(f.sent[1].prompt, /완료 판정 정보/);
  const absolute = path.join(f.home, "verdict.md");
  await writeFile(absolute, "보고");
  await f.report(
    block(
      decision("complete", { verdict: { ...verdict, path: absolute, condition: "자체 점검" } }),
    ),
  );
  assert.equal((await f.view()).status, "completed");
  assert.equal((await f.view()).verdict.path, absolute);
});

test("general-development conversations never enter the complete gate", async (t) => {
  const f = await fixture(t, { mode: "general" });
  await f.report("기본값(현재 대화 설정) 사용. 작업을 이어갑니다.");
  assert.equal((await f.state()).contract, 1);
  assert.equal((await f.state()).completeRepairs, 0);
  assert.equal((await f.view()).mode, "general");
  assert.equal(f.sent.length, 0);
});

test("a later completion in the same workflow gets a fresh single verdict request", async (t) => {
  const f = await fixture(t);
  await f.report(block(decision("complete")));
  assert.equal((await f.state()).completeRepairs, 1);
  await writeFile(path.join(f.home, "verdict.md"), "검증 판정 보고");
  await f.report(block(decision("complete", { verdict })));
  const first = await f.state();
  assert.equal(first.status, "completed");
  assert.equal(first.completeRepairs, 0);
  await f.restart();
  await f.report(block(decision("complete")));
  assert.equal((await f.state()).id, first.id, "the completed workflow is reused");
  assert.equal((await f.view()).status, "active");
  assert.equal((await f.state()).completeRepairs, 1);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].prompt, /완료 판정 정보가 없거나 맞지 않습니다\(판정 없음\)/);
  await f.report(block(decision("complete")));
  assert.equal((await f.view()).status, "completed");
  assert.equal((await f.view()).verdict.status, "판정 없음");
  assert.equal((await f.state()).completeRepairs, 0);
  assert.equal(f.sent.length, 2, "the same complete resubmission is never requested again");
});

for (const status of ["plan", "input", "continue"])
  test(`planner ${status} ends the pending verdict gate and allows one new request`, async (t) => {
    const f = await fixture(t);
    await f.report(block(decision("complete")));
    assert.equal((await f.state()).completeRepairs, 1);
    await f.report(block(decision(status)));
    assert.equal((await f.state()).completeRepairs, 0);
    await f.report(block(decision("complete")));
    assert.equal((await f.view()).status, "active");
    assert.equal((await f.state()).completeRepairs, 1);
    const requests = () =>
      f.sent.filter((row) => row.prompt.includes("완료 판정 정보가 없거나 맞지 않습니다("));
    assert.equal(requests().length, 2);
    assert.equal(f.sent.at(-1).id, "planner");
    await f.report(block(decision("complete")));
    assert.equal((await f.view()).status, "completed");
    assert.equal((await f.state()).completeRepairs, 0);
    assert.equal(requests().length, 2);
  });
