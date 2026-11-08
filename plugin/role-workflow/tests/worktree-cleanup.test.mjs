import { gitTestEnvironment } from "./git-test-environment.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TestWorkflowEngine as WorkflowEngine } from "./lifecycle-fixture.mjs";
import { createRepoProbe } from "../server/git.ts";
import { managedPushSchema } from "../shared/managed-push.ts";
import { withCallBudgets, createPort } from "../server/paseo-port.ts";
import { CLEANUP_RETRY_MS, preserveEvidence } from "../server/worktree-cleanup.ts";

const exec = promisify(execFile);
const execute = (file, args, options = {}) => exec(file, args, { ...options, env: gitTestEnvironment() });
const git = (cwd, ...args) => execute("git", ["-c", "user.email=cleanup@example.invalid", "-c", "user.name=cleanup", ...args], { cwd }).then(r => r.stdout.trim());
async function fixture(t, { defaultPins = false } = {}) {
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
  const pins = new Map(), pinCalls = [], unpinCalls = [];
  const port = {
    inspect: async id => agents.get(id) ?? null,
    archiveInspection: async ids => ({
      workspaces: [...spaces].filter(id => ids.includes(id)).map(id => ({ id, pinnedAt: pins.get(id) ?? null, archiving: false, status: "done" })),
      conversations: [...agents.values()].filter(a => ids.includes(a.workspaceId)).map(a => ({ ...a, activeTurn: a.status === "running", lastActivityAt: new Date(now - 60000).toISOString() })),
    }),
    archiveWorkspace: async id => {
      assert.equal(id, "tree", "the planner workspace must never be archived by cleanup");
      calls.push(structuredClone(id)); spaces.delete(id); agents.get("E").archived = true;
    },
    pushReview: {
      get: async id => spaces.has(id) ? { pinnedAt: pins.get(id) ?? null } : null,
      pin: async id => {
        pinCalls.push(structuredClone(id));
        const at = `plugin-${pinCalls.length}`;
        pins.set(id, at);
        return at;
      },
      unpin: async (id, expectedPinAt) => {
        unpinCalls.push(structuredClone({ id, expectedPinAt }));
        if (pins.get(id) !== expectedPinAt) return false;
        pins.delete(id);
        return true;
      },
    },
    projectName: async () => "project", workspaceName: async () => "task", rename: async () => {},
    history: async () => ({ text: "", key: "", failed: null, messageIds: [] }),
    models: async () => [{ id: "test", label: "Test", thinkingOptions: [] }],
    create: async (w, role, m) => {
      agents.set(m.id, { ...agents.get("P"), id: m.id, config: m.config });
      return "plan";
    },
    placementPicker: async (agentId, workflowId, blocker, generation) => cards.push(structuredClone({ agentId, workflowId, blocker, generation })),
    createWorktree: async () => { throw new Error("not selected in this test"); },
    send: async () => {}, quotaAccount: async () => null, quotaAvailable: async () => null,
  };
  const file = path.join(state, "state.json"), probe = createRepoProbe();
  let record;
  const runner = { read: async () => structuredClone(record), history: async () => [], isRunning: () => false };
  let engine = new WorkflowEngine(file, port, undefined, probe, () => now, runner);
  await engine.configure({ ...await engine.settings(), autoArchivePushed: false, ...(defaultPins ? {} : { autoPinPushed: false, autoPinStarted: false }), titleMarker: false, autoResumeQuota: false, autoResumeTransient: false });
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
    dir, repo, tree, state, file, id, commit, port, probe, agents, spaces, calls, cards, pins, pinCalls, unpinCalls,
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
test(`AC-103/AC-205 D-4: ${failure === "missing" || failure === "unconfirmed" ? failure : `injected transport error (${failure}); raw response checks are in paseo-port`} preserves state and stops after three spaced attempts`, async t => {
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
    if (++reads === 1) {
      // C4: owner changes must affect the policy source, not the in-memory rollback copy.
      const current = await f.engine.policy.load();
      await f.engine.policy.save({...current.settings,autoArchiveWorktree:false},current.policy.revision);
    }
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
  assert.deepEqual(preview.blocked, [{ id: f.id, number: f.w.number, title: f.w.title, reason: "푸시 전 작업의 따로 작업 공간은 자동 정리하지 않습니다. 필요하면 커밋을 확인한 뒤 Paseo에서 직접 보관하세요(무시된 파일과 커밋하지 않은 파일은 지워집니다)." }]);
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


test("AC-101/R-1: default start and push pins preserve the planner while a newly placed worktree archives normally", async t => {
  const f = await fixture(t, { defaultPins: true });
  const settings = await f.engine.settings();
  assert.equal(settings.autoPinStarted, true);
  assert.equal(settings.autoPinPushed, true);
  f.w.execute.workspaceId = null;
  f.w.status = "active";
  f.port.create = async () => "tree";
  await f.engine.prepareMember(f.w, "execute");
  assert.equal(f.w.execute.workspaceId, "tree");
  assert.deepEqual(f.w.startPin.workspaces.map(row => row.id), ["plan"]);
  await f.engine.syncStartPin(f.w);
  await f.engine.queuePushReview(f.w);
  assert.deepEqual(f.w.pushReview.workspaces.map(row => row.id), ["plan"]);
  await f.engine.syncPushReview(f.w);
  assert.deepEqual(f.pinCalls, ["plan"]);
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "done");
  assert.deepEqual(f.calls, ["tree"]);
  assert.deepEqual(f.unpinCalls, []);
  assert.equal(f.pins.get("plan"), "plugin-1");
  assert.equal(f.agents.get("P").archived, false);
  assert.equal(await readFile(path.join(f.state, "evidence", f.id, "worktree", "tree", "test.log"), "utf8"), "test evidence\n");
});

function legacyPin(f, source = "startPin", ownedPinAt = "owned") {
  f.w[source] ??= { key: source, workspaces: [] };
  const row = { id: "tree", phase: "pinned", ownedPinAt };
  f.w[source].workspaces.push(row);
  f.pins.set("tree", "owned");
  return row;
}

for (const source of ["startPin", "pushReview", "both"])
test(`AC-101/R-1: legacy ${source} ownership releases only the executor pin immediately before archive`, async t => {
  const f = await fixture(t, { defaultPins: true });
  await f.engine.syncStartPin(f.w);
  const row = legacyPin(f, source === "both" ? "startPin" : source);
  const second = source === "both" ? legacyPin(f, "pushReview") : null;
  const order = [];
  const unpin = f.port.pushReview.unpin, archive = f.port.archiveWorkspace;
  f.port.pushReview.unpin = async (id, at) => {
    order.push("unpin");
    assert.equal(await readFile(path.join(f.state, "evidence", f.id, "worktree", "tree", "test.log"), "utf8"), "test evidence\n");
    return unpin(id, at);
  };
  f.port.archiveWorkspace = async id => {
    order.push("archive");
    assert.equal(f.pins.has("tree"), false);
    return archive(id);
  };
  await f.engine.syncStartPin(f.w);
  await f.engine.syncPushReview(f.w);
  assert.deepEqual(f.unpinCalls, [], "generic sync must not release the legacy pin before evidence checks");
  await f.run();
  assert.deepEqual(order, ["unpin", "archive"]);
  assert.deepEqual(f.unpinCalls, [{ id: "tree", expectedPinAt: "owned" }]);
  assert.equal(row.phase, "acknowledged");
  assert.equal(row.ownedPinAt, null);
  if (second) assert.equal(second.ownedPinAt, null);
  assert.equal(f.pins.get("plan"), "plugin-1");
  await f.restart();
  assert.deepEqual(f.pinCalls, ["plan"]);
  assert.deepEqual(f.calls, ["tree"]);
});

for (const kind of ["manual", "changed", "missing port", "missing method", "refused", "throw", "unconfirmed", "replaced during unpin", "active during unpin"])
test(`AC-102/R-1: ${kind} pin preserves the worktree pending without consuming archive attempts`, async t => {
  const f = await fixture(t, { defaultPins: true });
  const row = legacyPin(f, "startPin", kind === "manual" ? null : kind === "changed" ? "old" : "owned");
  if (kind === "missing port") delete f.port.pushReview;
  if (kind === "missing method") delete f.port.pushReview.unpin;
  if (kind === "refused") f.port.pushReview.unpin = async () => false;
  if (kind === "throw") f.port.pushReview.unpin = async () => { throw Error("unpin failed"); };
  if (kind === "unconfirmed") f.port.pushReview.unpin = async () => true;
  if (kind === "replaced during unpin") f.port.pushReview.unpin = async () => { f.pins.set("tree", "new user pin"); return true; };
  if (kind === "active during unpin") f.port.pushReview.unpin = async () => { f.pins.delete("tree"); f.agents.get("E").status = "running"; return true; };
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "pending");
  assert.equal(f.w.worktreeCleanup.attempts, 0);
  assert.deepEqual(f.calls, []);
  if (["manual", "changed", "missing port", "missing method"].includes(kind)) assert.deepEqual(f.unpinCalls, []);
  if (["refused", "throw", "unconfirmed"].includes(kind)) assert.equal(row.ownedPinAt, "owned");
  if (kind === "replaced during unpin") assert.equal(f.pins.get("tree"), "new user pin");
});

for (const unsafe of ["dirty", "evidence", "post-copy dirty"])
test(`AC-102/AC-105/R-1: ${unsafe} prevents releasing even a plugin-owned pin`, async t => {
  const f = await fixture(t);
  legacyPin(f);
  if (unsafe === "dirty") await writeFile(path.join(f.tree, "feature.txt"), "dirty");
  if (unsafe === "evidence") await writeFile(path.join(f.state, "evidence"), "blocked");
  if (unsafe === "post-copy dirty") {
    const inspect = f.port.archiveInspection;
    let count = 0;
    f.port.archiveInspection = async ids => {
      if (++count === 2) await writeFile(path.join(f.tree, "feature.txt"), "late edit");
      return inspect(ids);
    };
  }
  await f.run();
  assert.deepEqual(f.unpinCalls, []);
  assert.deepEqual(f.calls, []);
  assert.equal(f.pins.get("tree"), "owned");
});

test("AC-104/R-1: lost unpin reply recovers after restart without pinning the executor again", async t => {
  const f = await fixture(t, { defaultPins: true });
  legacyPin(f);
  const unpin = f.port.pushReview.unpin;
  f.port.pushReview.unpin = async (id, at) => { await unpin(id, at); throw Error("response lost"); };
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "pending");
  assert.deepEqual(f.calls, []);
  await f.restart();
  assert.equal(f.w.worktreeCleanup.stage, "done");
  assert.deepEqual(f.pinCalls, ["plan"]);
  assert.deepEqual(f.unpinCalls, [{ id: "tree", expectedPinAt: "owned" }]);
  assert.equal(f.w.startPin.workspaces.find(row => row.id === "tree").phase, "acknowledged");
});


test("AC-101/AC-104/R-1: legacy queued executor pins stay excluded and retire after confirmed cleanup", async t => {
  const f = await fixture(t, { defaultPins: true });
  await f.engine.queuePushReview(f.w);
  const start = { id: "tree", phase: "queued", ownedPinAt: null };
  const pushed = { ...start };
  f.w.startPin.workspaces.push(start);
  f.w.pushReview.workspaces.push(pushed);
  await f.engine.syncStartPin(f.w);
  await f.engine.syncPushReview(f.w);
  assert.deepEqual(f.pinCalls, ["plan"]);
  assert.deepEqual(f.unpinCalls, []);
  await f.run();
  assert.equal(start.phase, "acknowledged");
  assert.equal(pushed.phase, "acknowledged");
  assert.equal(f.w.worktreeCleanup.stage, "done");
  await newPlan(f);
  await f.engine.syncStartPin(f.w);
  assert.deepEqual(f.pinCalls, ["plan"]);
});


for (const failure of ["missing directory", "identity mismatch"])
test(`AC-205 R-3: three consecutive permanent ${failure} errors need ten minutes before stopping durably`, async t => {
  const f = await fixture(t);
  if (failure === "missing directory") await rm(f.tree, { recursive: true });
  else { const identify = f.probe.identity; f.probe.identity = async cwd => ({ ...await identify(cwd), common: cwd }); }
  for (let i = 1; i <= 3; i++) {
    await f.run();
    assert.equal(f.w.worktreeCleanup.permanentErrors, i);
    assert.equal(f.w.worktreeCleanup.stage, "pending");
    assert.equal(f.w.worktreeCleanup.attempts, 0);
  }
  f.advance(10 * 60_000);
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "failed");
  assert.match(f.w.detail, /직접 보관하세요/);
  await f.restart();
  assert.equal(f.w.worktreeCleanup.permanentErrors, 4);
  assert.deepEqual(f.calls, []);
});

for (const progress of ["done", "pushed", "no_push"])
test(`AC-205 R-4: tick recognizes a manually archived missing worktree for finished ${progress} work`, async t => {
  const f = await fixture(t);
  f.w.progress = progress;
  f.agents.get("E").archived = true;
  f.spaces.delete("tree");
  await rm(f.tree, { recursive: true });
  await f.restart();
  assert.equal(f.w.worktreeCleanup.stage, "done");
  assert.notEqual(f.w.status, "paused");
  assert.deepEqual(f.calls, []);
  const at = f.w.worktreeCleanup.at;
  f.advance(); await f.restart();
  assert.equal(f.w.worktreeCleanup.at, at);
});

for (const hazard of ["assume-unchanged", "skip-worktree", "reflog only", "submodule"])
test(`AC-205 D-1: real Git ${hazard} hazards preserve the directory using read-only probes`, async t => {
  const f = await fixture(t);
  if (hazard === "assume-unchanged" || hazard === "skip-worktree") {
    await git(f.tree, "update-index", `--${hazard}`, "feature.txt");
    await writeFile(path.join(f.tree, "feature.txt"), "hidden change");
  }
  if (hazard === "reflog only") {
    await git(f.tree, "commit", "--allow-empty", "-q", "-m", "reflog only");
    await git(f.tree, "reset", "--hard", f.commit);
  }
  if (hazard === "submodule") {
    const sub = path.join(f.dir, "sub");
    await git(f.dir, "init", "-q", sub);
    await git(sub, "commit", "--allow-empty", "-q", "-m", "sub base");
    await git(f.tree, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "module");
    await git(f.tree, "commit", "-q", "-am", "add submodule");
    const integrated = await git(f.tree, "rev-parse", "HEAD");
    f.w.integration.commit = integrated;
    f.w.managedPush.targets[0].commit = integrated;
    f.w.pushCheck.targets[0].commit = integrated;
    await git(path.join(f.tree, "module"), "commit", "--allow-empty", "-q", "-m", "module changed");
  }
  if (hazard === "submodule") assert.match((await f.probe.cleanupHazards(f.tree, f.w.integration.commit)).join(" "), /submodule/);
  const before = await git(f.tree, "show-ref");
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "skipped");
  assert.deepEqual(f.calls, []);
  assert.equal(await git(f.tree, "show-ref"), before);
  assert.match(f.w.worktreeCleanup.detail, hazard === "reflog only" ? /reflog/ : hazard === "submodule" ? /submodule|커밋하지 않은/ : /assume-unchanged|skip-worktree/);
});

for (const excess of ["files", "bytes"])
test(`AC-205 D-3: evidence ${excess} over the limit stays pending with zero archive attempts`, async t => {
  const f = await fixture(t);
  const folder = path.join(f.tree, "evidence");
  if (excess === "files") await Promise.all(Array.from({ length: 1000 }, (_, i) => writeFile(path.join(folder, String(i)), "")));
  else {
    const { open } = await import("node:fs/promises");
    const file = await open(path.join(folder, "huge"), "w");
    await file.truncate(200 * 1024 * 1024 + 1); await file.close();
  }
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "pending");
  assert.equal(f.w.worktreeCleanup.attempts, 0);
  assert.match(f.w.detail, /1000.*200MB/);
  assert.deepEqual(f.calls, []);
});

test("AC-205 D-3: a swapped source symlink after enumeration never copies outside contents", async t => {
  const f = await fixture(t);
  const source = path.join(f.tree, "evidence");
  const target = path.join(f.state, "swapped-copy");
  const outside = path.join(f.dir, "outside");
  await writeFile(outside, "PRIVATE OUTSIDE CONTENT");
  // Swap the second file while the first file's bounded copy is running.
  const { open, access } = await import("node:fs/promises");
  const large = await open(path.join(source, "00-large"), "w"); await large.truncate(64 * 1024 * 1024); await large.close();
  const swap = (async () => {
    for (;;) {
      try { await access(path.join(target, "00-large")); break; } catch { await new Promise(r => setTimeout(r, 1)); }
    }
    await rm(path.join(source, "test.log"));
    await symlink(outside, path.join(source, "test.log"));
  })();
  await assert.rejects(preserveEvidence(source, target));
  await swap;
  const copied = await readFile(path.join(target, "test.log"), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  assert.doesNotMatch(copied, /PRIVATE|OUTSIDE/);
});

test("AC-205 D-4: engine recreates generation 2 through the real port with a stable :2 key after a lost workspace reply", async t => {
  const f = await fixture(t);
  await f.run();
  const other = { ...f.agents.get("P"), id: "other", workspaceId: "other" };
  f.agents.set("other", other); await f.engine.enroll(other, other.config, {}, "general", true, 5);
  await f.engine.configure({ ...await f.engine.settings(), executorPlacement: "worktree" });
  const requests = [];
  let made = false;
  const folder = path.join(f.dir, "generation-2");
  const native = createPort(() => ({ workspaces: { create: async input => {
    requests.push(structuredClone(input));
    if (!made) {
      made = true;
      await git(f.repo, "worktree", "add", "-q", "-b", input.source.branchName, folder, input.source.baseBranch);
      throw Error("workspace reply lost");
    }
    return { id: "second-tree", refresh: async () => ({ workspaceDirectory: folder }) };
  } } }));
  f.port.createWorktree = native.createWorktree;
  f.port.create = async (w, role, member) => {
    f.agents.set(member.id, { ...f.agents.get("P"), id: member.id, workspaceId: "second-tree", cwd: folder });
    return "second-tree";
  };
  await newPlan(f);
  assert.equal(f.w.status, "error");
  await f.engine.control(f.id, "resume");
  assert.equal(f.w.execute.generation, 2);
  assert.equal(f.w.execute.workspaceId, "second-tree");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].idempotencyKey, `role-workflow:${f.id}:worktree:2`);
  assert.deepEqual(requests[0], requests[1]);
  assert.match(requests[0].source.branchName, /-2$/);
});


test("AC-205 D-3: exactly 1000 evidence files are preserved at the inclusive limit", async t => {
  const f = await fixture(t);
  const source = path.join(f.tree, "evidence");
  await Promise.all(Array.from({ length: 999 }, (_, i) => writeFile(path.join(source, String(i)), "")));
  assert.equal(await preserveEvidence(source, path.join(f.state, "limit-copy")), 1000);
});

test("AC-205 D-3: a pre-existing destination symlink cannot overwrite an outside file", async t => {
  const f = await fixture(t);
  const destination = path.join(f.state, "target-copy");
  await mkdir(destination);
  const outside = path.join(f.dir, "outside");
  await writeFile(outside, "outside must survive");
  await symlink(outside, path.join(destination, "test.log"));
  await assert.rejects(preserveEvidence(path.join(f.tree, "evidence"), destination));
  assert.equal(await readFile(outside, "utf8"), "outside must survive");
});


test("AC-205 D-3: growth beyond 200MB during copy stays pending without consuming archive attempts", async t => {
  const f = await fixture(t);
  const { open, access } = await import("node:fs/promises");
  const source = path.join(f.tree, "evidence");
  const large = await open(path.join(source, "00-large"), "w"); await large.truncate(64 * 1024 * 1024); await large.close();
  const grow = (async () => {
    for (;;) { try { await access(path.join(f.state, "evidence", f.id, "worktree", "tree", "00-large")); break; } catch { await new Promise(r => setTimeout(r, 1)); } }
    const file = await open(path.join(source, "test.log"), "r+"); await file.truncate(200 * 1024 * 1024 + 1); await file.close();
  })();
  await f.run(); await grow;
  assert.equal(f.w.worktreeCleanup.stage, "pending");
  assert.equal(f.w.worktreeCleanup.attempts, 0);
  assert.deepEqual(f.calls, []);
});


test("AC-202: the real engine gate rejects archive requests without this cleanup call's copied-evidence proof", async t => {
  const f = await fixture(t);
  assert.equal((await f.engine.lifecycle.archiveCleaned(f.w)).stage, "pending");
  assert.equal((await f.engine.worktreeCleanup.verifyForArchive(f.w)).stage, "pending");
  assert.deepEqual(f.calls, []);
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "done");
  assert.equal((await f.engine.worktreeCleanup.verifyForArchive(f.w)).stage, "pending", "proof cannot be reused after archive");
});

test("AC-205 N-3: Git query output limits remain pending with a reason and no archive attempt", async t => {
  const f = await fixture(t);
  f.probe.cleanupHazards = async () => { throw Error("Git 안전 검사 출력이 32MB를 넘어 전체 상태를 확인하지 못했습니다"); };
  for (let i = 0; i < 4; i++) { await f.run(); f.advance(); }
  assert.equal(f.w.worktreeCleanup.stage, "pending");
  assert.equal(f.w.worktreeCleanup.attempts, 0);
  assert.equal(f.w.worktreeCleanup.permanentErrors, 0);
  assert.match(f.w.worktreeCleanup.detail, /32MB.*확인하지 못/);
  assert.deepEqual(f.calls, []);
});

test("AC-205 N-2: elapsed ten minutes alone is insufficient and legacy failures start a fresh observation window", async t => {
  const f = await fixture(t);
  await rm(f.tree, { recursive: true });
  f.w.worktreeCleanup = { stage: "failed", attempts: 0, at: new Date(0).toISOString(), detail: "old", evidenceFiles: null,
    permanentError: "worktree 디렉터리가 없습니다", permanentErrors: 3, permanentSince: null };
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "pending");
  assert.equal(f.w.worktreeCleanup.permanentErrors, 1);
  f.advance(10 * 60_000);
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "pending");
  assert.equal(f.w.worktreeCleanup.permanentErrors, 2);
  await f.run();
  assert.equal(f.w.worktreeCleanup.stage, "failed");
  assert.equal(f.w.worktreeCleanup.permanentErrors, 3);
  assert.deepEqual(f.calls, []);
});

test("AC-205 N-3: repeated submodule timeout stays pending with a direct archive explanation and no attempt consumption", async t => {
  const f = await fixture(t);
  const slow = createRepoProbe(async (cwd, args) => {
    if (args[0] === "submodule" && args[1] === "foreach") throw Object.assign(Error("timeout"), { killed: true });
    return "";
  });
  f.probe.cleanupHazards = slow.cleanupHazards;
  for (let i = 0; i < 4; i++) { await f.run(); f.advance(); }
  assert.equal(f.w.worktreeCleanup.stage, "pending");
  assert.equal(f.w.worktreeCleanup.attempts, 0);
  assert.match(f.w.worktreeCleanup.detail, /서브모듈.*5초/);
  assert.match(f.w.worktreeCleanup.detail, /Paseo에서 해당 작업 공간을 직접 보관/);
  assert.deepEqual(f.calls, []);
});
