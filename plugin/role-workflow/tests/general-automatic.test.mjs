import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowEngine } from "../server/engine.ts";
import { GENERAL_QUESTIONS as Q, LEGACY_GENERAL_QUESTIONS } from "../shared/general-agent.ts";
import { generalQuestionNames, generalAnswers } from "../server/general-agent.ts";
import { workflowLabel } from "../shared/workflow-list.ts";

const block = (status, extra = {}) => `<paseo-workflow>${JSON.stringify({
  status, summary: status, next: "인계서에 따른 작업", handoff: "handoff.md / impl-report.md",
  checks: [], ...extra,
})}</paseo-workflow>`;

async function fixture(t, { choice = { provider: "codex", model: "builder", thinking: "high" }, contract = 3, requestedDefault = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "general-automatic-"));
  const file = path.join(dir, "state.json");
  const original = { provider: "codex/planner", thinkingOptionId: "medium", modeId: "full-access" };
  const agents = new Map([["A", { id: "A", workspaceId: "workspace", projectId: "project", cwd: dir,
    title: "Task", status: "idle", archived: false, permission: false, usage: 0, config: original }]]);
  const sent = [], created = [], histories = new Map();
  let failCreate = false, failSend = false;
  const port = {
    inspect: async (id) => agents.get(id) ?? null,
    projectName: async () => "Project", workspaceName: async () => "Task", rename: async () => {},
    quotaAccount: async () => null, quotaAvailable: async () => null,
    history: async (id) => histories.get(id) ?? { text: "", key: "", messageIds: [], failed: null },
    create: async (w, role, member) => {
      created.push({ id: member.id, role, config: { ...member.config } });
      if (failCreate) throw Error("creation failed");
      agents.set(member.id, { ...agents.get("A"), id: member.id, config: member.config });
      return "workspace";
    },
    send: async (id, prompt, messageId) => {
      sent.push({ id, prompt, messageId });
      if (failSend) throw Error("delivery acknowledgement lost");
      agents.get(id).status = "running";
    },
    createGeneral: async () => { throw Error("must never replace the original planner"); },
  };
  let engine = new WorkflowEngine(file, port);
  await engine.configure({ ...await engine.settings(), autoPinStarted: false, autoArchivePushed: false,
    autoResumeTransient: false, autoResumeQuota: false });
  const id = await engine.enroll(agents.get("A"), requestedDefault ? { provider: "codex" } : original, {}, "general", true, contract);
  let sequence = 0;
  t.after(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    dir, file, id, agents, created, sent, port, original, histories,
    get engine() { return engine; },
    state: async () => JSON.parse(await readFile(file, "utf8")).workflows[0],
    view: async () => (await engine.list()).workflows[0],
    choose: async () => engine.generalTimeline("A", [], { agent: choice.provider === "codex" ? "Codex" : "Claude Code", model: `${choice.provider}/${choice.model}`, thinking: choice.thinking }),
    finish: async (agentId, status, extra = {}, key = `turn-${++sequence}`) => {
      agents.get(agentId).status = "idle";
      const text = block(status, extra);
      const delivery = sent.findLast((row) => row.id === agentId);
      const messageIds = delivery ? [delivery.messageId] : [];
      histories.set(agentId, { text, key, failed: null, messageIds });
      await engine.ended(agentId, key, text, null, "Original goal", false, delivery?.prompt ?? "", false, messageIds);
    },
    restart: async () => { await engine.close(); engine = new WorkflowEngine(file, port); },
    failCreate: (value) => { failCreate = value; }, failSend: (value) => { failSend = value; },
  };
}

for (const choice of [
  { provider: "codex", model: "builder", thinking: "high" },
  { provider: "claude", model: "builder", thinking: "medium" },
  { provider: "codex", model: "planner", thinking: "medium" },
]) test(`general A -> ${choice.provider}/${choice.model} -> A correction and review preserve both roles`, async (t) => {
  const f = await fixture(t, { choice });
  await f.choose();
  await f.finish("A", "note");
  assert.deepEqual((await f.state()).plan.config, f.original);
  assert.equal(f.created.length, 0, "a selection alone never starts implementation");
  await f.finish("A", "plan");
  const b = (await f.view()).executeAgentId;
  assert.notEqual(b, "A");
  assert.equal(f.created[0].config.provider, `${choice.provider}/${choice.model}`);
  assert.equal(f.created[0].config.thinkingOptionId, choice.thinking);
  assert.match(f.sent.find((row) => row.id === b).prompt, /진행 방식: 일반개발.*구현·자체 시험/);
  await f.finish(b, "result");
  assert.equal(f.sent.at(-1).id, "A");
  assert.equal((await f.view()).phase, "review");
  assert.equal(workflowLabel(await f.view()), "검증");
  await f.finish("A", "plan");
  assert.equal(f.sent.at(-1).id, b);
  await f.finish(b, "result");
  await writeFile(path.join(f.dir, "verdict.md"), "검증 결과: 완료");
  const condition = choice.model === "planner" ? "단일 모델" : "교차 모델";
  await f.finish("A", "complete", { verdict: { path: "verdict.md", judgement: "완료", condition } });
  const state = await f.state();
  assert.equal(state.status, "completed");
  assert.equal(state.mode, "general");
  assert.equal(state.plan.id, "A");
  assert.deepEqual(state.plan.config, f.original);
  assert.equal(f.created.length, 1);
  assert.equal(state.history.length, 0);
});

test("missing implementation choice never creates an executor or falls back to A", async (t) => {
  const f = await fixture(t);
  await f.finish("A", "plan");
  assert.equal(f.created.length, 0);
  assert.equal((await f.view()).status, "needs_input");
  await f.choose();
  await f.finish("A", "plan");
  assert.equal((await f.view()).planAgentId, "A");
  assert.equal(f.created.length, 1);
});

test("explicit implementation model works with questions disabled and keeps A unchanged", async (t) => {
  const f = await fixture(t);
  await f.engine.configure({ ...await f.engine.settings(), askExecutorModel: false });
  await f.engine.ended("A", "explicit-choice", block("plan"), null,
    "일반개발\ncodex/explicit-builder 추론 low\n구현 요청");
  assert.equal(f.created[0].config.provider, "codex/explicit-builder");
  assert.equal(f.created[0].config.thinkingOptionId, "low");
  assert.deepEqual((await f.state()).plan.config, f.original);
});

test("a plain explicit choice after the initial request can unblock an unanswered selection", async (t) => {
  const f = await fixture(t);
  await f.finish("A", "plan");
  assert.equal((await f.view()).status, "needs_input");
  await f.engine.ended("A", "plain-answer", block("plan"), null, "Original goal", false,
    "codex/plain-builder 추론 low");
  assert.equal(f.created[0].config.provider, "codex/plain-builder");
  assert.equal(f.created[0].config.thinkingOptionId, "low");
  assert.equal((await f.view()).planAgentId, "A");
});

test("a remembered general preference supplies only the implementation model", async (t) => {
  const f = await fixture(t);
  await f.engine.configure({ ...await f.engine.settings(), askExecutorModel: false });
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  db.projects[f.dir] = { mode: "general", general: { provider: "codex", model: "remembered", thinking: "high" } };
  await writeFile(f.file, JSON.stringify(db));
  await f.restart();
  await f.finish("A", "plan");
  assert.equal(f.created[0].config.provider, "codex/remembered");
  assert.deepEqual((await f.state()).plan.config, f.original);
});

test("initial provider defaults are recorded as the actual resolved planner model", async (t) => {
  const f = await fixture(t, { requestedDefault: true });
  assert.deepEqual((await f.state()).plan.config, f.original);
  assert.deepEqual((await f.view()).plannerAgent, { provider: "codex", model: "planner", thinking: "medium" });
});

test("a pending native selection blocks implementation across restart", async (t) => {
  const f = await fixture(t);
  await f.choose();
  await f.engine.permission("A", { id: "thinking", kind: "question", input: {
    questions: [{ question: Q.thinking.question, header: Q.thinking.header, options: [] }],
  } });
  await f.restart();
  await f.finish("A", "plan");
  assert.equal(f.created.length, 0);
  assert.equal((await f.state()).generalState.settled, false);
  await f.engine.permissionResolved("A", "thinking", { behavior: "allow", updatedInput: {
    answers: { [Q.thinking.header]: "high" },
  } });
  await f.finish("A", "plan");
  assert.equal(f.created.length, 1);
});

test("executor completion is refused and cannot promote the task to green", async (t) => {
  const f = await fixture(t);
  await f.choose(); await f.finish("A", "plan");
  const b = (await f.view()).executeAgentId;
  await f.finish(b, "complete", { summary: "작업상태: 완료" });
  assert.notEqual((await f.view()).status, "completed");
  assert.notEqual((await f.view()).progress, "done");
});

test("missing or failing verdict remains incomplete after one repair", async (t) => {
  const f = await fixture(t);
  await f.choose(); await f.finish("A", "plan");
  await f.finish((await f.view()).executeAgentId, "result");
  await f.finish("A", "complete");
  assert.notEqual((await f.view()).status, "completed");
  assert.notEqual((await f.view()).progress, "done");
  await f.finish("A", "complete", { verdict: { path: "missing.md", judgement: "부분 완료", condition: "교차 모델" } });
  assert.equal((await f.view()).status, "needs_input");
  assert.notEqual((await f.view()).progress, "done");
});

for (const delivered of [true, false])
test(`uncertain general delivery ${delivered ? "confirmed in history" : "without a receipt"} is not blindly repeated`, async (t) => {
  const f = await fixture(t);
  await f.choose(); f.failSend(true);
  await f.finish("A", "plan");
  const pending = (await f.state()).pending;
  const b = (await f.view()).executeAgentId;
  assert.equal(pending.stage, "sending");
  assert.equal(f.sent.length, 1);
  if (delivered) f.histories.set(b, { text: "", key: "", failed: null, messageIds: [pending.id] });
  await f.restart(); f.failSend(false);
  await f.engine.control(f.id, "resume").catch(() => {});
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).pending.id, pending.id);
  assert.equal((await f.state()).pending.stage, delivered ? "sent" : "sending");
});

test("an explicit mode toggle retains the queued implementation and both identities", async (t) => {
  const f = await fixture(t);
  await f.choose(); await f.finish("A", "plan");
  const before = await f.state();
  // Simulate the native mode choice path as well as the dashboard control.
  for (const mode of ["연합개발", "일반개발"]) {
    await f.engine.permission("A", { id: "mode", kind: "question", input: { questions: [{
      question: "진행 방식", header: "방식", options: [{ label: "일반개발" }, { label: "연합개발" }],
    }] } });
    await f.engine.permissionResolved("A", "mode", { behavior: "allow", updatedInput: { answers: { 방식: mode } } });
  }
  const after = await f.state();
  assert.equal(after.mode, "general");
  assert.equal(after.plan.id, before.plan.id);
  assert.equal(after.execute.id, before.execute.id);
  assert.deepEqual(after.pending, before.pending);
});

test("same-model sessions cannot claim cross-model verification", async (t) => {
  const f = await fixture(t, { choice: { provider: "codex", model: "planner", thinking: "high" } });
  await f.choose(); await f.finish("A", "plan");
  await f.finish((await f.view()).executeAgentId, "result");
  await writeFile(path.join(f.dir, "verdict.md"), "검증 결과");
  await f.finish("A", "complete", { verdict: { path: "verdict.md", judgement: "완료", condition: "교차 모델" } });
  assert.notEqual((await f.view()).status, "completed");
});

test("restart and duplicate planner events do not duplicate implementation", async (t) => {
  const f = await fixture(t);
  await f.choose(); await f.finish("A", "plan", {}, "design-turn");
  const before = await f.state();
  await f.restart();
  await f.finish("A", "plan", {}, "design-turn");
  await f.engine.tick();
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).execute.id, before.execute.id);
});

test("creation retry after restart preserves the chosen provider, model and identity", async (t) => {
  const f = await fixture(t);
  await f.choose(); f.failCreate(true);
  await f.finish("A", "plan");
  const target = (await f.state()).execute.id;
  assert.equal((await f.view()).status, "error");
  assert.equal((await f.view()).planAgentId, "A");
  await f.restart(); f.failCreate(false);
  await f.engine.control(f.id, "resume");
  assert.equal((await f.state()).execute.id, target);
  assert.equal(f.created.at(-1).config.provider, "codex/builder");
  assert.equal(f.created.at(-1).config.thinkingOptionId, "high");
});

test("general controls pause/resume the automatic flow without replacing its roles", async (t) => {
  const f = await fixture(t);
  await f.choose(); await f.finish("A", "plan");
  const before = await f.state();
  await f.engine.control(f.id, "pause");
  assert.equal((await f.view()).status, "paused");
  f.agents.get(before.execute.id).status = "idle";
  await f.engine.control(f.id, "resume");
  assert.equal((await f.view()).status, "active");
  assert.equal((await f.state()).plan.id, "A");
  assert.equal((await f.state()).execute.id, before.execute.id);
});

test("legacy selection question text remains recognizable", () => {
  const q = LEGACY_GENERAL_QUESTIONS.model;
  assert.deepEqual(generalQuestionNames({ questions: [{ title: q.question }] }), ["model"]);
  assert.deepEqual(generalAnswers({ answers: { [q.header]: "codex/builder" } }, ["model"]), { model: "codex/builder" });
});

test("reading a legacy general task never upgrades its contract or creates a paired executor", async (t) => {
  const f = await fixture(t, { contract: 1 });
  await f.restart(); await f.engine.tick();
  assert.equal((await f.state()).contract, 1);
  assert.equal((await f.state()).execute, null);
  assert.equal((await f.view()).automatic, false);
});
