import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import { WorkspaceLifecycle } from "../server/workspace-lifecycle.ts";

async function sources(folder) {
  return (await Promise.all((await readdir(folder, { withFileTypes: true })).map(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? sources(file) : /\.[cm]?tsx?$/.test(file) ? [file] : [];
  }))).flat();
}
test("AC-201: every raw workspace mutation call in server stays inside workspace-lifecycle", async () => {
  const folder = path.resolve(import.meta.dirname, "../server");
  const violations = [];
  for (const file of await sources(folder)) {
    const ast = parse(await readFile(file, "utf8"), { sourceType: "module", plugins: ["typescript"] });
    function visit(node) {
      if (!node || typeof node !== "object") return;
      const key = property => property?.type === "Identifier" ? property.name : property?.value;
      const raw = name => ["archiveWorkspace", "pin", "unpin"].includes(name);
      if (path.basename(file) !== "workspace-lifecycle.ts") {
        if (["MemberExpression", "OptionalMemberExpression"].includes(node.type) && raw(node.computed ? node.property.value : key(node.property)))
          violations.push(`${path.basename(file)}:${node.loc.start.line} raw mutation handle`);
        if (node.type === "ObjectPattern" && node.properties.some(p => raw(key(p.key))))
          violations.push(`${path.basename(file)}:${node.loc.start.line} destructured mutation handle`);
        if (["CallExpression", "OptionalCallExpression"].includes(node.type) && node.callee.type === "Identifier" && raw(node.callee.name))
          violations.push(`${path.basename(file)}:${node.loc.start.line} raw mutation function`);
      }
      if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
        let callee = node.callee;
        while (callee?.type === "TSNonNullExpression") callee = callee.expression;
        if (["MemberExpression", "OptionalMemberExpression"].includes(callee?.type)) {
          const key = callee.computed ? callee.property.value : callee.property.name;
          if (["archiveWorkspace", "pin", "unpin"].includes(key) && path.basename(file) !== "workspace-lifecycle.ts")
            violations.push(`${path.basename(file)}:${node.loc.start.line} ${key}`);
          if (key === "archiveCleaned" && path.basename(file) !== "worktree-cleanup.ts")
            violations.push(`${path.basename(file)}:${node.loc.start.line} cleanup proof outside cleanup`);
          if (key === "append" && callee.object?.property?.name === "timeline" && path.basename(file) !== "timeline-cards.ts")
            violations.push(`${path.basename(file)}:${node.loc.start.line} unchecked timeline append`);
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    }
    visit(ast);
  }
  assert.deepEqual(violations, []);
});

function fixture(cleanupReadiness) {
  const w = { id: "w", isolation: "worktree", worktree: { workspaceId: "tree" }, execute: { id: "E", workspaceId: "tree" }, plan: { workspaceId: "plan" }, startPin: { workspaces: [] } };
  let pinnedAt = "user";
  const calls = [];
  const port = {
    archiveWorkspace: async (...args) => calls.push(args),
    archiveInspection: async () => ({ workspaces: [{ id: "tree", pinnedAt: null }], conversations: [{ id: "E", workspaceId: "tree", status: "idle", activeTurn: false, permission: false }] }),
    pushReview: { get: async () => ({ pinnedAt }), pin: async () => { assert.fail("worktree pin"); },
      unpin: async (...args) => { calls.push(args); pinnedAt = null; return true; } },
  };
  const gate = new WorkspaceLifecycle({ port: () => port, db: async () => ({ workflows: [w] }), cleanupReadiness });
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
