import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WorkflowEngine } from "../server/engine.ts";
import { createRepoProbe } from "../server/git.ts";

const run = promisify(execFile);
const git = (cwd, ...args) =>
  run("git", ["-c", "user.email=wt@example.invalid", "-c", "user.name=wt", ...args], { cwd }).then((r) => r.stdout.trim());
const block = (status, extra = {}) =>
  `<paseo-workflow>${JSON.stringify({ status, summary: status, next: "구현 지시", handoff: "인계", checks: [], ...extra })}</paseo-workflow>`;
const ALL = [{ id: "high", label: "High", isDefault: true }];

async function fixture(t, { worktree = true, foreign = false } = {}) {
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
  const created = [], sent = [], worktrees = [], histories = new Map();
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
      agents.set(m.id, { ...agents.get("A"), id: m.id, config: m.config, cwd: w.isolation === "worktree" ? w.worktree.path : repo });
      return w.isolation === "worktree" ? w.worktree.workspaceId : "ws";
    },
    send: async (id, prompt, messageId) => {
      sent.push({ id, prompt, messageId });
      agents.get(id).status = "running";
    },
  };
  const engine = new WorkflowEngine(file, port, undefined, createRepoProbe());
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
    executorWorktree: worktree,
  });
  const id = await engine.enroll(agents.get("A"), original, {}, "federated", true, 5);
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
  return { dir, repo, other, base, id, engine, created, sent, worktrees, state, finish, start };
}

test("the first federated executor works in its own worktree cut from the planner's branch", async (t) => {
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

test("with the setting off the executor shares the planner's folder as before", async (t) => {
  const f = await fixture(t, { worktree: false });
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

test("a lost worktree stops the next executor instead of moving the work to the shared folder", async (t) => {
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

test("a replacement executor of an undecided older task keeps sharing the folder", async (t) => {
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
  await f.engine["integrateWorktree"](w, record);
  assert.equal(w.integration.ok, true, w.integration.detail);
  assert.equal(await git(f.repo, "rev-parse", "HEAD"), commit);
  assert.match(w.integration.detail, /빨리 감기/);

  // A planner checkout that moved on its own is never merged or reset.
  await git(f.repo, "commit", "-q", "--allow-empty", "-m", "local only");
  const local = await git(f.repo, "rev-parse", "HEAD");
  await git(w.worktree.path, "commit", "-q", "--allow-empty", "-m", "second");
  const second = await git(w.worktree.path, "rev-parse", "HEAD");
  await f.engine["integrateWorktree"](w, { targets: [{ ...record.targets[0], commit: second }] });
  assert.equal(w.integration.ok, false);
  assert.match(w.integration.detail, /직접 반영 필요/);
  assert.equal(await git(f.repo, "rev-parse", "HEAD"), local);

  // A push to another branch leaves the checkout alone.
  await f.engine["integrateWorktree"](w, { targets: [{ ...record.targets[0], branch: "release", commit: second }] });
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
