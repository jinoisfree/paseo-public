import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveCandidate } from "../server/archive.ts";
import { WorkflowEngine } from "../server/engine.ts";

const now = Date.parse("2026-10-06T12:00:00Z");
const old = new Date(now - 4 * 86400000).toISOString();
const flow = () => ({
  id: "flow",
  number: 1,
  title: "finished",
  projectId: "project",
  cwd: "/work/project",
  progress: "pushed",
  mode: "federated",
  status: "completed",
  plan: { id: "planner", workspaceId: "ws" },
  execute: { id: "executor", workspaceId: "ws" },
});
const inspection = () => ({
  workspaces: [{ id: "ws", pinnedAt: null, archiving: false, status: "done" }],
  conversations: ["planner", "executor"].map((id) => ({
    id,
    workspaceId: "ws",
    archived: false,
    status: "idle",
    permission: false,
    activeTurn: false,
    lastActivityAt: old,
  })),
});
test("archive candidate uses the latest conversation and respects the exact grace boundary", () => {
  const data = inspection();
  assert.equal(archiveCandidate(flow(), data, "pushed", 3, now)?.workspaceIds.length, 1);
  data.conversations[1].lastActivityAt = new Date(now - 3 * 86400000 + 1).toISOString();
  assert.equal(archiveCandidate(flow(), data, "pushed", 3, now), null);
  data.conversations[1].lastActivityAt = new Date(now - 3 * 86400000).toISOString();
  assert.ok(archiveCandidate(flow(), data, "pushed", 3, now));
  data.conversations[1].lastActivityAt = new Date(now).toISOString();
  assert.ok(archiveCandidate(flow(), data, "pushed", 0, now));
});

test("unfinished mode transition and uncertain continuation delivery cannot be archived", () => {
  assert.equal(
    archiveCandidate({ ...flow(), generalTransition: true }, inspection(), "pushed", 3, now),
    null,
  );
  for (const stage of ["queued", "sending", "uncertain"])
    assert.equal(
      archiveCandidate({ ...flow(), generalDelivery: { stage } }, inspection(), "pushed", 3, now),
      null,
    );
  assert.ok(
    archiveCandidate(
      { ...flow(), generalDelivery: { stage: "sent" } },
      inspection(),
      "pushed",
      3,
      now,
    ),
  );
});
test("a previously archived half still contributes its last conversation activity to the grace period", () => {
  const w = flow(),
    data = inspection();
  w.plan.workspaceId = "old-ws";
  data.conversations[0].workspaceId = "old-ws";
  data.conversations[0].archived = true;
  data.conversations[0].lastActivityAt = new Date(now - 86400000).toISOString();
  assert.equal(archiveCandidate(w, data, "pushed", 3, now), null);
  data.conversations[0].lastActivityAt = old;
  assert.deepEqual(archiveCandidate(w, data, "pushed", 3, now)?.workspaceIds, ["ws"]);
  data.conversations[0].lastActivityAt = null;
  assert.equal(archiveCandidate(w, data, "pushed", 3, now), null);
});
for (const [name, change] of [
  [
    "pinned",
    (w, d) => {
      d.workspaces[0].pinnedAt = old;
    },
  ],
  [
    "unknown pin",
    (w, d) => {
      delete d.workspaces[0].pinnedAt;
    },
  ],
  [
    "running",
    (w, d) => {
      d.conversations[1].status = "running";
    },
  ],
  [
    "initializing",
    (w, d) => {
      d.conversations[1].status = "initializing";
    },
  ],
  [
    "permission or question",
    (w, d) => {
      d.conversations[1].permission = true;
    },
  ],
  [
    "unknown permissions",
    (w, d) => {
      d.conversations[1].permission = null;
    },
  ],
  [
    "active turn",
    (w, d) => {
      d.conversations[1].activeTurn = true;
    },
  ],
  [
    "unknown turn",
    (w, d) => {
      d.conversations[1].activeTurn = null;
    },
  ],
  [
    "other running tab",
    (w, d) => {
      d.conversations.push({ ...d.conversations[0], id: "other", status: "running" });
    },
  ],
  [
    "question in engine",
    (w) => {
      w.status = "needs_input";
    },
  ],
  [
    "queued delivery",
    (w) => {
      w.pending = { stage: "queued" };
    },
  ],
  [
    "unprocessed result",
    (w) => {
      w.inbox = {};
    },
  ],
  [
    "held instruction",
    (w) => {
      w.held = {};
    },
  ],
  [
    "asker",
    (w) => {
      w.asker = "execute";
    },
  ],
  [
    "compacting",
    (w) => {
      w.plan.compaction = "compact";
    },
  ],
  [
    "undecided",
    (w) => {
      w.mode = "undecided";
    },
  ],
  [
    "plan progress",
    (w) => {
      w.progress = "plan";
    },
  ],
  [
    "active progress",
    (w) => {
      w.progress = "active";
    },
  ],
  [
    "done in pushed scan",
    (w) => {
      w.progress = "done";
    },
  ],
  [
    "missing member",
    (w, d) => {
      d.conversations.pop();
    },
  ],
  [
    "missing workspace",
    (w, d) => {
      d.workspaces = [];
    },
  ],
  [
    "missing workspace id",
    (w) => {
      w.execute.workspaceId = null;
    },
  ],
  [
    "unknown activity",
    (w, d) => {
      d.conversations[1].lastActivityAt = null;
    },
  ],
  [
    "invalid activity",
    (w, d) => {
      d.conversations[1].lastActivityAt = "invalid";
    },
  ],
  [
    "future activity",
    (w, d) => {
      d.conversations[1].lastActivityAt = new Date(now + 1).toISOString();
    },
  ],
  [
    "already archiving",
    (w, d) => {
      d.workspaces[0].archiving = true;
    },
  ],
  [
    "waiting workspace",
    (w, d) => {
      d.workspaces[0].status = "needs_input";
    },
  ],
  [
    "already archived",
    (w, d) => {
      d.workspaces = [];
      d.conversations.forEach((a) => {
        a.archived = true;
      });
    },
  ],
])
  test(`archive candidate preserves ${name}`, () => {
    const w = flow(),
      d = inspection();
    change(w, d);
    assert.equal(archiveCandidate(w, d, "pushed", 3, now), null);
  });

async function fixture(
  t,
  progress = "pushed",
  mode = "general",
  separated = false,
  status = mode === "general" ? "active" : "completed",
) {
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-archive-"));
  const file = path.join(dir, "state.json");
  const events = [],
    archived = [];
  const agents = new Map(
    ["planner", "executor"].map((id) => [
      id,
      {
        id,
        workspaceId: separated && id === "executor" ? "other-ws" : "ws",
        projectId: "project",
        cwd: dir,
        title: "finished",
        status: "idle",
        archived: false,
        permission: false,
        usage: 0,
        activeTurn: false,
        lastActivityAt: new Date(Date.now() - 4 * 86400000).toISOString(),
      },
    ]),
  );
  const workspaces = new Map(
    ["ws", ...(separated ? ["other-ws"] : [])].map((id) => [
      id,
      {
        id,
        pinnedAt: null,
        archiving: false,
        status: "done",
      },
    ]),
  );
  let inspections = 0;
  const port = {
    projectName: async (id) => id,
    workspaceName: async () => "finished",
    inspect: async (id) => agents.get(id) ?? null,
    rename: async () => {},
    history: async () => ({ text: "", key: "", messageIds: [], failed: null }),
    send: async () => {
      throw Error("must not send");
    },
    compact: async () => {
      throw Error("must not compact");
    },
    archiveInspection: async () => {
      inspections++;
      return { workspaces: [...workspaces.values()], conversations: [...agents.values()] };
    },
    archiveWorkspace: async (id) => {
      archived.push(id);
      workspaces.delete(id);
      for (const a of agents.values()) if (a.workspaceId === id) a.archived = true;
    },
  };
  const probe = { snapshot: async () => null, changes: async () => "", pushed: async () => true };
  let engine = new WorkflowEngine(file, port, async (event) => events.push(event), probe);
  const id = await engine.enroll(agents.get("planner"), { provider: "claude" }, {}, mode);
  await engine.setProgress(1, progress);
  await engine.close();
  const db = JSON.parse(await readFile(file, "utf8"));
  // Archive eligibility is tested against existing state, independently of push verification.
  db.workflows[0].progress = progress;
  db.workflows[0].execute = {
    ...db.workflows[0].plan,
    id: "executor",
    workspaceId: agents.get("executor").workspaceId,
  };
  // Tests only: isolated state fixture. Operational state is never edited.
  db.workflows[0].status = db.workflows[0].notifiedStatus = status;
  await writeFile(file, JSON.stringify(db));
  engine = new WorkflowEngine(file, port, async (event) => events.push(event));
  t.after(async () => {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    engine,
    port,
    id,
    file,
    agents,
    workspaces,
    events,
    archived,
    inspections: () => inspections,
  };
}
test("pushed automatic archive produces one lightweight entry without notifications or handoff", async (t) => {
  const f = await fixture(t);
  await f.engine.tick();
  assert.deepEqual(f.archived, ["ws"]);
  const state = await f.engine.list();
  assert.equal(state.workflows.length, 0);
  assert.equal(state.archives.length, 1);
  assert.equal(state.archives[0].progress, "pushed");
  assert.deepEqual(state.archives[0].agentIds, ["planner", "executor"]);
  assert.ok(!("lastPlan" in state.archives[0]));
  await assert.rejects(readFile(path.join(path.dirname(f.file), "handoffs", `${f.id}.json`)), {
    code: "ENOENT",
  });
  await f.engine.archived("planner");
  await f.engine.archived("executor");
  assert.deepEqual(f.events, []);
  assert.equal((await f.engine.list()).archives.length, 1);
});
test("done stays out of automatic archive, preview is read-only, apply archives confirmed ids", async (t) => {
  const f = await fixture(t, "done");
  const before = await readFile(f.file, "utf8");
  const preview = await f.engine.archiveFinished();
  assert.equal(preview.rows.length, 1);
  assert.equal(await readFile(f.file, "utf8"), before);
  assert.deepEqual(f.archived, []);
  await f.engine.tick();
  assert.deepEqual(f.archived, []);
  assert.equal((await f.engine.archiveFinished(true)).archivedIds.length, 0);
  const applied = await f.engine.archiveFinished(true, [f.id]);
  assert.deepEqual(applied.archivedIds, [f.id]);
  assert.deepEqual(f.archived, ["ws"]);
  assert.deepEqual(f.events, []);
});
test("legacy split workspaces archive both halves and retain both ids", async (t) => {
  const f = await fixture(t, "pushed", "federated", true);
  await f.engine.tick();
  assert.deepEqual(f.archived, ["ws", "other-ws"]);
  assert.deepEqual((await f.engine.list()).archives[0].workspaceIds, ["ws", "other-ws"]);
  assert.deepEqual(f.events, []);
});
test("automatic archive disabled keeps pushed work and avoids safety directory lookup", async (t) => {
  const f = await fixture(t);
  await f.engine.configure({ ...(await f.engine.settings()), autoArchivePushed: false });
  await f.engine.tick();
  assert.deepEqual(f.archived, []);
  assert.equal(f.inspections(), 0);
});
test("automatic archive safety scans run no more often than every ten minutes", async (t) => {
  const f = await fixture(t);
  f.workspaces.get("ws").pinnedAt = old;
  await f.engine.tick();
  const count = f.inspections();
  await f.engine.tick();
  await f.engine.tick();
  assert.equal(f.inspections(), count);
  assert.equal(count, 1);
  assert.deepEqual(f.archived, []);
});
test("inspection failure preserves flow and automatic archive failure sends no notification", async (t) => {
  const f = await fixture(t);
  f.port.archiveInspection = async () => {
    throw Error("lookup failure");
  };
  await f.engine.tick();
  assert.deepEqual(f.archived, []);
  assert.equal((await f.engine.list()).workflows.length, 1);
  assert.deepEqual(f.events, []);
  await f.engine.setProgress(1, "done");
  await assert.rejects(f.engine.archiveFinished(), /lookup failure/);
});
test("apply rechecks new pins and never adds a newly eligible flow to a confirmed preview", async (t) => {
  const f = await fixture(t, "done");
  const preview = await f.engine.archiveFinished();
  f.workspaces.get("ws").pinnedAt = old;
  assert.deepEqual(
    (
      await f.engine.archiveFinished(
        true,
        preview.rows.map((r) => r.id),
      )
    ).archivedIds,
    [],
  );
  assert.deepEqual(f.archived, []);
});
test("fresh running state between row selection and mutation cancels archive", async (t) => {
  const f = await fixture(t, "done");
  const inspect = f.port.archiveInspection;
  let calls = 0;
  f.port.archiveInspection = async (...args) => {
    if (++calls === 2) f.agents.get("executor").status = "running";
    return inspect(...args);
  };
  assert.deepEqual((await f.engine.archiveFinished(true, [f.id])).archivedIds, []);
  assert.deepEqual(f.archived, []);
});
test("partial split archive failure preserves remaining half, retries and sends no stopped alert", async (t) => {
  const f = await fixture(t, "done", "federated", true, "active");
  const archive = f.port.archiveWorkspace;
  f.port.archiveWorkspace = async (id) => {
    if (id === "other-ws") throw Error("archive failed");
    await archive(id);
  };
  const result = await f.engine.archiveFinished(true, [f.id]);
  assert.deepEqual(result.archivedIds, []);
  assert.equal(result.errors.length, 1);
  assert.equal((await f.engine.list()).workflows.length, 1);
  await f.engine.tick();
  assert.equal((await f.engine.list()).workflows[0].status, "active");
  assert.deepEqual(f.events, []);
  f.port.archiveWorkspace = archive;
  assert.deepEqual((await f.engine.archiveFinished(true, [f.id])).archivedIds, [f.id]);
  assert.deepEqual(f.archived, ["ws", "other-ws"]);
});
for (const mode of ["general", "federated"])
  test(`manually archived finished ${mode} retains a lightweight entry after restart cleanup`, async (t) => {
    const f = await fixture(t, "done", mode);
    for (const a of f.agents.values()) a.archived = true;
    await f.engine.tick();
    assert.equal((await f.engine.list()).workflows.length, 0);
    assert.equal((await f.engine.list()).archives.length, 1);
    assert.deepEqual(f.events, []);
  });
test("manual archive events retain finished general record and ignore a partially archived pair", async (t) => {
  const f = await fixture(t, "done");
  f.agents.get("planner").archived = true;
  await f.engine.archived("planner");
  assert.equal((await f.engine.list()).workflows.length, 1);
  f.agents.get("executor").archived = true;
  await f.engine.archived("executor");
  assert.equal((await f.engine.list()).archives.length, 1);
  assert.deepEqual(f.events, []);
});
test("manual collection preserves the real archive timestamp", async (t) => {
  const f = await fixture(t, "done");
  for (const a of f.agents.values()) {
    a.archived = true;
    a.archivedAt = "2026-10-01T00:00:00.000Z";
  }
  await f.engine.archived("planner");
  assert.equal((await f.engine.list()).archives[0].archivedAt, "2026-10-01T00:00:00.000Z");
});
test("old state loads default archive settings and an empty archive list", async (t) => {
  const f = await fixture(t, "done");
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  delete db.archives;
  delete db.settings.autoArchivePushed;
  delete db.settings.archiveAfterDays;
  await writeFile(f.file, JSON.stringify(db));
  const engine = new WorkflowEngine(f.file, f.port);
  t.after(() => engine.close());
  assert.equal((await engine.settings()).autoArchivePushed, true);
  assert.equal((await engine.settings()).archiveAfterDays, 3);
  assert.deepEqual((await engine.list()).archives, []);
});
test("archive retains only the most recent 500 entries and survives a new engine", async (t) => {
  const f = await fixture(t, "done");
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  db.archives = Array.from({ length: 500 }, (_, i) => ({
    id: `old-${i}`,
    number: i,
    title: "old",
    projectId: "project",
    folder: "project",
    progress: "done",
    workspaceIds: [],
    agentIds: [],
    archivedAt: new Date(Date.now() - 86400000 - i * 1000).toISOString(),
  }));
  await writeFile(f.file, JSON.stringify(db));
  const engine = new WorkflowEngine(f.file, f.port);
  t.after(() => engine.close());
  await engine.archiveFinished(true, [f.id]);
  const state = await engine.list();
  assert.equal(state.archives.length, 500);
  assert.equal(state.archives[0].id, f.id);
  assert.ok(!state.archives.some((a) => a.id === "old-499"));
});
