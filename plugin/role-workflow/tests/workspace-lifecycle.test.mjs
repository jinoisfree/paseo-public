import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { capabilityViolations } from "./capability-structure.mjs";
import { WorkspaceLifecycle } from "../server/workspace-lifecycle.ts";

async function sources(folder) {
  return (await Promise.all((await readdir(folder, { withFileTypes: true })).map(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? sources(file) : /\.[cm]?tsx?$/.test(file) ? [file] : [];
  }))).flat();
}
test("AC-201 C-1: all server modules and the server entrypoint obey capability file allowlists", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const files = [...await sources(path.join(root, "server")), path.join(root, "index.server.ts")];
  const violations = (await Promise.all(files.map(async file => capabilityViolations(await readFile(file, "utf8"), path.relative(root, file))))).flat();
  assert.deepEqual(violations, []);
});
for (const name of ["workspace-chain", "reflect", "template", "concatenation", "daemon-pin", "timeline-alias", "timeline-destructure", "computed-cleanup"])
  test(`AC-201 C-1: negative fixture ${name} must fail in both server and entrypoint`, async () => {
    const source = await readFile(new URL(`./fixtures/capability-bypasses/${name}.ts`, import.meta.url), "utf8");
    for (const file of ["server/bypass.ts", "index.server.ts"])
      assert.ok(capabilityViolations(source, file).length > 0, `${file}: ${name} escaped`);
  });

function fixture(cleanupReadiness) {
  const w = { id: "w", isolation: "worktree", worktree: { workspaceId: "tree" }, execute: { id: "E", workspaceId: "tree" }, plan: { workspaceId: "plan" }, startPin: { workspaces: [] } };
  let pinnedAt = "user";
  const calls = [];
  const port = {
    archiveWorkspace: async (...args) => calls.push(structuredClone(args)),
    archiveInspection: async () => ({ workspaces: [{ id: "tree", pinnedAt: null }], conversations: [{ id: "E", workspaceId: "tree", status: "idle", activeTurn: false, permission: false }] }),
    pushReview: { get: async () => ({ pinnedAt }), pin: async () => { assert.fail("worktree pin"); },
      unpin: async (...args) => { calls.push(structuredClone(args)); pinnedAt = null; return true; } },
  };
  const gate = new WorkspaceLifecycle({ port: () => port, db: async () => ({ workflows: [w] }), cleanupReadiness }, port);
  return { w, port, calls, gate };
}
test("AC-202: direct worktree archive, non-ready cleanup, automatic pin and user unpin have zero mutations", async () => {
  const f = fixture();
  await assert.rejects(f.gate.archive("tree"), /안전 정리/);
  assert.equal((await f.gate.archiveCleaned(f.w)).stage, "pending");
  await assert.rejects(f.gate.pinWorkspace("tree"), /자동 고정/);
  assert.equal(await f.gate.unpinOwned("tree", "user"), false, "matching a user timestamp alone is not ownership");
  f.w.startPin.workspaces.push({ id: "tree", ownedPinAt: "old" });
  assert.equal(await f.gate.unpinOwned("tree", "old"), false);
  assert.deepEqual(f.calls, []);
});
test("AC-202: current owned pin may be released and each clean archive consumes a fresh readiness result", async () => {
  let checks = 0;
  const f = fixture(async () => ({ stage: ++checks === 1 ? "ready" : "pending", detail: "changed" }));
  f.w.startPin.workspaces.push({ id: "tree", ownedPinAt: "user" });
  assert.equal(await f.gate.unpinOwned("tree", "user"), true);
  assert.equal((await f.gate.archiveCleaned(f.w)).stage, "ready");
  assert.equal((await f.gate.archiveCleaned(f.w)).stage, "pending");
  assert.deepEqual(f.calls, [["tree", "user"], ["tree"]]);
});
test("AC-205 D-2: a final active turn or permission appearing after readiness prevents archive", async () => {
  for (const field of ["activeTurn", "permission"]) {
    const f = fixture(async () => ({ stage: "ready", detail: "" }));
    const inspect = f.port.archiveInspection;
    f.port.archiveInspection = async () => { const data = await inspect(); data.conversations[0][field] = true; return data; };
    assert.equal((await f.gate.archiveCleaned(f.w)).stage, "pending");
    assert.deepEqual(f.calls, []);
  }
});


test("AC-205 R-3/D-2: a final activity query failure preserves the workspace for a later tick", async () => {
  const f = fixture(async () => ({ stage: "ready", detail: "" }));
  f.port.archiveInspection = async () => { throw Error("offline"); };
  assert.equal((await f.gate.archiveCleaned(f.w)).stage, "pending");
  assert.deepEqual(f.calls, []);
});

test("AC-205 D-2: ordinary archive also refuses a last-moment active turn or permission", async () => {
  for (const field of ["activeTurn", "permission"]) {
    const f = fixture();
    f.w.isolation = "shared";
    const inspect = f.port.archiveInspection;
    f.port.archiveInspection = async () => { const result = await inspect(); result.conversations[0][field] = true; return result; };
    await assert.rejects(f.gate.archive("tree"), /보관 직전/);
    assert.deepEqual(f.calls, []);
  }
});

test("AC-201 C-1: operational handles and port expose no raw mutation or timeline capability", async () => {
  const { operationalApi } = await import("../server/timeline-cards.ts");
  const { createPort } = await import("../server/paseo-port.ts");
  const raw = { agents: { ref: () => ({ timeline: { append() {} }, send() {}, refresh() {} }) },
    workspaces: { ref: () => ({ id: "x", archive() {}, refresh() {}, setTitle() {}, agents: { create() {} } }) } };
  const safe = operationalApi(raw);
  assert.deepEqual(Object.keys(safe.agents.ref("x")).sort(), ["id", "refresh", "send"]);
  assert.deepEqual(Object.keys(safe.workspaces.ref("x")).sort(), ["agents", "id", "refresh", "setTitle"]);
  const port = createPort(() => raw);
  assert.equal("archiveWorkspace" in port, false);
  assert.equal("pushReview" in port, false);
  assert.equal("getApi" in port, false);
  raw.workspaces.create = async () => raw.workspaces.ref("x");
  raw.workspaces.ref = () => ({ id: "new", archive() {}, refresh() {}, setTitle() {},
    agents: { create: async () => ({ id: "agent", timeline: { append() {} }, refresh() {}, send() {} }) } });
  const fresh = await safe.workspaces.create({});
  assert.equal("archive" in fresh, false);
  const created = await fresh.agents.create({});
  assert.deepEqual(Object.keys(created).sort(), ["id", "refresh", "send"]);
  assert.equal("timeline" in created, false);
});

test("AC-202 N-4: ordinary archive preserves dirty/unpushed external linked worktrees and archives only remote-included clean HEAD", async t => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, writeFile, rm, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const exec = promisify(execFile);
  const dir = await mkdtemp(path.join(tmpdir(), "external-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo"), tree = path.join(dir, "tree"), remote = path.join(dir, "remote.git");
  const git = (cwd, ...args) => exec("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd });
  await git(dir, "init", "-q", "-b", "main", repo);
  await git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  await git(repo, "worktree", "add", "-q", "-b", "feature", tree);
  await mkdir(path.join(tree, "nested"));
  const f = fixture(); f.w.isolation = "shared";
  const inspect = f.port.archiveInspection;
  f.port.archiveInspection = async () => { const data = await inspect(); data.workspaces[0].cwd = path.join(tree, "nested"); return data; };
  await writeFile(path.join(tree, "dirty"), "keep me");
  await assert.rejects(f.gate.archive("tree"), /커밋하지 않은/);
  assert.deepEqual(f.calls, []);
  await git(tree, "add", "dirty"); await git(tree, "commit", "-q", "-m", "local");
  await assert.rejects(f.gate.archive("tree"), /원격 포함/);
  assert.deepEqual(f.calls, []);
  await git(dir, "init", "--bare", "-q", remote);
  await git(tree, "remote", "add", "origin", remote);
  // Test fixture writes to its disposable bare remote; production uses read-only probes.
  await git(remote, "fetch", "-q", tree, "HEAD:refs/heads/feature");
  await git(tree, "fetch", "-q", "origin");
  await f.gate.archive("tree");
  assert.deepEqual(f.calls, [["tree"]]);
  f.calls.length = 0;
  await git(remote, "update-ref", "-d", "refs/heads/feature");
  await assert.rejects(f.gate.archive("tree"), /원격 포함/);
  assert.deepEqual(f.calls, []);
});

test("AC-202 N-4: unknown or unreadable directories preserve ordinary workspaces with a reason", async () => {
  for (const cwd of [undefined, "/not-present-workspace-fixture"]) {
    const f = fixture(); f.w.isolation = "shared";
    const inspect = f.port.archiveInspection;
    f.port.archiveInspection = async () => { const data = await inspect(); data.workspaces[0].cwd = cwd; return data; };
    await assert.rejects(f.gate.archive("tree"), /디렉터리.*보존/);
    assert.deepEqual(f.calls, []);
  }
});

test("AC-202 C-1: moving archive transport into the gate preserves its thirty-second response budget", async t => {
  const { createWorkspaceAccess } = await import("../server/workspace-lifecycle.ts");
  let called;
  const started = new Promise(resolve => { called = resolve; });
  const access = createWorkspaceAccess("/tmp");
  access.attach({ workspaces: { ref: () => ({ archive: () => { called(); return new Promise(() => {}); } }) } });
  const f = fixture();
  const inspect = f.port.archiveInspection;
  f.port.archiveInspection = async () => { const data = await inspect(); data.workspaces[0].cwd = "/tmp"; return data; };
  const gate = access.lifecycle({ port: () => f.port, db: async () => ({ workflows: [] }) });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = gate.archive("tree");
  await started;
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /30초/);
  await access.closeLifecycle();
});
