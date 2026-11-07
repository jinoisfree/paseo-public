import { archiveSdk } from "./lifecycle-fixture.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { capabilityViolations } from "./capability-structure.mjs";
import { WorkspaceLifecycle, bindWorkspaceLifecycle } from "../server/workspace-lifecycle.ts";

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
for (const name of ["workspace-chain", "reflect", "template", "concatenation", "daemon-pin", "timeline-alias", "timeline-destructure", "computed-cleanup", "lifecycle-destructure", "lifecycle-prototype", "context-data-helper", "context-entries", "context-unknown-data", "context-values", "context-descriptor", "context-alias"])
  test(`AC-201 C-1: negative fixture ${name} must fail in both server and entrypoint`, async () => {
    const source = await readFile(new URL(`./fixtures/capability-bypasses/${name}.ts`, import.meta.url), "utf8");
    for (const file of ["server/bypass.ts", "index.server.ts"]) {
      const violations = capabilityViolations(source, file);
      assert.ok(violations.length > 0, `${file}: ${name} escaped`);
      if (name.startsWith("context-")) assert.ok(violations.some(v => /raw context API/.test(v)), `${name} must be caught at its API source`);
      if (name === "lifecycle-destructure") assert.ok(violations.some(v => /destructured capability/.test(v)));
      if (name === "lifecycle-prototype") assert.ok(violations.some(v => /prototype/.test(v)));
    }
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
  const gate = new WorkspaceLifecycle(port, ids => port.archiveInspection(ids));
  bindWorkspaceLifecycle(gate, { db: async () => ({ workflows: [w] }), cleanupReadiness });
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
  assert.deepEqual(Object.keys(safe.agents.ref("x")).sort(), ["id", "refresh", "respondToPermission", "send"]);
  assert.deepEqual(Object.keys(safe.workspaces.ref("x")).sort(), ["agents", "id", "refresh", "setTitle"]);
  const port = createPort(() => raw);
  assert.equal("lifecycle" in port, false);
  assert.equal("archiveWorkspace" in port, false);
  assert.equal("pushReview" in port, false);
  assert.equal("getApi" in port, false);
  raw.workspaces.create = async () => raw.workspaces.ref("x");
  raw.workspaces.ref = () => ({ id: "new", archive() {}, refresh() {}, setTitle() {},
    agents: { create: async () => ({ id: "agent", timeline: { append() {} }, refresh() {}, send() {} }) } });
  const fresh = await safe.workspaces.create({});
  assert.equal("archive" in fresh, false);
  const created = await fresh.agents.create({});
  assert.deepEqual(Object.keys(created).sort(), ["id", "refresh", "respondToPermission", "send"]);
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
  const before = (await git(tree, "rev-parse", "HEAD")).stdout.trim();
  await git(tree, "commit", "-q", "--allow-empty", "-m", "reflog only");
  await git(tree, "reset", "--hard", before);
  await assert.rejects(f.gate.archive("tree"), error => {
    assert.match(error.message, /reflog/);
    assert.match(error.message, /Paseo에서 해당 작업 공간을 직접 보관/);
    return true;
  });
  assert.deepEqual(f.calls, []);
  // Only this disposable fixture removes the historical commit before testing a deleted remote.
  await git(tree, "reflog", "expire", "--expire=now", "--all");
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
  access.attach(archiveSdk("tree", () => { called(); return new Promise(() => {}); }));
  const f = fixture();
  const inspect = f.port.archiveInspection;
  f.port.archiveInspection = async () => { const data = await inspect(); data.workspaces[0].cwd = "/tmp"; return data; };
  const gate = access.createLifecycle();
  bindWorkspaceLifecycle(gate, { db: async () => ({ workflows: [] }) });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = gate.archive("tree");
  await started;
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /30초/);
  await access.closeLifecycle();
});

test("AC-201/AC-202 C-1-R1: one real gate binds once to the actual engine and forged operation policies never archive", async t => {
  const { WorkflowEngine } = await import("../server/engine.ts");
  const { createWorkspaceAccess } = await import("../server/workspace-lifecycle.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(path.join(tmpdir(), "bound-policy-"));
  let archives = 0;
  const access = createWorkspaceAccess("/tmp");
  const sdk = archiveSdk("tree", async () => { archives++; return { workspaceId: "tree", archivedAt: "now" }; });
  access.attach(sdk);
  const gate = access.createLifecycle();
  const port = {};
  const engine = new WorkflowEngine(path.join(dir, "state.json"), port, undefined, undefined, undefined, undefined, gate);
  t.after(async () => { await engine.close(); await access.closeLifecycle(); await rm(dir, { recursive: true, force: true }); });
  await engine.settings();
  const w = { id: "w", isolation: "worktree", worktree: { workspaceId: "tree" }, execute: { id: "agent", workspaceId: "tree" }, startPin: { workspaces: [] } };
  engine.database.workflows.push(w);
  const forged = { db: async () => ({ workflows: [] }), cleanupReadiness: async () => ({ stage: "ready", detail: "forged" }) };
  assert.equal("lifecycle" in port, false);
  assert.equal("bind" in gate, false);
  assert.equal("host" in gate, false);
  assert.equal("transport" in gate, false);
  assert.ok(Object.isFrozen(gate));
  assert.throws(() => { gate.host = forged; }, TypeError);
  assert.throws(() => access.createLifecycle(), /한 번/);
  assert.throws(() => bindWorkspaceLifecycle(gate, forged), /한 번/);
  assert.throws(() => new WorkflowEngine(path.join(dir, "second.json"), port, undefined, undefined, undefined, undefined, gate), /한 번/);
  await assert.rejects(gate.archive("tree", forged), /안전 정리/);
  await assert.rejects(gate.pinWorkspace("tree", forged), /자동 고정/);
  assert.equal(await gate.unpinOwned("tree", "user", forged), false);
  assert.equal((await gate.archiveCleaned(w, forged)).stage, "pending");
  const { archive } = gate;
  await assert.rejects(archive.call(gate, "tree", forged), /안전 정리/);
  assert.equal((await WorkspaceLifecycle.prototype.archiveCleaned.call(gate, w, forged)).stage, "pending");
  await assert.rejects(WorkspaceLifecycle.prototype.unpinOwned.call({ host: forged, transport: {} }, "tree", "user"), TypeError);
  // A caller replacing the public port inspector cannot replace the gate's real SDK observation.
  w.isolation = "shared";
  let fakeInspections = 0;
  port.archiveInspection = async () => { fakeInspections++; return { workspaces: [], conversations: [] }; };
  const ref = sdk.agents.ref;
  sdk.agents.ref = id => {
    const handle = ref(id);
    const read = handle.timeline.refetch;
    handle.timeline.refetch = async () => { const data = await read(); data.agent.activeTurn = {}; return data; };
    return handle;
  };
  await assert.rejects(gate.archive("tree"), /보관 직전/);
  assert.equal(fakeInspections, 0);
  assert.equal(archives, 0);
});

test("AC-201 D-1/C-1-R2: ordinary computed data access is allowed while raw context aliases and policy registration are rejected", () => {
  assert.deepEqual(capabilityViolations('const title = labels[key]; rows[index] = title; delete env[key];', "server/data.ts"), []);
  assert.deepEqual(capabilityViolations('attach(context.paseo);', "index.server.ts"), []);
  for (const source of [
    'const alias = context; const api = alias["pa" + "seo"];',
    'const key = "paseo"; const api = context[key];',
    'const { paseo: api } = context;',
    'server.handle(contract, (input, ctx) => { const alias = ctx; return alias[field]; });',
    'bindWorkspaceLifecycle(gate, {db: fake});',
  ]) assert.ok(capabilityViolations(source, "index.server.ts").length);
  assert.ok(capabilityViolations('class E { resume() { bindWorkspaceLifecycle(gate, {db: fake}); } }', "server/engine.ts").length);
});

test("AC-201 C-1-R1: every lifecycle policy operation rejects destructured and prototype bypass syntax", () => {
  for (const method of ["pinWorkspace", "unpinOwned", "archive", "archiveCleaned"]) {
    assert.ok(capabilityViolations(`const { ${method}: go } = gate; go.call(gate, target, forged);`, "server/bypass.ts").some(v => /destructured capability/.test(v)), method);
    assert.ok(capabilityViolations(`const go = WorkspaceLifecycle.prototype.${method}; go.call(gate, target, forged);`, "server/bypass.ts").some(v => /prototype/.test(v)), method);
  }
});
