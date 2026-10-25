import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowEngine } from "../server/engine.ts";
import { readTurn } from "../server/paseo-port.ts";

const decision = (status, next = "next task") =>
  `<paseo-workflow>${JSON.stringify({ status, summary: `${status} summary`, next, handoff: "goal, decisions, files, evidence", checks: ["node --test: passed"] })}</paseo-workflow>`;
const verifiedPushProbe = {
  snapshot: async () => null,
  changes: async () => "",
  pushed: async () => true,
  repository: async (cwd) => path.resolve(cwd),
  pushedTarget: async () => true,
};
const pushedCommit = {
  repository: "/repo",
  remote: "origin",
  branch: "main",
  commit: "a".repeat(40),
};
const pushEvidence = (target = pushedCommit, report = "작업상태: 푸시") => ({
  report,
  changed: false,
  pushes: [
    {
      callId: "successful-push",
      cwd: target.repository,
      remote: target.remote,
      branch: target.branch,
      commit: target.commit,
    },
  ],
});
const finishPush = (engine, id, key, text = "작업상태: 푸시", target = pushedCommit) =>
  engine.ended(id, key, text, null, "", false, "", false, undefined, pushEvidence(target, text));
async function fixture(
  t,
  notify,
  mode,
  titled,
  provider = "claude",
  probe = null,
  now = Date.now,
  managedRunner,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "role-engine-"));
  t.after(async () => {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  });
  const agents = new Map([
    [
      "planner",
      {
        id: "planner",
        workspaceId: "initial",
        projectId: "project",
        cwd: dir,
        title: "task",
        status: "idle",
        archived: false,
        permission: false,
        usage: 0.1,
      },
    ],
  ]);
  const sent = [],
    created = [],
    renamed = [],
    compacted = [],
    histories = new Map();
  const port = {
    projectName: async (id) => id,
    quotaAccount: async () => null,
    quotaAvailable: async () => null,
    async workspaceName(workspaceId) {
      const last = renamed.findLast((row) => row.workspaceId === workspaceId)?.title;
      if (!last && workspaceId !== "initial") throw Error("unknown workspace");
      return last ?? "현재 이름";
    },
    async rename(workspaceId, title) {
      renamed.push({ workspaceId, title });
    },
    async inspect(id) {
      return agents.get(id) ?? null;
    },
    async create(w, role, member, marker) {
      // As the real port does: the executor opens as a tab in its planner's workspace.
      const workspaceId =
        role === "execute" && w.plan?.workspaceId ? w.plan.workspaceId : `workspace-${member.id}`;
      created.push({
        role,
        marker,
        id: member.id,
        generation: member.generation,
        projectId: w.projectId,
        cwd: w.cwd,
        config: member.config,
        title: w.title,
      });
      agents.set(member.id, { ...agents.get("planner"), id: member.id, workspaceId, usage: 0 });
      return workspaceId;
    },
    async send(id, prompt, messageId) {
      sent.push({ id, prompt, messageId });
      agents.get(id).status = "running";
    },
    async compact(id) {
      compacted.push(id);
    },
    async history(id) {
      return histories.get(id) ?? { text: "", key: "", messageIds: [], failed: null };
    },
  };
  const file = path.join(dir, "state.json");
  const engine = new WorkflowEngine(file, port, notify, probe, now, managedRunner);
  const id = await engine.enroll(
    agents.get("planner"),
    {
      provider,
      options: { sandbox: "read-only" },
      systemPrompt: "project rules",
    },
    {},
    mode,
    titled,
  );
  const finish = async (agentId, key, status) => {
    agents.get(agentId).status = "idle";
    await engine.ended(agentId, key, decision(status), null, "original goal");
  };
  return {
    engine,
    id,
    agents,
    sent,
    created,
    compacted,
    renamed,
    port,
    file,
    histories,
    finish,
    view: async () => (await engine.list()).workflows[0],
  };
}

for (const provider of ["claude", "codex"])
  test(`${provider} plan -> execution -> review -> correction -> final completion stays in one project`, async (t) => {
    const f = await fixture(t, undefined, undefined, undefined, provider);
    await f.finish("planner", "p1", "plan");
    const executor = f.created[0].id;
    assert.equal(f.created[0].config.provider, provider === "claude" ? "codex" : "claude");
    assert.equal(f.created[0].config.modeId, provider === "claude" ? "auto" : "acceptEdits");
    assert.equal(f.created.length, 1);
    assert.equal(f.created[0].projectId, "project");
    assert.equal(f.sent[0].id, executor);
    assert.match(f.sent[0].prompt, /original goal/);
    await f.finish(executor, "e1", "result");
    assert.equal(f.sent[1].id, "planner");
    assert.equal((await f.view()).phase, "review");
    await f.finish("planner", "p2", "plan");
    assert.equal(f.sent[2].id, executor);
    assert.equal(f.created.length, 1);
    await f.finish(executor, "e2", "result");
    await f.finish("planner", "p3", "complete");
    assert.equal((await f.view()).status, "completed");
    assert.equal(f.sent.length, 4);
  });
test("80% compacts both roles once per turn and preserves workspace and agent identities", async (t) => {
  const f = await fixture(t);
  f.agents.get("planner").usage = 0.79;
  await f.finish("planner", "p1", "plan");
  assert.equal(f.compacted.length, 0);
  const executor = f.created[0].id;
  f.agents.get("planner").usage = 0.8;
  f.agents.get(executor).usage = 0.81;
  await f.finish(executor, "e1", "result");
  await new Promise((resolve) => setImmediate(resolve));
  await f.engine.tick();
  const v = await f.view();
  assert.deepEqual(f.compacted.sort(), [executor, "planner"].sort());
  assert.equal(v.planGeneration, 1);
  assert.equal(v.executeGeneration, 1);
  assert.equal(v.planAgentId, "planner");
  assert.equal(v.executeAgentId, executor);
  assert.equal(f.created.length, 1);
  assert.equal(f.sent[1].id, "planner");
  await f.engine.tick();
  assert.equal(f.compacted.length, 2, "stale usage must not cause repeat compaction");
});
test("compaction waits for completion, accepts pause, and preserves the queued handoff", async (t) => {
  const f = await fixture(t);
  let done;
  f.port.compact = () =>
    new Promise((resolve) => {
      done = resolve;
    });
  f.agents.get("planner").usage = 0.8;
  await f.finish("planner", "p1", "plan");
  assert.equal(f.sent.length, 0);
  await f.engine.control(f.id, "pause");
  done();
  await new Promise((resolve) => setImmediate(resolve));
  await f.engine.tick();
  assert.equal(f.sent.length, 0);
  await f.engine.control(f.id, "resume");
  assert.equal(f.sent.length, 1);
});
test("failed compaction never dispatches work or creates a replacement workspace", async (t) => {
  const f = await fixture(t);
  f.port.compact = async () => {
    throw new Error("native compaction failed");
  };
  f.agents.get("planner").usage = 0.8;
  await f.finish("planner", "p1", "plan");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.view()).status, "error");
  assert.equal(f.sent.length, 0);
  assert.equal((await f.view()).planAgentId, "planner");
});
test("pause keeps a completed result durable and resume dispatches it once", async (t) => {
  const f = await fixture(t);
  await f.engine.control(f.id, "pause");
  await f.finish("planner", "p1", "plan");
  assert.equal(f.sent.length, 0);
  await f.engine.control(f.id, "resume");
  await f.finish("planner", "p1", "plan");
  assert.equal(f.sent.length, 1);
});
test("failed, canceled, malformed and role-invalid results never launch implementation", async (t) => {
  const f = await fixture(t);
  await f.engine.ended("planner", "bad", "not a plan", null);
  assert.equal((await f.view()).status, "needs_input");
  assert.equal(f.sent.length, 0);
  await f.engine.control(f.id, "resume", "continue with a clear plan");
  assert.equal(f.sent.length, 1);
  f.agents.get("planner").status = "idle";
  await f.engine.ended("planner", "fail", decision("plan"), "canceled by user");
  assert.equal((await f.view()).status, "paused");
  assert.equal(f.created.length, 0);
});
test("durable queued work resumes after reload without creating duplicate workspaces", async (t) => {
  const f = await fixture(t);
  await f.engine.control(f.id, "pause");
  await f.finish("planner", "p1", "plan");
  const restarted = new WorkflowEngine(f.file, f.port);
  await restarted.control(f.id, "resume");
  await restarted.tick();
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 1);
});
test("uncertain delivery is reconciled with history and never blindly resent", async (t) => {
  const f = await fixture(t);
  const send = f.port.send;
  f.port.send = async (...args) => {
    await send(...args);
    throw new Error("connection lost after acceptance");
  };
  await f.finish("planner", "p1", "plan");
  assert.equal((await f.view()).status, "error");
  const outgoing = f.sent[0];
  f.histories.set(outgoing.id, {
    text: "",
    key: "",
    messageIds: [outgoing.messageId],
    failed: null,
  });
  await f.engine.control(f.id, "resume");
  assert.equal((await f.view()).status, "active");
  assert.equal(f.sent.length, 1);
});
test("uncertain delivery without an echo stops visibly; corrupt state is not overwritten", async (t) => {
  const f = await fixture(t);
  f.port.send = async () => {
    throw new Error("lost");
  };
  await f.finish("planner", "p1", "plan");
  await f.engine.control(f.id, "resume");
  assert.equal((await f.view()).status, "error");
  assert.match((await f.view()).detail, /전달 여부/);
  await writeFile(f.file, "corrupt");
  const restarted = new WorkflowEngine(f.file, f.port);
  await assert.rejects(restarted.list());
  assert.equal(await readFile(f.file, "utf8"), "corrupt");
});
test("repeated callbacks and a permission wait cannot create a second executor", async (t) => {
  const f = await fixture(t);
  await Promise.all([f.finish("planner", "p1", "plan"), f.finish("planner", "p1", "plan")]);
  const executor = f.created[0].id;
  f.agents.get(executor).permission = true;
  await f.engine.tick();
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 1);
});
test("cycle limits preserve the pending plan until the limit is raised", async (t) => {
  const f = await fixture(t);
  await f.engine.configure({ ...(await f.engine.settings()), maxCycles: 1 });
  await f.finish("planner", "p1", "plan");
  await f.finish(f.created[0].id, "e1", "result");
  await f.finish("planner", "p2", "plan");
  assert.equal((await f.view()).status, "paused");
  assert.equal(f.sent.length, 2);
  await f.engine.configure({ ...(await f.engine.settings()), maxCycles: 2 });
  await f.engine.control(f.id, "resume");
  assert.equal(f.sent.length, 3);
});

test("resuming with a note after the cycle limit still dispatches the held plan", async (t) => {
  const f = await fixture(t);
  await f.engine.configure({ ...(await f.engine.settings()), maxCycles: 1 });
  await f.finish("planner", "p1", "plan");
  await f.finish(f.created[0].id, "e1", "result");
  await f.finish("planner", "p2", "plan");
  assert.equal((await f.view()).status, "paused");
  assert.equal(f.sent.length, 2);
  await f.engine.control(f.id, "resume", "로그도 함께 확인하세요");
  assert.equal(f.sent.length, 3);
  const last = f.sent.at(-1);
  assert.equal(last.id, f.created[0].id, "the held plan goes to the executor");
  assert.match(last.prompt, /next task/);
  assert.match(last.prompt, /로그도 함께 확인하세요/);
  const w = await stored(f);
  assert.equal(w.limitPlan, "");
  assert.equal(w.resumeNote, "");
});

test("a direct reply after needs_input resumes and dispatches the new plan once", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "question", "input");
  assert.equal((await f.view()).status, "needs_input");
  await f.engine.ended("planner", "reply", decision("plan", "latest direct reply"), null);
  await f.engine.ended("planner", "reply", decision("plan", "latest direct reply"), null);
  await f.finish("planner", "question", "input");
  await f.engine.tick();
  assert.equal((await f.view()).status, "active");
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, f.created[0].id);
  assert.match(f.sent[0].prompt, /latest direct reply/);
});
test("pause retains the latest result and resumes without dispatching superseded instructions", async (t) => {
  const f = await fixture(t);
  await f.engine.control(f.id, "pause");
  await f.engine.ended("planner", "old", decision("plan", "superseded instruction"), null);
  await f.engine.ended("planner", "new", decision("plan", "latest instruction"), null);
  assert.equal((await f.view()).status, "paused");
  assert.equal(f.sent.length, 0);
  await f.engine.control(f.id, "resume");
  await f.engine.ended("planner", "old", decision("plan", "superseded instruction"), null);
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].prompt, /latest instruction/);
  assert.doesNotMatch(f.sent[0].prompt, /superseded instruction/);
});
test("error retains the latest result until an explicit resume", async (t) => {
  const f = await fixture(t);
  await f.engine.control(f.id, "pause");
  await f.engine.ended("planner", "old", decision("plan", "old error instruction"), null);
  await f.engine.close();
  const state = JSON.parse(await readFile(f.file, "utf8"));
  state.workflows[0].status = "error";
  await writeFile(f.file, JSON.stringify(state));
  const restarted = new WorkflowEngine(f.file, f.port);
  t.after(() => restarted.close());
  await restarted.ended("planner", "replacement", decision("plan", "recovered instruction"), null);
  assert.equal((await restarted.list()).workflows[0].status, "error");
  assert.equal(f.sent.length, 0);
  await restarted.control(f.id, "resume");
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].prompt, /recovered instruction/);
  assert.doesNotMatch(f.sent[0].prompt, /old error instruction/);
});

test("notification transitions deduplicate, permission targets member, and pause is silent", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e));
  await f.engine.permission("stranger", { id: "r", kind: "tool" });
  await f.engine.permission("planner", { id: "r", kind: "tool", title: "approve" });
  await f.engine.permission("planner", { id: "r", kind: "tool" });
  await f.engine.control(f.id, "pause");
  assert.deepEqual(
    events.map((e) => e.kind),
    ["permission"],
  );
  await f.engine.control(f.id, "resume");
  await f.finish("planner", "bad", "input");
  await f.engine.tick();
  assert.deepEqual(
    events.map((e) => e.kind),
    ["permission", "stopped"],
  );
  await f.finish("planner", "p", "plan");
  await f.finish(f.created[0].id, "e", "result");
  await f.finish("planner", "done", "complete");
  await f.engine.tick();
  assert.deepEqual(
    events.map((e) => e.kind),
    ["permission", "stopped", "completed"],
  );
  assert.equal(events[0].workspaceId, "initial");
});
test("zero-cycle completion and disabled notifications are silent; rejection cannot stop flow", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e));
  await f.finish("planner", "done", "complete");
  assert.equal(events.length, 0);
  await f.engine.configure({
    ...(await f.engine.settings()),
    notifyPermission: false,
    notifyStopped: false,
    notifyCompleted: false,
  });
  await f.engine.permission("planner", { id: "r", kind: "tool" });
  await f.finish("planner", "p", "plan");
  await f.finish(f.created[0].id, "e", "result");
  await f.finish("planner", "d2", "complete");
  assert.equal(events.length, 0);
  const g = await fixture(t, async () => {
    throw new Error("offline");
  });
  await g.finish("planner", "bad", "input");
  await g.finish("planner", "p", "plan");
  assert.equal((await g.view()).status, "active");
});
test("completed planner resumes once in existing workspace; invalid and executor responses ignored", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e));
  await f.finish("planner", "p", "plan");
  const executor = f.created[0].id;
  await f.finish(executor, "e", "result");
  await f.finish("planner", "done", "complete");
  await f.engine.ended("planner", "chat", "hello", null);
  await f.finish(executor, "late", "result");
  assert.equal((await f.view()).status, "completed");
  await f.finish("planner", "new", "plan");
  await f.finish("planner", "new", "plan");
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2].id, executor);
  assert.equal((await f.view()).cycles, 1);
  assert.equal((await f.view()).turns, 1);
  await f.finish(executor, "e2", "result");
  await f.finish("planner", "done2", "complete");
  const count = events.length;
  await f.finish("planner", "noop", "complete");
  assert.equal((await f.view()).cycles, 0);
  assert.equal(events.length, count);
});
test("selected executor model overrides setting only before member exists", async (t) => {
  const f = await fixture(t);
  await f.engine.configure({ ...(await f.engine.settings()), executorModel: "codex/configured" });
  const selected = decision("plan").replace(
    '"status":"plan"',
    '"status":"plan","executorModel":"codex/selected"',
  );
  await f.engine.ended("planner", "p", selected, null);
  assert.equal(f.created[0].config.provider, "codex/selected");
  await f.finish(f.created[0].id, "e", "result");
  await f.engine.ended("planner", "p2", selected.replace("codex/selected", "codex/other"), null);
  assert.equal(f.created.length, 1);
  assert.match(f.sent.at(-1).prompt, /codex\/selected.*다시 묻지 않음/);
  const g = await fixture(t);
  await g.engine.configure({ ...(await g.engine.settings()), executorModel: "codex/configured" });
  await g.finish("planner", "p", "plan");
  assert.equal(g.created[0].config.provider, "codex/configured");
});
test("model creation error is durable and resume repairs uncreated member model", async (t) => {
  const f = await fixture(t);
  const create = f.port.create;
  f.port.create = async () => {
    throw new Error("codex에 missing 모델이 없습니다.");
  };
  await f.engine.ended(
    "planner",
    "p",
    decision("plan").replace('"status":"plan"', '"status":"plan","executorModel":"codex/missing"'),
    null,
  );
  assert.equal((await f.view()).status, "error");
  assert.match((await f.view()).detail, /missing/);
  await f.engine.configure({ ...(await f.engine.settings()), executorModel: "codex/repaired" });
  f.port.create = create;
  await f.engine.control(f.id, "resume");
  assert.equal(f.created[0].config.provider, "codex/repaired");
});
test("legacy state defaults settings and suppresses historical completed notification", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p", "plan");
  await f.finish(f.created[0].id, "e", "result");
  await f.finish("planner", "done", "complete");
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  delete db.workflows[0].notifiedStatus;
  for (const key of ["notifyPermission", "notifyStopped", "notifyCompleted", "askExecutorModel"])
    delete db.settings[key];
  await writeFile(f.file, JSON.stringify(db));
  const events = [];
  const engine = new WorkflowEngine(f.file, f.port, async (e) => events.push(e));
  t.after(() => engine.close());
  assert.equal((await engine.settings()).notifyCompleted, true);
  await engine.tick();
  assert.equal(events.length, 0);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).workflows[0].notifiedStatus, "completed");
});

test("undecided responses, failures and cancellations leave state unchanged and silent", async (t) => {
  const events = [];
  const f = await fixture(t, async (event) => events.push(event), "undecided");
  const before = await readFile(f.file, "utf8");
  for (const [key, text, failed] of [
    ["plain", "확인", null],
    ["failed", decision("plan"), "failure"],
    ["canceled", "", "canceled"],
  ]) {
    await f.engine.ended("planner", key, text, failed);
    assert.equal(await readFile(f.file, "utf8"), before);
  }
  assert.equal((await f.view()).mode, "undecided");
  assert.equal(f.created.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(events.length, 0);
  await assert.rejects(f.engine.control(f.id, "pause"), /연합개발이 시작되지 않은/);
  await assert.rejects(f.engine.control(f.id, "resume"), /연합개발이 시작되지 않은/);
});
test("undecided valid plan opts into federated exactly once and enables permission notifications", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e), "undecided");
  await f.engine.permission("planner", { id: "r", kind: "question" });
  assert.equal(events.length, 0);
  await f.finish("planner", "p", "plan");
  await f.finish("planner", "p", "plan");
  assert.equal((await f.view()).mode, "federated");
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 1);
  await f.engine.permission("planner", { id: "r", kind: "question" });
  await f.engine.permission("planner", { id: "r", kind: "question" });
  assert.deepEqual(
    events.map((e) => e.kind),
    ["permission"],
  );
});
test("undecided archived conversations are ignored after the first tick cleanup", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e), "undecided");
  await f.engine.tick();
  f.agents.get("planner").archived = true;
  await f.engine.tick();
  assert.equal((await f.view()).status, "active");
  assert.equal((await f.view()).mode, "undecided");
  assert.equal(events.length, 0);
});
test("legacy workflows and default enrollment are federated", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.view()).mode, "federated");
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  delete db.workflows[0].mode;
  delete db.settings.askMode;
  await writeFile(f.file, JSON.stringify(db));
  const engine = new WorkflowEngine(f.file, f.port);
  t.after(() => engine.close());
  assert.equal((await engine.list()).workflows[0].mode, "federated");
  assert.equal((await engine.settings()).askMode, true);
});

test("archived removes undecided workflow and handoff silently and ignores later turn", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e), "undecided");
  const handoff = path.join(path.dirname(f.file), "handoffs", `${f.id}.json`);
  await readFile(handoff);
  await f.engine.archived("unrelated-executor");
  assert.equal((await f.engine.list()).workflows.length, 1);
  await f.engine.archived("planner");
  assert.deepEqual((await f.engine.list()).workflows, []);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).workflows, []);
  await assert.rejects(readFile(handoff), { code: "ENOENT" });
  await f.finish("planner", "late", "plan");
  await f.engine.archived("planner");
  assert.equal(f.created.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(events.length, 0);
});
test("archived preserves federated planner, executor and handoff", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e));
  await f.finish("planner", "p", "plan");
  const before = await readFile(f.file, "utf8");
  const handoff = path.join(path.dirname(f.file), "handoffs", `${f.id}.json`);
  const artifact = await readFile(handoff, "utf8");
  await f.engine.archived(f.created[0].id);
  await f.engine.archived("planner");
  assert.equal(await readFile(f.file, "utf8"), before);
  assert.equal(await readFile(handoff, "utf8"), artifact);
  assert.equal(events.length, 0);
});
test("first tick only removes confirmed archived undecided and never repeats lookup", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e), "undecided");
  for (const id of ["alive", "missing", "failure"]) {
    const snapshot = { ...f.agents.get("planner"), id };
    f.agents.set(id, snapshot);
    await f.engine.enroll(snapshot, { provider: "claude" }, {}, "undecided");
  }
  f.agents.get("planner").archived = true;
  const inspect = f.port.inspect;
  const calls = [];
  f.port.inspect = async (id) => {
    calls.push(id);
    if (id === "failure") throw Error("lookup failed");
    if (id === "missing") return null;
    return inspect(id);
  };
  await f.engine.tick();
  assert.deepEqual(
    (await f.engine.list()).workflows.map((w) => w.planAgentId),
    ["alive", "missing", "failure"],
  );
  assert.equal(calls.length, 4);
  await f.engine.tick();
  assert.equal(calls.length, 4);
  assert.equal(events.length, 0);
  await assert.rejects(readFile(path.join(path.dirname(f.file), "handoffs", `${f.id}.json`)), {
    code: "ENOENT",
  });
});
test("handoff deletion failure is ignored without stopping subsequent work", async (t) => {
  const f = await fixture(t, undefined, "undecided");
  const handoff = path.join(path.dirname(f.file), "handoffs", `${f.id}.json`);
  await rm(handoff);
  await mkdir(handoff);
  await f.engine.archived("planner");
  assert.equal((await f.engine.list()).workflows.length, 0);
  await f.engine.tick();
});
test("cleanup inspection failure does not block active federated observation", async (t) => {
  const f = await fixture(t);
  const other = { ...f.agents.get("planner"), id: "undecided" };
  f.agents.set(other.id, other);
  await f.engine.enroll(other, { provider: "claude" }, {}, "undecided");
  const inspect = f.port.inspect;
  const calls = [];
  f.port.inspect = async (id) => {
    calls.push(id);
    if (id === "undecided") throw Error("lookup failed");
    return inspect(id);
  };
  await f.engine.tick();
  assert.ok(calls.includes("planner"));
  assert.equal((await f.view()).status, "active");
  assert.equal((await f.engine.list()).workflows.length, 2);
});

test("thinking choice overrides settings only for a new executor", async (t) => {
  const f = await fixture(t);
  await f.engine.configure({ ...(await f.engine.settings()), executorThinking: "medium" });
  const withThinking = decision("plan").replace(
    '"status":"plan"',
    '"status":"plan","executorThinking":"high"',
  );
  await f.engine.ended("planner", "p", withThinking, null);
  assert.equal(f.created[0].config.thinkingOptionId, "high");
  assert.match(f.sent[0].prompt, /추론: high/);
  await f.finish(f.created[0].id, "e", "result");
  await f.engine.ended("planner", "p2", withThinking.replace('"high"', '"low"'), null);
  assert.equal(f.created.length, 1);
  assert.match(f.sent.at(-1).prompt, /추론: high/);
  const g = await fixture(t);
  await g.engine.configure({ ...(await g.engine.settings()), executorThinking: "medium" });
  await g.finish("planner", "p", "plan");
  assert.equal(g.created[0].config.thinkingOptionId, "medium");
  const h = await fixture(t);
  await h.finish("planner", "p", "plan");
  assert.equal(Object.hasOwn(h.created[0].config, "thinkingOptionId"), false);
  assert.match(h.sent[0].prompt, /모델 기본값/);
});
test("thinking creation errors persist and resume restores model and thinking settings", async (t) => {
  const f = await fixture(t);
  const create = f.port.create;
  f.port.create = async () => {
    throw Error("model에 bad 추론 정도가 없습니다.");
  };
  await f.engine.ended(
    "planner",
    "p",
    decision("plan").replace('"status":"plan"', '"status":"plan","executorThinking":"bad"'),
    null,
  );
  assert.equal((await f.view()).status, "error");
  await f.engine.configure({
    ...(await f.engine.settings()),
    executorModel: "codex/fixed",
    executorThinking: "medium",
  });
  f.port.create = create;
  await f.engine.control(f.id, "resume");
  assert.equal(f.created[0].config.provider, "codex/fixed");
  assert.equal(f.created[0].config.thinkingOptionId, "medium");
});
test("completed uncreated executor resets thinking on a new plan", async (t) => {
  const f = await fixture(t);
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  const w = db.workflows[0];
  w.status = "completed";
  w.execute = {
    ...w.plan,
    id: "executor",
    workspaceId: null,
    config: { provider: "codex/bad", thinkingOptionId: "bad" },
  };
  db.settings.executorModel = "codex/fixed";
  db.settings.executorThinking = "";
  await writeFile(f.file, JSON.stringify(db));
  const restarted = new WorkflowEngine(f.file, f.port);
  t.after(() => restarted.close());
  await restarted.ended("planner", "new", decision("plan"), null);
  assert.equal(f.created[0].config.provider, "codex/fixed");
  assert.equal(Object.hasOwn(f.created[0].config, "thinkingOptionId"), false);
});
test("undecided first title is saved and renamed once before mode parsing", async (t) => {
  const f = await fixture(t, undefined, "undecided", false);
  await f.engine.ended("planner", "one", "OK\n제목: 첫 한글 제목", null);
  assert.equal((await f.view()).title, "첫 한글 제목");
  assert.equal((await f.view()).mode, "undecided");
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).workflows[0].titled, true);
  await f.engine.ended("planner", "two", "제목: 두 번째", null);
  assert.deepEqual(f.renamed, [{ workspaceId: "initial", title: "🟠 C[project]-01 첫 한글 제목" }]);
  assert.equal(f.created.length, 0);
});
test("rename failure cannot stop a plan and new execution uses the title", async (t) => {
  const f = await fixture(t, undefined, "federated", false);
  f.port.rename = async () => {
    throw Error("offline");
  };
  await f.engine.ended("planner", "p", "제목: 한글 작업\n" + decision("plan"), null);
  assert.equal((await f.view()).status, "active");
  assert.equal(f.created[0].title, "한글 작업");
});
test("legacy titled default and failed turns do not rename", async (t) => {
  const f = await fixture(t, undefined, "undecided", false);
  await f.engine.ended("planner", "fail", "제목: 실패", "canceled");
  assert.equal(f.renamed.length, 0);
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  delete db.workflows[0].titled;
  await writeFile(f.file, JSON.stringify(db));
  const restarted = new WorkflowEngine(f.file, f.port);
  t.after(() => restarted.close());
  await restarted.ended("planner", "p", "제목: 새 제목", null);
  assert.equal((await restarted.list()).workflows[0].title, "task");
  assert.equal(f.renamed.length, 0);
});

test("marker uses workspace fallback once and survives lookup failure", async (t) => {
  const f = await fixture(t, undefined, "undecided", false);
  await f.engine.configure({ ...(await f.engine.settings()), koreanTitle: false });
  await f.engine.ended("planner", "first", "OK", null);
  await f.engine.ended("planner", "second", "OK", null);
  assert.deepEqual(f.renamed, [{ workspaceId: "initial", title: "🟠 C[project]-01 현재 이름" }]);
  assert.equal((await f.view()).title, "현재 이름");
  const g = await fixture(t, undefined, "undecided", false);
  g.port.workspaceName = async () => {
    throw Error("offline");
  };
  await g.engine.ended("planner", "first", "OK", null);
  assert.equal(g.renamed[0].title, "🟠 C[project]-01 task");
});
test("federated first response renames once and keeps flow and notifications undecorated", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e), "undecided", false);
  await f.engine.ended("planner", "first", "제목: 🟠 계획2: 새 작업\n" + decision("plan"), null);
  assert.deepEqual(f.renamed, [{ workspaceId: "initial", title: "🟠 C[project]-01 새 작업" }]);
  assert.equal(f.created[0].title, "새 작업");
  assert.equal(f.created[0].marker, true);
  assert.equal((await f.view()).mode, "federated");
  await f.engine.permission("planner", { id: "permission", kind: "tool" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[0].title, "권한 요청 · 새 작업");
});
test("later federation adds role without reading or replacing the established title", async (t) => {
  const f = await fixture(t, undefined, "undecided", false);
  await f.engine.ended("planner", "first", "제목: 기존 제목", null);
  await f.engine.ended("planner", "second", "제목: 무시\n" + decision("plan"), null);
  assert.deepEqual(
    f.renamed.map((x) => x.title),
    ["🟠 C[project]-01 기존 제목", "🟠 C[project]-01 기존 제목"],
  );
});
test("standalone codex is labelled general and turns green on completion", async (t) => {
  const f = await fixture(t, undefined, "federated", false, "codex/m");
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  const w = db.workflows[0];
  w.execute = w.plan;
  w.plan = null;
  w.phase = "execute";
  await writeFile(f.file, JSON.stringify(db));
  const restored = new WorkflowEngine(f.file, f.port);
  t.after(() => restored.close());
  await restored.ended("planner", "first", "제목: 단독 작업\n" + decision("complete"), null);
  assert.deepEqual(
    f.renamed.map((x) => x.title),
    ["🟢 G[project]-01 단독 작업"],
  );
});
test("general conversation follows declared progress and ignores repeats", async (t) => {
  const f = await fixture(t, undefined, "general", false, "claude", verifiedPushProbe);
  await f.engine.ended("planner", "1", "계획입니다\n제목: 색 표식\n작업상태: 계획", null);
  await f.engine.ended("planner", "2", "구현 중\n작업상태: 진행", null);
  await f.engine.ended("planner", "3", "여전히 구현 중\n작업상태: 진행", null);
  await f.engine.ended("planner", "4", "본문의 작업상태: 완료 는 무시", null);
  await f.engine.ended("planner", "5", "검증 끝\n작업상태: 완료", null);
  await f.engine.ended("planner", "6", "실패\n작업상태: 푸시", "canceled");
  await finishPush(f.engine, "planner", "7", "푸시함\n작업상태: 푸시");
  assert.deepEqual(
    f.renamed.map((x) => x.title),
    ["🟣", "🟠", "🟢", "🔵"].map(
      (symbol) => `${symbol} C[project]-01 ${symbol === "🔵" ? "[PUSH] " : ""}색 표식`,
    ),
  );
  assert.equal((await f.view()).mode, "general");
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).workflows[0].progress, "pushed");
});
test("a federation is one workspace whose title follows completion, push and a new plan", async (t) => {
  const f = await fixture(t, undefined, "federated", false, "claude", verifiedPushProbe);
  await f.engine.ended("planner", "p", "제목: 짝 작업\n" + decision("plan"), null);
  const executor = f.created[0].id;
  assert.equal(
    f.agents.get(executor).workspaceId,
    "initial",
    "the executor is a tab beside its planner",
  );
  const titles = () => f.renamed.map((x) => x.title);
  assert.deepEqual(titles(), ["🟠 C[project]-01 짝 작업"]);
  await f.finish(executor, "r", "result");
  await f.finish("planner", "c", "complete");
  f.agents.get(executor).status = "idle";
  await finishPush(f.engine, executor, "late", "푸시 완료\n작업상태: 푸시");
  await f.finish("planner", "again", "plan");
  assert.deepEqual(titles(), [
    "🟠 C[project]-01 짝 작업",
    "🟢 C[project]-01 짝 작업",
    "🔵 C[project]-01 [PUSH] 짝 작업",
    "🟠 C[project]-01 짝 작업",
  ]);
  assert.ok(f.renamed.every((row) => row.workspaceId === "initial"));
  const g = await fixture(t, undefined, "federated", false);
  await g.engine.configure({ ...(await g.engine.settings()), titleMarker: false });
  await g.engine.ended("planner", "p", "제목: 표식 없음\n" + decision("plan"), null);
  await g.finish(g.created[0].id, "r", "result");
  await g.finish("planner", "c", "complete");
  assert.deepEqual(
    g.renamed.map((x) => x.title),
    ["C[project]-01 표식 없음"],
  );
});
test("a federation from before shared workspaces keeps a title for each role", async (t) => {
  const f = await fixture(t, undefined, "federated", false);
  f.port.create = async (w, role, member) => {
    f.created.push({ role, id: member.id });
    f.agents.set(member.id, {
      ...f.agents.get("planner"),
      id: member.id,
      workspaceId: "separate",
    });
    return "separate";
  };
  await f.engine.ended("planner", "p", "제목: 옛 짝\n" + decision("plan"), null);
  const executor = f.created[0].id;
  await f.finish(executor, "r", "result");
  await f.finish("planner", "c", "complete");
  assert.deepEqual(
    f.renamed.slice(-2).map((x) => [x.workspaceId, x.title]),
    [
      ["initial", "🟢 C[project:계획]-01 옛 짝"],
      ["separate", "🟢 G[project:실행]-01 옛 짝"],
    ],
  );
});
test("user-typed progress line and direct setting recolour conversations without the prompt", async (t) => {
  const f = await fixture(t, undefined, "general", true, "claude", verifiedPushProbe);
  const turn = (key, request, text = "네") =>
    f.engine.ended("planner", key, text, null, "goal", false, request);
  await turn("1", "커밋 푸시 끝났어\n작업상태: 푸시");
  await turn("2", "작업 ID: x\n작업상태: 계획");
  await turn("3", "작업상태: 완료", "아직입니다\n작업상태: 진행");
  assert.deepEqual(
    f.renamed.map((x) => x.title),
    ["🟢 C[project]-01 [푸시 확인필요] 현재 이름", "🟢 C[project]-01 현재 이름"],
  );
  assert.deepEqual(await f.engine.setProgress(1, "plan"), ["🟣 C[project]-01 현재 이름"]);
  assert.equal(f.renamed.at(-1).title, "🟣 C[project]-01 현재 이름");
  await assert.rejects(f.engine.setProgress(9, "done"), /9번 작업/);
});
test("paused flow turns green on the planner's complete without resuming", async (t) => {
  const f = await fixture(t, undefined, "federated", false);
  await f.engine.ended("planner", "p", "제목: 멈춘 작업\n" + decision("plan"), null);
  const executor = f.created[0].id;
  await f.engine.control(f.id, "pause");
  await f.finish(executor, "r", "complete");
  assert.equal(f.renamed.length, 1);
  await f.finish("planner", "c", "complete");
  assert.deepEqual(
    f.renamed.slice(1).map((x) => x.title),
    ["🟢 C[project]-01 멈춘 작업"],
  );
  assert.equal((await f.view()).status, "paused");
  const saved = JSON.parse(await readFile(f.file, "utf8")).workflows[0];
  saved.progress = "active";
  await f.engine.close();
  await writeFile(f.file, JSON.stringify({ version: 1, settings: {}, workflows: [saved] }));
  const engine = new WorkflowEngine(f.file, f.port);
  t.after(() => engine.close());
  assert.equal((await engine.retitle(false, []))[0].title, "🟢 C[project]-01 멈춘 작업");
});
test("retitle previews without writing, then numbers legacy flows and unmanaged pairs", async (t) => {
  const f = await fixture(t);
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  delete db.sequence;
  delete db.sequences;
  delete db.revision;
  delete db.workflows[0].number;
  delete db.workflows[0].progress;
  db.workflows[0].status = "completed";
  db.workflows[0].title = "예전 작업";
  db.workflows[0].execute = { ...db.workflows[0].plan, id: "gone", workspaceId: "archived" };
  await writeFile(f.file, JSON.stringify(db));
  const engine = new WorkflowEngine(f.file, f.port);
  t.after(() => engine.close());
  const unmanaged = [
    { workspaceId: "initial", provider: "claude", role: null, title: "중복은 제외" },
    { workspaceId: "a", provider: "claude", role: "plan", title: "🟠 계획: 옛 짝" },
    { workspaceId: "b", provider: "codex", role: "execute", title: "🟢 실행: 옛 짝" },
    { workspaceId: "c", provider: "codex", role: null, title: "🟢 단독" },
    { workspaceId: "e", provider: "codex", role: null, title: "🟠 GPT[일반개발]-15 옛 양식" },
    { workspaceId: "d", provider: "other", role: null, title: "main" },
  ];
  for (const row of unmanaged) row.projectId = "project";
  const expected = [
    {
      workspaceId: "initial",
      title: "🟢 C[project:계획]-01 현재 이름",
      error: null,
    },
    { workspaceId: "a", title: "🟠 C[project:계획]-02 옛 짝", error: null },
    { workspaceId: "b", title: "🟢 G[project:실행]-02 옛 짝", error: null },
    { workspaceId: "c", title: "🟢 G[project]-03 단독", error: null },
    { workspaceId: "e", title: "🟠 G[project]-15 옛 양식", error: null },
    { workspaceId: "d", title: "main", error: null },
  ];
  assert.deepEqual(await engine.retitle(false, unmanaged), expected);
  assert.equal(f.renamed.length, 0);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).sequence, undefined);
  assert.deepEqual(await engine.retitle(true, unmanaged), expected);
  assert.deepEqual(
    f.renamed,
    expected.map(({ workspaceId, title }) => ({ workspaceId, title })),
  );
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  assert.deepEqual(saved.sequences, { project: 4 });
  assert.equal(saved.workflows[0].number, 1);
  assert.equal(saved.workflows[0].title, "현재 이름");
  assert.equal(saved.workflows[0].progress, "done");
});
test("retitle refreshes project labels without changing task numbers, modes or progress", async (t) => {
  const f = await fixture(t, undefined, "general");
  f.renamed.push({ workspaceId: "initial", title: "🟠 C[일반]-01 기존 제목" });
  let projectName = "sample-development";
  f.port.projectName = async () => projectName;
  const before = JSON.parse(await readFile(f.file, "utf8")).workflows[0];
  const preview = await f.engine.retitle(false, []);
  assert.equal(preview[0].title, "🟠 C[sample dev]-01 기존 제목");
  assert.equal(f.renamed.length, 1);
  await f.engine.retitle(true, []);
  const after = JSON.parse(await readFile(f.file, "utf8")).workflows[0];
  for (const key of ["number", "mode", "progress", "status", "projectId"])
    assert.equal(after[key], before[key]);
  projectName = "새 프로젝트";
  await f.engine.setProgress(1, "done");
  assert.equal(f.renamed.at(-1).title, "🟢 C[새 프로젝트]-01 기존 제목");
});

test("disabled title features preserve text while federation adds an explicit role", async (t) => {
  const f = await fixture(t, undefined, "undecided", false);
  await f.engine.configure({
    ...(await f.engine.settings()),
    titleMarker: false,
    koreanTitle: false,
  });
  await f.engine.ended("planner", "first", "OK", null);
  await f.engine.ended("planner", "second", decision("plan"), null);
  assert.deepEqual(
    f.renamed.map((row) => row.title),
    ["C[project]-01 현재 이름"],
  );
  assert.equal(f.created[0].marker, false);
  const g = await fixture(t);
  await g.engine.close();
  const db = JSON.parse(await readFile(g.file, "utf8"));
  delete db.settings.titleMarker;
  await writeFile(g.file, JSON.stringify(db));
  const restarted = new WorkflowEngine(g.file, g.port);
  t.after(() => restarted.close());
  assert.equal((await restarted.settings()).titleMarker, true);
});

async function recordWrites(t, run) {
  const { JsonStore } = await import("../server/store.ts");
  const writes = [];
  const original = JsonStore.prototype.write;
  const spy = t.mock.method(JsonStore.prototype, "write", async function (value) {
    writes.push(this.file);
    return original.call(this, value);
  });
  try {
    await run(writes);
  } finally {
    spy.mock.restore();
  }
}

test("unchanged ticks write neither state nor handoffs; only changed flow writes its handoff", async (t) => {
  const f = await fixture(t);
  const other = { ...f.agents.get("planner"), id: "other", workspaceId: "other-space" };
  f.agents.set(other.id, other);
  const otherId = await f.engine.enroll(other, { provider: "claude" });
  await f.engine.tick();
  await recordWrites(t, async (writes) => {
    await f.engine.tick();
    await f.engine.tick();
    assert.deepEqual(writes, []);
    await f.engine.control(f.id, "pause");
    assert.deepEqual(writes, [f.file, path.join(path.dirname(f.file), "handoffs", `${f.id}.json`)]);
    assert.ok(!writes.some((file) => file.endsWith(`${otherId}.json`)));
  });
});

test("permission waiting ticks preserve updatedAt and perform zero writes", async (t) => {
  const f = await fixture(t);
  f.agents.get("planner").permission = true;
  await f.engine.tick();
  const updatedAt = (await f.view()).updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 10));
  await recordWrites(t, async (writes) => {
    await f.engine.tick();
    await f.engine.tick();
    assert.equal((await f.view()).updatedAt, updatedAt);
    assert.deepEqual(writes, []);
  });
});

test("first save after restart writes all artifacts and a failed handoff write is retried", async (t) => {
  const f = await fixture(t);
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port);
  t.after(() => restored.close());
  await recordWrites(t, async (writes) => {
    await restored.tick();
    assert.equal(writes.length, 2);
    writes.length = 0;
    await restored.tick();
    assert.deepEqual(writes, []);
  });
  const { JsonStore } = await import("../server/store.ts");
  const original = JsonStore.prototype.write;
  const spy = t.mock.method(JsonStore.prototype, "write", async function (value) {
    if (this.file.includes("handoffs")) throw Error("handoff failure");
    return original.call(this, value);
  });
  await assert.rejects(restored.control(f.id, "pause"), /handoff failure/);
  spy.mock.restore();
  await recordWrites(t, async (writes) => {
    await restored.tick();
    assert.deepEqual(writes, [path.join(path.dirname(f.file), "handoffs", `${f.id}.json`)]);
  });
});

test("archive state-write failure rolls back and retries removal", async (t) => {
  const f = await fixture(t, undefined, "undecided");
  const spy = t.mock.method(f.engine.store, "write", async () => {
    throw Error("state failure");
  });
  await assert.rejects(f.engine.archived("planner"), /state failure/);
  assert.equal((await f.view()).id, f.id);
  spy.mock.restore();
  await f.engine.archived("planner");
  assert.equal((await f.engine.list()).workflows.length, 0);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).workflows.length, 0);
});

test("review report occurs once; second-cycle and resume omit own context until compaction", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  assert.match(f.sent[0].prompt, /원래 목표:\noriginal goal/);
  await f.finish(executor, "e1", "result");
  assert.equal(f.sent[1].prompt.split("result summary").length - 1, 1);
  assert.doesNotMatch(f.sent[1].prompt, /원래 목표:|직전 인계:|최근 계획:|이전 대화 ID:/);
  await f.finish("planner", "p2", "plan");
  assert.doesNotMatch(f.sent[2].prompt, /원래 목표:|직전 인계:|최근 실행 결과:|이전 대화 ID:/);
  assert.equal(f.sent[2].prompt.split("plan summary").length - 1, 1);
  await f.engine.control(f.id, "pause");
  f.agents.get(executor).status = "idle";
  await f.engine.control(f.id, "resume", "추가 작업");
  assert.doesNotMatch(f.sent.at(-1).prompt, /원래 목표:/);
  assert.match(f.sent.at(-1).prompt, /추가 작업/);
  f.agents.get("planner").usage = 0.85;
  await f.finish(executor, "e2", "result");
  await new Promise((resolve) => setImmediate(resolve));
  await f.engine.tick();
  assert.match(f.sent.at(-1).prompt, /원래 목표:\noriginal goal/);
  assert.equal(f.sent.at(-1).prompt.split("result summary").length - 1, 1);
});

const modeRequest = (id = "mode") => ({
  id,
  kind: "question",
  input: {
    questions: [
      {
        question: "진행 방식을 선택하세요",
        header: "진행 방식",
        options: [{ label: "일반개발" }, { label: "연합개발" }],
      },
    ],
  },
});
const modeAnswer = (answer, key = "진행 방식") => ({
  behavior: "allow",
  updatedInput: { answers: { [key]: answer } },
});

test("mode answers by header or question persist general/federated and enable later notifications", async (t) => {
  for (const [answer, mode, key] of [
    ["일반개발", "general", "진행 방식"],
    ["연합개발", "federated", "진행 방식을 선택하세요"],
  ]) {
    const events = [];
    const f = await fixture(t, async (e) => events.push(e), "undecided", false);
    await f.engine.permission("planner", modeRequest());
    await f.engine.permissionResolved("planner", "mode", modeAnswer(answer, key));
    assert.equal((await f.view()).mode, mode);
    assert.equal(JSON.parse(await readFile(f.file, "utf8")).workflows[0].mode, mode);
    assert.equal(events.length, 0);
    await f.engine.permission("planner", { id: "model", kind: "question" });
    await f.engine.permission("planner", { id: "model", kind: "question" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.length, mode === "federated" ? 1 : 0);
    if (mode === "federated") {
      await f.engine.ended(
        "planner",
        "p1",
        "제목: 개발 설정 개선\n" + decision("plan"),
        null,
        "goal",
      );
      assert.equal(f.renamed[0].title, "🟠 C[project]-01 개발 설정 개선");
    }
  }
});

test("freeform, deny, malformed, mismatched and replayed answers do not select a mode", async (t) => {
  const f = await fixture(t, undefined, "undecided");
  for (const response of [
    modeAnswer("직접 진행해주세요"),
    modeAnswer("연합개발 (추천)"),
    { behavior: "deny" },
    { behavior: "allow" },
    modeAnswer(["연합개발"]),
    modeAnswer("연합개발", "unrelated"),
  ]) {
    await f.engine.permission("planner", modeRequest());
    await f.engine.permissionResolved("planner", "mode", response);
    await f.engine.permissionResolved("planner", "mode", modeAnswer("연합개발"));
    assert.equal((await f.view()).mode, "undecided");
  }
  const request = modeRequest();
  request.input.questions[0].options.pop();
  await f.engine.permission("planner", request);
  await f.engine.permissionResolved("planner", "mode", modeAnswer("연합개발"));
  assert.equal((await f.view()).mode, "undecided");
  await f.engine.permission("planner", modeRequest());
  await f.engine.permissionResolved("other-agent", "mode", modeAnswer("연합개발"));
  assert.equal((await f.view()).mode, "undecided");
});

test("mode request memory is bounded and old requests cannot change a chosen mode", async (t) => {
  const f = await fixture(t, undefined, "undecided");
  for (let i = 0; i <= 200; i++) await f.engine.permission("planner", modeRequest(String(i)));
  await f.engine.permissionResolved("planner", "0", modeAnswer("연합개발"));
  assert.equal((await f.view()).mode, "undecided");
  await f.engine.permissionResolved("planner", "200", modeAnswer("일반개발"));
  await f.engine.permissionResolved("planner", "199", modeAnswer("연합개발"));
  assert.equal((await f.view()).mode, "general");
});

test("general skips ticks and control, archives silently, and valid block transitions with title", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e), "general", false);
  await f.engine.tick(); // Initial cleanup may inspect general; subsequent ticks must not.
  const spy = t.mock.method(f.port, "inspect", async () => {
    throw Error("must not inspect");
  });
  await f.engine.tick();
  assert.equal(spy.mock.callCount(), 0);
  spy.mock.restore();
  await assert.rejects(f.engine.control(f.id, "resume"), /연합개발이 시작되지/);
  await f.engine.ended("planner", "general-first", "제목: 개발 설정\n일반 응답", null);
  await f.finish("planner", "stray-block", "plan");
  assert.equal((await f.view()).mode, "general");
  assert.equal(f.created.length, 0);
  await f.engine.ended(
    "planner",
    "federated-first",
    decision("plan"),
    null,
    "original goal",
    false,
    "연합개발로 전환해줘",
  );
  assert.equal((await f.view()).mode, "federated");
  assert.equal(f.created.length, 1);
  assert.equal(f.renamed.at(-1).title, "🟠 C[project]-01 개발 설정");
  const g = await fixture(t, async (e) => events.push(e), "general");
  await g.engine.archived("planner");
  assert.equal((await g.engine.list()).workflows.length, 0);
  await assert.rejects(readFile(path.join(path.dirname(g.file), "handoffs", `${g.id}.json`)), {
    code: "ENOENT",
  });
  const h = await fixture(t, async (e) => events.push(e), "general");
  h.agents.get("planner").archived = true;
  await h.engine.tick();
  assert.equal((await h.engine.list()).workflows.length, 0);
  assert.deepEqual(events, []);
});

const rememberedDecision = (status, remember) =>
  decision(status).replace('"checks":', `"remember":${JSON.stringify(remember)},"checks":`);

test("remember accumulates normalized unique entries in handoff, sends once then fully after compaction", async (t) => {
  const f = await fixture(t);
  await f.engine.ended(
    "planner",
    "p1",
    rememberedDecision("plan", ["  지킬\n 규칙  ", "지킬 규칙", " "]),
    null,
    "original goal",
  );
  const executor = f.created[0].id;
  assert.equal(f.sent[0].prompt.split("지킬 규칙").length - 1, 1);
  const handoff = JSON.parse(
    await readFile(path.join(path.dirname(f.file), "handoffs", `${f.id}.json`), "utf8"),
  );
  assert.deepEqual(handoff.remember, ["지킬 규칙"]);
  await f.finish(executor, "e1", "result");
  await f.finish("planner", "p2", "plan");
  assert.doesNotMatch(f.sent[2].prompt, /지킬 규칙|반드시 지킬 사항:/);
  await f.finish(executor, "e2", "result");
  f.agents.get(executor).usage = 0.85;
  await f.finish("planner", "p3", "plan");
  await new Promise((resolve) => setImmediate(resolve));
  await f.engine.tick();
  assert.match(f.sent.at(-1).prompt, /반드시 지킬 사항:\n- 지킬 규칙/);
});

test("memory sequence survives eviction and legacy state loads with defaults", async (t) => {
  const f = await fixture(t);
  const db = JSON.parse(await readFile(f.file, "utf8"));
  delete db.workflows[0].memories;
  delete db.workflows[0].memorySequence;
  delete db.workflows[0].plan.rememberedThrough;
  await f.engine.close();
  await writeFile(f.file, JSON.stringify(db));
  const engine = new WorkflowEngine(f.file, f.port);
  t.after(() => engine.close());
  for (let i = 0; i < 6; i++) {
    f.agents.get("planner").status = "idle";
    await engine.ended(
      "planner",
      `turn-${i}`,
      rememberedDecision(
        "continue",
        Array.from({ length: 10 }, (_, n) => `rule-${i * 10 + n}`),
      ),
      null,
    );
  }
  const w = JSON.parse(await readFile(f.file, "utf8")).workflows[0];
  assert.equal(w.memories.length, 50);
  assert.equal(w.memorySequence, 60);
  assert.equal(w.memories[0].text, "rule-10");
  assert.equal(w.plan.rememberedThrough, 60);
  assert.match(f.sent.at(-1).prompt, /rule-50/);
  assert.doesNotMatch(f.sent.at(-1).prompt, /rule-49/);
});

test("automatic compaction through ended and recovery forces full context without duplicate compact", async (t) => {
  for (const recovery of [false, true]) {
    const f = await fixture(t);
    await f.engine.ended(
      "planner",
      "p1",
      rememberedDecision("plan", ["기억 유지"]),
      null,
      "original goal",
    );
    const executor = f.created[0].id;
    f.agents.get(executor).status = "idle";
    f.agents.get(executor).usage = 0.9;
    if (recovery) {
      f.histories.set(executor, {
        text: decision("result"),
        key: "e1",
        messageIds: [f.sent[0].messageId],
        failed: null,
        compacted: true,
      });
      await f.engine.tick();
    } else await f.engine.ended(executor, "e1", decision("result"), null, "", true);
    assert.equal(f.compacted.length, 0);
    await f.finish("planner", "p2", "plan");
    assert.match(f.sent.at(-1).prompt, /원래 목표:\noriginal goal/);
    assert.match(f.sent.at(-1).prompt, /기억 유지/);
    assert.equal(f.compacted.length, 0);
  }
});

test("memory cursor advances only after confirmed send including recovery after restart", async (t) => {
  const f = await fixture(t);
  f.port.send = async () => {
    throw Error("delivery uncertain");
  };
  await f.engine.ended("planner", "p1", rememberedDecision("plan", ["미전달 기억"]), null);
  let w = JSON.parse(await readFile(f.file, "utf8")).workflows[0];
  assert.equal(w.execute.rememberedThrough, 0);
  assert.equal(w.pending.rememberedThrough, 1);
  f.histories.set(w.execute.id, { messageIds: [w.pending.id], key: "", text: "", failed: null });
  await f.engine.close();
  const engine = new WorkflowEngine(f.file, f.port);
  t.after(() => engine.close());
  await engine.control(f.id, "resume");
  w = JSON.parse(await readFile(f.file, "utf8")).workflows[0];
  assert.equal(w.pending.stage, "sent");
  assert.equal(w.execute.rememberedThrough, 1);
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} rejects a same-provider executor without creating or sending work`, async (t) => {
    const f = await fixture(t, undefined, undefined, undefined, provider);
    const text = decision("plan").replace(
      '"status":"plan"',
      `"status":"plan","executorModel":"${provider}/wrong"`,
    );
    await f.engine.ended("planner", "bad", text, null);
    assert.equal((await f.view()).status, "needs_input");
    assert.equal(f.created.length, 0);
    assert.equal(f.sent.length, 0);
    assert.equal((await f.view()).cycles, 0);
  });
}

test("GPT planner uses and repairs only Claude settings then preserves assignment after reload and compaction", async (t) => {
  const f = await fixture(t, undefined, "federated", false, "codex/planner-model");
  await f.engine.configure({
    ...(await f.engine.settings()),
    executorModel: "codex/keep",
    executorThinking: "xhigh",
    claudeExecutorModel: "claude/bad",
    claudeExecutorThinking: "high",
  });
  const create = f.port.create;
  f.port.create = async () => {
    throw Error("invalid Claude model");
  };
  await f.finish("planner", "p1", "plan");
  assert.equal((await f.view()).status, "error");
  await f.engine.configure({
    ...(await f.engine.settings()),
    claudeExecutorModel: "claude/fixed",
    claudeExecutorThinking: "medium",
    claudeExecutorMode: "acceptEdits",
  });
  f.port.create = create;
  await f.engine.control(f.id, "resume");
  const executor = f.created[0].id;
  assert.deepEqual(f.created[0].config, {
    provider: "claude/fixed",
    thinkingOptionId: "medium",
    modeId: "acceptEdits",
  });
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port);
  t.after(() => restored.close());
  f.agents.get("planner").usage = 0.85;
  f.agents.get(executor).status = "idle";
  await restored.ended(executor, "e1", decision("result"), null);
  await new Promise((resolve) => setImmediate(resolve));
  await restored.tick();
  assert.equal(f.sent.at(-1).id, "planner");
  assert.deepEqual(f.compacted, ["planner"]);
  const before = f.sent.length;
  await restored.ended(executor, "e1", decision("result"), null);
  assert.equal(f.sent.length, before);
  const db = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(db.workflows[0].plan.config.provider, "codex/planner-model");
  assert.equal(db.workflows[0].execute.config.provider, "claude/fixed");
  assert.equal(db.settings.executorModel, "codex/keep");
  f.agents.get("planner").status = "idle";
  await restored.ended("planner", "p2", decision("complete"), null);
  assert.equal((await restored.list()).workflows[0].status, "completed");
});

test("Claude executor cannot finalize a GPT-planned workflow", async (t) => {
  const f = await fixture(t, undefined, undefined, undefined, "codex");
  await f.finish("planner", "p", "plan");
  await f.finish(f.created[0].id, "e", "complete");
  assert.equal((await f.view()).status, "needs_input");
});

test("GPT general mode creates no counterpart and mode answer can select federation", async (t) => {
  const f = await fixture(t, undefined, "undecided", false, "codex");
  await f.engine.permission("planner", {
    id: "q",
    kind: "question",
    input: {
      questions: [
        {
          question: "진행 방식",
          header: "Question 1",
          options: [{ label: "일반개발" }, { label: "연합개발" }],
        },
      ],
    },
  });
  await f.engine.permissionResolved("planner", "q", {
    behavior: "allow",
    updatedInput: { answers: { "Question 1": "일반개발" } },
  });
  await f.engine.ended("planner", "g", "제목: 일반 작업\n작업상태: 완료", null);
  assert.equal((await f.view()).mode, "general");
  assert.equal(f.created.length, 0);
  assert.equal(f.sent.length, 0);
  const g = await fixture(t, undefined, "undecided", false, "codex");
  await g.finish("planner", "p", "plan");
  assert.equal((await g.view()).mode, "federated");
  assert.equal(g.created[0].config.provider, "claude");
  assert.match(g.renamed[0].title, /G\[project\]-01/);
});

for (const provider of ["claude", "codex"]) {
  for (const choice of ["일반개발", "연합개발"]) {
    test(`${provider} accepts a delayed ${choice} answer after the question turn ends`, async (t) => {
      const f = await fixture(t, undefined, "undecided", false, provider);
      const request = modeRequest();
      request.input.questions[0].header = "Question 1";
      await f.engine.permission("planner", request);
      await f.engine.ended("planner", "question-turn", "진행 방식 선택을 기다립니다.", null);
      await f.engine.tick();
      assert.equal((await f.view()).mode, "undecided");
      assert.equal(f.created.length, 0);
      assert.equal(f.sent.length, 0);

      await f.engine.permissionResolved("planner", "mode", modeAnswer(choice, "Question 1"));
      if (choice === "일반개발") {
        await f.engine.ended("planner", "answer-turn", "작업상태: 완료", null);
        await f.engine.tick();
        assert.equal((await f.view()).mode, "general");
        assert.equal(f.created.length, 0);
        assert.equal(f.sent.length, 0);
      } else {
        assert.equal((await f.view()).mode, "federated");
        assert.equal(f.created.length, 0);
        await f.finish("planner", "plan-turn", "plan");
        assert.equal(f.created.length, 1);
        assert.equal(f.created[0].config.provider, provider === "codex" ? "claude" : "codex");
        await f.finish(f.created[0].id, "result-turn", "result");
        assert.equal(f.sent.at(-1).id, "planner");
        await f.finish("planner", "review-turn", "complete");
        assert.equal((await f.view()).status, "completed");
      }
    });
  }
}

test("old settings load without changing the existing Codex executor configuration", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p", "plan");
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  for (const key of ["claudeExecutorModel", "claudeExecutorThinking", "claudeExecutorMode"])
    delete db.settings[key];
  const existing = structuredClone(db.workflows[0]);
  await writeFile(f.file, JSON.stringify(db));
  const restored = new WorkflowEngine(f.file, f.port);
  t.after(() => restored.close());
  assert.equal((await restored.settings()).claudeExecutorModel, "claude");
  const loaded = await restored.store.read();
  assert.deepEqual(loaded.workflows[0], existing);
});

/** Keeps a new executor busy so its first instruction stays queued. */
function occupyNewExecutor(f) {
  const create = f.port.create;
  f.port.create = async (w, role, member, marker) => {
    const workspaceId = await create(w, role, member, marker);
    f.agents.get(member.id).status = "running";
    return workspaceId;
  };
}
const stored = async (f) => JSON.parse(await readFile(f.file, "utf8")).workflows[0];

test("comparison and negation never start a federation even with a stray plan block", async (t) => {
  const f = await fixture(t, undefined, "general");
  for (const [index, request] of [
    "연합개발과 일반개발의 차이를 설명해 줘",
    "연합개발로 전환하지 말고 일반개발로 해",
    "연합개발로 할까 고민 중",
  ].entries()) {
    await f.engine.ended(
      "planner",
      `comparison-${index}`,
      decision("plan"),
      null,
      "goal",
      false,
      request,
    );
    assert.equal((await f.view()).mode, "general");
    assert.equal((await stored(f)).wantsFederation, false);
  }
  await f.engine.ended(
    "planner",
    "request",
    "모델 선택 중",
    null,
    "goal",
    false,
    "연합개발로 전환해줘",
  );
  assert.equal((await stored(f)).wantsFederation, true);
  await f.engine.ended(
    "planner",
    "cancel",
    decision("plan"),
    null,
    "goal",
    false,
    "연합개발로 전환하지 마",
  );
  assert.equal((await stored(f)).wantsFederation, false);
  assert.equal(f.created.length, 0);
});

test("project mode selection persists across restart, remains folder scoped, and can be disabled or reset", async (t) => {
  const f = await fixture(t, undefined, "undecided");
  await f.engine.permission("planner", modeRequest());
  await f.engine.permissionResolved("planner", "mode", modeAnswer("일반개발"));
  const cwd = f.agents.get("planner").cwd;
  assert.equal((await f.engine.startSettings(cwd, "codex")).defaultMode, "general");
  assert.equal((await f.engine.startSettings(cwd, "codex")).askMode, true);
  assert.equal((await f.engine.startSettings(path.join(cwd, "other"), "codex")).askMode, true);
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port);
  t.after(() => restored.close());
  assert.equal((await restored.startSettings(cwd, "claude")).defaultMode, "general");
  assert.equal((await restored.startSettings(cwd, "claude")).askMode, true);
  await restored.configure({ ...(await restored.settings()), askMode: false });
  assert.equal((await restored.startSettings(cwd, "claude")).askMode, false);
  assert.equal((await restored.startSettings(cwd, "claude")).defaultMode, "general");
  await restored.configure({ ...(await restored.settings()), askMode: true });
  await restored.configure({ ...(await restored.settings()), rememberProjectChoices: false });
  assert.equal((await restored.startSettings(cwd, "claude")).askMode, true);
  await restored.configure({ ...(await restored.settings()), rememberProjectChoices: true });
  await restored.forgetProject(cwd);
  assert.equal((await restored.startSettings(cwd, "claude")).askMode, true);
  assert.deepEqual((await restored.list()).projects, {});
});

test("explicit general selection is saved even when there is no permission question", async (t) => {
  const f = await fixture(t, undefined, "undecided");
  await f.engine.ended(
    "planner",
    "choice",
    "작업상태: 완료",
    null,
    "goal",
    false,
    "일반개발로 진행해줘",
  );
  const data = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(data.workflows[0].mode, "general");
  assert.equal(data.projects[f.agents.get("planner").cwd].mode, "general");
  assert.equal((await f.view()).progress, "done");
});

test("an explicit general request overrides a saved federation before an executor exists", async (t) => {
  const f = await fixture(t, undefined, "federated");
  await f.engine.ended(
    "planner",
    "override",
    "직접 진행합니다.",
    null,
    "goal",
    false,
    "일반개발로 진행해줘",
  );
  assert.equal((await f.view()).mode, "general");
  assert.equal(f.created.length, 0);
  assert.equal(
    (await f.engine.startSettings(f.agents.get("planner").cwd, "claude")).defaultMode,
    "general",
  );
});

test("changing executor model does not carry the old model's saved thinking into the new one", async (t) => {
  const f = await fixture(t, undefined, "federated");
  await f.engine.configure({
    ...(await f.engine.settings()),
    executorModel: "codex/old",
    executorThinking: "xhigh",
  });
  await f.engine.ended(
    "planner",
    "changed-model",
    decision("plan").replace('"status":', '"executorModel":"codex/new","status":'),
    null,
    "goal",
  );
  assert.equal(f.created[0].config.provider, "codex/new");
  assert.equal(f.created[0].config.thinkingOptionId, undefined);
});

for (const planner of ["claude", "codex"]) {
  test(`${planner} remembers executor model and thinking as the offered default without disabling the question`, async (t) => {
    const f = await fixture(t, undefined, "federated", true, planner);
    const executor = planner === "claude" ? "codex" : "claude";
    const report = decision("plan").replace(
      '"status":',
      `"executorModel":"${executor}/chosen","executorThinking":"high","status":`,
    );
    await f.engine.ended("planner", "selected", report, null, "goal");
    const cwd = f.agents.get("planner").cwd;
    const settings = await f.engine.startSettings(cwd, planner);
    assert.equal(settings.askMode, true);
    assert.equal(settings.askExecutorModel, true);
    assert.equal(
      settings[executor === "codex" ? "executorModel" : "claudeExecutorModel"],
      `${executor}/chosen`,
    );
    assert.equal(
      settings[executor === "codex" ? "executorThinking" : "claudeExecutorThinking"],
      "high",
    );
    assert.equal((await f.engine.startSettings(cwd, executor)).askExecutorModel, true);
    assert.equal((await f.engine.settings()).executorModel, "codex");
  });
}

test("unchanged code, instruction and result trigger one reassessment, then require new input", async (t) => {
  const probe = {
    snapshot: async () => ({ head: "same", dirty: [] }),
    changes: async () => "unchanged",
  };
  const f = await fixture(t, undefined, "federated", true, "claude", probe);
  await f.finish("planner", "p0", "plan");
  const executor = f.created[0].id;
  for (let i = 1; i <= 3; i++) {
    await f.finish(executor, `e${i}`, "result");
    await f.finish("planner", `p${i}`, "plan");
  }
  assert.equal(f.sent.at(-1).id, "planner");
  assert.match(f.sent.at(-1).prompt, /원인과 기존 검증 증거를 재검토/);
  await f.finish("planner", "p4", "plan");
  assert.equal((await f.view()).status, "needs_input");
  assert.equal((await stored(f)).asker, "plan");
  f.agents.get("planner").status = "idle";
  await f.engine.control(f.id, "resume", "새로운 재현 조건으로 확인해");
  assert.equal((await stored(f)).repeatedPlans, 0);
});

test("new repository evidence prevents the repetition guard from interrupting progress", async (t) => {
  let revision = 0;
  const probe = {
    snapshot: async () => ({ head: "same", dirty: [`file.ts:${revision++}`] }),
    changes: async () => "changed",
  };
  const f = await fixture(t, undefined, "federated", true, "claude", probe);
  await f.finish("planner", "p0", "plan");
  const executor = f.created[0].id;
  for (let i = 1; i <= 3; i++) {
    await f.finish(executor, `e${i}`, "result");
    await f.finish("planner", `p${i}`, "plan");
  }
  assert.equal(f.sent.at(-1).id, executor);
  assert.equal((await stored(f)).repeatedPlans, 0);
});

for (const role of ["execute", "plan"]) {
  for (const status of ["closed", "error"]) {
    test(`resume ${status} ${role} with queued work ${status === "closed" ? "delivers once" : "keeps the existing error"}`, async (t) => {
      const f = await fixture(t);
      occupyNewExecutor(f);
      await f.finish("planner", "p1", "plan");
      const executor = f.created[0].id;
      const target = role === "execute" ? executor : "planner";
      if (role === "plan") {
        f.agents.get(executor).status = "idle";
        await f.engine.tick();
        f.agents.get("planner").status = "running";
        await f.finish(executor, "e1", "result");
      }
      const queued = (await stored(f)).pending;
      assert.equal(queued.role, role);
      assert.equal(queued.stage, "queued");
      await f.engine.control(f.id, "pause");
      f.agents.get(target).status = status;
      const sentBefore = f.sent.length;
      await f.engine.control(f.id, "resume");
      const w = await stored(f);
      assert.equal(w.pending.id, queued.id);
      if (status === "closed") {
        assert.equal(w.status, "active");
        assert.equal(w.pending.stage, "sent");
        assert.equal(f.sent.length, sentBefore + 1);
        assert.equal(f.sent.at(-1).id, target);
        assert.equal(f.sent.at(-1).messageId, queued.id);
        await f.engine.tick();
        assert.equal(f.sent.length, sentBefore + 1);
        assert.equal((await f.view()).status, "active");
      } else {
        assert.equal(w.status, "error");
        assert.equal(w.pending.stage, "queued");
        assert.equal(w.detail, "담당 대화에 오류가 있습니다. 대화를 확인한 뒤 재개하세요.");
        assert.equal(f.sent.length, sentBefore);
      }
    });
  }
}

test("an instruction the executor never received survives the planner's side turns", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e));
  occupyNewExecutor(f);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  assert.equal(f.sent.length, 0);
  assert.equal((await stored(f)).pending.stage, "queued");

  await f.engine.ended("planner", "ask", decision("input", "기다릴까요?"), null);
  let w = await stored(f);
  assert.equal(w.status, "needs_input");
  assert.equal(w.pending, null);
  assert.equal(w.held.prompt, "next task", "the instruction is parked, not dropped");
  assert.equal(w.asker, "plan");
  assert.match(w.detail, /기다릴까요\?.*보류/);
  assert.equal(w.lastInstruction, "next task");

  await f.engine.ended("planner", "chat", "그럼 기다리겠습니다.", null);
  w = await stored(f);
  assert.equal(w.status, "needs_input", "a reply without a block must not release the instruction");
  assert.equal(w.held.stage, "queued");
  assert.equal(f.sent.length, 0);

  // A resume without an answer does not release it: the question is still open.
  f.agents.get(executor).status = "idle";
  await assert.rejects(f.engine.control(f.id, "resume"), /답변을 기다리는 질문/);
  await f.engine.tick();
  assert.equal(f.sent.length, 0);
  await userTurn(f, "planner", "go", decision("continue", "대기 중인 계획대로 진행"));
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, executor);
  assert.match(f.sent[0].prompt, /이번 지시:\nnext task/);
  assert.equal((await f.view()).cycles, 1);
  assert.equal((await f.view()).turns, 1);
});

test("a reissued plan replaces the undelivered one without counting another cycle", async (t) => {
  const f = await fixture(t);
  occupyNewExecutor(f);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  await f.engine.ended("planner", "p1b", decision("plan", "revised task"), null);
  assert.equal((await f.view()).cycles, 1);
  assert.equal(f.created.length, 1);
  f.agents.get(executor).status = "idle";
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].prompt, /이번 지시:\nrevised task/);
  // A delivered plan followed by a new one is a real second cycle.
  await f.finish(executor, "e1", "result");
  await f.finish("planner", "p2", "plan");
  assert.equal((await f.view()).cycles, 2);
});

test("side turns beside running work neither stop the flow nor notify", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e));
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  await f.engine.ended("planner", "chat", "진행 상황을 설명드리면…", null);
  await f.engine.ended("planner", "stopped", "", "interrupted", "", false, "", true);
  assert.equal((await f.view()).status, "active");
  assert.equal((await stored(f)).pending.stage, "sent");
  await f.finish(executor, "e1", "result");
  assert.equal(f.sent.at(-1).id, "planner");
  assert.equal((await f.view()).phase, "review");
  await f.engine.tick();
  assert.deepEqual(events, []);
});

test("a planner cannot finish on a result it has not been shown", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  // The user is talking to the planner when the result arrives, so the review waits.
  f.agents.get("planner").status = "running";
  f.agents.get(executor).status = "idle";
  await f.engine.ended(executor, "e1", decision("result"), null);
  assert.equal(f.sent.length, 1);
  await f.finish("planner", "premature", "complete");
  assert.equal((await f.view()).status, "active");
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].id, "planner");
  assert.match(f.sent[1].prompt, /구현 결과를 검토하세요/);
  await f.finish("planner", "reviewed", "complete");
  assert.equal((await f.view()).status, "completed");
});

test("writers in one folder queue behind the named flow without rewriting state", async (t) => {
  const f = await fixture(t);
  f.agents.set("planner2", {
    ...f.agents.get("planner"),
    id: "planner2",
    workspaceId: "second",
    title: "second task",
  });
  const second = await f.engine.enroll(f.agents.get("planner2"), { provider: "claude" });
  await f.finish("planner", "p1", "plan");
  await f.finish("planner2", "q1", "plan");
  assert.equal(f.sent.length, 1);
  const waiting = (await f.engine.list()).workflows.find((w) => w.id === second);
  assert.match(waiting.detail, /#1 task/);
  await f.engine.tick();
  const before = await readFile(f.file, "utf8");
  assert.match(before, /#1 task/);
  await f.engine.tick();
  await f.engine.tick();
  assert.equal(await readFile(f.file, "utf8"), before);
  await f.finish(f.created[0].id, "e1", "result");
  await f.engine.tick();
  assert.deepEqual(
    f.sent.map((message) => message.id),
    [f.created[0].id, "planner", f.created[1].id],
  );
});

test("a missing block is requested once per stretch before the flow stops", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e));
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  f.agents.get(executor).status = "idle";
  await f.engine.ended(executor, "e1", "구현을 마쳤습니다.", null);
  assert.equal((await f.view()).status, "active");
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].id, executor);
  assert.match(f.sent[1].prompt, /상태 블록만 출력하세요/);
  assert.deepEqual(events, []);
  // The repaired answer carries on as if the block had been there.
  await f.finish(executor, "e1-block", "result");
  assert.equal(f.sent[2].id, "planner");
  f.agents.get("planner").status = "idle";
  await f.engine.ended("planner", "r1", "검토했습니다.", null);
  assert.equal(f.sent[3].id, "planner");
  f.agents.get("planner").status = "idle";
  await f.engine.ended("planner", "r2", "여전히 블록이 없습니다.", null);
  assert.equal((await f.view()).status, "needs_input");
  assert.equal(f.sent.length, 4);
  await f.engine.tick();
  assert.deepEqual(
    events.map((e) => e.kind),
    ["stopped"],
  );
  // What the user types next is theirs to fix, so no request follows it.
  await f.engine.ended("planner", "r3", "다시 설명합니다.", null, "", false, "왜 멈췄어?");
  assert.equal(f.sent.length, 4);
  assert.equal((await f.view()).status, "needs_input");
  // A bare resume still has to move the flow, and the next delivered instruction is asked again.
  await f.engine.control(f.id, "resume");
  assert.equal(f.sent.length, 5);
  assert.equal(f.sent[4].id, "planner");
  assert.match(f.sent[4].prompt, /중단된 지점부터 이어서/);
  f.agents.get("planner").status = "idle";
  await f.engine.ended("planner", "r4", "또 블록이 없습니다.", null);
  assert.equal(f.sent.length, 6);
  assert.match(f.sent[5].prompt, /상태 블록만 출력하세요/);
  assert.equal((await f.view()).status, "active");
});

test("a stopped turn waits for the user and either a reply or a bare resume continues", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  f.agents.get(executor).status = "idle";
  await f.engine.ended(executor, "cut", "", "interrupted", "", false, "", true);
  let w = await stored(f);
  assert.equal(w.status, "needs_input");
  assert.equal(w.inbox, null);
  assert.equal(w.pending, null, "the stopped instruction is over");
  await f.engine.control(f.id, "resume");
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].id, executor);
  assert.match(f.sent[1].prompt, /중단된 지점부터 이어서/);

  const g = await fixture(t);
  await g.finish("planner", "p1", "plan");
  const other = g.created[0].id;
  g.agents.get(other).status = "idle";
  await g.engine.ended(other, "cut", "", "interrupted", "", false, "", true);
  await g.finish(other, "direct", "result");
  assert.equal((await g.view()).status, "active");
  assert.equal(g.sent.at(-1).id, "planner");
  // A provider failure still pauses until the user looks.
  const h = await fixture(t);
  await h.engine.ended("planner", "boom", "", "rate limited");
  assert.equal((await h.view()).status, "paused");
});

test("only a plan federates, and a general conversation needs the user to name the mode", async (t) => {
  const f = await fixture(t, undefined, "undecided");
  for (const status of ["input", "continue", "complete"]) await f.finish("planner", status, status);
  assert.equal((await f.view()).mode, "undecided");
  assert.equal(f.sent.length, 0);

  const g = await fixture(t, undefined, "general");
  const turn = (key, request, text) =>
    g.engine.ended("planner", key, text, null, "goal", false, request);
  await turn("1", "이 계획대로 해줘", decision("plan"));
  assert.equal((await g.view()).mode, "general");
  // Delivered messages are never the user's words.
  await turn("2", "작업 ID: x\n연합개발", decision("plan"));
  assert.equal((await g.view()).mode, "general");
  await turn("3", "연합개발로 바꿔줘", "실행 모델을 고르는 중입니다.");
  assert.equal((await g.view()).mode, "general");
  assert.equal((await stored(g)).wantsFederation, true);
  await turn("4", "GPT-6-Sol", decision("plan"));
  assert.equal((await g.view()).mode, "federated");
  assert.equal(g.created.length, 1);
  assert.equal((await stored(g)).wantsFederation, false);

  const h = await fixture(t, undefined, "general");
  await h.engine.ended("planner", "1", "네", null, "goal", false, "연합개발로 할까 고민 중");
  await h.engine.ended(
    "planner",
    "2",
    decision("plan"),
    null,
    "goal",
    false,
    "아니 일반개발로 계속",
  );
  assert.equal((await h.view()).mode, "general");
  assert.equal(h.created.length, 0);
});

test("a mode answer switches a general conversation and returns a lone planner to general", async (t) => {
  const f = await fixture(t, undefined, "general", false);
  await f.engine.ended("planner", "first", "제목: 전환 작업\n작업상태: 진행", null);
  await f.engine.permission("planner", modeRequest("switch"));
  await f.engine.permissionResolved("planner", "switch", modeAnswer("연합개발"));
  assert.equal((await f.view()).mode, "federated");
  assert.equal(f.renamed.at(-1).title, "🟠 C[project]-01 전환 작업");

  await f.engine.ended("planner", "no-block", "직접 하겠습니다.", null);
  await f.engine.permission("planner", modeRequest("back"));
  await f.engine.permissionResolved("planner", "back", modeAnswer("일반개발"));
  let w = await stored(f);
  assert.equal(w.mode, "general");
  assert.equal(w.pending, null);
  assert.equal(w.status, "active");
  assert.equal(f.renamed.at(-1).title, "🟠 C[project]-01 전환 작업");

  await f.engine.permission("planner", modeRequest("again"));
  await f.engine.permissionResolved("planner", "again", modeAnswer("연합개발"));
  await f.finish("planner", "p1", "plan");
  await f.engine.permission("planner", modeRequest("late"));
  await f.engine.permissionResolved("planner", "late", modeAnswer("일반개발"));
  w = await stored(f);
  assert.equal(w.mode, "federated", "running work finishes before the mode changes");
  assert.equal(w.generalTransition, true);
  assert.equal(f.created.length, 1);
});

test("the dashboard can return a planner without an executor to general mode", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e), "federated", false);
  await f.engine.ended("planner", "t", "제목: 혼자 한 작업\n" + decision("continue"), null);
  f.agents.get("planner").status = "idle";
  await f.engine.ended("planner", "plain", "직접 끝냈습니다.", null);
  await f.engine.control(f.id, "general");
  const w = await stored(f);
  assert.equal(w.mode, "general");
  assert.equal(w.inbox, null);
  assert.equal(w.pending, null);
  assert.equal(f.renamed.at(-1).title, "🟠 C[project]-01 혼자 한 작업");
  await assert.rejects(f.engine.control(f.id, "resume"), /연합개발이 시작되지 않은/);
  await f.engine.ended("planner", "later", "일반 응답", null);
  await f.engine.tick();
  assert.deepEqual(events, []);

  const g = await fixture(t);
  await g.finish("planner", "p1", "plan");
  await g.engine.control(g.id, "general");
  assert.equal((await stored(g)).generalTransition, true);
});

test("review carries git evidence and an unpushed claim stays green", async (t) => {
  const calls = [];
  let pushed = false;
  const probe = {
    repository: async (cwd) => path.resolve(cwd),
    pushedTarget: async () => pushed,
    snapshot: async (cwd) => (calls.push(["snapshot", cwd]), { head: "abc", dirty: [" M a.ts"] }),
    changes: async (cwd, baseline) => (
      calls.push(["changes", cwd, baseline.head]), "git 증거 본문"
    ),
    pushed: async () => pushed,
  };
  const f = await fixture(t, undefined, "federated", false, "claude", probe);
  await f.engine.ended("planner", "p1", "제목: 증거 작업\n" + decision("plan"), null);
  const executor = f.created[0].id;
  const cwd = f.agents.get("planner").cwd;
  assert.deepEqual(calls, [["snapshot", cwd]]);
  f.agents.get(executor).status = "idle";
  await f.engine.ended(executor, "more", decision("continue", "남은 부분"), null);
  assert.equal(calls.length, 1, "the baseline belongs to the plan, not to each delivery");
  await f.finish(executor, "e1", "result");
  assert.deepEqual(calls.at(-1), ["changes", cwd, "abc"]);
  assert.match(f.sent.at(-1).prompt, /구현 결과를 검토하세요[\s\S]*git 증거 본문/);

  await f.finish("planner", "done", "complete");
  f.agents.get(executor).status = "idle";
  await f.engine.ended(executor, "claim", "푸시했습니다\n작업상태: 푸시", null);
  assert.match(f.renamed.at(-1).title, /^🟢 /);
  await f.engine.ended(executor, "typed", "네", null, "", false, "작업상태: 푸시");
  assert.match(f.renamed.at(-1).title, /^🟢 /);

  pushed = true;
  const g = await fixture(t, undefined, "general", false, "claude", probe);
  await finishPush(g.engine, "planner", "1", "제목: 푸시 확인\n작업상태: 푸시");
  assert.match(g.renamed.at(-1).title, /^🔵 /);
  const h = await fixture(t, undefined, "general", false, "claude", {
    ...probe,
    pushed: async () => null,
    pushedTarget: async () => null,
  });
  await finishPush(h.engine, "planner", "1", "제목: 저장소 아님\n작업상태: 푸시");
  assert.match(
    h.renamed.at(-1).title,
    /^🟢 /,
    "unknown push evidence must not mark the task pushed",
  );
});

test("loading trims planner configuration and files a lone executor under general", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await stored(f)).plan.config, { provider: "claude" });
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  const w = db.workflows[0];
  delete db.revision;
  for (const key of ["lastInstruction", "wantsFederation", "asker", "held", "repairs", "baseline"])
    delete w[key];
  w.plan.config = { provider: "codex/m", modeId: "auto", systemPrompt: "x".repeat(4000) };
  db.workflows.push({ ...structuredClone(w), id: "lone", execute: w.plan, plan: null });
  db.workflows[1].execute = { ...w.plan, id: "lone-agent", workspaceId: "lone-workspace" };
  await writeFile(f.file, JSON.stringify(db));
  f.agents.set("lone-agent", {
    ...f.agents.get("planner"),
    id: "lone-agent",
    workspaceId: "lone-workspace",
  });
  const engine = new WorkflowEngine(f.file, f.port);
  t.after(() => engine.close());
  const views = (await engine.list()).workflows;
  assert.deepEqual(
    views.map((view) => view.mode),
    ["federated", "general"],
  );
  assert.equal(views[0].number, 1);
  await engine.ended("lone-agent", "block", decision("plan"), null, "", false, "연합개발");
  assert.equal((await engine.list()).workflows[1].mode, "general");
  // Records of lone executors were never cleaned up and still are not.
  f.agents.get("lone-agent").archived = true;
  await engine.archived("lone-agent");
  await engine.tick();
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(saved.workflows.length, 2);
  assert.equal(saved.revision, 3);
  // Only the mode moves, so the earlier version still ignores this flow after a rollback.
  assert.equal(saved.workflows[1].status, db.workflows[1].status);
  assert.deepEqual(saved.workflows[1].pending, db.workflows[1].pending);
  assert.deepEqual(saved.workflows[0].plan.config, { provider: "codex/m", modeId: "auto" });
  assert.equal(saved.workflows[0].lastInstruction, "");
});

test("delivered context states the mode and role and no longer lists unused ids", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  assert.match(
    f.sent[0].prompt,
    /^작업 ID: .+\n진행 방식: 연합개발 · 이 대화의 역할: 구현·검증 담당\n/,
  );
  await f.finish(f.created[0].id, "e1", "result");
  assert.match(f.sent[1].prompt, /이 대화의 역할: 계획·검토 담당/);
  for (const message of f.sent) assert.doesNotMatch(message.prompt, /이전 대화 ID/);
  for (let i = 0; i < 230; i++) await f.engine.ended("planner", `chat-${i}`, "잡담", null);
  assert.ok((await stored(f)).processed.length <= 200);
});

/** A turn the user started; delivered instructions begin with the flow id instead. */
const userTurn = (f, agentId, key, text, failed = null, canceled = false) =>
  f.engine.ended(agentId, key, text, failed, "", false, "옆에서 묻는 사용자 메시지", canceled);

test("a planner repeating its plan beside running work never sends the instruction twice", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  await userTurn(f, "planner", "side", decision("plan"));
  await userTurn(f, "planner", "side-new", decision("plan", "a plan made without the result"));
  assert.equal((await f.view()).cycles, 1);
  assert.equal((await stored(f)).pending.stage, "sent");
  await f.finish(executor, "e1", "result");
  assert.deepEqual(
    f.sent.map((message) => message.id),
    [executor, "planner"],
  );
  assert.equal((await f.view()).phase, "review");
});

test("an executor repeating its result beside a running review does not drop the verdict", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  await f.finish(executor, "e1", "result");
  f.agents.get(executor).status = "idle";
  await userTurn(f, executor, "side", decision("result"));
  assert.equal(f.sent.length, 2, "no second review");
  await f.engine.ended("planner", "verdict", decision("plan", "fix Y"), null);
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2].id, executor);
  assert.match(f.sent[2].prompt, /이번 지시:\nfix Y/);
});

test("a result that arrives while paused survives side turns and is reviewed on resume", async (t) => {
  for (const side of [
    (f) => userTurn(f, "planner", "side", "블록 없는 답"),
    (f) => userTurn(f, "planner", "side", "", "interrupted", true),
    (f) => userTurn(f, "planner", "side", decision("input", "질문")),
  ]) {
    const f = await fixture(t);
    await f.finish("planner", "p1", "plan");
    const executor = f.created[0].id;
    await f.engine.control(f.id, "pause");
    await f.finish(executor, "e1", "result");
    await side(f);
    await f.engine.control(f.id, "resume");
    assert.equal((await f.view()).status, "active");
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1].id, "planner");
    assert.match(f.sent[1].prompt, /구현 결과를 검토하세요/);
  }
  // The addressee's own newer decision replaces its unread answer and still ends the instruction.
  const g = await fixture(t);
  await g.finish("planner", "p1", "plan");
  const executor = g.created[0].id;
  await g.engine.control(g.id, "pause");
  await g.finish(executor, "e1", "result");
  await userTurn(g, executor, "e1b", decision("continue", "남은 일"));
  await g.engine.control(g.id, "resume");
  assert.equal(g.sent.at(-1).id, executor);
  assert.match(g.sent.at(-1).prompt, /이번 지시:\n남은 일/);
});

test("a resume always leaves something queued, running or asked", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  f.agents.get(executor).status = "idle";
  await f.engine.ended(executor, "e1", "블록 없음", null);
  f.agents.get(executor).status = "idle";
  await f.engine.ended(executor, "e2", "또 블록 없음", null);
  assert.equal((await f.view()).status, "needs_input");
  assert.equal((await stored(f)).pending, null);
  await userTurn(f, "planner", "side", "계획 담당의 블록 없는 답");
  assert.equal((await f.view()).status, "needs_input");
  const before = f.sent.length;
  await f.engine.control(f.id, "resume");
  assert.equal(f.sent.length, before + 1);
  assert.equal(f.sent.at(-1).id, executor);
  assert.match(f.sent.at(-1).prompt, /중단된 지점부터 이어서/);

  // A flow that never started has nothing to continue.
  const g = await fixture(t);
  await g.engine.control(g.id, "pause");
  await g.engine.control(g.id, "resume");
  assert.equal(g.sent.length, 0);
});

test("an open question is not answered by a bare resume or by another conversation", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  f.agents.get(executor).status = "idle";
  await f.engine.ended(
    executor,
    "ask",
    decision("input", "DB 마이그레이션을 실행해도 됩니까?"),
    null,
  );
  f.agents.get("planner").status = "idle";
  await userTurn(f, "planner", "cut", "", "interrupted", true);
  await userTurn(f, "planner", "chat", "잘 모르겠네요.");
  let w = await stored(f);
  assert.equal(w.status, "needs_input");
  assert.match(w.detail, /DB 마이그레이션/);
  const snapshot = await readFile(f.file, "utf8");
  await assert.rejects(f.engine.control(f.id, "resume"), /답변을 기다리는 질문/);
  assert.equal((await f.view()).status, "needs_input", "a refused resume changes nothing");
  await f.engine.tick();
  assert.equal(await readFile(f.file, "utf8"), snapshot);
  assert.equal(f.sent.length, 1);
  await f.engine.control(f.id, "resume", "실행하세요");
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].id, executor);
  assert.match(f.sent[1].prompt, /사용자의 추가 지시\/답변:\n실행하세요/);

  // The planner asked; the executor chatting on the side does not get a turn out of it.
  const g = await fixture(t);
  await g.finish("planner", "p1", "plan");
  const other = g.created[0].id;
  await g.finish(other, "e1", "result");
  g.agents.get("planner").status = "idle";
  await g.engine.ended("planner", "ask", decision("input", "A안과 B안 중 무엇입니까?"), null);
  g.agents.get(other).status = "idle";
  await userTurn(g, other, "side", "블록 없는 설명");
  await userTurn(g, other, "side2", decision("result"));
  assert.equal((await g.view()).status, "needs_input");
  assert.equal(g.sent.length, 2);
  await userTurn(g, "planner", "answered", decision("plan", "A안으로 구현"));
  assert.equal(g.sent.at(-1).id, other);
  assert.match(g.sent.at(-1).prompt, /A안으로 구현/);

  // The executor was stopped, then the planner asked: the dashboard answer is the planner's.
  const h = await fixture(t);
  await h.finish("planner", "p1", "plan");
  const stoppedExecutor = h.created[0].id;
  h.agents.get(stoppedExecutor).status = "idle";
  await h.engine.ended(stoppedExecutor, "cut", "", "interrupted", "", false, "", true);
  await userTurn(h, "planner", "ask", decision("input", "A안과 B안 중 무엇으로 할까요?"));
  assert.equal((await stored(h)).asker, "plan");
  await h.engine.control(h.id, "resume", "A안");
  assert.equal(h.sent.at(-1).id, "planner");
  assert.match(h.sent.at(-1).prompt, /사용자의 추가 지시\/답변:\nA안/);
  assert.match((await h.view()).detail, /계획 담당이 답변을 처리/);
});

test("an answer to the planner's question goes to the planner while the instruction stays parked", async (t) => {
  const ask = async (f) => {
    occupyNewExecutor(f);
    await f.finish("planner", "p1", "plan");
    await userTurn(f, "planner", "ask", decision("input", "이 계획대로 할까요, 범위를 줄일까요?"));
    f.agents.get(f.created[0].id).status = "idle";
    return f.created[0].id;
  };
  const f = await fixture(t);
  const executor = await ask(f);
  await f.engine.control(f.id, "resume", "범위를 줄여서 다시 세워주세요");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, "planner", "the answer reaches whoever asked");
  assert.match(f.sent[0].prompt, /사용자의 추가 지시\/답변:\n범위를 줄여서/);
  assert.equal((await stored(f)).held.prompt, "next task");
  await f.engine.tick();
  assert.equal(f.sent.length, 1, "the executor does not start on the plan in question");
  // The planner's new plan takes the parked one's place without counting another cycle.
  await f.engine.ended("planner", "replan", decision("plan", "줄인 계획"), null);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].id, executor);
  assert.match(f.sent[1].prompt, /이번 지시:\n줄인 계획$/);
  assert.equal((await f.view()).cycles, 1);
  assert.equal((await stored(f)).held, null);

  // Telling the planner to go on, on the dashboard or in its conversation, releases it as it was.
  for (const release of [
    async (g) => {
      await g.engine.control(g.id, "resume", "그대로 진행하세요");
      await g.engine.ended("planner", "go", decision("continue", "대기 중인 계획대로 진행"), null);
    },
    (g) => userTurn(g, "planner", "go", decision("continue", "대기 중인 계획대로 진행")),
    (g) => userTurn(g, "planner", "same", decision("plan")),
  ]) {
    const g = await fixture(t);
    const other = await ask(g);
    await release(g);
    await g.engine.tick();
    assert.equal(g.sent.at(-1).id, other);
    assert.match(g.sent.at(-1).prompt, /이번 지시:\nnext task$/);
    assert.equal((await g.view()).cycles, 1);
    assert.equal((await stored(g)).asker, null);
  }
  // The executor is not given the floor while its instruction is parked.
  const h = await fixture(t);
  const idle = await ask(h);
  await userTurn(h, idle, "chat", decision("result"));
  assert.equal((await h.view()).status, "needs_input");
  assert.equal(h.sent.length, 0);
});

test("a note added while pausing rides with the instruction that has not gone out", async (t) => {
  const f = await fixture(t);
  occupyNewExecutor(f);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  await f.engine.control(f.id, "pause");
  await f.engine.control(f.id, "resume", "테스트도 함께 고쳐주세요");
  f.agents.get(executor).status = "idle";
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, executor);
  assert.match(
    f.sent[0].prompt,
    /이번 지시:\nnext task\n\n사용자의 추가 지시\/답변:\n테스트도 함께/,
  );
});

test("a review waiting behind the user's chat goes out next whatever that chat decided", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  f.agents.get("planner").status = "running";
  f.agents.get(executor).status = "idle";
  await f.engine.ended(executor, "e1", decision("result"), null);
  f.agents.get("planner").status = "idle";
  await userTurn(f, "planner", "chat", decision("input", "곁대화의 질문"));
  assert.equal((await f.view()).status, "active");
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].prompt, /구현 결과를 검토하세요/);
  await f.finish("planner", "verdict", "plan");
  assert.equal(f.sent[2].id, executor);
  assert.equal((await f.view()).cycles, 2);
});

test("a request for federation counts even when its turn failed", async (t) => {
  const f = await fixture(t, undefined, "general");
  await f.engine.ended("planner", "1", "", "rate limited", "goal", false, "연합개발로 진행해줘");
  await f.engine.ended("planner", "2", decision("plan"), null, "goal", false, "계속해줘");
  assert.equal((await f.view()).mode, "federated");
  assert.equal(f.created.length, 1);
});

test("a permission wait and a writer wait do not rewrite each other every tick", async (t) => {
  const f = await fixture(t);
  f.agents.set("planner2", {
    ...f.agents.get("planner"),
    id: "planner2",
    workspaceId: "second",
    title: "second task",
  });
  await f.engine.enroll(f.agents.get("planner2"), { provider: "claude" });
  await f.finish("planner", "p1", "plan");
  await f.finish("planner2", "q1", "plan");
  f.agents.get("planner2").permission = true;
  await f.engine.tick();
  await f.engine.tick();
  const before = await readFile(f.file, "utf8");
  await f.engine.tick();
  await f.engine.tick();
  assert.equal(await readFile(f.file, "utf8"), before);
});

test("flows stored before the new flags load as waiting questions and unread answers", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  await f.engine.control(f.id, "pause");
  f.agents.get(executor).status = "idle";
  await f.engine.ended(executor, "cut", "", "interrupted");
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  delete db.revision;
  const paused = db.workflows[0];
  assert.equal(paused.inbox.failed, "interrupted");
  delete paused.inbox.answers;
  delete paused.asker;
  const asked = structuredClone(paused);
  Object.assign(asked, { id: "asked", status: "needs_input", inbox: null, pending: null });
  asked.plan = { ...paused.plan, id: "asked-planner" };
  asked.execute = { ...paused.execute, id: "asked-executor" };
  db.workflows.push(asked);
  await writeFile(f.file, JSON.stringify(db));
  for (const id of ["asked-planner", "asked-executor"])
    f.agents.set(id, { ...f.agents.get("planner"), id, workspaceId: `workspace-${id}` });
  const engine = new WorkflowEngine(f.file, f.port);
  t.after(() => engine.close());
  await assert.rejects(engine.control("asked", "resume"), /답변을 기다리는 질문/);
  // The old interrupted turn no longer pauses the flow again; a bare resume carries on.
  const before = f.sent.length;
  await engine.control(f.id, "resume");
  assert.equal((await engine.list()).workflows[0].status, "active");
  assert.equal(f.sent.length, before + 1);
  assert.equal(f.sent.at(-1).id, executor);
  assert.match(f.sent.at(-1).prompt, /중단된 지점부터 이어서/);
});

test("a side turn during a wait does not announce the stop a second time", async (t) => {
  const events = [];
  const f = await fixture(t, async (e) => events.push(e));
  await f.finish("planner", "p1", "plan");
  await f.finish(f.created[0].id, "ask", "input");
  await f.engine.tick();
  await userTurn(f, "planner", "side", "블록 없는 답");
  await userTurn(f, "planner", "cut", "", "interrupted", true);
  await f.engine.tick();
  assert.equal((await f.view()).status, "needs_input");
  assert.deepEqual(
    events.map((e) => e.kind),
    ["stopped"],
  );
});

test("an instruction whose turn already ended and was seen is over, on resume and on a tick", async (t) => {
  // As stored by earlier versions: the executor's stopped turn was displaced by a planner turn
  // while paused, leaving a sent instruction that nothing will ever answer.
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  f.agents.get(executor).status = "idle";
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  const w = db.workflows[0];
  delete db.revision;
  w.status = "paused";
  w.processed.push("cut");
  w.inbox = { agentId: "planner", key: "after", text: decision("plan", "새 계획"), failed: null };
  await writeFile(f.file, JSON.stringify(db));
  f.histories.set(executor, { text: "", key: "cut", messageIds: [w.pending.id], failed: null });
  const engine = new WorkflowEngine(f.file, f.port);
  t.after(() => engine.close());
  await engine.control(f.id, "resume");
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].id, executor);
  assert.match(f.sent[1].prompt, /이번 지시:\n새 계획/);
  assert.equal((await engine.list()).workflows[0].status, "active");

  // The same state reached while active is stopped visibly instead of idling.
  const events = [];
  const g = await fixture(t, async (e) => events.push(e));
  await g.finish("planner", "p1", "plan");
  const other = g.created[0].id;
  g.agents.get(other).status = "idle";
  const state = await stored(g);
  g.histories.set(other, { text: "끝", key: "seen", messageIds: [state.pending.id], failed: null });
  await g.engine.ended("planner", "seen", "곁대화", null, "", false, "사용자 메시지");
  assert.equal((await g.view()).status, "active");
  await g.engine.tick();
  const stopped = await stored(g);
  assert.equal(stopped.status, "needs_input");
  assert.equal(stopped.pending, null);
  assert.match(stopped.detail, /응답이 이미 끝나/);
  await g.engine.tick();
  assert.deepEqual(
    events.map((e) => e.kind),
    ["stopped"],
  );
  // A turn that has only just been delivered is not mistaken for one that ended.
  const h = await fixture(t);
  await h.finish("planner", "p1", "plan");
  const fresh = h.created[0].id;
  h.agents.get(fresh).status = "idle";
  h.histories.set(fresh, {
    text: "",
    key: "not-seen",
    messageIds: [(await stored(h)).pending.id],
    failed: null,
  });
  await h.engine.tick();
  assert.equal((await h.view()).status, "active");
  assert.equal((await stored(h)).pending.stage, "sent");
});

test("a delivered turn the user steered still answers its instruction", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  f.agents.get(executor).status = "idle";
  // The user's message was folded into the running turn, so it is that turn's last request.
  await userTurn(f, executor, "steered", decision("result"));
  assert.equal(f.sent.at(-1).id, "planner");
  assert.equal((await f.view()).phase, "review");
  assert.equal((await stored(f)).pending.stage, "sent");
});

test("a turn that ended before the delivery, or never received it, is not the answer", async (t) => {
  // The review is delivered a moment after the planner's own turn ended; that turn's record
  // of messages does not contain the delivery.
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  await f.finish(executor, "e1", "result");
  const review = (await stored(f)).pending.id;
  f.agents.get("planner").status = "idle";
  await f.engine.ended(
    "planner",
    "stale",
    decision("complete"),
    null,
    "",
    false,
    "사용자 질문",
    false,
    ["users-own-message"],
  );
  assert.equal((await f.view()).status, "active", "the review is still running");
  assert.equal((await stored(f)).pending.id, review);
  await f.engine.ended(
    "planner",
    "real",
    decision("complete"),
    null,
    "",
    false,
    "사용자 질문",
    false,
    ["users-own-message", review],
  );
  assert.equal(
    (await f.view()).status,
    "completed",
    "a steered turn that carries the delivery answers it",
  );

  // A send that failed before delivery leaves the instruction for the retry.
  const g = await fixture(t);
  const send = g.port.send;
  g.port.send = async () => {
    throw new Error("offline");
  };
  await g.finish("planner", "p1", "plan");
  assert.equal((await g.view()).status, "error");
  const other = g.created[0].id;
  await g.engine.ended(other, "chat", "블록 없는 잡담", null, "", false, "사용자 질문", false, [
    "u1",
  ]);
  const kept = await stored(g);
  assert.equal(kept.pending.prompt, "next task");
  assert.equal(kept.pending.stage, "sending");
  g.port.send = send;
  await g.engine.control(g.id, "resume");
  assert.equal(g.sent.length, 0, "nothing is sent until the delivery is settled");
  assert.match((await g.view()).detail, /전달 여부/);
  // The user's explicit retry sends it once the conversation shows it never arrived.
  assert.equal((await g.view()).deliveryUnconfirmed, true);
  await g.engine.control(g.id, "resend");
  assert.equal(g.sent.length, 1, "the undelivered instruction goes out on the user's retry");
  assert.equal((await stored(g)).pending.stage, "sent");
  assert.equal((await g.view()).deliveryUnconfirmed, false);
  await assert.rejects(g.engine.control(g.id, "resend"), /미확인 전달이 없습니다/);
});

test("releasing a parked instruction clears the question it was parked for", async (t) => {
  const f = await fixture(t);
  occupyNewExecutor(f);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  await userTurn(f, "planner", "ask", decision("input", "진행할까요?"));
  f.agents.get(executor).status = "idle";
  await userTurn(f, "planner", "go", decision("continue", "그대로 진행"));
  assert.equal(f.sent.length, 1);
  f.agents.get(executor).status = "idle";
  await f.engine.ended(executor, "cut", "", "interrupted", "", false, "", true);
  assert.equal((await stored(f)).asker, null);
  await f.engine.control(f.id, "resume");
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].prompt, /중단된 지점부터 이어서/);

  // If the planner's reply to the answer cannot be read, a bare resume asks the planner
  // again instead of letting the parked instruction go.
  const g = await fixture(t);
  occupyNewExecutor(g);
  await g.finish("planner", "p1", "plan");
  await userTurn(g, "planner", "ask", decision("input", "진행할까요?"));
  g.agents.get(g.created[0].id).status = "idle";
  await g.engine.control(g.id, "resume", "범위를 줄이세요");
  g.agents.get("planner").status = "idle";
  await g.engine.ended("planner", "n1", "블록 없음", null);
  g.agents.get("planner").status = "idle";
  await g.engine.ended("planner", "n2", "또 블록 없음", null);
  assert.equal((await g.view()).status, "needs_input");
  assert.equal((await stored(g)).held.prompt, "next task");
  await g.engine.control(g.id, "resume");
  assert.ok(g.sent.every((message) => message.id === "planner"));
  assert.match(g.sent.at(-1).prompt, /중단된 지점부터 이어서/);
});

test("a stored question whose executor never worked is answered to the planner", async (t) => {
  // As left by the earlier version: the plan's instruction was lost and the planner's
  // question is the only thing the flow shows.
  const f = await fixture(t);
  occupyNewExecutor(f);
  await f.finish("planner", "p1", "plan");
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  delete db.revision;
  const w = db.workflows[0];
  Object.assign(w, { status: "needs_input", pending: null, inbox: null, detail: "기다릴까요?" });
  delete w.asker;
  delete w.held;
  await writeFile(f.file, JSON.stringify(db));
  const engine = new WorkflowEngine(f.file, f.port);
  t.after(() => engine.close());
  await assert.rejects(engine.control(f.id, "resume"), /답변을 기다리는 질문/);
  await engine.control(f.id, "resume", "계획을 다시 내 주세요");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, "planner");
});

/** Enrolls one more conversation, in the given project, on the fixture's engine. */
async function another(f, id, projectId, mode = "general") {
  f.agents.set(id, {
    ...f.agents.get("planner"),
    id,
    workspaceId: `ws-${id}`,
    projectId,
    title: id,
  });
  return f.engine.enroll(f.agents.get(id), { provider: "claude" }, {}, mode, false);
}

test("each project numbers its own work from one", async (t) => {
  const f = await fixture(t, undefined, "general", false, "claude", verifiedPushProbe);
  await another(f, "a2", "project");
  await another(f, "b1", "other");
  await another(f, "b2", "other");
  for (const id of ["planner", "a2", "b1", "b2"])
    await f.engine.ended(id, `first-${id}`, `제목: ${id} 작업\n작업상태: 진행`, null);
  assert.deepEqual(
    f.renamed.map((row) => row.title),
    [
      "🟠 C[project]-01 planner 작업",
      "🟠 C[project]-02 a2 작업",
      "🟠 C[other]-01 b1 작업",
      "🟠 C[other]-02 b2 작업",
    ],
  );
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  assert.deepEqual(saved.sequences, { project: 2, other: 2 });
  // The same number in two projects needs the project named.
  await assert.rejects(f.engine.setProgress(1, "done"), /여러 프로젝트에 있습니다/);
  assert.deepEqual(await f.engine.setProgress(1, "done", "other"), ["🟢 C[other]-01 b1 작업"]);
  assert.deepEqual(await f.engine.setProgress(2, "pushed", "project"), [
    "🟢 C[project]-02 [푸시 확인필요] a2 작업",
  ]);
  await assert.rejects(f.engine.setProgress(3, "done", "other"), /3번 작업/);
});

test("renumbering restarts every project at one in the order its work was created", async (t) => {
  const f = await fixture(t, undefined, "general", false);
  await another(f, "a2", "project");
  await another(f, "b1", "other", "federated");
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  // As numbered globally by the earlier version, interleaved across projects.
  delete db.sequences;
  delete db.revision;
  db.sequence = 59;
  [7, 41, 12].forEach((number, index) => (db.workflows[index].number = number));
  ["done", "active", "pushed"].forEach(
    (progress, index) => (db.workflows[index].progress = progress),
  );
  await writeFile(f.file, JSON.stringify(db));
  for (const [workspaceId, name] of [
    ["initial", "🟢 C[일반]-07 첫 작업"],
    ["ws-a2", "🟠 C[일반]-41 나중 작업"],
    ["ws-b1", "🔵 C[연합:계획]-12 다른 프로젝트"],
  ])
    f.renamed.push({ workspaceId, title: name });
  const engine = new WorkflowEngine(f.file, f.port);
  t.after(() => engine.close());
  // Until renumbered, a project continues from its own highest number.
  f.agents.set("a3", { ...f.agents.get("planner"), id: "a3", workspaceId: "ws-a3", title: "a3" });
  await engine.enroll(f.agents.get("a3"), { provider: "claude" }, {}, "general", true);
  assert.equal((await engine.list()).workflows.at(-1).number, 42);
  f.renamed.push({ workspaceId: "ws-a3", title: "🟠 C[일반]-42 새 작업" });

  const unmanaged = [
    {
      workspaceId: "old-plan",
      projectId: "project",
      provider: "claude",
      role: "plan",
      title: "🟢 C[연합:계획]-03 옛 짝",
    },
    {
      workspaceId: "old-exec",
      projectId: "project",
      provider: "codex",
      role: "execute",
      title: "🟢 G[연합:실행]-03 옛 짝",
    },
    {
      workspaceId: "old-b",
      projectId: "other",
      provider: "codex",
      role: null,
      title: "🟠 G[일반]-30 다른 단독",
    },
    {
      workspaceId: "initial",
      projectId: "project",
      provider: "claude",
      role: null,
      title: "흐름이 있으면 제외",
    },
  ];
  const before = f.renamed.length;
  const preview = await engine.retitle(false, unmanaged, true);
  assert.equal(f.renamed.length, before, "a preview renames nothing");
  const titles = Object.fromEntries(preview.map((row) => [row.workspaceId, row.title]));
  assert.deepEqual(titles, {
    "old-plan": "🟢 C[project:계획]-01 옛 짝",
    "old-exec": "🟢 G[project:실행]-01 옛 짝",
    initial: "🟢 C[project]-02 첫 작업",
    "ws-a2": "🟠 C[project]-03 나중 작업",
    "ws-a3": "🟠 C[project]-04 새 작업",
    "ws-b1": "🔵 C[other]-01 [PUSH] 다른 프로젝트",
    "old-b": "🟠 G[other]-02 다른 단독",
  });
  await engine.retitle(true, unmanaged, true);
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  assert.deepEqual(saved.sequences, { project: 4, other: 2 });
  assert.deepEqual(
    saved.workflows.map((w) => w.number),
    [2, 3, 1, 4],
  );
  // The next conversation takes the next number of its project.
  f.agents.set("b3", {
    ...f.agents.get("planner"),
    id: "b3",
    workspaceId: "ws-b3",
    projectId: "other",
  });
  await engine.enroll(f.agents.get("b3"), { provider: "claude" }, {}, "general", true);
  assert.equal((await engine.list()).workflows.at(-1).number, 3);
});

for (const limit of ["cycles", "turns"]) {
  test(`manual resume resets exhausted ${limit} and dispatches retained work`, async (t) => {
    const f = await fixture(t);
    await f.engine.control(f.id, "pause");
    await f.finish("planner", "limited-plan", "plan");
    await f.engine.close();
    const db = JSON.parse(await readFile(f.file, "utf8"));
    db.workflows[0][limit] = limit === "cycles" ? db.settings.maxCycles : db.settings.maxTurns;
    await writeFile(f.file, JSON.stringify(db));
    const engine = new WorkflowEngine(f.file, f.port);
    t.after(() => engine.close());
    const result = await engine.control(f.id, "resume");
    assert.equal(result.ok, true);
    assert.equal(result.status, "active");
    assert.match(result.detail, /실행/);
    const state = JSON.parse(await readFile(f.file, "utf8"));
    assert.equal(state.workflows[0].cycles, 1);
    assert.equal(state.workflows[0].turns, 1);
    assert.deepEqual(state.settings, db.settings);
    assert.equal(f.sent.length, 1);
    await engine.tick();
    assert.equal(f.sent.length, 1);
  });
}

for (const role of ["plan", "execute"]) {
  for (const missing of [false, true]) {
    test(`resume rejects ${missing ? "missing" : "archived"} ${role} without mutation`, async (t) => {
      const f = await fixture(t);
      await f.finish("planner", "p1", "plan");
      await f.engine.control(f.id, "pause");
      const agentId = role === "plan" ? "planner" : f.created[0].id;
      if (missing) f.agents.delete(agentId);
      else f.agents.get(agentId).archived = true;
      const before = await readFile(f.file, "utf8");
      const view = await f.view();
      await assert.rejects(
        f.engine.control(f.id, "resume", "계속"),
        /연결된 대화가 보관되어 재개할 수 없습니다/,
      );
      assert.equal(await readFile(f.file, "utf8"), before);
      assert.deepEqual(await f.view(), view);
    });
  }
}

test("control returns the actual pause and immediately stopped resume result", async (t) => {
  const f = await fixture(t);
  occupyNewExecutor(f);
  await f.finish("planner", "p1", "plan");
  const paused = await f.engine.control(f.id, "pause");
  assert.equal(paused.status, "paused");
  assert.match(paused.detail, /일시정지/);
  f.agents.get(f.created[0].id).status = "error";
  const resumed = await f.engine.control(f.id, "resume");
  assert.equal(resumed.status, "error");
  assert.equal(resumed.detail, (await f.view()).detail);
  assert.match(resumed.detail, /오류/);
});

for (const limit of ["cycles", "turns"]) {
  test(`resume passes the real ${limit} guard without changing global limits`, async (t) => {
    const f = await fixture(t);
    const settings = await f.engine.settings();
    await f.engine.configure({
      ...settings,
      ...(limit === "cycles" ? { maxCycles: 1 } : { maxTurns: 2 }),
    });
    await f.finish("planner", "p1", "plan");
    await f.finish(f.created[0].id, "e1", "result");
    await f.finish("planner", "p2", "plan");
    assert.equal((await f.view()).status, "paused");
    assert.match((await f.view()).detail, /한도/);
    assert.equal(f.sent.length, 2);
    const before = await f.engine.settings();
    const result = await f.engine.control(f.id, "resume");
    assert.equal(result.status, "active");
    assert.equal(f.sent.length, 3);
    assert.equal((await f.view()).turns, 1);
    assert.deepEqual(await f.engine.settings(), before);
  });
}

test("chat federation resume consumes a paused planner's valid plan once", async (t) => {
  const f = await fixture(t, undefined, "federated");
  await f.engine.control(f.id, "pause");
  await f.engine.ended(
    "planner",
    "chat-plan",
    decision("plan", "새 실행 지시"),
    null,
    "",
    false,
    "연합개발 재개해줘",
  );
  assert.equal((await f.view()).status, "active");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, f.created[0].id);
  assert.match(f.sent[0].prompt, /이번 지시:\n새 실행 지시$/);
  await f.engine.ended(
    "planner",
    "chat-plan",
    decision("plan"),
    null,
    "",
    false,
    "연합개발 재개해줘",
  );
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
});

test("chat federation resume accepts a reference to previously stopped work", async (t) => {
  const f = await fixture(t, undefined, "federated");
  await f.engine.control(f.id, "pause");
  await f.engine.ended(
    "planner",
    "previously-stopped-chat",
    decision("plan", "재개한 실행 지시"),
    null,
    "",
    false,
    "중지된 연합개발 다시 해줘",
  );
  assert.equal((await f.view()).status, "active");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, f.created[0].id);
  assert.match(f.sent[0].prompt, /이번 지시:\n재개한 실행 지시$/);
});

for (const text of [
  "재개했습니다.",
  "<paseo-workflow>{broken}</paseo-workflow>",
  decision("result"),
]) {
  test(`chat federation resume continues without a valid planner block: ${text}`, async (t) => {
    const f = await fixture(t, undefined, "federated");
    await f.engine.control(f.id, "pause");
    await f.engine.ended("planner", "chat-no-block", text, null, "", false, "연합개발 계속");
    assert.equal((await f.view()).status, "active");
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].id, "planner");
    assert.match(f.sent[0].prompt, /이번 지시:\n중단된 지점부터 이어서/);
    assert.ok((await stored(f)).processed.includes("chat-no-block"));
    await f.engine.tick();
    assert.equal(f.sent.length, 1);
  });
}

test("chat federation resume settles an instruction ended by a blockless executor turn", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  const pending = (await stored(f)).pending;
  await f.engine.control(f.id, "pause");
  f.agents.get(executor).status = "idle";
  f.histories.set(executor, {
    text: "계속합니다",
    key: "blockless-executor",
    messageIds: [pending.id],
    failed: null,
  });
  await f.engine.ended(
    executor,
    "blockless-executor",
    "계속합니다",
    null,
    "",
    false,
    "연합개발 계속",
    false,
    [pending.id],
  );
  assert.equal((await f.view()).status, "active");
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent.at(-1).id, executor);
  assert.match(f.sent.at(-1).prompt, /중단된 지점부터 이어서/);
  assert.notEqual((await stored(f)).pending.id, pending.id);
  await f.engine.tick();
  assert.equal((await f.view()).status, "active");
  assert.equal(f.sent.length, 2);
});

for (const status of ["error", "needs_input"]) {
  for (const block of [false, true]) {
    test(`chat federation resume recovers ${status} with block=${block}`, async (t) => {
      const f = await fixture(t, undefined, "federated");
      if (status === "error") {
        const create = f.port.create;
        f.port.create = async () => {
          throw Error("creation failed");
        };
        await f.finish("planner", "p1", "plan");
        f.port.create = create;
      } else {
        await f.finish("planner", "p1", "plan");
        const executor = f.created[0].id;
        f.agents.get(executor).status = "idle";
        await f.engine.ended(executor, "stopped", "", "interrupted", "", false, "", true);
      }
      assert.equal((await f.view()).status, status);
      const before = f.sent.length;
      await f.engine.ended(
        "planner",
        "chat-recovery",
        block ? decision("plan", "복구한 지시") : "계속합니다",
        null,
        "",
        false,
        "연합개발로 다시 진행해",
      );
      assert.equal((await f.view()).status, "active");
      assert.equal(f.sent.length, before + 1);
      assert.equal(f.sent.at(-1).id, f.created[0].id);
      if (block) assert.match(f.sent.at(-1).prompt, /복구한 지시$/);
      await f.engine.tick();
      assert.equal(f.sent.length, before + 1);
    });
  }
}

for (const request of [
  "연합개발 하지마",
  "연합개발이 뭐야?",
  "작업 ID: host\n진행 방식: 연합개발\n연합개발 재개해줘",
]) {
  test(`chat federation resume ignores a stop, question or host message: ${request}`, async (t) => {
    const f = await fixture(t, undefined, "federated");
    await f.finish("planner", "p1", "plan");
    await f.engine.control(f.id, "pause");
    await f.engine.ended(f.created[0].id, "not-resume", "알겠습니다", null, "", false, request);
    assert.equal((await f.view()).status, "paused");
    assert.equal(f.sent.length, 1);
    assert.doesNotMatch((await f.view()).detail, /채팅의 연합개발 요청/);
  });
}

test("chat federation resume does not interrupt a transition to general", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  await f.engine.control(f.id, "general");
  assert.equal((await stored(f)).generalTransition, true);
  await f.engine.ended(
    "planner",
    "transition-chat",
    "계속합니다",
    null,
    "",
    false,
    "연합개발 재개해줘",
  );
  assert.equal((await stored(f)).generalTransition, true);
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch((await f.view()).detail, /채팅의 연합개발 요청/);
});

for (const role of ["plan", "execute"]) {
  test(`chat federation resume refuses an archived ${role} conversation`, async (t) => {
    const f = await fixture(t, undefined, "federated");
    if (role === "execute") await f.finish("planner", "p1", "plan");
    await f.engine.control(f.id, "pause");
    f.agents.get(role === "plan" ? "planner" : f.created[0].id).archived = true;
    const before = f.sent.length;
    await f.engine.ended("planner", "archived-chat", "계속합니다", null, "", false, "연합개발");
    assert.equal((await f.view()).status, "paused");
    assert.match((await f.view()).detail, /채팅 재개 불가:.*보관/);
    assert.equal(f.sent.length, before);
  });
}

test("chat federation resume treats a planner's reply as the decision after an open question", async (t) => {
  const f = await fixture(t);
  occupyNewExecutor(f);
  await f.finish("planner", "p1", "plan");
  await userTurn(f, "planner", "question", decision("input", "그대로 진행할까요?"));
  const executor = f.created[0].id;
  f.agents.get(executor).status = "idle";
  assert.equal((await stored(f)).asker, "plan");
  await f.engine.ended(
    "planner",
    "answer",
    decision("plan", "답변에 따른 새 계획"),
    null,
    "",
    false,
    "연합개발 계속",
  );
  assert.equal((await f.view()).status, "active");
  assert.equal((await stored(f)).asker, null);
  assert.equal((await stored(f)).held, null);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, executor);
  assert.match(f.sent[0].prompt, /답변에 따른 새 계획$/);
});

test("chat federation resume without a block clears an open question and continues the floor", async (t) => {
  const f = await fixture(t, undefined, "federated");
  await f.finish("planner", "question", "input");
  assert.equal((await stored(f)).asker, "plan");
  await f.engine.ended("planner", "answer", "계속합니다", null, "", false, "연합개발 계속");
  assert.equal((await f.view()).status, "active");
  assert.equal((await stored(f)).asker, null);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].prompt, /중단된 지점부터 이어서/);
});

for (const block of [false, true]) {
  test(`chat federation resume cannot bypass an archived needs_input conversation, block=${block}`, async (t) => {
    const f = await fixture(t, undefined, "federated");
    await f.finish("planner", "ask", "input");
    f.agents.get("planner").archived = true;
    await f.engine.ended(
      "planner",
      "blocked-answer",
      block ? decision("plan") : "계속합니다",
      null,
      "",
      false,
      "연합개발 계속",
    );
    assert.equal((await f.view()).status, "needs_input");
    assert.match((await f.view()).detail, /채팅 재개 불가:.*보관/);
    assert.equal(f.sent.length, 0);
  });
}

test("chat federation resume uses the executor's valid result after cancellation", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  f.agents.get(executor).status = "idle";
  await f.engine.ended(executor, "cut", "", "interrupted", "", false, "", true);
  await f.engine.ended(
    executor,
    "executor-result",
    decision("result"),
    null,
    "",
    false,
    "연합개발 계속",
  );
  assert.equal((await f.view()).status, "active");
  assert.equal((await f.view()).phase, "review");
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent.at(-1).id, "planner");
});

for (const limit of ["cycles", "turns"]) {
  test(`chat federation resume resets exhausted ${limit} and stale maintenance`, async (t) => {
    const f = await fixture(t, undefined, "federated");
    await f.engine.control(f.id, "pause");
    await f.engine.close();
    const db = JSON.parse(await readFile(f.file, "utf8"));
    const w = db.workflows[0];
    w[limit] = limit === "cycles" ? db.settings.maxCycles : db.settings.maxTurns;
    w.planFingerprint = "old fingerprint";
    w.repeatedPlans = 3;
    w.plan.compaction = "interrupted compaction";
    await writeFile(f.file, JSON.stringify(db));
    const engine = new WorkflowEngine(f.file, f.port);
    t.after(() => engine.close());
    await engine.ended(
      "planner",
      "limited-chat",
      decision("plan"),
      null,
      "",
      false,
      "연합개발 재개해줘",
    );
    const after = JSON.parse(await readFile(f.file, "utf8"));
    assert.equal(after.workflows[0].status, "active");
    assert.equal(after.workflows[0].cycles, 1);
    assert.equal(after.workflows[0].turns, 1);
    assert.equal(after.workflows[0].planFingerprint, "");
    assert.equal(after.workflows[0].repeatedPlans, 0);
    assert.equal(after.workflows[0].quotaPause, null);
    assert.equal(after.workflows[0].plan.compaction, null);
    assert.deepEqual(after.settings, db.settings);
    assert.equal(f.sent.length, 1);
  });
}

test("chat federation stop preserves the planner's existing general-mode switch", async (t) => {
  const f = await fixture(t, undefined, "federated");
  await f.engine.control(f.id, "pause");
  await f.engine.ended("planner", "stop", "알겠습니다", null, "", false, "연합개발 하지마");
  assert.equal((await f.view()).mode, "general");
  assert.equal(f.sent.length, 0);
  assert.doesNotMatch((await f.view()).detail, /채팅의 연합개발 요청/);
});

test("chat federation resume accepts an executor but preserves the planner's floor", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  await f.finish(executor, "e1", "result");
  f.agents.get("planner").status = "idle";
  await f.engine.ended("planner", "question", decision("input"), null);
  assert.equal((await f.view()).status, "needs_input");
  await f.engine.ended(
    executor,
    "executor-chat",
    decision("result"),
    null,
    "",
    false,
    "연합개발 재개해줘",
  );
  assert.equal((await f.view()).status, "active");
  assert.equal(f.sent.at(-1).id, "planner");
  assert.match(f.sent.at(-1).prompt, /중단된 지점부터 이어서/);
  assert.ok((await stored(f)).processed.includes("executor-chat"));
});

for (const [failed, canceled] of [
  ["failed", false],
  [null, true],
]) {
  test(`chat federation resume ignores unsuccessful turns (${failed}, ${canceled})`, async (t) => {
    const f = await fixture(t, undefined, "federated");
    await f.engine.control(f.id, "pause");
    await f.engine.ended(
      "planner",
      "failed-chat",
      decision("plan"),
      failed,
      "",
      false,
      "연합개발 재개해줘",
      canceled,
    );
    assert.equal((await f.view()).status, "paused");
    assert.equal(f.sent.length, 0);
  });
}

for (const mode of ["general", "undecided"]) {
  test(`chat federation resume does not federate a ${mode} conversation`, async (t) => {
    const f = await fixture(t, undefined, mode);
    await f.engine.ended(
      "planner",
      "other-mode",
      "계속합니다",
      null,
      "",
      false,
      "연합개발 재개해줘",
    );
    assert.equal((await f.view()).mode, mode);
    assert.equal((await f.view()).status, "active");
    assert.equal(f.sent.length, 0);
  });
}

test("chat federation resume leaves active and completed admission behavior intact", async (t) => {
  for (const status of ["active", "completed"]) {
    const f = await fixture(t, undefined, "federated");
    if (status === "completed") await f.finish("planner", "done", "complete");
    await f.engine.ended(
      "planner",
      "ordinary-chat",
      "설명입니다",
      null,
      "",
      false,
      "연합개발 재개해줘",
    );
    assert.equal((await f.view()).status, status === "active" ? "needs_input" : "completed");
    assert.equal(f.sent.length, 0);
  }
});

test("ordinary resume preserves counters and status reads leave persisted state untouched", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  await f.engine.control(f.id, "pause");
  const before = await f.view();
  await f.engine.control(f.id, "resume");
  assert.equal((await f.view()).cycles, before.cycles);
  assert.equal((await f.view()).turns, before.turns);
  const persisted = await readFile(f.file, "utf8");
  await f.engine.list();
  await f.engine.list();
  assert.equal(await readFile(f.file, "utf8"), persisted);
});

for (const [answer, mode] of [
  ["일반개발", "general"],
  ["연합개발", "federated"],
]) {
  test(`three startup questions resolve ${mode} from the mode question`, async (t) => {
    const f = await fixture(t, undefined, "undecided");
    const request = modeRequest();
    request.input.questions.unshift({
      question: "모델",
      header: "모델",
      options: [{ label: "codex/model" }],
    });
    request.input.questions.push({
      question: "추론",
      header: "추론",
      options: [{ label: "모델 기본값" }],
    });
    await f.engine.permission("planner", request);
    await f.engine.permissionResolved("planner", "mode", {
      behavior: "allow",
      updatedInput: { answers: { 모델: "codex/model", "진행 방식": answer, 추론: "모델 기본값" } },
    });
    assert.equal((await f.view()).mode, mode);
  });
}

const unchangedNoteFields = (w) =>
  Object.fromEntries(
    [
      "pending",
      "held",
      "phase",
      "cycles",
      "turns",
      "lastPlan",
      "lastInstruction",
      "lastResult",
      "asker",
      "status",
      "progress",
      "plan",
      "execute",
    ].map((key) => [key, w[key]]),
  );
const note = (remember = []) =>
  `<paseo-workflow>${JSON.stringify({ status: "note", summary: "진행 상황 답변", handoff: "상황만 설명", remember })}</paseo-workflow>`;
for (const stage of ["queued", "sent"]) {
  test(`planner note preserves ${stage} work and remembers without replacing handoff`, async (t) => {
    const f = await fixture(t);
    if (stage === "queued") occupyNewExecutor(f);
    await f.finish("planner", "p1", "plan");
    const before = await stored(f);
    assert.equal(before.pending.stage, stage);
    await f.engine.ended("planner", "note", note(["운영 재로드 금지"]), null);
    const after = await stored(f);
    assert.deepEqual(unchangedNoteFields(after), unchangedNoteFields(before));
    assert.equal(after.inbox, null);
    assert.ok(after.processed.includes("note"));
    assert.equal(after.memories.at(-1).text, "운영 재로드 금지");
    await f.engine.ended("planner", "note-progress", "작업상태: 완료\n" + note(), null);
    const progressed = await stored(f);
    assert.deepEqual(unchangedNoteFields(progressed), {
      ...unchangedNoteFields(before),
      progress: "done",
      // Recolouring refreshes live agent usage, independently of the workflow decision.
      execute: { ...before.execute, usage: progressed.execute.usage },
    });
    if (stage === "queued") {
      f.agents.get(f.created[0].id).status = "idle";
      await f.engine.tick();
      assert.equal(f.sent.length, 1);
      assert.equal(f.sent[0].messageId, before.pending.id);
    }
  });
}
for (const held of [false, true]) {
  test(`note keeps needs_input and notifications unchanged (held=${held})`, async (t) => {
    const events = [];
    const f = await fixture(t, async (e) => events.push(e));
    if (held) {
      occupyNewExecutor(f);
      await f.finish("planner", "p1", "plan");
    }
    await f.engine.ended("planner", "ask", decision("input", "사용자 답변 필요"), null);
    await new Promise((resolve) => setImmediate(resolve));
    const before = await stored(f);
    const count = events.length;
    await f.engine.ended("planner", "note", note(["기억 유지"]), null);
    await new Promise((resolve) => setImmediate(resolve));
    const after = await stored(f);
    assert.deepEqual(unchangedNoteFields(after), unchangedNoteFields(before));
    assert.equal(after.detail, before.detail);
    assert.equal(after.memories.at(-1).text, "기억 유지");
    assert.equal(events.length, count);
    assert.equal(after.inbox, null);
  });
}
test("note as the answer to a delivered instruction stops for input", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  await f.finish(f.created[0].id, "e1", "note");
  const w = await stored(f);
  assert.equal(w.status, "needs_input");
  assert.match(w.detail, /note로 답할 수 없습니다/);
  assert.equal(w.pending, null);
  assert.equal(w.repairs, 0);
  assert.equal(f.sent.length, 1);
});
test("a completed flow stays completed after a note", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "done", "complete");
  const before = await stored(f);
  await f.engine.ended("planner", "note", note(["완료 기준 보존"]), null);
  const after = await stored(f);
  assert.deepEqual(unchangedNoteFields(after), unchangedNoteFields(before));
  assert.equal(after.memories.at(-1).text, "완료 기준 보존");
  await f.engine.ended("planner", "note-progress", "작업상태: 진행\n" + note(), null);
  assert.deepEqual(unchangedNoteFields(await stored(f)), {
    ...unchangedNoteFields(before),
    progress: "active",
  });
  assert.equal(f.sent.length, 0);
});
for (const mode of ["undecided", "general"]) {
  test(`note does not federate ${mode}`, async (t) => {
    const f = await fixture(t, undefined, mode);
    await f.engine.ended("planner", "note", note(), null);
    assert.equal((await f.view()).mode, mode);
    assert.equal(f.created.length, 0);
  });
}
test("old baseline state loads with optional repository fields defaulted", async (t) => {
  const f = await fixture(t);
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  db.workflows[0].baseline = { head: "abc", dirty: [" M file\t1:2"] };
  await writeFile(f.file, JSON.stringify(db));
  const restored = new WorkflowEngine(f.file, f.port);
  t.after(() => restored.close());
  await restored.list();
  const loaded = await restored.store.read();
  assert.deepEqual(loaded.workflows[0].baseline, {
    head: "abc",
    dirty: [" M file\t1:2"],
    repositories: [],
    incomplete: false,
  });
});

test("side note preserves an unread delivered result while paused", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  await f.engine.control(f.id, "pause");
  await f.finish(executor, "e1", "result");
  const before = await stored(f);
  await userTurn(f, executor, "note", note(["결과 보존"]));
  const after = await stored(f);
  assert.deepEqual(after.inbox, before.inbox);
  assert.deepEqual(unchangedNoteFields(after), unchangedNoteFields(before));
  assert.equal(after.memories.at(-1).text, "결과 보존");
  await f.engine.control(f.id, "resume");
  assert.equal(f.sent.at(-1).id, "planner");
});

test("note preserves an unread user plan paused at the cycle limit", async (t) => {
  const f = await fixture(t);
  await f.engine.configure({ ...(await f.engine.settings()), maxCycles: 1 });
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  await f.finish(executor, "e1", "result");
  await f.finish("planner", "ask", "input");
  await userTurn(f, "planner", "p2", decision("plan", "preserved second user plan"));
  const before = await stored(f);
  assert.equal(before.status, "paused");
  assert.equal(before.inbox.key, "p2");
  assert.equal(before.inbox.answers, false);
  assert.match(before.detail, /한도/);
  await userTurn(f, "planner", "side-note", note(["두 번째 계획 보존"]));
  const after = await stored(f);
  assert.deepEqual(after.inbox, before.inbox);
  assert.deepEqual(unchangedNoteFields(after), unchangedNoteFields(before));
  assert.ok(after.processed.includes("side-note"));
  assert.equal(after.memories.at(-1).text, "두 번째 계획 보존");
  await f.engine.configure({ ...(await f.engine.settings()), maxCycles: 2 });
  await f.engine.control(f.id, "resume");
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent.at(-1).id, executor);
  assert.match(f.sent.at(-1).prompt, /이번 지시:\npreserved second user plan/);
});

for (const source of ["user", "response"]) {
  test(`note respects ${source} progress and retains push verification`, async (t) => {
    let probes = 0;
    const probe = {
      snapshot: async () => null,
      changes: async () => "",
      pushed: async () => {
        probes++;
        return false;
      },
    };
    const f = await fixture(t, undefined, "federated", false, "claude", probe);
    await f.finish("planner", "p1", "plan");
    const before = await stored(f);
    await f.engine.ended(
      "planner",
      "push-note",
      (source === "response" ? "작업상태: 푸시\n" : "작업상태: 진행\n") + note(),
      null,
      "goal",
      false,
      source === "user" ? "작업상태: 푸시" : "",
    );
    assert.deepEqual(unchangedNoteFields(await stored(f)), {
      ...unchangedNoteFields(before),
      progress: "done",
    });
    assert.equal(
      probes,
      0,
      "a colour request without execution evidence never probes current HEAD",
    );
    assert.match(f.renamed.at(-1).title, /^🟢 /);
  });
}

const quotaError =
  "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 14th, 2026 9:36 PM.";
async function quotaFixture(t, notify) {
  let time = new Date(2026, 9, 9, 12).getTime();
  const f = await fixture(t, notify, undefined, undefined, "claude", null, () => time);
  let account = "account-a",
    available = null;
  const calls = { account: 0, usage: 0 };
  f.port.quotaAccount = async () => {
    calls.account++;
    return account;
  };
  f.port.quotaAvailable = async () => {
    calls.usage++;
    return available;
  };
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  return {
    ...f,
    executor,
    calls,
    advance: (ms) => {
      time += ms;
    },
    now: () => time,
    account: (value) => {
      account = value;
    },
    available: (value) => {
      available = value;
    },
    fail: async (key = "quota", error = quotaError, canceled = false) => {
      f.agents.get(executor).status = "idle";
      await f.engine.ended(executor, key, "", error, "", false, "", canceled);
    },
  };
}
test("quota failure records the role, account, original instruction and local retry time", async (t) => {
  const events = [];
  const f = await quotaFixture(t, async (event) => events.push(event));
  await f.fail();
  const w = await stored(f);
  assert.equal(w.status, "paused");
  assert.deepEqual(w.quotaPause, {
    role: "execute",
    provider: "codex",
    stoppedAt: f.now(),
    retryAt: new Date(2026, 9, 14, 21, 36).getTime(),
    account: "account-a",
    attempts: 0,
    accountRetry: false,
    nextCheckAt: f.now() + 60_000,
    lastCheckedAt: null,
    prompt: "next task",
    phase: "execute",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((e) => e.kind === "stopped").length, 1);
  f.account("account-b");
  f.advance(60_000);
  await f.engine.tick();
  f.advance(120_000);
  await f.engine.tick();
  assert.equal((await stored(f)).status, "active");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1, "auto resume does not send its own notification");
});
for (const reason of ["account", "usage", "time"]) {
  test(`quota auto resume on ${reason} redelivers the original instruction`, async (t) => {
    const f = await quotaFixture(t);
    await f.fail();
    f.advance(60_000);
    if (reason === "account") f.account("account-b");
    if (reason === "usage") f.available(true);
    if (reason === "time") f.advance(new Date(2026, 9, 14, 21, 36).getTime() - f.now());
    await f.engine.tick();
    if (reason === "account") {
      f.advance(120_000);
      await f.engine.tick();
    }
    const w = await stored(f);
    assert.equal(w.status, "active");
    assert.equal(w.quotaPause.attempts, 1);
    assert.match(w.detail, /사용 한도 자동 재개/);
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent.at(-1).id, f.executor);
    assert.match(f.sent.at(-1).prompt, /이번 지시:\nnext task/);
    await f.engine.tick();
    assert.equal(f.sent.length, 2);
  });
}
for (const [failure, canceled] of [
  ["network error", false],
  [quotaError, true],
]) {
  test(`non-quota or canceled failure has no automatic record (${canceled})`, async (t) => {
    const f = await quotaFixture(t);
    await f.fail("fail", failure, canceled);
    assert.equal((await stored(f)).quotaPause, null);
    f.account("b");
    f.available(true);
    f.advance(60_000);
    await f.engine.tick();
    assert.equal(f.sent.length, 1);
  });
}
test("quota probes run at most once a minute and unknown account or usage never resumes", async (t) => {
  const f = await quotaFixture(t);
  await f.fail();
  f.advance(60_000);
  f.account(null);
  await f.engine.tick();
  const calls = { ...f.calls };
  f.advance(59_999);
  await f.engine.tick();
  assert.deepEqual(f.calls, calls);
  f.advance(1);
  await f.engine.tick();
  assert.equal(f.calls.account, calls.account + 1);
  assert.equal((await f.view()).status, "paused");
  assert.equal(f.sent.length, 1);
});
test("quota retry backoff grows, caps at five and resets for a changed account", async (t) => {
  const f = await quotaFixture(t);
  await f.fail();
  f.available(true);
  f.advance(60_000);
  const delays = [5, 15, 30, 60, 60];
  for (let attempt = 1; attempt <= 5; attempt++) {
    await f.engine.tick();
    assert.equal((await stored(f)).quotaPause.attempts, attempt);
    await f.fail(`again-${attempt}`);
    const w = await stored(f);
    assert.equal(w.quotaPause.nextCheckAt, f.now() + delays[attempt - 1] * 60_000);
    f.advance(60_000);
    await f.engine.tick();
    assert.equal((await f.view()).status, "paused");
    f.advance((delays[attempt - 1] - 1) * 60_000);
  }
  await f.engine.tick();
  assert.equal((await f.view()).status, "paused");
  assert.equal(f.sent.length, 6);
  f.account("account-b");
  f.advance(60_000);
  await f.engine.tick();
  f.advance(120_000);
  await f.engine.tick();
  assert.equal((await f.view()).status, "active");
  assert.equal((await stored(f)).quotaPause.attempts, 1);
  await f.fail("again-b");
  f.account("account-c");
  f.advance(60_000);
  await f.engine.tick();
  f.advance(120_000);
  await f.engine.tick();
  assert.equal((await stored(f)).quotaPause.attempts, 1);
  assert.equal((await f.view()).status, "active");
});
for (const action of ["pause", "resume"]) {
  test(`manual ${action} clears quota recovery`, async (t) => {
    const f = await quotaFixture(t);
    await f.fail();
    await f.engine.control(f.id, action);
    assert.equal((await stored(f)).quotaPause, null);
  });
}
test("successful response clears quota retry history", async (t) => {
  const f = await quotaFixture(t);
  await f.fail();
  f.account("b");
  f.advance(60_000);
  await f.engine.tick();
  f.advance(120_000);
  await f.engine.tick();
  await f.finish(f.executor, "ok", "result");
  assert.equal((await stored(f)).quotaPause, null);
});
for (const excluded of ["disabled", "expired", "old-state", "general", "completed"]) {
  test(`quota recovery excludes ${excluded}`, async (t) => {
    const f = await quotaFixture(t);
    await f.fail();
    f.account("b");
    f.available(true);
    f.advance(60_000);
    if (excluded === "disabled")
      await f.engine.configure({ ...(await f.engine.settings()), autoResumeQuota: false });
    if (excluded === "expired") f.advance(14 * 24 * 60 * 60_000);
    if (["old-state", "general", "completed"].includes(excluded)) {
      await f.engine.close();
      const db = JSON.parse(await readFile(f.file, "utf8"));
      if (excluded === "old-state") {
        delete db.workflows[0].quotaPause;
        delete db.settings.autoResumeQuota;
      }
      if (excluded === "general") db.workflows[0].mode = "general";
      if (excluded === "completed") db.workflows[0].status = "completed";
      await writeFile(f.file, JSON.stringify(db));
      f.engine = new WorkflowEngine(f.file, f.port, undefined, null, f.now);
      t.after(() => f.engine.close());
    }
    await f.engine.tick();
    assert.equal(f.sent.length, 1);
    if (excluded === "old-state") {
      assert.equal((await stored(f)).quotaPause, null);
      assert.equal((await f.engine.settings()).autoResumeQuota, true);
    }
  });
}
test("quota usage lookup failure is unknown and cannot restart a flow", async (t) => {
  const f = await quotaFixture(t);
  await f.fail();
  f.advance(60_000);
  f.port.quotaAvailable = async () => {
    throw Error("fetch failed");
  };
  await f.engine.tick();
  assert.equal((await f.view()).status, "paused");
  assert.equal(f.sent.length, 1);
});
test("refused quota recovery clears its record and preserves the stopped detail", async (t) => {
  const f = await quotaFixture(t);
  await f.fail();
  const before = await stored(f);
  f.agents.get(f.executor).archived = true;
  f.account("b");
  f.advance(60_000);
  await f.engine.tick();
  f.advance(120_000);
  await f.engine.tick();
  const after = await stored(f);
  assert.equal(after.status, "paused");
  assert.equal(after.detail, before.detail);
  assert.equal(after.quotaPause, null);
  assert.equal(f.sent.length, 1);
});

test("a direct Claude quota failure records only its observed extra-usage message", async (t) => {
  const f = await fixture(t);
  await f.engine.ended("planner", "limit", "", "You're out of extra usage");
  const w = await stored(f);
  assert.equal(w.status, "paused");
  assert.equal(w.quotaPause.provider, "claude");
  assert.equal(w.quotaPause.role, "plan");
  assert.equal(w.quotaPause.retryAt, null);
});
test("quota recovery survives reload without resetting attempts or retry timing", async (t) => {
  const f = await quotaFixture(t);
  await f.fail();
  f.available(true);
  f.advance(60_000);
  await f.engine.tick();
  await f.fail("again");
  const before = (await stored(f)).quotaPause;
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port, undefined, null, f.now);
  t.after(() => restored.close());
  await restored.tick();
  assert.deepEqual((await stored(f)).quotaPause, { ...before, lastCheckedAt: f.now() });
  assert.equal(f.sent.length, 2);
  f.advance(5 * 60_000);
  await restored.tick();
  assert.equal(f.sent.length, 3);
  assert.equal((await stored(f)).quotaPause.attempts, 2);
});
test("a quota retry rejected by an agent error clears automatic recovery", async (t) => {
  const f = await quotaFixture(t);
  await f.fail();
  const before = await stored(f);
  f.agents.get(f.executor).status = "error";
  f.account("b");
  f.advance(60_000);
  await f.engine.tick();
  f.advance(120_000);
  await f.engine.tick();
  const after = await stored(f);
  assert.equal(after.status, "paused");
  assert.equal(after.quotaPause, null);
  assert.equal(after.detail, before.detail);
  assert.equal(f.sent.length, 1);
});

test("account-switch quota retry survives an old-login failure without new recovery evidence", async (t) => {
  const f = await quotaFixture(t);
  await f.fail();
  f.account("account-b");
  f.advance(60_000);
  await f.engine.tick();
  // Let both the old immediate implementation and the required grace period reach a retry.
  f.advance(120_000);
  await f.engine.tick();
  assert.equal((await f.view()).status, "active");
  await f.fail("old-login-limit");
  assert.equal((await stored(f)).quotaPause.account, "account-b");
  f.advance(5 * 60_000);
  await f.engine.tick();
  assert.equal(
    (await f.view()).status,
    "active",
    "same account, unknown usage and future reset must not strand a switched-account retry",
  );
  assert.equal(f.sent.length, 3);
});

test("account switch waits 120 seconds even with available usage and resets on another switch", async (t) => {
  const f = await quotaFixture(t);
  await f.fail();
  f.account("b");
  f.available(true);
  await f.engine.tick();
  f.advance(60_000);
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  f.account("c");
  f.advance(60_000);
  await f.engine.tick();
  assert.equal((await stored(f)).quotaPause.nextCheckAt, f.now() + 120_000);
  f.advance(60_000);
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  f.advance(59_999);
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  f.advance(1);
  await f.engine.tick();
  assert.equal(f.sent.length, 2);
});

test("account-driven retries persist across restart and stop after five attempts", async (t) => {
  const f = await quotaFixture(t);
  await f.fail();
  f.account("b");
  await f.engine.tick();
  await f.engine.close();
  f.engine = new WorkflowEngine(f.file, f.port, undefined, null, f.now);
  t.after(() => f.engine.close());
  f.advance(60_000);
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  f.advance(60_000);
  await f.engine.tick();
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.equal((await stored(f)).quotaPause.attempts, attempt);
    f.agents.get(f.executor).status = "idle";
    await f.engine.ended(f.executor, `switched-${attempt}`, "", quotaError);
    if (attempt === 1) {
      await f.engine.close();
      f.engine = new WorkflowEngine(f.file, f.port, undefined, null, f.now);
      t.after(() => f.engine.close());
    }
    const delay = [5, 15, 30, 60, 60][attempt - 1] * 60_000;
    f.advance(delay - 60_000);
    await f.engine.tick();
    assert.equal((await stored(f)).status, "paused");
    f.advance(60_000);
    await f.engine.tick();
  }
  assert.equal((await stored(f)).status, "paused");
  assert.equal(f.sent.length, 6);
  f.account("c");
  f.advance(60_000);
  await f.engine.tick();
  assert.equal((await stored(f)).quotaPause.attempts, 0);
  assert.equal(f.sent.length, 6);
  f.advance(120_000);
  await f.engine.tick();
  assert.equal(f.sent.length, 7);
  assert.equal((await stored(f)).quotaPause.attempts, 1);
});

test("previous quota record format defaults to no account-driven retries", async (t) => {
  const f = await quotaFixture(t);
  await f.fail();
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  delete db.workflows[0].quotaPause.accountRetry;
  await writeFile(f.file, JSON.stringify(db));
  const restored = new WorkflowEngine(f.file, f.port, undefined, null, f.now);
  t.after(() => restored.close());
  f.advance(60 * 60_000);
  await restored.tick();
  assert.equal((await stored(f)).quotaPause.accountRetry, false);
  assert.equal((await stored(f)).status, "paused");
  assert.equal(f.sent.length, 1);
});

const withArtifacts = (status, artifacts) =>
  decision(status).replace('"checks":', `${JSON.stringify(artifacts).slice(1, -1)},"checks":`);
const scopedProbe = (overrides = {}) => ({
  repository: async (cwd) => path.resolve(cwd),
  snapshot: async () => ({ head: "a".repeat(40), dirty: [] }),
  changes: async (cwd) => `evidence: ${cwd}`,
  pushed: async () => false,
  ...overrides,
});

test("explicit repositories and exact push targets survive reload; malformed targets cannot reuse prior evidence", async (t) => {
  const calls = [];
  const probe = scopedProbe({
    pushedTarget: async (target) => (calls.push(target), target.remote === "approved"),
  });
  const f = await fixture(t, undefined, "general", true, "claude", probe);
  const repository = path.join(path.dirname(f.file), "child");
  await f.engine.setRepositories(f.id, [repository]);
  const target = { repository, remote: "approved", branch: "release", commit: "a".repeat(40) };
  await finishPush(
    f.engine,
    "planner",
    "push",
    `푸시대상: ${JSON.stringify([target])}\n작업상태: 푸시`,
    target,
  );
  assert.equal((await f.view()).progress, "pushed");
  assert.deepEqual(calls, [target]);
  assert.equal((await stored(f)).pushCheck.targets[0].result, "pushed");
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port, undefined, probe);
  t.after(() => restored.close());
  assert.deepEqual((await restored.list()).workflows[0].repositories, [repository]);
  await restored.ended("planner", "new", "작업상태: 진행", null);
  await restored.ended("planner", "bad", "푸시대상: invalid\n작업상태: 푸시", null);
  assert.equal((await stored(f)).progress, "done");
  assert.equal((await stored(f)).invalidTargets, true);
  assert.equal(calls.length, 1);
  await finishPush(
    restored,
    "planner",
    "different",
    `푸시대상: ${JSON.stringify([{ ...target, remote: "different" }])}\n작업상태: 푸시`,
    { ...target, remote: "different" },
  );
  assert.equal((await stored(f)).progress, "done");
  assert.equal(calls.at(-1).remote, "different");
  await restored.setRepositories(f.id, [path.join(repository, "other")]);
  assert.deepEqual((await stored(f)).pushTargets, []);
});

test("no git probe cannot establish push completion", async (t) => {
  const f = await fixture(t, undefined, "general");
  await finishPush(f.engine, "planner", "push");
  assert.equal((await f.view()).progress, "done");
});

async function federationWithLoggedPush(t) {
  const f = await fixture(t, undefined, "federated", true, "codex", {
    ...verifiedPushProbe,
    commit: async (_cwd, hash) => (hash === "aaaaaaa" ? pushedCommit.commit : null),
  });
  let pinnedAt = null,
    pinCalls = 0,
    unpinCalls = 0;
  f.port.pushReview = {
    get: async () => ({ pinnedAt }),
    pin: async () => {
      pinCalls++;
      return (pinnedAt = "automatic");
    },
    unpin: async () => {
      unpinCalls++;
      pinnedAt = null;
      return true;
    },
  };
  await f.engine.setRepositories(f.id, ["/repo", "/worktree"]);
  await f.finish("planner", "plan", "plan");
  const executor = f.created[0].id;
  assert.match(f.sent[0].prompt, /명시적 승인을 직접 받은 대화가 단독 셸 명령/);
  assert.doesNotMatch(f.sent[0].prompt, /전용 실행 경로를 사용한다/);
  assert.match(f.sent[0].prompt, /merge-base --is-ancestor/);
  assert.match(f.sent[0].prompt, /이미 원격에 반영됨/);
  assert.match(f.sent[0].prompt, /pull\/rebase\/merge\/강제 푸시로 우회하지 않고/);
  f.agents.get(executor).status = "idle";
  const report = `작업상태: 푸시\n${withArtifacts("result", { repositories: ["/repo"], pushTargets: [pushedCommit] })}`;
  const turn = readTurn(
    [
      { type: "user_message", text: f.sent[0].prompt, messageId: f.sent[0].messageId },
      {
        type: "tool_call",
        callId: "logged-push",
        name: "Bash",
        status: "completed",
        error: null,
        detail: {
          type: "shell",
          command:
            'F=/tmp/final; git push origin main > $F/push.log 2>&1; e=$?; echo "push exit=$e" | tee $F/push-exit.txt; cat $F/push.log; git ls-remote origin refs/heads/main | tee $F/ls-remote.txt',
          output: `push exit=0\nTo example:repo.git\n bbbbbbb..aaaaaaa main -> main\n${pushedCommit.commit}\trefs/heads/main\n`,
        },
      },
      { type: "assistant_message", text: report },
    ],
    "/repo",
  );
  await f.engine.ended(
    executor,
    turn.key,
    turn.text,
    null,
    "",
    false,
    turn.request,
    false,
    turn.messageIds,
    turn.evidence,
  );
  assert.equal(
    (await f.view()).progress,
    "pushed",
    "the executor's real tool must create the receipt",
  );
  assert.equal((await stored(f)).pushReceipt.agentId, executor);
  assert.equal(f.sent[1].id, "planner", "executor result must be handed back for review");
  assert.equal((await f.view()).phase, "review");
  f.agents.get("planner").status = "idle";
  return { f, executor, pins: () => ({ pinnedAt, pinCalls, unpinCalls }) };
}

test("federated review keeps the executor's logged push receipt when adding an inspected worktree", async (t) => {
  const { f, executor, pins } = await federationWithLoggedPush(t);
  const report = `작업상태: 푸시\n${withArtifacts("complete", { repositories: ["/repo", "/worktree"], pushTargets: [pushedCommit] })}`;
  await f.engine.ended("planner", "review", report, null, "", false, "", false, [], {
    report,
    changed: false,
    pushes: [],
  });
  const state = await stored(f);
  assert.equal(state.status, "completed");
  assert.equal(state.progress, "pushed");
  assert.deepEqual(state.repositories, ["/repo", "/worktree"]);
  assert.equal(state.pushReceipt.agentId, executor);
  assert.deepEqual(state.pushReceipt.calls, ["logged-push"]);
  assert.equal(state.pushCheck.targets[0].result, "pushed");
  assert.deepEqual(pins(), { pinnedAt: "automatic", pinCalls: 1, unpinCalls: 0 });
  assert.match(f.renamed.at(-1).title, /^🔵 .*\[PUSH\]/);
});

test("new edits, approval requests, target changes and explicit scope edits still clear federated receipts", async (t) => {
  for (const kind of ["edit", "target", "replaced scope", "manual scope", "active", "approval"]) {
    const { f } = await federationWithLoggedPush(t);
    if (kind === "manual scope") await f.engine.setRepositories(f.id, ["/repo", "/worktree"]);
    const target = kind === "target" ? { ...pushedCommit, commit: "b".repeat(40) } : pushedCommit;
    const report = `${kind === "active" ? "작업상태: 진행" : "작업상태: 푸시"}\n${kind === "approval" ? "새 커밋을 푸시할까요?\n" : ""}${withArtifacts("complete", { repositories: kind === "replaced scope" ? ["/other"] : ["/repo", "/worktree"], pushTargets: [target] })}`;
    await f.engine.ended("planner", "review", report, null, "", false, "", false, [], {
      report,
      changed: kind === "edit",
      pushes: [],
    });
    assert.notEqual((await f.view()).progress, "pushed", kind);
    assert.equal((await stored(f)).pushReceipt, null, kind);
  }
});

test("reordering identical push targets does not discard their execution receipt", async (t) => {
  const f = await fixture(t, undefined, "general", true, "codex", verifiedPushProbe);
  const targets = [pushedCommit, { ...pushedCommit, repository: "/second" }];
  const report = `푸시대상: ${JSON.stringify(targets)}\n작업상태: 푸시`;
  await f.engine.ended("planner", "pushed", report, null, "", false, "", false, [], {
    report,
    changed: false,
    pushes: targets.flatMap((target) => pushEvidence(target).pushes),
  });
  const receipt = (await stored(f)).pushReceipt;
  assert.ok(receipt);
  await f.engine.ended(
    "planner",
    "review",
    `푸시대상: ${JSON.stringify(targets.toReversed())}\n작업상태: 푸시`,
    null,
  );
  assert.equal((await f.view()).progress, "pushed");
  assert.deepEqual((await stored(f)).pushReceipt, receipt);
});

test("a settings mirror outside the edit scope requires matching explicit same-turn push evidence", async (t) => {
  const report = `푸시대상: ${JSON.stringify([pushedCommit])}\n작업상태: 푸시`;
  for (const [kind, text, evidence, expected] of [
    ["matching", report, pushEvidence(pushedCommit, report), "pushed"],
    ["claim only", report, { report, changed: false, pushes: [] }, "done"],
    [
      "wrong commit",
      report,
      pushEvidence({ ...pushedCommit, commit: "b".repeat(40) }, report),
      "done",
    ],
    [
      "wrong repository",
      report,
      pushEvidence({ ...pushedCommit, repository: "/other" }, report),
      "done",
    ],
    ["unreported repository", "작업상태: 푸시", pushEvidence(), "done"],
  ]) {
    const calls = [];
    const f = await fixture(
      t,
      undefined,
      "general",
      true,
      "codex",
      scopedProbe({
        pushedTarget: async (target) => (calls.push(target), true),
      }),
    );
    await f.engine.setRepositories(f.id, ["/source"]);
    await f.engine.ended(
      "planner",
      kind,
      text,
      null,
      "",
      false,
      "푸시",
      false,
      undefined,
      evidence,
    );
    assert.equal((await f.view()).progress, expected, kind);
    assert.deepEqual((await f.view()).repositories, ["/source"], "edit scope must be preserved");
    assert.deepEqual(calls, expected === "pushed" ? [pushedCommit] : [], kind);
  }
});

test("a follow-up repeating receipted targets outside the edit scope keeps the push", async (t) => {
  const report = `푸시대상: ${JSON.stringify([pushedCommit])}\n작업상태: 푸시`;
  const f = await fixture(
    t,
    undefined,
    "general",
    true,
    "codex",
    scopedProbe({ pushedTarget: async () => true }),
  );
  await f.engine.setRepositories(f.id, ["/source"]);
  await f.engine.ended(
    "planner",
    "push",
    report,
    null,
    "",
    false,
    "푸시",
    false,
    undefined,
    pushEvidence(pushedCommit, report),
  );
  assert.equal((await f.view()).progress, "pushed");
  // The next reply only re-checks the remote and repeats the same targets without pushing.
  const followup = `원격에 이미 있습니다.\n푸시대상: ${JSON.stringify([pushedCommit])}`;
  await f.engine.ended("planner", "check", followup, null, "", false, "푸시", false, undefined, {
    report: followup,
    changed: false,
    pushes: [],
  });
  const saved = await stored(f);
  assert.equal(saved.progress, "pushed");
  assert.equal(saved.invalidTargets, false);
  assert.equal(saved.pushReceipt.turnKey, "push");
  // A different target outside the scope still needs its own execution.
  const other = { ...pushedCommit, commit: "b".repeat(40) };
  const changed = `푸시대상: ${JSON.stringify([other])}\n작업상태: 푸시`;
  await f.engine.ended("planner", "other", changed, null, "", false, "푸시", false, undefined, {
    report: changed,
    changed: false,
    pushes: [],
  });
  assert.equal((await stored(f)).invalidTargets, true);
  assert.notEqual((await f.view()).progress, "pushed");
});

test("repair re-reads previously rejected targets with their same-turn execution", async (t) => {
  const report = `푸시대상: ${JSON.stringify([pushedCommit])}\n작업상태: 푸시`;
  const f = await fixture(t, undefined, "general", true, "codex", verifiedPushProbe);
  await f.engine.setRepositories(f.id, ["/source"]);
  // The old parser saw the report but missed --porcelain, leaving invalidTargets persisted.
  await f.engine.ended("planner", "old-push", report, null);
  assert.equal((await stored(f)).invalidTargets, true);
  f.histories.set("planner", {
    key: "old-push",
    text: `작업저장소: /previous-source\n${report}`,
    evidence: pushEvidence(pushedCommit, report),
    failed: null,
    messageIds: ["approved"],
  });
  await f.engine.setProgress(1, "pushed", "project");
  assert.equal((await f.view()).progress, "pushed");
  assert.equal((await stored(f)).invalidTargets, false);
  assert.equal((await stored(f)).pushReceipt.turnKey, "old-push");
  assert.deepEqual((await f.view()).repositories, ["/source"]);
  assert.equal(f.sent.length, 0);
});

test("push recheck survives reload and remains pinned when another task changes HEAD", async (t) => {
  let now = Date.now(),
    available = false;
  const target = {
    repository: "/repo",
    remote: "origin",
    branch: "release",
    commit: "a".repeat(40),
  };
  const calls = [];
  let discovered = 0;
  const probe = scopedProbe({
    pushTarget: async () => (discovered++, target),
    pushedTarget: async (item) => (calls.push(item), available ? true : null),
  });
  const f = await fixture(t, undefined, "general", false, "claude", probe, () => now);
  await finishPush(f.engine, "planner", "push", "작업상태: 푸시", target);
  assert.equal((await stored(f)).progress, "done");
  assert.deepEqual((await stored(f)).pushTargets, [target]);
  assert.ok((await stored(f)).pushRetry);
  await f.engine.tick();
  assert.equal(calls.length, 1, "no immediate polling");
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port, undefined, probe, () => now);
  t.after(() => restored.close());
  available = true;
  now += 30_001;
  await restored.tick();
  assert.equal((await stored(f)).progress, "pushed");
  assert.equal((await stored(f)).pushRetry, null);
  assert.deepEqual(calls, [target, target]);
  assert.equal(discovered, 0, "neither initial checks nor retries discover current HEAD/upstream");
  assert.match(f.renamed.at(-1).title, /^🔵 /);
  assert.equal(f.sent.length, 0, "rechecking does not send any agent messages");
});

test("a push report is retried only while idle and stops after five attempts", async (t) => {
  let now = Date.now(),
    calls = 0;
  const target = { repository: "/repo", remote: "origin", branch: "main", commit: "a".repeat(40) };
  const f = await fixture(
    t,
    undefined,
    "general",
    false,
    "claude",
    scopedProbe({
      pushTarget: async () => target,
      pushedTarget: async () => (calls++, null),
    }),
    () => now,
  );
  await finishPush(f.engine, "planner", "push", "작업상태: 푸시", target);
  f.agents.get("planner").status = "running";
  now += 600_000;
  await f.engine.tick();
  assert.equal(calls, 1);
  f.agents.get("planner").status = "idle";
  f.agents.get("planner").permission = true;
  await f.engine.tick();
  assert.equal(calls, 1);
  f.agents.get("planner").permission = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    now += 600_000;
    await f.engine.tick();
  }
  assert.equal(calls, 6, "one initial check plus five retries");
  assert.equal((await stored(f)).pushRetry, null);
  assert.equal((await stored(f)).progress, "done");
});

test("new work, scope changes, failures and malformed targets cancel deferred push confirmation", async (t) => {
  for (const change of [
    "started",
    "active",
    "done",
    "repository",
    "target",
    "failed",
    "malformed",
  ]) {
    let now = Date.now(),
      calls = 0;
    const target = {
      repository: "/repo",
      remote: "origin",
      branch: "main",
      commit: "a".repeat(40),
    };
    const f = await fixture(
      t,
      undefined,
      "general",
      false,
      "claude",
      scopedProbe({
        pushTarget: async () => target,
        pushedTarget: async () => (calls++, null),
      }),
      () => now,
    );
    await finishPush(f.engine, "planner", "push", "작업상태: 푸시", target);
    if (change === "started") await f.engine.started("planner");
    if (change === "repository") await f.engine.setRepositories(f.id, ["/other"]);
    if (change === "target")
      await f.engine.ended(
        "planner",
        "next",
        `푸시대상: ${JSON.stringify([{ ...target, commit: "b".repeat(40) }])}`,
        null,
      );
    if (change === "active") await f.engine.ended("planner", "next", "작업상태: 진행", null);
    if (change === "done") await f.engine.ended("planner", "next", "작업상태: 완료", null);
    if (change === "failed") await f.engine.ended("planner", "next", "작업상태: 푸시", "canceled");
    if (change === "malformed") await f.engine.ended("planner", "next", "푸시대상: invalid", null);
    now += 600_000;
    await f.engine.tick();
    assert.equal(calls, 1, change);
    assert.equal((await stored(f)).pushRetry, null, change);
    if (change === "active") assert.deepEqual((await stored(f)).pushTargets, []);
  }
});

test("a mismatched new push cannot retain the prior receipt even if its report repeats the old target", async (t) => {
  const f = await fixture(t, undefined, "general", true, "codex", verifiedPushProbe);
  await finishPush(f.engine, "planner", "first");
  const report = `푸시대상: ${JSON.stringify([pushedCommit])}\n작업상태: 푸시`;
  await finishPush(f.engine, "planner", "mismatch", report, {
    ...pushedCommit,
    commit: "b".repeat(40),
  });
  assert.equal((await stored(f)).progress, "done");
  assert.equal((await stored(f)).pushReceipt, null);
});

test("a read-only follow-up preserves an existing legacy blue display without creating a receipt or pin", async (t) => {
  const f = await fixture(t, undefined, "general", true, "codex", verifiedPushProbe);
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  db.workflows[0].progress = "pushed";
  await writeFile(f.file, JSON.stringify(db));
  const engine = new WorkflowEngine(f.file, f.port, undefined, verifiedPushProbe);
  t.after(() => engine.close());
  await engine.ended("planner", "explain", "작업상태: 푸시", null);
  assert.equal((await stored(f)).progress, "pushed");
  assert.equal((await stored(f)).pushReceipt, null);
  assert.equal((await stored(f)).pushReview, null);
  await engine.ended("planner", "new-approval", "새 수정 커밋을 푸시할까요?", null);
  assert.equal((await stored(f)).progress, "done");
});

test("actual successful pushes determine the colour even if the assistant omits or understates the final status", async (t) => {
  for (const report of ["원격 반영을 확인했습니다.", "작업상태: 완료"]) {
    const f = await fixture(t, undefined, "general", true, "codex", verifiedPushProbe);
    await finishPush(f.engine, "planner", "push-without-label", report);
    assert.equal((await f.view()).progress, "pushed");
    assert.match(f.renamed.at(-1).title, /^🔵 /);
    await f.engine.ended("planner", "new-report", "작업상태: 완료", null);
    assert.equal((await f.view()).progress, "done", "old receipts do not override later work");
  }
});

test("push repair recovers same-task execution from history without resending or repinning acknowledged work", async (t) => {
  const f = await fixture(t, undefined, "general", true, "codex", verifiedPushProbe);
  const evidence = pushEvidence();
  f.histories.set("planner", {
    key: "old-push-turn",
    text: evidence.report,
    evidence,
    failed: null,
    messageIds: ["approved"],
  });
  let pinnedAt = null,
    pinCalls = 0;
  f.port.pushReview = {
    get: async () => ({ pinnedAt }),
    pin: async () => {
      pinCalls++;
      return (pinnedAt = "automatic");
    },
    unpin: async () => {
      pinnedAt = null;
      return true;
    },
  };
  await f.engine.setProgress(1, "pushed", "project");
  assert.equal((await f.view()).progress, "pushed");
  assert.equal((await stored(f)).pushReceipt.turnKey, "old-push-turn");
  assert.equal(pinCalls, 1);
  assert.equal(f.sent.length, 0);
  pinnedAt = null;
  await f.engine.setProgress(1, "pushed", "project");
  assert.equal(pinCalls, 1);
  assert.equal((await stored(f)).pushReview.workspaces[0].phase, "acknowledged");
});

test("push repair rejects a stale history claim, pending approval and a mismatched requested target", async (t) => {
  for (const report of ["작업상태: 진행", "푸시할까요?", "작업상태: 푸시"]) {
    const f = await fixture(t, undefined, "general", true, "codex", verifiedPushProbe);
    const evidence = pushEvidence(pushedCommit, report);
    f.histories.set("planner", {
      key: "old",
      text: report,
      evidence,
      failed: null,
      messageIds: [],
    });
    await f.engine.setProgress(1, "pushed", "project", [
      { ...pushedCommit, commit: "b".repeat(40) },
    ]);
    assert.equal((await f.view()).progress, "done");
    assert.equal((await stored(f)).pushReceipt, null);
  }
});

async function historicalPushFixture(t, probe = verifiedPushProbe) {
  const f = await fixture(t, undefined, "general", true, "codex", probe);
  const targets = `푸시대상: ${JSON.stringify([pushedCommit])}`;
  await f.engine.ended("planner", "prepared", `${targets}\n작업상태: 완료`, null);
  const report = `${targets}\n작업상태: 푸시`;
  const turn = {
    key: "selected-push-response",
    text: report,
    evidence: pushEvidence(pushedCommit, report),
    failed: null,
    messageIds: ["selected-message"],
  };
  const later = [
    {
      key: "installation-explanation",
      text: "맥북 터미널에서 기존 설치 파일을 실행하세요.",
      evidence: { report: "설치 방법만 설명했습니다.", changed: false, pushes: [] },
      failed: null,
      messageIds: ["later-message"],
    },
  ];
  const requests = [];
  f.port.historicalPush = async (agentId, messageId) => {
    requests.push({ agentId, messageId });
    return { turn, later };
  };
  f.histories.set("planner", later[0]);
  const source = { agentId: "planner", messageId: "selected-message" };
  return { ...f, source, turn, later, requests };
}

test("an explicit historical source restores only its exact push after read-only follow-ups", async (t) => {
  const checked = [];
  const f = await historicalPushFixture(t, {
    ...verifiedPushProbe,
    pushedTarget: async (target) => (checked.push(target), true),
  });
  f.turn.evidence.changed = true; // Edits before the surviving push belong to that same response.
  f.later[0].text += "\n```text\n작업상태: 진행\n```";
  await f.engine.setProgress(1, "pushed", "project", undefined, f.source);
  const saved = await stored(f);
  assert.equal(saved.progress, "pushed");
  assert.equal(saved.pushReceipt.agentId, "planner");
  assert.equal(saved.pushReceipt.turnKey, f.turn.key);
  assert.deepEqual(saved.pushReceipt.calls, ["successful-push"]);
  assert.deepEqual(checked, [pushedCommit]);
  assert.deepEqual(f.requests, [f.source]);
  assert.match(f.renamed.at(-1).title, /\[PUSH\]/);
  assert.equal(f.sent.length, 0);
});

test("historical recovery accepts follow-ups that only repeat the identical push targets", async (t) => {
  const f = await historicalPushFixture(t);
  f.later[0].text = `커밋이 원격에 있습니다.\n\n푸시대상: ${JSON.stringify([pushedCommit])}\n\n작업상태: 푸시`;
  await f.engine.setProgress(1, "pushed", "project", undefined, f.source);
  const saved = await stored(f);
  assert.equal(saved.progress, "pushed");
  assert.equal(saved.pushReceipt.turnKey, f.turn.key);
  assert.equal(f.sent.length, 0);
});

test("historical recovery is opt-in and never replaces targets or a newer phase", async (t) => {
  for (const kind of [
    "normal",
    "target-input",
    "other-state",
    "wrong-agent",
    "new-target",
    "active",
    "running",
    "error",
    "archived",
    "existing-receipt",
  ]) {
    const f = await historicalPushFixture(t);
    let source = f.source,
      progress = "pushed",
      targets;
    if (kind === "normal") source = undefined;
    if (kind === "target-input") targets = [pushedCommit];
    if (kind === "other-state") progress = "done";
    if (kind === "wrong-agent") source = { ...source, agentId: "other-workflow" };
    if (kind === "new-target")
      await f.engine.ended(
        "planner",
        "new-target",
        `푸시대상: ${JSON.stringify([{ ...pushedCommit, commit: "b".repeat(40) }])}\n작업상태: 완료`,
        null,
      );
    if (kind === "active") await f.engine.ended("planner", "new-work", "작업상태: 진행", null);
    if (kind === "running" || kind === "error") f.agents.get("planner").status = kind;
    if (kind === "archived") f.agents.get("planner").archived = true;
    if (kind === "existing-receipt") await finishPush(f.engine, "planner", "existing");
    const before = await stored(f),
      titles = f.renamed.length;
    if (kind === "normal") {
      await f.engine.setProgress(1, progress, "project");
      assert.equal(f.requests.length, 0);
      assert.equal((await stored(f)).progress, "done");
      assert.equal((await stored(f)).pushReceipt, null);
    } else {
      await assert.rejects(
        f.engine.setProgress(1, progress, "project", targets, source),
        undefined,
        kind,
      );
      assert.deepEqual(await stored(f), before, kind);
      assert.equal(f.renamed.length, titles, kind);
    }
    assert.equal(f.sent.length, 0, kind);
  }
});

test("historical recovery rejects later work, approval, targets and uncertain histories without mutation", async (t) => {
  const reports = [
    "작업상태: 진행",
    "작업상태: 계획",
    "작업상태: 진행\n설명을 마쳤습니다.\n작업상태: 완료",
    "작업상태: 계획\n설명을 마쳤습니다.\n작업상태: 완료",
    "푸시할까요?\n작업상태: 완료",
    `푸시대상: ${JSON.stringify([{ ...pushedCommit, commit: "b".repeat(40) }])}`,
    "푸시대상: broken",
    "작업저장소: /repo",
    decision("plan"),
    decision("continue"),
    "<paseo-workflow>broken</paseo-workflow>",
  ];
  for (const kind of [
    ...reports,
    "changed",
    "compacted",
    "failed",
    "push",
    "port-rejected",
    "key-race",
    "runtime-race",
  ]) {
    const f = await historicalPushFixture(t);
    const followup = f.later[0];
    if (reports.includes(kind)) followup.text = followup.evidence.report = kind;
    if (kind === "changed") followup.evidence.changed = true;
    if (kind === "compacted") followup.compacted = true;
    if (kind === "failed") followup.failed = "canceled";
    if (kind === "push") followup.evidence.pushes = pushEvidence().pushes;
    if (kind === "port-rejected")
      f.port.historicalPush = async () => {
        throw Error("후속 tool activity");
      };
    if (kind === "key-race") f.histories.set("planner", { ...followup, key: "new-user-response" });
    if (kind === "runtime-race")
      f.port.history = async () => {
        f.agents.get("planner").status = "running";
        return followup;
      };
    const before = await stored(f),
      titles = f.renamed.length;
    await assert.rejects(
      f.engine.setProgress(1, "pushed", "project", undefined, f.source),
      undefined,
      kind,
    );
    assert.deepEqual(await stored(f), before, kind);
    assert.equal(f.renamed.length, titles, kind);
    assert.equal(f.sent.length, 0, kind);
  }
});

test("historical source must contain matching successful execution and a completed push report", async (t) => {
  for (const kind of [
    "failed",
    "pending",
    "no-report",
    "no-push",
    "other-push",
    "extra-push",
    "reported-other-target",
    "invalid-target-report",
  ]) {
    const f = await historicalPushFixture(t);
    if (kind === "failed") f.turn.failed = "canceled";
    if (kind === "pending") f.turn.evidence.report = "푸시할까요?\n작업상태: 푸시";
    if (kind === "no-report") f.turn.evidence.report = "설명만 합니다.";
    if (kind === "no-push") f.turn.evidence.pushes = [];
    if (kind === "other-push") f.turn.evidence.pushes[0].commit = "b".repeat(40);
    if (kind === "extra-push")
      f.turn.evidence.pushes.push({
        ...f.turn.evidence.pushes[0],
        cwd: "/unrelated",
        callId: "foreign-push",
      });
    if (kind === "reported-other-target")
      f.turn.text = `푸시대상: ${JSON.stringify([{ ...pushedCommit, commit: "b".repeat(40) }])}\n작업상태: 푸시`;
    if (kind === "invalid-target-report") f.turn.text = "푸시대상: broken\n작업상태: 푸시";
    const before = await stored(f);
    await assert.rejects(
      f.engine.setProgress(1, "pushed", "project", undefined, f.source),
      undefined,
      kind,
    );
    assert.deepEqual(await stored(f), before, kind);
  }
});

test("historical execution still needs current remote confirmation", async (t) => {
  const f = await historicalPushFixture(t, {
    ...verifiedPushProbe,
    pushedTarget: async () => null,
  });
  await f.engine.setProgress(1, "pushed", "project", undefined, f.source);
  const saved = await stored(f);
  assert.equal(saved.progress, "done");
  assert.equal(saved.pushReceipt.turnKey, f.turn.key);
  assert.equal(saved.pushUnverified, true);
  assert.doesNotMatch(f.renamed.at(-1).title, /\[PUSH\]/);
  assert.equal(f.sent.length, 0);
});

test("historical recovery cannot hide an earlier plan behind a later completion block", async (t) => {
  const f = await historicalPushFixture(t);
  f.later[0].text = `${decision("plan")}\n${decision("complete")}`;
  f.later[0].evidence.report = decision("complete");
  const before = await stored(f),
    titles = f.renamed.length;
  await assert.rejects(
    f.engine.setProgress(1, "pushed", "project", undefined, f.source),
    /여러 작업 상태 블록/,
  );
  assert.deepEqual(await stored(f), before);
  assert.equal(f.renamed.length, titles);
  assert.equal(f.sent.length, 0);
});

test("manual repair cannot turn another task's remotely present commit into this task's completed push", async (t) => {
  const calls = [];
  const target = { repository: "/repo", remote: "origin", branch: "main", commit: "a".repeat(40) };
  const f = await fixture(
    t,
    undefined,
    "general",
    false,
    "claude",
    scopedProbe({
      pushedTarget: async (item) => (calls.push(item), item.commit === target.commit),
    }),
  );
  await f.engine.setProgress(1, "pushed", "project", [target]);
  assert.equal((await stored(f)).progress, "done");
  assert.equal(calls.length, 0, "remote presence is not a task execution receipt");
  await finishPush(f.engine, "planner", "actual-push", "작업상태: 푸시", target);
  assert.equal((await stored(f)).progress, "pushed");
  assert.equal((await stored(f)).pushCheck.targets[0].result, "pushed");
  await f.engine.setProgress(1, "pushed", "project", [target]);
  assert.equal((await stored(f)).progress, "pushed", "same task's actual push can be rechecked");
  await f.engine.setProgress(1, "pushed", "project", [{ ...target, commit: "b".repeat(40) }]);
  assert.equal((await stored(f)).progress, "done");
  assert.equal((await stored(f)).pushCheck, null);
  assert.equal((await stored(f)).pushReceipt, null);
  assert.equal(calls.length, 2);
  const priorTargets = (await f.view()).pushTargets;
  await assert.rejects(f.engine.setProgress(1, "active", "project", [target]), /푸시 상태/);
  assert.deepEqual(
    (await f.view()).pushTargets,
    priorTargets,
    "rejected requests do not mutate evidence",
  );
  const noProbe = await fixture(t, undefined, "general", false);
  await noProbe.engine.setProgress(1, "pushed");
  assert.equal((await noProbe.view()).progress, "done");
});

test("verified pushes pin with a visible review marker; unpin survives reload and duplicate reports", async (t) => {
  const target = { repository: "/repo", remote: "origin", branch: "main", commit: "a".repeat(40) };
  const probe = scopedProbe({ pushedTarget: async () => true });
  const f = await fixture(t, undefined, "general", false, "claude", probe);
  let pinned = false,
    calls = 0;
  f.port.pushReview = {
    get: async () => ({ pinnedAt: pinned ? `auto-${calls}` : null }),
    pin: async () => {
      pinned = true;
      calls++;
      return `auto-${calls}`;
    },
    unpin: async () => {
      pinned = false;
      return true;
    },
  };
  const report = (item) => `푸시대상: ${JSON.stringify([item])}\n작업상태: 푸시`;
  await finishPush(f.engine, "planner", "push", report(target), target);
  assert.equal(calls, 1);
  assert.match(f.renamed.at(-1).title, /^🔵 .* \[PUSH\] /);
  await f.engine.tick();
  assert.equal(calls, 1);
  pinned = false;
  await f.engine.tick();
  assert.match(f.renamed.at(-1).title, /\[PUSH\]/);
  assert.equal((await stored(f)).pushReview.workspaces[0].phase, "acknowledged");
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port, undefined, probe);
  t.after(() => restored.close());
  await restored.ended("planner", "same", report(target), null);
  await restored.tick();
  assert.equal(calls, 1);
  await finishPush(restored, "planner", "new", report({ ...target, commit: "b".repeat(40) }), {
    ...target,
    commit: "b".repeat(40),
  });
  await restored.tick();
  assert.equal(calls, 2);
  assert.match(f.renamed.at(-1).title, / \[PUSH\] /);
});

test("unverified work and legacy pushed work are never automatically pinned", async (t) => {
  let verified = false,
    calls = 0;
  const target = { repository: "/repo", remote: "origin", branch: "main", commit: "a".repeat(40) };
  const f = await fixture(
    t,
    undefined,
    "general",
    false,
    "claude",
    scopedProbe({ pushedTarget: async () => verified }),
  );
  f.port.pushReview = {
    get: async () => ({ pinnedAt: null }),
    pin: async () => {
      calls++;
      return "auto";
    },
  };
  await finishPush(f.engine, "planner", "unconfirmed", "작업상태: 푸시", target);
  assert.equal(calls, 0);
  await f.engine.configure({ ...(await f.engine.settings()), autoPinPushed: false });
  verified = true;
  await finishPush(f.engine, "planner", "confirmed", "작업상태: 푸시", target);
  await f.engine.configure({ ...(await f.engine.settings()), autoPinPushed: true });
  await f.engine.tick();
  assert.equal(calls, 0);
  assert.equal((await stored(f)).pushReview, null);
});

test("a new approval request without a status line clears old blue and only its automatic pin", async (t) => {
  for (const manual of [false, true]) {
    const f = await fixture(t, undefined, "general", false, "claude", verifiedPushProbe);
    let pinnedAt = manual ? "manual" : null;
    f.port.pushReview = {
      get: async () => ({ pinnedAt }),
      pin: async () => (pinnedAt = "automatic"),
      unpin: async (_id, expected) => {
        assert.equal(expected, pinnedAt);
        pinnedAt = null;
        return true;
      },
    };
    await finishPush(f.engine, "planner", "old-push");
    assert.equal((await f.view()).progress, "pushed");
    const report =
      "새 자동 업데이트 커밋을 만들었습니다. feature/github-updates를 푸시하고 CI 후 배포까지 진행할까요?";
    await f.engine.ended(
      "planner",
      "new-approval",
      `이전 작업상태는 아래와 같습니다.\n작업상태: 푸시\n${report}`,
      null,
      "",
      false,
      "",
      false,
      undefined,
      { report, changed: true, pushes: [] },
    );
    assert.equal((await f.view()).progress, "done");
    assert.equal((await stored(f)).pushReceipt, null);
    assert.equal((await stored(f)).pushRetry, null);
    assert.equal(pinnedAt, manual ? "manual" : null);
    assert.match(f.renamed.at(-1).title, /^🟢 /);
    assert.doesNotMatch(f.renamed.at(-1).title, /\[PUSH\]/);
    await f.engine.tick();
    assert.equal((await f.view()).progress, "done");
  }
});

test("target changes, edits and repository changes invalidate old receipts even without a new status declaration", async (t) => {
  for (const kind of ["target", "malformed", "repository", "edit", "failed edit"]) {
    const f = await fixture(t, undefined, "general", false, "claude", verifiedPushProbe);
    await finishPush(f.engine, "planner", "old");
    if (kind === "repository") await f.engine.setRepositories(f.id, ["/other"]);
    else {
      const text =
        {
          target: `푸시대상: ${JSON.stringify([{ ...pushedCommit, commit: "b".repeat(40) }])}`,
          malformed: "푸시대상: invalid",
        }[kind] ?? "수정 중입니다.";
      await f.engine.ended(
        "planner",
        "next",
        text,
        kind === "failed edit" ? "canceled" : null,
        "",
        false,
        "",
        false,
        undefined,
        { report: text, changed: kind.includes("edit"), pushes: [] },
      );
    }
    assert.notEqual((await f.view()).progress, "pushed", kind);
    assert.equal((await stored(f)).pushReceipt, null, kind);
    assert.doesNotMatch(f.renamed.at(-1).title, /^🔵 /, kind);
  }
});

test("remote availability and success prose cannot replace a matching successful command", async (t) => {
  let headReads = 0;
  const f = await fixture(t, undefined, "general", false, "claude", {
    ...verifiedPushProbe,
    pushTarget: async () => (headReads++, pushedCommit),
  });
  await f.engine.ended("planner", "claim", "푸시 완료\n작업상태: 푸시", null);
  assert.equal((await f.view()).progress, "done");
  assert.equal(headReads, 0);
  await finishPush(
    f.engine,
    "planner",
    "wrong-target",
    `푸시대상: ${JSON.stringify([{ ...pushedCommit, commit: "b".repeat(40) }])}\n작업상태: 푸시`,
  );
  assert.equal((await f.view()).progress, "done");
  assert.equal((await stored(f)).pushReceipt, null);
  await finishPush(f.engine, "planner", "real-target");
  assert.equal((await f.view()).progress, "pushed");
  await f.engine.ended("planner", "installation-help", "같은 버전의 설치 방법입니다.", null);
  assert.equal(
    (await f.view()).progress,
    "pushed",
    "read-only follow-ups retain the actual receipt",
  );
});

test("replayed general turns cannot re-pin acknowledged work, even when that turn included edits", async (t) => {
  const f = await fixture(t, undefined, "general", false, "claude", verifiedPushProbe);
  let calls = 0,
    pinnedAt = null;
  f.port.pushReview = {
    get: async () => ({ pinnedAt }),
    pin: async () => (pinnedAt = `auto-${++calls}`),
    unpin: async () => {
      pinnedAt = null;
      return true;
    },
  };
  const evidence = { ...pushEvidence(), changed: true };
  const ended = (engine) =>
    engine.ended(
      "planner",
      "same-completed-turn",
      "작업상태: 푸시",
      null,
      "",
      false,
      "",
      false,
      undefined,
      evidence,
    );
  await ended(f.engine);
  pinnedAt = null;
  await f.engine.tick();
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port, undefined, verifiedPushProbe);
  t.after(() => restored.close());
  await ended(restored);
  assert.equal(calls, 1);
  assert.equal(pinnedAt, null);
  assert.equal((await stored(f)).pushReview.workspaces[0].phase, "acknowledged");
});

test("legacy pin adoption rejects changed timestamps, acknowledged work and different push targets", async (t) => {
  const f = await fixture(t, undefined, "general", false, "claude", verifiedPushProbe);
  let pinnedAt = "existing-pin";
  f.port.pushReview = {
    get: async () => ({ pinnedAt }),
    pin: async () => assert.fail(),
    unpin: async () => assert.fail(),
  };
  await finishPush(f.engine, "planner", "push");
  const review = (await stored(f)).pushReview;
  assert.equal(review.workspaces[0].ownedPinAt, null);
  await assert.rejects(
    f.engine.adoptReviewPins(f.id, "wrong-target", [{ workspaceId: "initial", pinnedAt }]),
    /다릅니다/,
  );
  await assert.rejects(
    f.engine.adoptReviewPins(f.id, review.key, [{ workspaceId: "initial", pinnedAt: "older" }]),
    /변경/,
  );
  assert.deepEqual(
    await f.engine.adoptReviewPins(f.id, review.key, [{ workspaceId: "initial", pinnedAt }]),
    { adopted: 1 },
  );
  pinnedAt = null;
  await f.engine.tick();
  await assert.rejects(
    f.engine.adoptReviewPins(f.id, review.key, [
      { workspaceId: "initial", pinnedAt: "existing-pin" },
    ]),
    /확인/,
  );
});

test("evidence and repetition guard use all selected repositories outside the starting folder", async (t) => {
  let revision = 0;
  const changes = [];
  const probe = scopedProbe({
    snapshot: async (cwd) => ({
      head: "same",
      dirty: cwd.endsWith("beta") ? [`file:${revision++}`] : [],
    }),
    changes: async (cwd) => (changes.push(cwd), cwd),
  });
  const f = await fixture(t, undefined, undefined, undefined, "claude", probe);
  const roots = [path.join(path.dirname(f.file), "alpha"), path.join(path.dirname(f.file), "beta")];
  await f.engine.setRepositories(f.id, roots);
  await f.finish("planner", "start", "plan");
  for (let i = 0; i < 5; i++) {
    await f.finish(f.created[0].id, `result-${i}`, "result");
    await f.finish("planner", `plan-${i}`, "plan");
  }
  assert.deepEqual([...new Set(changes)], roots);
  assert.equal((await stored(f)).repeatedPlans, 0);
});

async function addWriter(f, cwd, mode = "general", id = "other") {
  const snapshot = { ...f.agents.get("planner"), cwd, id, workspaceId: id, status: "running" };
  f.agents.set(id, snapshot);
  return f.engine.enroll(snapshot, { provider: "codex" }, {}, mode);
}
test("general writers in nested or symlinked directories delay federation, then release it", async (t) => {
  const { symlink } = await import("node:fs/promises");
  const f = await fixture(t);
  const root = path.dirname(f.file);
  await mkdir(path.join(root, "src"));
  await symlink(path.join(root, "src"), path.join(root, "linked"));
  const other = await addWriter(f, path.join(root, "linked"));
  await f.finish("planner", "plan", "plan");
  assert.equal(f.sent.length, 0);
  assert.match((await f.view()).conflict, /다른 작업/);
  f.agents.get("other").status = "idle";
  await f.engine.ended("other", "done", "finished", null);
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.view()).conflict, "");
  assert.ok((await f.engine.list()).workflows.some((w) => w.id === other));
});

test("general overlap warns both conversations without sending or blocking their turns", async (t) => {
  const f = await fixture(t, undefined, "general");
  f.agents.get("planner").status = "running";
  await addWriter(f, path.dirname(f.file));
  await f.engine.started("other");
  assert.ok((await f.engine.list()).workflows.every((w) => w.conflict.includes("동시 수정")));
  assert.equal(f.sent.length, 0);
  f.agents.get("other").status = "idle";
  await f.engine.ended("other", "finished", "done", null);
  assert.ok((await f.engine.list()).workflows.every((w) => !w.conflict));
});

test("a running executor finishes into the general handoff; reload and late results never resend", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "plan", "plan");
  const executor = f.created[0].id;
  await f.engine.control(f.id, "general");
  assert.equal((await stored(f)).generalTransition, true);
  await assert.rejects(f.engine.control(f.id, "resume"), /전환/);
  await f.finish(executor, "final-result", "result");
  const w = await stored(f);
  assert.equal(w.mode, "general");
  assert.equal(w.execute, null);
  assert.ok(w.history.includes(executor));
  const handoff = JSON.parse(w.generalHandoff);
  assert.equal(handoff.pending.stage, "sent");
  assert.match(handoff.finishedTurns[0].text, /result summary/);
  assert.match(f.sent.at(-1).prompt, /진행 방식: 일반개발/);
  assert.equal(f.sent.length, 2);
  await f.engine.ended(executor, "late-result", decision("result"), null);
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port);
  t.after(() => restored.close());
  await restored.tick();
  assert.equal(f.sent.length, 2);
});

test("general transition preserves unread paused results and queued work; permission and compaction must settle", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "plan", "plan");
  const executor = f.created[0].id;
  await f.engine.control(f.id, "pause");
  await f.finish(executor, "unread", "result");
  f.agents.get(executor).permission = true;
  await f.engine.control(f.id, "general");
  assert.equal((await stored(f)).generalTransition, true);
  f.agents.get(executor).permission = false;
  // Simulate a live compaction and verify no conversion races it.
  f.engine.database.workflows[0].execute.compaction = "compact-id";
  f.engine.compacting.set(executor, Promise.resolve());
  await f.engine.tick();
  assert.equal((await stored(f)).mode, "federated");
  f.engine.database.workflows[0].execute.compaction = null;
  f.engine.compacting.delete(executor);
  await f.engine.tick();
  const handoff = JSON.parse((await stored(f)).generalHandoff);
  assert.equal(handoff.inbox.key, "unread");
  assert.match(handoff.inbox.text, /result summary/);
});

for (const receipt of [true, false])
  test(`general transition send ambiguity is resolved from history (${receipt}) without retry`, async (t) => {
    const f = await fixture(t);
    await f.finish("planner", "plan", "plan");
    f.agents.get(f.created[0].id).status = "idle";
    f.histories.set(f.created[0].id, {
      key: "final-before-event",
      text: decision("result"),
      failed: null,
      messageIds: [(await stored(f)).pending.id],
    });
    let attempts = 0;
    f.port.send = async (id, prompt, messageId) => {
      attempts++;
      if (receipt)
        f.histories.set(id, { text: "", key: "", failed: null, messageIds: [messageId] });
      throw new Error("ack lost");
    };
    await f.engine.control(f.id, "general");
    await f.engine.close();
    const restored = new WorkflowEngine(f.file, f.port);
    t.after(() => restored.close());
    await restored.tick();
    await restored.tick();
    assert.equal(attempts, 1);
    assert.equal((await stored(f)).generalDelivery.stage, receipt ? "sent" : "uncertain");
    assert.equal((await stored(f)).status, receipt ? "active" : "needs_input");
    if (!receipt) {
      await restored.started("planner");
      assert.equal((await stored(f)).status, "active");
    }
  });

test("critical constraints survive fifty later memories, reload and full context", async (t) => {
  const f = await fixture(t);
  await f.engine.ended(
    "planner",
    "first-rule",
    rememberedDecision("note", ["배포 전에 사용자 승인"]),
    null,
  );
  for (let i = 0; i < 6; i++)
    await f.engine.ended(
      "planner",
      `rules-${i}`,
      rememberedDecision(
        "note",
        Array.from({ length: 10 }, (_, j) => `later-${i}-${j}`),
      ),
      null,
    );
  assert.equal((await stored(f)).memories.length, 50);
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port);
  t.after(() => restored.close());
  await restored.ended("planner", "after-reload", decision("plan"), null);
  assert.match(f.sent.at(-1).prompt, /배포 전에 사용자 승인/);
  assert.equal(f.sent.at(-1).prompt.split("배포 전에 사용자 승인").length - 1, 1);
  const handoff = JSON.parse(
    await readFile(path.join(path.dirname(f.file), "handoffs", `${f.id}.json`), "utf8"),
  );
  assert.ok(Object.values(handoff.constraints).includes("배포 전에 사용자 승인"));
});

test("structured checks are tied to the commit and existing log, without executing their commands", async (t) => {
  const f = await fixture(t, undefined, "federated", undefined, "claude", scopedProbe());
  await writeFile(path.join(path.dirname(f.file), "check.log"), "test passed");
  await f.finish("planner", "p", "plan");
  f.agents.get(f.created[0].id).status = "idle";
  const item = {
    command: "never execute this report",
    cwd: ".",
    commit: "a".repeat(40),
    exitCode: 0,
    logPath: "check.log",
    criterion: "regression",
  };
  await f.engine.ended(
    f.created[0].id,
    "r",
    withArtifacts("result", { verification: [item] }),
    null,
  );
  assert.equal((await stored(f)).verification[0].state, "matched");
  assert.match(f.sent.at(-1).prompt, /로그 내용 직접 확인 필요/);
  assert.match(f.sent.at(-1).prompt, /check.log/);
});

test("a transition waits for missing final history and recovers it before retiring an executor", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "plan", "plan");
  const executor = f.created[0].id;
  f.agents.get(executor).status = "idle";
  await f.engine.control(f.id, "general");
  assert.equal((await stored(f)).generalTransition, true);
  assert.equal(f.sent.length, 1);
  f.histories.set(executor, {
    key: "missed-ended-event",
    text: decision("result"),
    failed: null,
    messageIds: [(await stored(f)).pending.id],
  });
  // A restart left an old marker, but the provider is now idle. Do not claim compaction.
  f.engine.database.workflows[0].plan.compaction = "unverified-old-maintenance";
  await f.engine.tick();
  const w = await stored(f);
  assert.equal(w.mode, "general");
  assert.equal(w.plan.compactions, 0);
  const handoff = JSON.parse(w.generalHandoff);
  assert.equal(handoff.maintenanceAtTransition.plan, "unverified-old-maintenance");
  assert.equal(handoff.finishedTurns[0].key, "missed-ended-event");
  assert.match(handoff.finishedTurns[0].text, /result summary/);
});

test("a truncated snapshot cannot trigger the unchanged-plan stop", async (t) => {
  const f = await fixture(
    t,
    undefined,
    undefined,
    undefined,
    "claude",
    scopedProbe({
      snapshot: async () => ({ head: "same", dirty: ["400 visible files"], incomplete: true }),
    }),
  );
  await f.engine.configure({ ...(await f.engine.settings()), maxCycles: 10 });
  await f.finish("planner", "plan", "plan");
  for (let i = 0; i < 5; i++) {
    await f.finish(f.created[0].id, `result-${i}`, "result");
    await f.finish("planner", `plan-${i}`, "plan");
  }
  assert.equal((await stored(f)).status, "active");
  assert.equal((await stored(f)).repeatedPlans, 0);
});

function managedFixtureRunner() {
  const records = new Map();
  let executions = 0;
  const runner = {
    records,
    executions: () => executions,
    prepare: async (workflowId, epoch, targets) => {
      const record = {
        id: randomUUID(),
        workflowId,
        epoch,
        state: "prepared",
        createdAt: "2026-10-15T00:00:00Z",
        updatedAt: "2026-10-15T00:00:00Z",
        approvedAt: null,
        error: "",
        targets: targets.map((t) => ({
          ...t,
          remoteUrl: "https://example.com/repo.git",
          exitCode: null,
          verified: null,
          startedAt: null,
          finishedAt: null,
          error: "",
        })),
      };
      records.set(record.id, record);
      return structuredClone(record);
    },
    read: async (id) => structuredClone(records.get(id)),
    history: async (id) =>
      [...records.values()].filter((r) => r.workflowId === id).map((r) => structuredClone(r)),
    isRunning: () => false,
    execute: async (id) => {
      const r = records.get(id);
      if (r.state !== "prepared") return structuredClone(r);
      executions++;
      r.state = "pushed";
      r.approvedAt = r.updatedAt;
      for (const t of r.targets) {
        t.exitCode = 0;
        t.verified = true;
      }
      return structuredClone(r);
    },
    recheck: async (id) => structuredClone(records.get(id)),
  };
  return runner;
}
async function managedReady(t, runner = managedFixtureRunner()) {
  const f = await fixture(
    t,
    undefined,
    "general",
    true,
    "codex",
    verifiedPushProbe,
    Date.now,
    runner,
  );
  await f.engine.ended(
    "planner",
    "ready",
    `푸시대상: ${JSON.stringify([pushedCommit])}\n작업상태: 완료`,
    null,
  );
  return { ...f, runner };
}

test("managed push requires exact preview approval and succeeds without any shell transcript", async (t) => {
  const f = await managedReady(t);
  let pin = null,
    pins = 0;
  f.port.pushReview = {
    get: async () => ({ pinnedAt: pin }),
    pin: async () => {
      pins++;
      return (pin = "automatic");
    },
    unpin: async () => {
      pin = null;
      return true;
    },
  };
  const request = await f.engine.prepareManagedPush(f.id);
  assert.equal(f.runner.executions(), 0);
  assert.equal(request.targets[0].commit, pushedCommit.commit);
  await assert.rejects(f.engine.executeManagedPush(f.id, request.id, false), /승인/);
  assert.equal(f.runner.executions(), 0);
  await f.engine.executeManagedPush(f.id, request.id, true);
  assert.equal((await f.view()).progress, "pushed");
  assert.equal(
    (await stored(f)).pushReceipt,
    null,
    "managed success needs no parsed shell receipt",
  );
  await f.engine.executeManagedPush(f.id, request.id, true);
  assert.equal(f.runner.executions(), 1);
  await f.engine.ended(
    "planner",
    "review",
    `작업저장소: /repo\n작업저장소: /worktree\n푸시대상: ${JSON.stringify([pushedCommit])}\n작업상태: 완료`,
    null,
  );
  assert.equal((await f.view()).progress, "pushed");
  assert.equal(pins, 1);
  pin = null;
  await f.engine.tick();
  assert.match(f.renamed.at(-1).title, /\[PUSH\]/);
  assert.equal(pins, 1, "acknowledgement never re-pins");
  assert.equal((await f.view()).pushHistory.length, 1);
});

test("managed previews cannot execute after target or phase changes and never cross tasks", async (t) => {
  for (const change of ["target", "edit", "scope"]) {
    const f = await managedReady(t);
    const request = await f.engine.prepareManagedPush(f.id);
    if (change === "scope") await f.engine.setRepositories(f.id, ["/new"]);
    else {
      const report =
        change === "target"
          ? `푸시대상: ${JSON.stringify([{ ...pushedCommit, commit: "b".repeat(40) }])}\n작업상태: 완료`
          : "새 수정\n작업상태: 진행";
      await f.engine.ended("planner", "changed", report, null, "", false, "", false, [], {
        report,
        changed: change === "edit",
        pushes: [],
      });
    }
    await assert.rejects(f.engine.executeManagedPush(f.id, request.id, true), /바뀌었습니다/);
    assert.equal(f.runner.executions(), 0);
    assert.equal((await f.view()).pushHistory.length, 1, "old request is retained in history");
  }
  const f = await managedReady(t);
  const foreign = await f.runner.prepare("other-workflow", 0, [pushedCommit]);
  await assert.rejects(f.engine.executeManagedPush(f.id, foreign.id, true), /바뀌었습니다/);
});

test("managed late success stays in history without completing newer work", async (t) => {
  const f = await managedReady(t);
  const request = await f.engine.prepareManagedPush(f.id);
  let start, finish;
  const started = new Promise((r) => {
    start = r;
  });
  const release = new Promise((r) => {
    finish = r;
  });
  const execute = f.runner.execute;
  f.runner.execute = async (id) => {
    start();
    await release;
    return execute(id);
  };
  const pending = f.engine.executeManagedPush(f.id, request.id, true);
  await started;
  await f.engine.ended("planner", "new-code", "작업상태: 진행", null, "", false, "", false, [], {
    report: "작업상태: 진행",
    changed: true,
    pushes: [],
  });
  finish();
  await pending;
  const view = await f.view();
  assert.equal(view.progress, "active");
  assert.equal(view.managedPush, null);
  assert.equal(view.pushHistory[0].state, "pushed");
  assert.doesNotMatch(f.renamed.at(-1).title, /\[PUSH\]/);
});

test("managed receipt survives plugin reload and a failed or unknown execution never becomes PUSH from prose", async (t) => {
  const f = await managedReady(t);
  const request = await f.engine.prepareManagedPush(f.id);
  await f.runner.execute(request.id); // Durable runner result before workflow acknowledgement.
  await f.engine.close();
  const restored = new WorkflowEngine(
    f.file,
    f.port,
    undefined,
    verifiedPushProbe,
    Date.now,
    f.runner,
  );
  t.after(() => restored.close());
  await restored.tick();
  assert.equal((await restored.list()).workflows[0].progress, "pushed");
  for (const state of ["failed", "unknown"]) {
    const other = await managedReady(t);
    const req = await other.engine.prepareManagedPush(other.id);
    other.runner.records.get(req.id).state = state;
    await other.engine.tick();
    await other.engine.ended("planner", "claims", "작업상태: 푸시", null);
    assert.equal((await other.view()).progress, "done");
    assert.match(other.renamed.at(-1).title, state === "failed" ? /푸시 실패/ : /푸시 확인필요/);
    await other.engine.recheckManagedPush(other.id, req.id);
    assert.equal(other.runner.executions(), 0);
  }
});

test("managed failed turns, structured new plans and manual target changes invalidate only the current phase", async (t) => {
  for (const kind of ["failed-edit", "plan", "manual-target"]) {
    const f = await managedReady(t);
    const request = await f.engine.prepareManagedPush(f.id);
    await f.engine.executeManagedPush(f.id, request.id, true);
    if (kind === "manual-target") {
      await f.engine.setProgress(1, "pushed", "project", [
        { ...pushedCommit, commit: "b".repeat(40) },
      ]);
    } else if (kind === "failed-edit") {
      await f.engine.ended(
        "planner",
        "failed-edit",
        "partial edit",
        "canceled",
        "",
        false,
        "",
        true,
        [],
        { report: "partial edit", changed: true, pushes: [] },
      );
    } else {
      await f.engine.close();
      const db = JSON.parse(await readFile(f.file, "utf8"));
      db.workflows[0].mode = "federated";
      db.workflows[0].status = "completed";
      await writeFile(f.file, JSON.stringify(db));
      const engine = new WorkflowEngine(
        f.file,
        f.port,
        undefined,
        verifiedPushProbe,
        Date.now,
        f.runner,
      );
      t.after(() => engine.close());
      await engine.ended("planner", "new-plan", decision("plan"), null);
      const view = (await engine.list()).workflows[0];
      assert.equal(view.managedPush, null);
      assert.equal(view.progress, "active");
      assert.equal(view.pushHistory[0].state, "pushed");
      assert.doesNotMatch(f.renamed.at(-1).title, /\[PUSH\]/);
      continue;
    }
    assert.equal((await f.view()).managedPush, null);
    assert.notEqual((await f.view()).progress, "pushed");
    assert.equal((await f.view()).pushHistory[0].state, "pushed");
  }
});

test("managed unknown blocks a new request and successful exit records are retried read-only", async (t) => {
  let time = 0;
  const runner = managedFixtureRunner();
  const f = await fixture(
    t,
    undefined,
    "general",
    true,
    "codex",
    verifiedPushProbe,
    () => time,
    runner,
  );
  await f.engine.ended(
    "planner",
    "ready",
    `푸시대상: ${JSON.stringify([pushedCommit])}\n작업상태: 완료`,
    null,
  );
  const request = await f.engine.prepareManagedPush(f.id);
  const record = runner.records.get(request.id);
  record.state = "unknown";
  record.targets[0].exitCode = 0;
  await f.engine.tick();
  await assert.rejects(f.engine.prepareManagedPush(f.id), /기존 푸시/);
  let checked;
  const checking = new Promise((resolve) => {
    checked = resolve;
  });
  runner.recheck = async (id) => {
    record.state = "pushed";
    record.targets[0].verified = true;
    checked();
    return runner.read(id);
  };
  time = 30001;
  await f.engine.tick();
  await checking;
  await new Promise((resolve) => setImmediate(resolve));
  await f.engine.tick();
  assert.equal(runner.executions(), 0);
  assert.equal((await f.view()).progress, "pushed");
  assert.equal((await stored(f)).managedRetry, null);
});

test("managed projection retries a failed title update and stops before execution if workflow persistence fails", async (t) => {
  const f = await managedReady(t);
  const request = await f.engine.prepareManagedPush(f.id);
  const write = f.engine.store.write.bind(f.engine.store);
  f.engine.store.write = async () => {
    throw Error("disk full");
  };
  await assert.rejects(f.engine.executeManagedPush(f.id, request.id, true), /disk full/);
  assert.equal(f.runner.executions(), 0);
  f.engine.store.write = write;
  const rename = f.port.rename;
  let failures = 0;
  f.port.rename = async (id, title) => {
    if (title.includes("[PUSH]") && failures++ === 0) throw Error("temporary disconnect");
    return rename(id, title);
  };
  await f.engine.executeManagedPush(f.id, request.id, true);
  assert.equal(f.runner.executions(), 1);
  assert.equal((await f.view()).progress, "pushed");
  await f.engine.tick();
  assert.match(f.renamed.at(-1).title, /\[PUSH\]/);
  assert.equal(f.runner.executions(), 1);
});

test("unverified push reports stay visibly unresolved across follow-ups and reload", async (t) => {
  const f = await fixture(t, undefined, "general", true, "codex", verifiedPushProbe);
  await f.engine.ended("planner", "done", "작업상태: 완료", null);
  await f.engine.ended("planner", "unverified", "작업상태: 푸시", null);
  assert.equal((await f.view()).progress, "done");
  assert.equal((await stored(f)).pushUnverified, true);
  assert.match(f.renamed.at(-1).title, /\[푸시 확인필요\]/);
  assert.equal((await stored(f)).pushReview, null);
  await f.engine.ended("planner", "explanation", "설명만 보충합니다.", null);
  assert.equal((await stored(f)).pushUnverified, true);
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port, undefined, verifiedPushProbe);
  t.after(() => restored.close());
  await restored.tick();
  assert.match(f.renamed.at(-1).title, /\[푸시 확인필요\]/);
  await finishPush(restored, "planner", "proven");
  assert.equal((await stored(f)).pushUnverified, false);
  assert.equal((await stored(f)).progress, "pushed");
  assert.match(f.renamed.at(-1).title, /\[PUSH\]/);
  assert.doesNotMatch(f.renamed.at(-1).title, /확인필요/);
  assert.equal(f.sent.length, 0);
});

test("a new phase or approval request removes an older unresolved push label", async (t) => {
  for (const report of [
    "작업상태: 진행",
    "푸시할까요?\n작업상태: 완료",
    "새 구현 완료\n작업상태: 완료",
  ]) {
    const f = await fixture(t, undefined, "general", true, "codex", verifiedPushProbe);
    await f.engine.ended("planner", "unverified", "작업상태: 푸시", null);
    await f.engine.ended("planner", "next", report, null, "", false, "", false, undefined, {
      report,
      changed: report.startsWith("새 구현"),
      pushes: [],
    });
    assert.equal((await stored(f)).pushUnverified, false, report);
    assert.doesNotMatch(f.renamed.at(-1).title, /푸시 확인필요/, report);
    assert.notEqual((await f.view()).progress, "pushed", report);
  }
});

test("failed remote confirmation is visible and a read-only retry clears the label", async (t) => {
  let available = false,
    now = Date.now();
  const f = await fixture(
    t,
    undefined,
    "general",
    true,
    "codex",
    {
      ...verifiedPushProbe,
      pushedTarget: async () => (available ? true : null),
    },
    () => now,
  );
  await finishPush(f.engine, "planner", "push");
  assert.match(f.renamed.at(-1).title, /\[푸시 확인필요\]/);
  available = true;
  now += 30_001;
  await f.engine.tick();
  assert.match(f.renamed.at(-1).title, /\[PUSH\]/);
  assert.equal((await stored(f)).pushUnverified, false);
  assert.equal(f.sent.length, 0);
});

test("user-requested plan or active state clears an older unresolved push label", async (t) => {
  for (const progress of ["계획", "진행"]) {
    const f = await fixture(t, undefined, "general", true, "codex", verifiedPushProbe);
    await f.engine.ended("planner", "unverified", "작업상태: 푸시", null);
    await f.engine.ended(
      "planner",
      "user-phase",
      "알겠습니다.",
      null,
      "",
      false,
      `작업상태: ${progress}`,
    );
    assert.equal((await stored(f)).pushUnverified, false);
    assert.doesNotMatch(f.renamed.at(-1).title, /푸시 확인필요/);
  }
});

test("malformed follow-up targets cannot silently clear an unresolved push", async (t) => {
  const f = await fixture(t, undefined, "general", true, "codex", verifiedPushProbe);
  await f.engine.ended("planner", "unverified", "작업상태: 푸시", null);
  await f.engine.ended("planner", "bad-target", "푸시대상: [잘못된 대상]", null);
  assert.equal((await stored(f)).invalidTargets, true);
  assert.equal((await stored(f)).pushUnverified, true);
  assert.match(f.renamed.at(-1).title, /\[푸시 확인필요\]/);
  assert.equal((await f.view()).progress, "done");
});

const auditPushTurn = () => {
  const text = `푸시대상: ${JSON.stringify([pushedCommit])}\n작업상태: 푸시`;
  return {
    key: "actual-push-turn",
    text,
    request: "푸시",
    auditRevision: "stable-provider-epoch",
    failed: null,
    messageIds: ["actual-push-request"],
    evidence: pushEvidence(pushedCommit, text),
  };
};
async function auditFixture(t, probe = verifiedPushProbe, now = Date.now) {
  const f = await fixture(t, undefined, "general", true, "codex", probe, now);
  await f.engine.ended("planner", "implementation", "작업상태: 완료", null);
  f.port.pushAuditHistory = async () => auditPushTurn();
  return f;
}

test("automatic push audit restores exact latest evidence and refreshes the persistent PUSH title", async (t) => {
  const checked = [];
  const f = await auditFixture(t, {
    ...verifiedPushProbe,
    pushedTarget: async (target) => (checked.push(target), true),
  });
  let reads = 0;
  f.port.pushAuditHistory = async () => (reads++, auditPushTurn());
  const before = await stored(f);
  await f.engine.auditPushes();
  const saved = await stored(f);
  assert.equal(saved.progress, "pushed");
  assert.deepEqual(saved.pushTargets, [pushedCommit]);
  assert.equal(saved.pushReceipt.turnKey, "actual-push-turn");
  assert.equal(saved.pushReceipt.agentId, "planner");
  assert.deepEqual(saved.pushReceipt.calls, ["successful-push"]);
  assert.deepEqual(saved.repositories, before.repositories, "does not replay older artifacts");
  assert.deepEqual(checked, [pushedCommit]);
  await f.engine.tick();
  assert.match(f.renamed.at(-1).title, /\[PUSH\]/);
  await f.engine.auditPushes();
  assert.equal(reads, 2, "successful task is never audited again");
  assert.equal(f.sent.length, 0);
});

test("automatic push audit supports completed federation without replaying its handoffs", async (t) => {
  const f = await fixture(t, undefined, "federated", true, "codex", verifiedPushProbe);
  await f.finish("planner", "plan", "plan");
  const executor = f.created[0].id;
  await f.finish(executor, "result", "result");
  await f.finish("planner", "review", "complete");
  const sent = f.sent.length;
  f.port.pushAuditHistory = async (id) => {
    if (id === executor) return auditPushTurn();
    return {
      key: "latest-final-review",
      text: `<paseo-workflow>${JSON.stringify({ status: "complete", summary: "검토 완료", next: "", handoff: "목표와 결과 검토 완료", checks: [], pushTargets: [pushedCommit] })}</paseo-workflow>`,
      failed: null,
      messageIds: [],
      evidence: { report: "검토 완료", changed: false, pushes: [] },
    };
  };
  await f.engine.auditPushes();
  const saved = await stored(f);
  assert.equal(saved.progress, "pushed", JSON.stringify(saved.pushAudit) + saved.artifactNotice);
  assert.equal(saved.pushReceipt.agentId, executor);
  assert.equal(saved.status, "completed");
  assert.equal(f.sent.length, sent);
});

test("automatic push audit caches absent evidence across reload and invalidates after a new event", async (t) => {
  let now = Date.now(),
    reads = 0;
  const f = await auditFixture(t, verifiedPushProbe, () => now);
  f.port.pushAuditHistory = async () => (
    reads++,
    {
      key: "latest-explanation",
      text: "설치 방법 설명입니다.",
      failed: null,
      messageIds: [],
      evidence: { report: "설치 방법 설명입니다.", changed: false, pushes: [] },
    }
  );
  await f.engine.auditPushes();
  await f.engine.auditPushes();
  assert.equal(reads, 1);
  assert.equal((await stored(f)).pushAudit.outcome, "none");
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port, undefined, verifiedPushProbe, () => now);
  t.after(() => restored.close());
  await restored.auditPushes();
  assert.equal(reads, 1, "restart preserves the next audit time");
  now += 600_001;
  await restored.auditPushes();
  assert.equal(reads, 2);
  await restored.ended("planner", "new-read-only-answer", "설명했습니다.", null);
  await restored.auditPushes();
  assert.equal(reads, 3, "a new completed turn invalidates the cache");
  assert.equal((await stored(f)).progress, "done");
});

test("automatic push audit bounds retries and preserves exhaustion across reload", async (t) => {
  let now = Date.now(),
    reads = 0;
  const f = await auditFixture(t, verifiedPushProbe, () => now);
  await f.engine.ended(
    "planner",
    "targets",
    `푸시대상: ${JSON.stringify([pushedCommit])}\n작업상태: 완료`,
    null,
  );
  f.port.pushAuditHistory = async () => {
    reads++;
    throw Error("offline");
  };
  for (let attempt = 1; attempt <= 5; attempt++) {
    await f.engine.auditPushes();
    const saved = await stored(f);
    assert.equal(saved.pushAudit.attempts, attempt);
    if (attempt < 5) {
      assert.equal(saved.pushAudit.after - now, 30_000 * 2 ** (attempt - 1));
      now = saved.pushAudit.after;
    }
  }
  assert.equal((await stored(f)).pushUnverified, true);
  now += 600_001;
  await f.engine.auditPushes();
  await f.engine.close();
  const restored = new WorkflowEngine(f.file, f.port, undefined, verifiedPushProbe, () => now);
  t.after(() => restored.close());
  await restored.auditPushes();
  assert.equal(reads, 5);
  assert.match((await stored(f)).artifactNotice, /완료하지 못했습니다/);
});

test("automatic push audit history I/O does not hold the workflow queue and admits one worker", async (t) => {
  const f = await auditFixture(t);
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let reads = 0;
  f.port.pushAuditHistory = async () => {
    reads++;
    entered();
    await gate;
    return auditPushTurn();
  };
  const running = f.engine.auditPushes();
  await started;
  await f.engine.auditPushes();
  assert.equal(reads, 1);
  await f.engine.setProgress(1, "active", "project");
  assert.equal(
    (await f.view()).progress,
    "active",
    "ordinary RPC completed while history is pending",
  );
  release();
  await running;
  assert.equal((await stored(f)).progress, "active");
  assert.equal(
    (await stored(f)).pushReceipt,
    null,
    "late successful result cannot finish new work",
  );
});

test("automatic push audit discards started, target and member races even when the stored colour stays done", async (t) => {
  for (const change of ["started", "targets", "member"]) {
    let entered, release;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const f = await auditFixture(t, {
      ...verifiedPushProbe,
      pushedTarget: async () => {
        entered();
        await gate;
        return true;
      },
    });
    const running = f.engine.auditPushes();
    await started;
    const w = f.engine.database.workflows[0];
    if (change === "started") await f.engine.started("planner");
    if (change === "targets") w.pushTargets = [{ ...pushedCommit, commit: "b".repeat(40) }];
    if (change === "member") w.plan.generation++;
    release();
    await running;
    assert.equal(w.progress, "done", change);
    assert.equal(w.pushReceipt, null, change);
  }
});

test("automatic push audit skips pending approvals, active work, transitions and managed pushes", async (t) => {
  const f = await auditFixture(t);
  let reads = 0;
  f.port.pushAuditHistory = async () => (reads++, auditPushTurn());
  const w = f.engine.database.workflows[0];
  for (const [field, value] of [
    ["progress", "active"],
    ["progress", "plan"],
    ["status", "needs_input"],
    ["status", "paused"],
    ["invalidTargets", true],
    ["inbox", {}],
    ["pending", {}],
    ["generalTransition", {}],
    ["managedPush", {}],
  ]) {
    const before = w[field];
    w[field] = value;
    await f.engine.auditPushes();
    w[field] = before;
  }
  assert.equal(reads, 0);
});

test("automatic push audit times out without duplicating a still-running lookup or applying its late success", async (t) => {
  let now = Date.now(),
    entered,
    release,
    reads = 0;
  const f = await auditFixture(t, verifiedPushProbe, () => now);
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.port.pushAuditHistory = async () => {
    reads++;
    entered();
    await gate;
    return auditPushTurn();
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = f.engine.auditPushes();
  await started;
  t.mock.timers.tick(30_001);
  await running;
  assert.equal((await stored(f)).pushAudit.outcome, "retry");
  now += 60_001;
  await f.engine.auditPushes();
  assert.equal(reads, 1, "unresolved timed-out work still owns its slot");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await stored(f)).progress, "done");
  assert.equal((await stored(f)).pushReceipt, null);
  await f.engine.auditPushes();
  assert.equal((await stored(f)).progress, "pushed");
});

test("automatic push audit prioritizes never-inspected tasks ahead of older retries", async (t) => {
  let now = Date.now();
  const f = await auditFixture(t, verifiedPushProbe, () => now);
  const reads = [];
  f.port.pushAuditHistory = async (id) => {
    reads.push(id);
    if (id === "planner") throw Error("offline");
    return auditPushTurn();
  };
  await f.engine.auditPushes();
  now += 30_001;
  const second = { ...f.agents.get("planner"), id: "second", workspaceId: "second-workspace" };
  f.agents.set(second.id, second);
  await f.engine.enroll(second, { provider: "codex" }, {}, "general", true);
  await f.engine.ended(second.id, "second-done", "작업상태: 완료", null);
  await f.engine.auditPushes();
  assert.deepEqual(reads, ["planner", "second", "second"]);
  assert.equal(
    (await f.engine.list()).workflows.find((w) => w.planAgentId === "second").progress,
    "pushed",
  );
});

test("automatic push audit crash on the last attempt records exhaustion without inventing a push claim", async (t) => {
  let now = Date.now(),
    reads = 0;
  const f = await auditFixture(t, verifiedPushProbe, () => now);
  f.port.pushAuditHistory = async () => {
    reads++;
    throw Error("offline");
  };
  await f.engine.auditPushes();
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  db.workflows[0].pushAudit = {
    ...db.workflows[0].pushAudit,
    outcome: "checking",
    attempts: 5,
    after: now,
  };
  await writeFile(f.file, JSON.stringify(db));
  const restored = new WorkflowEngine(f.file, f.port, undefined, verifiedPushProbe, () => now);
  t.after(() => restored.close());
  await restored.auditPushes();
  assert.equal(reads, 1);
  assert.equal((await stored(f)).pushAudit.outcome, "retry");
  assert.equal((await stored(f)).pushAudit.after, Number.MAX_SAFE_INTEGER);
  assert.equal((await stored(f)).pushUnverified, false, "no targets or push claim were observed");
  assert.match((await stored(f)).artifactNotice, /완료하지 못했습니다/);
});

for (const mode of ["general", "federated"]) {
  test(`${mode} planner direct exact-commit push is recognized from shell tools`, async (t) => {
    const f = await fixture(t, undefined, mode, true, "codex", verifiedPushProbe);
    const report = `작업상태: 푸시\n${withArtifacts("complete", { repositories: ["/repo"], pushTargets: [pushedCommit] })}`;
    const turn = readTurn(
      [
        { type: "user_message", text: "제시한 대상 푸시 승인합니다", messageId: "approval" },
        {
          type: "tool_call",
          callId: "direct-push",
          name: "exec_command",
          status: "completed",
          error: null,
          detail: {
            type: "shell",
            command: `git -C /repo push origin ${pushedCommit.commit}:refs/heads/main`,
            output: `To example:repo.git\n bbbbbbb..aaaaaaa ${pushedCommit.commit} -> main\n`,
            exitCode: 0,
          },
        },
        {
          type: "tool_call",
          callId: "remote-check",
          name: "exec_command",
          status: "completed",
          error: null,
          detail: {
            type: "shell",
            command: "git -C /repo ls-remote origin refs/heads/main",
            output: `${pushedCommit.commit}\trefs/heads/main\n`,
            exitCode: 0,
          },
        },
        { type: "assistant_message", text: report },
      ],
      "/repo",
    );
    assert.equal(turn.evidence.pushes.length, 1);
    await f.engine.ended(
      "planner",
      turn.key,
      turn.text,
      null,
      "",
      false,
      turn.request,
      false,
      turn.messageIds,
      turn.evidence,
    );
    const saved = await stored(f);
    assert.equal(saved.progress, "pushed");
    assert.equal(saved.pushReceipt.agentId, "planner");
    assert.deepEqual(saved.pushReceipt.calls, ["direct-push"]);
    assert.equal(saved.pushCheck.targets[0].result, "pushed");
    assert.match(f.renamed.at(-1).title, /^🔵 .*\[PUSH\]/);
  });
}

test("managed already-included recheck marks PUSH and pins without another execution", async (t) => {
  const f = await managedReady(t);
  let pins = 0;
  let pinnedAt = null;
  f.port.pushReview = {
    get: async () => ({ pinnedAt }),
    pin: async () => {
      pins++;
      return (pinnedAt = "automatic");
    },
    unpin: async () => true,
  };
  const request = await f.engine.prepareManagedPush(f.id);
  const record = f.runner.records.get(request.id);
  record.state = "failed";
  record.targets[0].exitCode = 1;
  await f.engine.recheckManagedPush(f.id, request.id);
  assert.equal((await f.view()).progress, "done");
  record.state = "pushed";
  record.targets[0].verified = true;
  record.targets[0].alreadyIncluded = true;
  await f.engine.recheckManagedPush(f.id, request.id);
  assert.equal((await f.view()).progress, "pushed");
  assert.equal(pins, 1);
  assert.equal(f.runner.executions(), 0);
  assert.match(f.renamed.at(-1).title, /^🔵 .*\[PUSH\]/);
});

test("a state file that fails to load is read again once it is repaired", async (t) => {
  const f = await fixture(t);
  const good = await readFile(f.file, "utf8");
  await writeFile(f.file, "{ broken");
  const restarted = new WorkflowEngine(f.file, f.port);
  t.after(() => restarted.close());
  await assert.rejects(restarted.startSettings(f.dir ?? path.dirname(f.file), "claude"));
  await writeFile(f.file, good);
  const settings = await restarted.startSettings(path.dirname(f.file), "claude");
  assert.equal(typeof settings.maxCycles, "number");
  assert.equal((await restarted.list()).workflows.length, 1);
});

test("a single failed daemon read in a tick is retried; a persistent one stops the flow", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  assert.equal((await f.view()).status, "active");
  const inspect = f.port.inspect;
  f.port.inspect = async () => {
    throw new Error("daemon timeout");
  };
  await f.engine.tick();
  await f.engine.tick();
  assert.equal((await f.view()).status, "active", "two transient failures are retried");
  f.port.inspect = inspect;
  await f.engine.tick();
  f.port.inspect = async () => {
    throw new Error("daemon timeout");
  };
  await f.engine.tick();
  await f.engine.tick();
  assert.equal((await f.view()).status, "active", "a success resets the count");
  await f.engine.tick();
  assert.equal((await f.view()).status, "error");
  assert.match((await f.view()).detail, /daemon timeout/);
  f.port.inspect = inspect;
});

test("a general switch stuck on an unreadable executor can be finished by asking again", async (t) => {
  const f = await fixture(t);
  await f.finish("planner", "p1", "plan");
  const executor = f.created[0].id;
  await f.engine.control(f.id, "general");
  assert.equal((await stored(f)).generalTransition, true);
  const agent = f.agents.get(executor);
  agent.status = "idle";
  agent.archived = true;
  await f.engine.tick();
  let w = await stored(f);
  assert.equal(w.status, "needs_input");
  assert.equal(w.generalTransition, true);
  assert.equal((await f.view()).generalTransition, true);
  await f.engine.control(f.id, "general");
  w = await stored(f);
  assert.equal(w.mode, "general");
  assert.equal(w.generalTransition, false);
  assert.equal(JSON.parse(w.generalHandoff).resultUnconfirmed, true);
});

test("more push targets than the state can hold are refused, keeping the file loadable", async (t) => {
  const f = await fixture(t, undefined, "general", false, "claude", verifiedPushProbe);
  await f.engine.ended("planner", "1", "제목: 많은 푸시\n작업상태: 진행", null);
  const pushes = Array.from({ length: 9 }, (_, index) => ({
    callId: `push-${index}`,
    cwd: "/repo",
    remote: "origin",
    branch: `branch-${index}`,
    commit: "a".repeat(40),
  }));
  await f.engine.ended(
    "planner",
    "2",
    "푸시함\n작업상태: 푸시",
    null,
    "",
    false,
    "",
    false,
    undefined,
    { report: "푸시함\n작업상태: 푸시", changed: false, pushes },
  );
  const view = await f.view();
  assert.notEqual(view.progress, "pushed");
  assert.ok((await stored(f)).pushTargets.length <= 8);
  const restarted = new WorkflowEngine(f.file, f.port);
  t.after(() => restarted.close());
  assert.equal((await restarted.list()).workflows.length, 1);
});
