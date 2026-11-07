import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { WorkflowEngine } from "../server/engine.ts";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "mode-picker-"));
  const file = path.join(dir, "state.json");
  const config = { provider: "claude/planner", thinkingOptionId: "medium", modeId: "bypassPermissions" };
  const agents = new Map([
    ["A", { id: "A", workspaceId: "ws", projectId: "project", cwd: dir, title: "Task", status: "idle", archived: false, permission: false, usage: 0, config }],
  ]);
  const cards = [], sent = [], pickers = [];
  const port = {
    inspect: async (id) => agents.get(id) ?? null,
    history: async () => ({ text: "", key: "", failed: null, messageIds: [] }),
    models: async () => [],
    projectName: async () => "Project",
    workspaceName: async () => "Task",
    rename: async () => {},
    quotaAccount: async () => null,
    quotaAvailable: async () => null,
    create: async () => "ws",
    modePicker: async (agentId, workflowId) => cards.push({ agentId, workflowId }),
    executorPicker: async (agentId, workflowId) => pickers.push({ agentId, workflowId }),
    send: async (id, prompt, messageId) => sent.push({ id, prompt, messageId }),
  };
  const engine = new WorkflowEngine(file, port);
  t.after(async () => {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  });
  await engine.configure({ ...(await engine.settings()), autoPinStarted: false, autoArchivePushed: false, titleMarker: false });
  const id = await engine.enroll(agents.get("A"), config, {}, "undecided", true, 5);
  let turn = 0;
  const say = async (request, reply = "답변") => {
    agents.get("A").status = "idle";
    await engine.ended("A", `turn-${++turn}`, reply, null, "goal", false, request);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const state = async () => JSON.parse(await readFile(file, "utf8")).workflows[0];
  return { engine, id, cards, sent, pickers, say, state };
}

test("a request that names a mode without choosing it gets the mode card once", async (t) => {
  const f = await fixture(t);
  await f.say("연합개발 테스트");
  assert.deepEqual(f.cards, [{ agentId: "A", workflowId: f.id }]);
  assert.equal((await f.state()).mode, "undecided");
  await f.say("연합개발 테스트 다시");
  assert.equal(f.cards.length, 1, "the card is posted only once per task");
});

test("an exact choice sets the mode by text and needs no card; unrelated requests get none", async (t) => {
  const exact = await fixture(t);
  await exact.say("연합개발로 진행해줘");
  assert.equal((await exact.state()).mode, "federated");
  assert.deepEqual(exact.cards, []);
  const plain = await fixture(t);
  await plain.say("1+1은?");
  assert.deepEqual(plain.cards, []);
  assert.equal((await plain.state()).mode, "undecided");
});

test("choosing on the card sets the mode, tells the planner once and refuses a second change", async (t) => {
  const f = await fixture(t);
  await f.say("연합개발 테스트");
  const chosen = await f.engine.selectMode(f.id, "federated");
  assert.deepEqual(chosen, { ok: true, detail: "연합개발로 진행합니다." });
  assert.equal((await f.state()).mode, "federated");
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].prompt, /^작업 ID: .*\n진행 방식: 연합개발 \(사용자가 화면에서 선택\)\. 진행 방식을 다시 묻지 않고/);
  assert.equal(f.sent[0].messageId, `role-workflow-mode:${f.id}`);
  const again = await f.engine.selectMode(f.id, "general");
  assert.equal(again.ok, false);
  assert.match(again.detail, /이미 연합개발/);
  assert.equal(f.sent.length, 1);
});

test("choosing general on the card makes it a general task", async (t) => {
  const f = await fixture(t);
  await f.say("일반개발 비슷하게");
  assert.equal(f.cards.length, 1);
  assert.equal((await f.engine.selectMode(f.id, "general")).ok, true);
  assert.equal((await f.state()).mode, "general");
  assert.match(f.sent[0].prompt, /진행 방식: 일반개발/);
});
