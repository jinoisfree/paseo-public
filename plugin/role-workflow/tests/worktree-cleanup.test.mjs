import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkflowEngine } from "../server/engine.ts";
import { createRepoProbe } from "../server/git.ts";
import { managedPushSchema } from "../shared/managed-push.ts";
import { withCallBudgets } from "../server/paseo-port.ts";
import { CLEANUP_RETRY_MS } from "../server/worktree-cleanup.ts";

const execute = promisify(execFile);
const git = (cwd, ...args) => execute("git", ["-c", "user.email=cleanup@example.invalid", "-c", "user.name=cleanup", ...args], { cwd }).then(r => r.stdout.trim());
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "worktree-cleanup-")));
  const repo = path.join(dir, "repo"), tree = path.join(dir, "worktree"), state = path.join(dir, "state");
  await execute("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(path.join(repo, ".gitignore"), "evidence/\n");
  await git(repo, "add", ".gitignore");
  await git(repo, "commit", "-q", "-m", "base");
  await git(repo, "worktree", "add", "-q", "-b", "feature", tree);
  await writeFile(path.join(tree, "feature.txt"), "feature\n");
  await git(tree, "add", "feature.txt");
  await git(tree, "commit", "-q", "-m", "feature");
  const commit = await git(tree, "rev-parse", "HEAD");
  await git(repo, "merge", "--ff-only", "--no-edit", commit);
  await mkdir(path.join(tree, "evidence"));
  await writeFile(path.join(tree, "evidence", "test.log"), "test evidence\n");
  let now = Date.now();
  const config = { provider: "codex/test", modeId: "full-access" };
  const agents = new Map([
    ["P", { id: "P", workspaceId: "plan", projectId: "project", cwd: repo, config, status: "idle", permission: false, archived: false, usage: 0, title: "task" }],
    ["E", { id: "E", workspaceId: "tree", projectId: "project", cwd: tree, config, status: "idle", permission: false, archived: false, usage: 0, title: "executor" }],
  ]);
  const spaces = new Set(["plan", "tree"]), calls = [], cards = [];
  const port = {
    inspect: async id => agents.get(id) ?? null,
    archiveInspection: async ids => ({
      workspaces: [...spaces].filter(id => ids.includes(id)).map(id => ({ id, pinnedAt: null, archiving: false, status: "done" })),
      conversations: [...agents.values()].filter(a => ids.includes(a.workspaceId)).map(a => ({ ...a, activeTurn: a.status === "running", lastActivityAt: new Date(now - 60000).toISOString() })),
    }),
    archiveWorkspace: async id => {
      assert.equal(id, "tree", "the planner workspace must never be archived by cleanup");
      calls.push(id); spaces.delete(id); agents.get("E").archived = true;
    },
    projectName: async () => "project", workspaceName: async () => "task", rename: async () => {},
    history: async () => ({ text: "", key: "", failed: null, messageIds: [] }),
    models: async () => [{ id: "test", label: "Test", thinkingOptions: [] }],
    create: async (w, role, m) => {
      agents.set(m.id, { ...agents.get("P"), id: m.id, config: m.config });
      return "plan";
    },
    placementPicker: async (agentId, workflowId, blocker, generation) => cards.push({ agentId, workflowId, blocker, generation }),
    createWorktree: async () => { throw new Error("not selected in this test"); },
    send: async () => {}, quotaAccount: async () => null, quotaAvailable: async () => null,
  };
  const file = path.join(state, "state.json"), probe = createRepoProbe();
  let record;
  const runner = { read: async () => structuredClone(record), history: async () => [], isRunning: () => false };
  let engine = new WorkflowEngine(file, port, undefined, probe, () => now, runner);
  await engine.configure({ ...await engine.settings(), autoArchivePushed: false, autoPinPushed: false, autoPinStarted: false, titleMarker: false, autoResumeQuota: false, autoResumeTransient: false });
  const id = await engine.enroll(agents.get("P"), config, {}, "federated", true, 5);
  await engine.selectExecutor(id, { provider: "codex", model: "test", thinking: "" });
  let w = engine.database.workflows[0];
  w.execute = { ...structuredClone(w.plan), id: "E", workspaceId: "tree" };
  w.isolation = "worktree";
  w.worktree = { path: tree, branch: "feature", base: commit, workspaceId: "tree" };
  w.integration = { commit, ok: true, detail: "integrated" };
  w.pushTargets = [{ repository: tree, remote: "origin", branch: "main", commit }];
  record = managedPushSchema.parse({ id: randomUUID(), workflowId: id, epoch: w.pushEpoch, state: "pushed", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), approvedAt: new Date(now).toISOString(), targets: [{ ...w.pushTargets[0], remoteUrl: "https://example.com/repo.git", verified: true, exitCode: 0 }] });
  w.managedPush = structuredClone(record);
  w.pushCheck = { checkedAt: new Date(now).toISOString(), targets: [{ ...w.pushTargets[0], result: "pushed" }] };
  w.progress = "pushed"; w.status = "completed";
  await engine.save();
  t.after(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    dir, repo, tree, state, file, id, commit, port, probe, agents, spaces, calls, cards,
    get w() { return w; }, get engine() { return engine; },
    run: () => engine.worktreeCleanup.run(w),
    advance: (ms = CLEANUP_RETRY_MS + 1) => { now += ms; },
    restart: async () => { await engine.save(); await engine.close(); engine = new WorkflowEngine(file, port, undefined, probe, () => now, runner); await engine.tick(); w = engine.database.workflows[0]; },
  };
}

test("AC-101: verified integration archives only the executor and preserves evidence with autoArchivePushed off", async t => {
  const f = await fixture(t);
  const before = await git(f.repo, "status", "--porcelain");
  await f.run();
  assert.deepEqual(f.calls, ["tree"]);
  assert.equal(f.w.worktreeCleanup.stage, "done");
  assert.equal(f.w.worktreeCleanup.evidenceFiles, 1);
  assert.equal(await readFile(path.join(f.state, "evidence", f.id, "worktree", "tree", "test.log"), "utf8"), "test evidence\n");
  assert.equal(f.agents.get("P").archived, false);
  assert.equal(await git(f.repo, "status", "--porcelain"), before);
  assert.equal(f.w.detail, "따로 작업 공간을 정리했습니다(코드는 main에 반영됨).");
  await f.run(); assert.equal(f.calls.length, 1);
});

for (const reason of ["integration", "commit mismatch", "dirty", "untracked", "local commit", "running", "permission", "pending", "inbox", "held", "compaction", "other conversation", "other workflow", "disabled"])
test(`AC-102: ${reason} preserves the workspace`, async t => {
  const f = await fixture(t);
  if (reason === "integration") f.w.integration.ok = false;
  if (reason === "commit mismatch") f.w.integration.commit = "a".repeat(40);
  if (reason === "dirty") await writeFile(path.join(f.tree, "feature.txt"), "not committed");
  if (reason === "untracked") await writeFile(path.join(f.tree, "untracked.txt"), "not committed");
  if (reason === "local commit") await git(f.tree, "commit", "--allow-empty", "-q", "-m", "not integrated");
  if (reason === "running") f.agents.get("E").status = "running";
  if (reason === "permission") f.agents.get("E").permission = true;
  if (["pending", "inbox", "held"].includes(reason)) f.w[reason] = {};
  if (reason === "compaction") f.w.execute.compaction = "compacting";
  if (reason === "other conversation") f.agents.set("other", { ...f.agents.get("E"), id: "other" });
  if (reason === "other workflow") f.engine.database.workflows.push({ ...structuredClone(f.w), id: "other" });
  if (reason === "disabled") await f.engine.configure({ ...await f.engine.settings(), autoArchiveWorktree: false });
  await f.run();
  assert.deepEqual(f.calls, []);
  assert.ok(["pending", "skipped"].includes(f.w.worktreeCleanup.stage));
  assert.ok(f.w.worktreeCleanup.detail);
});

for (const failure of ["missing", "throw", "timeout", "archivedAt missing", "workspaceId mismatch", "unconfirmed"])
test(`AC-103: ${failure} preserves state and stops after three spaced attempts`, async t => {
  const f = await fixture(t);
  let attempts = 0;
  if (failure === "missing") f.port.archiveWorkspace = undefined;
  else f.port.archiveWorkspace = async () => {
    attempts++;
    if (failure !== "unconfirmed") throw new Error(failure);
  };
  for (let i = 0; i < 3; i++) {
    await f.run();
    assert.equal(f.w.worktreeCleanup.stage, "failed");
    assert.equal(f.w.worktreeCleanup.attempts, i + 1);
    await f.run();
    assert.equal(f.w.worktreeCleanup.attempts, i + 1, "no retry inside a tick interval");
    f.advance();
  }
  await f.run();
  assert.equal(f.w.worktreeCleanup.attempts, 3);
  assert.equal(attempts, failure === "missing" ? 0 : 3);
  assert.match(f.w.detail, /따로 작업 공간을 자동으로 정리하지 못했습니다: .*직접 보관하세요\./);
  assert.equal(f.agents.get("E").archived, false);
});

test("AC-104: pending cleanup resumes after engine recreation; done never archives twice", async t => {
  const f = await fixture(t);
  f.w.worktreeCleanup = { stage: "pending", attempts: 0, detail: "queued", at: new Date().toISOString(), evidenceFiles: null };
  await f.restart();
  assert.deepEqual(f.calls, ["tree"]);
  assert.equal(f.w.worktreeCleanup.stage, "done");
  await f.restart();
  assert.deepEqual(f.calls, ["tree"]);
});

test("AC-104: a lost archive response is confirmed after restart without another archive call", async t => {
  const f = await fixture(t);
  const archive = f.port.archiveWorkspace;
  f.port.archiveWorkspace = async id => { await archive(id); throw new Error("response lost"); };
  await f.run(); assert.equal(f.w.worktreeCleanup.stage, "failed");
  f.advance(); await f.restart();
  assert.equal(f.w.worktreeCleanup.stage, "done");
  assert.deepEqual(f.calls, ["tree"]);
});

for (const error of ["destination", "symlink"])
test(`AC-105: ${error} evidence copy failure prevents archive and never writes the repository`, async t => {
  const f = await fixture(t);
  if (error === "destination") await writeFile(path.join(f.state, "evidence"), "blocked destination");
  else await symlink(path.join(f.repo, "feature.txt"), path.join(f.tree, "evidence", "link"));
  const before = await git(f.repo, "status", "--porcelain");
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "failed");
  assert.deepEqual(f.calls, []);
  assert.equal(await git(f.repo, "status", "--porcelain"), before);
});

test("AC-102/AC-105: membership is rechecked after evidence copy before the archive RPC", async t => {
  const f = await fixture(t);
  const inspect = f.port.archiveInspection;
  let reads = 0;
  f.port.archiveInspection = async ids => {
    if (++reads === 2) f.agents.set("late", { ...f.agents.get("E"), id: "late" });
    return inspect(ids);
  };
  await f.run();
  assert.deepEqual(f.calls, []);
  assert.equal(f.w.worktreeCleanup.stage, "skipped");
});

for (const mode of ["shared", "general"])
test(`AC-107: ${mode} cleanup leaves existing archive behavior and state untouched`, async t => {
  const f = await fixture(t);
  if (mode === "shared") f.w.isolation = "shared";
  else f.w.mode = "general";
  await f.run();
  assert.deepEqual(f.calls, []);
  assert.equal(f.w.worktreeCleanup, null);
});


for (const overlap of [false, true])
test(`AC-106: a new implementation after cleanup gets generation+1 and ${overlap ? "a placement choice" : "a shared tab"}`, async t => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "done");
  if (overlap) {
    const other = { ...f.agents.get("P"), id: "other", workspaceId: "other-space" };
    f.agents.set(other.id, other);
    await f.engine.enroll(other, other.config, {}, "general", true, 5);
  }
  await f.engine.ended("P", "new-plan", `<paseo-workflow>${JSON.stringify({ status: "plan", summary: "new plan", next: "new implementation", handoff: "next", checks: [] })}</paseo-workflow>`, null, "next goal", false, "새 구현을 시작해줘");
  assert.equal(f.w.execute.generation, 2);
  assert.notEqual(f.w.execute.id, "E");
  assert.equal(f.w.worktreeHistory[0].workspaceId, "tree");
  assert.equal(f.w.worktree, null);
  assert.equal(f.w.worktreeCleanup, null);
  if (overlap) {
    assert.equal(f.w.isolation, "undecided");
    assert.equal(f.w.placement.stage, "choice");
    assert.equal(f.cards.length, 1);
    assert.equal(f.cards[0].generation, 2);
    assert.equal(f.w.execute.workspaceId, null);
  } else {
    assert.equal(f.w.isolation, "shared");
    assert.equal(f.w.execute.workspaceId, "plan");
    assert.equal(f.w.pending.stage, "sent");
  }
  assert.notEqual(f.w.status, "error");
});


test("AC-103: an actual RPC timeout preserves the workspace", async t => {
  const f = await fixture(t);
  const bounded = withCallBudgets({ archiveWorkspace: async () => new Promise(() => {}) }, { archiveWorkspace: 20 });
  f.port.archiveWorkspace = bounded.archiveWorkspace;
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "failed");
  assert.equal(f.agents.get("E").archived, false);
  assert.match(f.w.worktreeCleanup.detail, /시간|timeout/i);
});


test("AC-102: disabling cleanup during inspection is rechecked immediately before archive", async t => {
  const f = await fixture(t);
  const inspect = f.port.archiveInspection;
  let reads = 0;
  f.port.archiveInspection = async ids => {
    if (++reads === 1) f.engine.database.settings.autoArchiveWorktree = false;
    return inspect(ids);
  };
  await f.run();
  assert.deepEqual(f.calls, []);
  assert.equal(f.w.worktreeCleanup.stage, "skipped");
});


const newPlan = f => f.engine.ended("P", "new-plan", `<paseo-workflow>${JSON.stringify({ status: "plan", summary: "new plan", next: "new implementation", handoff: "next", checks: [] })}</paseo-workflow>`, null, "next goal", false, "새 구현을 시작해줘");

test("AC-107/B-1: dirty skipped worktrees cannot bypass cleanup through automatic or manual archive", async t => {
  const f = await fixture(t);
  await f.engine.configure({ ...await f.engine.settings(), autoArchivePushed: true, archiveAfterDays: 0 });
  await writeFile(path.join(f.tree, "feature.txt"), "uncommitted work must survive");
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "skipped");
  await f.engine.archives.checkArchives();
  assert.deepEqual(f.calls, []);
  const stale = [{ id: f.id, workspaceIds: ["plan", "tree"] }];
  assert.deepEqual((await f.engine.archives.applyArchive(stale, "pushed")).archivedIds, []);
  f.w.progress = "done";
  const preview = await f.engine.archiveFinished();
  assert.deepEqual(preview.rows, []);
  assert.deepEqual(preview.blocked, [{ id: f.id, number: f.w.number, title: f.w.title, reason: "따로 작업 공간 정리가 끝나지 않아 보관하지 않습니다" }]);
  assert.deepEqual((await f.engine.archiveFinished(true, [f.id])).archivedIds, []);
  assert.deepEqual((await f.engine.archives.applyArchive(stale, "done")).archivedIds, []);
  assert.deepEqual(f.calls, []);
  assert.equal(f.agents.get("P").archived, false);
  assert.equal(await readFile(path.join(f.tree, "feature.txt"), "utf8"), "uncommitted work must survive");
});

for (const stage of [null, "pending", "failed", "skipped"])
test(`AC-107/B-1: unfinished cleanup ${stage} excludes both workspace halves`, async t => {
  const f = await fixture(t);
  await f.engine.configure({ ...await f.engine.settings(), archiveAfterDays: 0 });
  if (stage) f.w.worktreeCleanup = { stage, attempts: 2, evidenceFiles: 1, at: new Date().toISOString(), detail: stage };
  assert.deepEqual(await f.engine.archives.archiveRows("pushed"), []);
  // done lifts only the cleanup gate; the normal safety checks still apply.
  f.w.worktreeCleanup = { stage: "done", attempts: 1, evidenceFiles: 1, at: new Date().toISOString(), detail: "done" };
  assert.deepEqual((await f.engine.archives.archiveRows("pushed"))[0].workspaceIds, ["plan", "tree"]);
});

for (const stage of ["pending", "failed", "skipped"])
test(`AC-106/N-2: a new implementation cycle resets ${stage} cleanup including its retry budget and evidence`, async t => {
  const f = await fixture(t);
  f.w.worktreeCleanup = { stage, attempts: 3, detail: "old", at: new Date().toISOString(), evidenceFiles: 99 };
  await newPlan(f);
  assert.equal(f.w.worktreeCleanup, null);
  assert.equal(f.w.execute.id, "E");
  assert.equal(f.w.worktree.path, f.tree);
  assert.equal(f.w.worktreeHistory.length, 0);
  assert.notEqual(f.w.status, "error");
});

for (const missing of [false, true])
test(`AC-106/N-3: manually archived executor with ${missing ? "missing" : "existing"} directory ${missing ? "is placed again" : "is preserved"}`, async t => {
  const f = await fixture(t);
  f.agents.get("E").archived = true;
  f.spaces.delete("tree");
  if (missing) await rm(f.tree, { recursive: true });
  await newPlan(f);
  if (missing) {
    assert.equal(f.w.execute.generation, 2);
    assert.notEqual(f.w.execute.id, "E");
    assert.equal(f.w.execute.workspaceId, "plan");
    assert.equal(f.w.isolation, "shared");
    assert.deepEqual(f.w.worktreeHistory.map(w => w.workspaceId), ["tree"]);
    assert.ok(f.w.history.includes("E"));
    assert.equal(f.w.worktree, null);
    assert.notEqual(f.w.status, "error");
  } else {
    assert.equal(f.w.execute.id, "E");
    assert.equal(f.w.worktree.path, f.tree);
    assert.deepEqual(f.w.worktreeHistory, []);
  }
  assert.equal(f.w.worktreeCleanup, null);
  assert.deepEqual(f.calls, []);
});

for (const source of ["directory", "conversation", "Git", "after copy"])
test(`AC-103/N-4: transient readiness ${source} failures stay pending without consuming attempts`, async t => {
  const f = await fixture(t);
  let fail = true;
  const inspect = f.port.archiveInspection, snapshot = f.port.inspect, gitSnapshot = f.probe.snapshot;
  let reads = 0;
  if (source === "directory" || source === "after copy") f.port.archiveInspection = async ids => {
    if (fail && (source === "directory" || ++reads % 2 === 0)) throw Error("temporary directory failure");
    return inspect(ids);
  };
  if (source === "conversation") f.port.inspect = async id => { if (fail) throw Error("temporary conversation failure"); return snapshot(id); };
  if (source === "Git") f.probe.snapshot = async cwd => { if (fail) throw Error("temporary Git failure"); return gitSnapshot(cwd); };
  for (let i = 0; i < 4; i++) {
    await f.run();
    assert.equal(f.w.worktreeCleanup.stage, "pending");
    assert.equal(f.w.worktreeCleanup.attempts, 0);
    assert.deepEqual(f.calls, []);
    f.advance();
  }
  fail = false;
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "done");
  assert.equal(f.w.worktreeCleanup.attempts, 1);
});

test("AC-103/N-4: archive failures wait at least sixty seconds before a retry", async t => {
  const f = await fixture(t);
  let calls = 0;
  f.port.archiveWorkspace = async () => { calls++; throw Error("offline"); };
  await f.run();
  f.advance(59_999); await f.run();
  assert.equal(calls, 1);
  f.advance(1); await f.run();
  assert.equal(calls, 2);
  assert.ok(CLEANUP_RETRY_MS >= 60_000);
});

for (const pinnedAt of ["2026-11-08T00:00:00Z", undefined])
test(`AC-102/N-5: ${pinnedAt ? "pinned" : "unknown pin"} workspace stays pending until explicitly unpinned`, async t => {
  const f = await fixture(t);
  const inspect = f.port.archiveInspection;
  let pin = pinnedAt;
  f.port.archiveInspection = async ids => {
    const result = await inspect(ids);
    result.workspaces.forEach(ws => { ws.pinnedAt = pin; });
    return result;
  };
  await f.run();
  assert.deepEqual(f.calls, []);
  assert.equal(f.w.worktreeCleanup.stage, "pending");
  assert.equal(f.w.worktreeCleanup.attempts, 0);
  pin = null;
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "done");
});
