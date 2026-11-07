import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WorkflowEngine } from "../server/engine.ts";
import { createRepoProbe } from "../server/git.ts";
import { settingsSchema } from "../shared/contracts.ts";
import { integrateWorktree } from "../server/worktree.ts";

const run = promisify(execFile);
const git = (cwd, ...args) =>
  run("git", ["-c", "user.email=wt@example.invalid", "-c", "user.name=wt", ...args], { cwd }).then((r) => r.stdout.trim());
const block = (status, extra = {}) =>
  `<paseo-workflow>${JSON.stringify({ status, summary: status, next: "구현 지시", handoff: "인계", checks: [], ...extra })}</paseo-workflow>`;
const ALL = [{ id: "high", label: "High", isDefault: true }];

async function fixture(t, { placement = "worktree", overlap = true, foreign = false, unavailable = "" } = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "worktree-engine-")));
  const repo = path.join(dir, "repo");
  await run("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  const base = await git(repo, "rev-parse", "HEAD");
  const other = path.join(dir, "other");
  await run("git", ["init", "-q", "-b", "main", other]);
  await git(other, "commit", "-q", "--allow-empty", "-m", "unrelated");
  const file = path.join(dir, "state.json");
  const original = { provider: "codex/planner", thinkingOptionId: "medium", modeId: "full-access" };
  const agents = new Map([
    ["A", { id: "A", workspaceId: "ws", projectId: "project", cwd: repo, title: "Task", status: "idle", archived: false, permission: false, usage: 0, config: original }],
  ]);
  const created = [], sent = [], worktrees = [], cards = [], histories = new Map();
  const port = {
    inspect: async (id) => agents.get(id) ?? null,
    history: async (id) => histories.get(id) ?? { text: "", key: "", failed: null, messageIds: [] },
    models: async () => [{ id: "builder", label: "Builder", thinkingOptions: ALL }],
    projectName: async () => "Project",
    workspaceName: async () => "Task",
    rename: async () => {},
    quotaAccount: async () => null,
    quotaAvailable: async () => null,
    executorPicker: async () => {},
    placementPicker: async (agentId, workflowId, blocker) => cards.push({ agentId, workflowId, ...blocker }),
    // Stands in for Paseo: a branch-off worktree from the named branch.
    createWorktree: async (w, baseBranch) => {
      worktrees.push({ baseBranch, id: w.id });
      const folder = path.join(dir, "wt");
      if (foreign) return { workspaceId: "wks_foreign", path: other };
      if (worktrees.length === 1) await git(repo, "worktree", "add", "-q", "-b", `role-workflow/${w.number}-x`, folder, baseBranch);
      return { workspaceId: "wks_worktree", path: folder };
    },
    create: async (w, role, m) => {
      created.push({ role, id: m.id, isolation: w.isolation, workspace: w.isolation === "worktree" ? w.worktree.workspaceId : "ws" });
      agents.set(m.id, { ...agents.get("A"), id: m.id, status: "idle", config: m.config, cwd: w.isolation === "worktree" ? w.worktree.path : repo });
      return w.isolation === "worktree" ? w.worktree.workspaceId : "ws";
    },
    send: async (id, prompt, messageId) => {
      sent.push({ id, prompt, messageId });
      agents.get(id).status = "running";
    },
  };
  if (unavailable === "unsupported") delete port.createWorktree;
  if (unavailable === "detached") await git(repo, "checkout", "--detach", "-q");
  const probe = createRepoProbe();
  if (unavailable === "non-git") probe.identity = async () => null;
  if (unavailable === "subfolder") {
    const identity = probe.identity;
    probe.identity = async (cwd) => ({ ...await identity(cwd), root: dir });
  }
  let engine = new WorkflowEngine(file, port, undefined, probe);
  t.after(async () => {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  });
  await engine.configure({
    ...(await engine.settings()),
    askExecutorModel: false,
    autoPinStarted: false,
    autoArchivePushed: false,
    titleMarker: false,
    autoResumeQuota: false,
    autoResumeTransient: false,
    executorPlacement: placement,
  });
  const id = await engine.enroll(agents.get("A"), original, {}, "federated", true, 5);
  const addBlocker = async (name = "B") => {
    agents.set(name, { ...agents.get("A"), id: name, title: `Other ${name}` });
    const otherId = await engine.enroll(agents.get(name), original, {}, "general", true, 5);
    return engine.database.workflows.find(w => w.id === otherId);
  };
  const blocker = overlap ? await addBlocker() : null;
  if (unavailable === "repositories") await engine.setRepositories(id, [repo]);
  let sequence = 0;
  const state = async () => JSON.parse(await readFile(file, "utf8")).workflows[0];
  const finish = async (agentId, status, extra = {}) => {
    const key = `turn-${++sequence}`;
    const delivery = sent.findLast((x) => x.id === agentId);
    const text = block(status, extra);
    agents.get(agentId).status = "idle";
    const h = { key, text, failed: null, messageIds: delivery ? [delivery.messageId] : [] };
    histories.set(agentId, h);
    await engine.ended(agentId, key, text, null, "goal", false, delivery?.prompt ?? "", false, h.messageIds);
  };
  const start = async () => {
    await finish("A", "plan", { next: "기능 구현" });
    return engine.selectExecutor(id, { provider: "codex", model: "builder", thinking: "high" });
  };
  return { dir, repo, other, base, id, file, get engine() { return engine; }, agents, blocker, addBlocker, cards, created, sent, worktrees, state, finish, start,
    restart: async () => { await engine.close(); engine = new WorkflowEngine(file, port, undefined, probe); await engine.tick(); },
  };
}

test("AC-03/AC-05: overlapping worktree placement preserves repository, branch and review evidence", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.start()).ok, true);
  const w = await f.state();
  assert.deepEqual(f.worktrees.map((x) => x.baseBranch), ["main"]);
  assert.equal(w.isolation, "worktree");
  assert.deepEqual(
    { path: w.worktree.path, base: w.worktree.base, workspaceId: w.worktree.workspaceId },
    { path: path.join(f.dir, "wt"), base: f.base, workspaceId: "wks_worktree" },
  );
  assert.match(w.worktree.branch, /^role-workflow\//);
  assert.deepEqual(f.created, [{ role: "execute", id: w.execute.id, isolation: "worktree", workspace: "wks_worktree" }]);
  const prompt = f.sent.findLast((x) => x.id === w.execute.id).prompt;
  assert.match(prompt, new RegExp(`구현 worktree: ${w.worktree.path.replaceAll("/", "\\/")}`));
  assert.match(prompt, /작업 문서\(handoff·impl-report·verdict\)는 계획 담당 폴더 .*의 절대 경로/);
  // The executor's evidence comes from its worktree, not the planner's checkout.
  await writeFile(path.join(w.worktree.path, "feature.txt"), "x\n");
  await writeFile(path.join(f.repo, "planner-note.txt"), "y\n");
  await f.finish(w.execute.id, "result");
  const review = f.sent.findLast((x) => x.id === "A").prompt;
  assert.match(review, /feature\.txt/);
  assert.doesNotMatch(review, /planner-note\.txt/);
});

test("AC-01: without overlap the executor opens beside its planner", async (t) => {
  const f = await fixture(t, { placement: "ask", overlap: false });
  assert.equal((await f.start()).ok, true);
  const w = await f.state();
  assert.equal(w.isolation, "shared");
  assert.equal(w.worktree, null);
  assert.deepEqual(f.worktrees, []);
  assert.equal(f.created[0].workspace, "ws");
  assert.doesNotMatch(f.sent.at(-1).prompt, /구현 worktree:/);
});

test("a worktree from another repository is refused before any executor is created", async (t) => {
  const f = await fixture(t, { foreign: true });
  await f.start();
  const w = await f.state();
  assert.equal(w.status, "error");
  assert.match(w.detail, /다른 Git 저장소/);
  assert.equal(w.worktree, null);
  assert.deepEqual(f.created, []);
});

test("AC-07: a lost worktree stops the next executor instead of moving the work to the shared folder", async (t) => {
  const f = await fixture(t);
  await f.start();
  let w = await f.state();
  await git(f.repo, "worktree", "remove", "--force", w.worktree.path);
  f.engine.database.workflows[0].execute.workspaceId = null;
  f.engine.database.workflows[0].execute.generation = 2;
  await f.finish("A", "plan", { next: "다음 구현" });
  w = await f.state();
  assert.equal(w.isolation, "worktree");
  assert.match(w.detail, /worktree.*찾을 수 없거나/);
  assert.equal(f.created.length, 1);
});

test("AC-07: a replacement executor of an undecided older task keeps sharing the folder", async (t) => {
  const f = await fixture(t);
  await f.finish("A", "plan", { next: "보관" });
  const w = f.engine.database.workflows[0];
  await f.engine.selectExecutor(f.id, { provider: "codex", model: "builder", thinking: "high" }).catch(() => {});
  // Simulates a workflow saved before isolation existed whose executor was already replaced once.
  w.isolation = "undecided";
  w.worktree = null;
  w.execute.workspaceId = null;
  w.execute.generation = 2;
  f.worktrees.length = 0;
  await f.finish("A", "plan", { next: "교체 후 구현" });
  const saved = await f.state();
  assert.equal(saved.isolation, "shared");
  assert.deepEqual(f.worktrees, []);
});

test("after a verified push the planner's checkout fast-forwards only when it is safe", async (t) => {
  const f = await fixture(t);
  await f.start();
  const w = f.engine.database.workflows[0];
  await writeFile(path.join(w.worktree.path, "feature.txt"), "x\n");
  await git(w.worktree.path, "add", "feature.txt");
  await git(w.worktree.path, "commit", "-q", "-m", "feature");
  const commit = await git(w.worktree.path, "rev-parse", "HEAD");
  const record = { targets: [{ repository: w.worktree.path, remote: "origin", branch: "main", commit }] };
  await integrateWorktree(w, createRepoProbe(), record);
  assert.equal(w.integration.ok, true, w.integration.detail);
  assert.equal(await git(f.repo, "rev-parse", "HEAD"), commit);
  assert.match(w.integration.detail, /빨리 감기/);

  // A planner checkout that moved on its own is never merged or reset.
  await git(f.repo, "commit", "-q", "--allow-empty", "-m", "local only");
  const local = await git(f.repo, "rev-parse", "HEAD");
  await git(w.worktree.path, "commit", "-q", "--allow-empty", "-m", "second");
  const second = await git(w.worktree.path, "rev-parse", "HEAD");
  await integrateWorktree(w, createRepoProbe(), { targets: [{ ...record.targets[0], commit: second }] });
  assert.equal(w.integration.ok, false);
  assert.match(w.integration.detail, /직접 반영 필요/);
  assert.equal(await git(f.repo, "rev-parse", "HEAD"), local);

  // A push to another branch leaves the checkout alone.
  await integrateWorktree(w, createRepoProbe(), { targets: [{ ...record.targets[0], branch: "release", commit: second }] });
  assert.match(w.integration.detail, /브랜치와 푸시한 브랜치가 달라/);
  assert.equal(await git(f.repo, "rev-parse", "HEAD"), local);
});

test("a worktree executor's writes are scoped to its worktree, so the shared checkout stays free", async (t) => {
  const f = await fixture(t);
  await f.start();
  const w = f.engine.database.workflows[0];
  assert.deepEqual(await f.engine["scopes"](w), [w.worktree.path]);
  w.isolation = "shared";
  assert.deepEqual(await f.engine["scopes"](w), [f.repo]);
});

for (const placement of ["ask", "worktree", "wait"])
test(`AC-01: ${placement} without overlap creates a shared tab without a card`, async t => {
  const f = await fixture(t, { placement, overlap: false });
  await f.start();
  assert.equal((await f.state()).isolation, "shared");
  assert.equal(f.created[0].workspace, "ws");
  assert.equal(f.worktrees.length, 0);
  assert.equal(f.cards.length, 0);
});

test("AC-02/AC-03/AC-09: idle overlap waits durably for a single choice, then creates one worktree", async t => {
  const f = await fixture(t, { placement: "ask" });
  await f.start();
  let w = await f.state();
  assert.equal(w.isolation, "undecided");
  assert.equal(w.pending.stage, "queued");
  assert.equal(w.placement.stage, "choice");
  assert.equal(f.created.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.cards.length, 1);
  await f.engine.tick();
  assert.equal(f.cards.length, 1);
  await f.restart();
  w = await f.state();
  assert.equal(w.isolation, "undecided");
  assert.equal(w.placement.stage, "choice");
  assert.equal(f.created.length, 0);
  assert.equal(f.cards[1].workflowId, f.cards[0].workflowId, "re-attachment uses the same timeline identity");
  assert.equal((await f.engine.selectPlacement(f.id, "worktree")).ok, true);
  assert.equal((await f.state()).isolation, "worktree");
  assert.equal(f.created.length, 1);
  assert.equal(f.worktrees.length, 1);
  assert.match(f.sent.find(x => x.id === "A").prompt, /따로 작업 공간에서 시작합니다\./);
  assert.ok(f.sent.some(x => x.id === (f.engine.database.workflows[0].execute.id)));
  const before = await f.state();
  assert.equal((await f.engine.selectPlacement(f.id, "wait")).ok, false);
  assert.deepEqual(await f.state(), before);
  assert.equal(f.worktrees.length, 1);
});

for (const release of ["done", "pushed", "no_push", "archived", "deleted", "read-only"])
test(`AC-04: wait keeps instructions queued until the blocker is ${release}`, async t => {
  const f = await fixture(t, { placement: "ask" });
  await f.start();
  assert.equal((await f.engine.selectPlacement(f.id, "wait")).ok, true);
  let w = await f.state();
  assert.equal(w.isolation, "shared");
  assert.equal(w.pending.stage, "queued");
  assert.equal(f.created.length, 0);
  assert.match(w.detail, /작업이 끝나면 .* 구현을 자동으로 시작합니다/);
  await f.restart();
  assert.equal(f.created.length, 0);
  const blocker = f.engine.database.workflows.find(w => w.id === f.blocker.id);
  if (release === "archived") f.agents.get("B").archived = true;
  else if (release === "deleted") f.agents.delete("B");
  else if (release === "read-only") blocker.plan.config.modeId = "read-only";
  else blocker.progress = release;
  await f.engine.tick();
  w = await f.state();
  assert.equal(w.placement, null);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].workspace, "ws");
  assert.equal(w.pending.stage, "sent");
  assert.equal(f.worktrees.length, 0);
});

test("AC-04/AC-05: automatic wait recomputes all unfinished blockers at every tick", async t => {
  const f = await fixture(t, { placement: "wait" });
  await f.start();
  assert.equal(f.cards.length, 0);
  assert.equal(f.created.length, 0);
  const second = await f.addBlocker("C");
  f.blocker.progress = "done";
  await f.engine.tick();
  assert.equal(f.created.length, 0);
  assert.match((await f.state()).detail, new RegExp(`#${second.number} Other C`));
  second.progress = "no_push";
  await f.engine.tick();
  assert.equal(f.created.length, 1);
});

for (const unavailable of ["unsupported", "detached", "subfolder", "non-git", "repositories"])
test(`AC-06: ${unavailable} automatically waits with an explanation`, async t => {
  const f = await fixture(t, { placement: "ask", unavailable });
  await f.start();
  const w = await f.state();
  assert.equal(w.isolation, "shared");
  assert.equal(w.placement.stage, "waiting");
  assert.ok(w.placement.reason);
  assert.ok(w.detail.includes(w.placement.reason));
  assert.equal(f.cards.length, 0);
  assert.equal(f.worktrees.length, 0);
  assert.equal(f.created.length, 0);
});

test("AC-07: shared placement is kept when the executor is replaced despite a new overlap", async t => {
  const f = await fixture(t, { overlap: false });
  await f.start();
  const w = f.engine.database.workflows[0];
  w.execute.workspaceId = null;
  w.execute.generation = 2;
  await f.addBlocker();
  f.agents.get(w.execute.id).status = "idle";
  await f.finish("A", "plan", { next: "교체 구현" });
  assert.equal((await f.state()).isolation, "shared");
  assert.equal(f.worktrees.length, 0);
  assert.equal(f.cards.length, 0);
});

test("AC-08: legacy boolean settings migrate to ask, and saving removes the old key", async t => {
  for (const old of [true, false]) {
    const settings = settingsSchema.parse({ executorWorktree: old });
    assert.equal(settings.executorPlacement, "ask");
    assert.equal("executorWorktree" in settings, false);
  }
  assert.equal(settingsSchema.parse({ executorPlacement: "unknown" }).executorPlacement, "ask");
  const f = await fixture(t, { overlap: false });
  await f.engine.close();
  const legacy = JSON.parse(await readFile(f.file, "utf8"));
  delete legacy.settings.executorPlacement;
  legacy.settings.executorWorktree = false;
  await writeFile(f.file, JSON.stringify(legacy));
  await f.restart();
  assert.equal((await f.engine.settings()).executorPlacement, "ask");
  await f.engine.configure(await f.engine.settings());
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(saved.settings.executorPlacement, "ask");
  assert.equal("executorWorktree" in saved.settings, false);
});

test("AC-09: missing, non-federated and non-waiting choices leave workflow state unchanged", async t => {
  const f = await fixture(t, { placement: "ask" });
  const before = await f.state();
  for (const id of ["missing", f.blocker.id, f.id]) {
    const result = await f.engine.selectPlacement(id, "wait");
    assert.equal(result.ok, false);
    assert.ok(result.detail);
    assert.deepEqual(await f.state(), before);
  }
  assert.equal(f.sent.length, 0);
});

test("AC-10: running writer protection and conflict warnings still block shared delivery", async t => {
  const f = await fixture(t, { overlap: false });
  await f.start();
  const w = f.engine.database.workflows[0];
  const blocker = await f.addBlocker();
  f.agents.get("B").status = "running";
  assert.equal(await f.engine.busyWriter(w), blocker);
  assert.equal(await f.engine.clearToExecute(w, { id: "next", instruction: true }), false);
  assert.match(w.conflict, /같은 저장소의 다른 작업/);
  await f.engine.refreshConflicts();
  assert.ok(w.conflict);
  f.agents.get("B").status = "idle";
  assert.equal(await f.engine.clearToExecute(w, { id: "next", instruction: true }), true);
  assert.equal(w.conflict, "");
  for (const contract of [1, 2, 3]) {
    w.isolation = "undecided";
    w.contract = contract;
    w.execute.workspaceId = null;
    await f.engine.prepareMember(w, "execute");
    assert.equal(w.isolation, "shared");
  }
  assert.equal(f.cards.length, 0);
  assert.equal(f.worktrees.length, 0);
});
