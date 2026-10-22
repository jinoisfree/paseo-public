import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowEngine } from "../server/engine.ts";
import assert from "node:assert/strict";
import { pushReviewKey, syncPushReview } from "../server/push-review.ts";
import { pinDaemonUrl } from "../server/workspace-pins.ts";
import { stripTitleDecor } from "../server/protocol.ts";

const review = () => ({
  key: "target",
  workspaces: [{ id: "w", phase: "queued", ownedPinAt: null }],
});

test("pin once, acknowledge manual unpin and never recreate it after reload", async () => {
  let state = review(),
    pinned = false,
    calls = 0,
    saved;
  const save = async () => {
    saved = JSON.stringify(state);
  };
  const port = {
    get: async () => ({ pinnedAt: pinned ? "automatic" : null }),
    pin: async () => {
      assert.equal(JSON.parse(saved).workspaces[0].phase, "sent");
      calls++;
      pinned = true;
      return "automatic";
    },
  };
  assert.equal(await syncPushReview(state, port, save), true);
  assert.equal(state.workspaces[0].phase, "pinned");
  await syncPushReview(state, port, save);
  assert.equal(calls, 1);
  pinned = false;
  await syncPushReview(state, port, save);
  assert.equal(state.workspaces[0].phase, "acknowledged");
  state = JSON.parse(saved);
  await syncPushReview(state, port, save);
  assert.equal(calls, 1);
});

test("unavailable workspace reads never count as an acknowledgement", async () => {
  const state = review();
  state.workspaces[0].phase = "pinned";
  for (const get of [
    async () => null,
    async () => {
      throw Error("offline");
    },
  ]) {
    assert.equal(
      await syncPushReview(state, { get, pin: async () => assert.fail() }, async () => {}),
      false,
    );
    assert.equal(state.workspaces[0].phase, "pinned");
  }
});

test("lost pin response is reconciled without re-pinning a manually released workspace", async () => {
  const state = review();
  let calls = 0;
  const port = {
    get: async () => ({ pinnedAt: null }),
    pin: async () => {
      calls++;
      throw Error("lost response");
    },
  };
  await assert.rejects(
    syncPushReview(state, port, async () => {}),
    /lost/,
  );
  assert.equal(state.workspaces[0].phase, "sent");
  const restored = JSON.parse(JSON.stringify(state));
  await syncPushReview(restored, port, async () => {});
  assert.equal(restored.workspaces[0].phase, "acknowledged");
  assert.equal(calls, 1);
});

test("pre-existing pins and separate workspaces are acknowledged independently", async () => {
  const state = review();
  state.workspaces.push({ id: "other", phase: "queued", ownedPinAt: null });
  let pinned = new Set(["w"]);
  const calls = [];
  const port = {
    get: async (id) => ({ pinnedAt: pinned.has(id) ? id : null }),
    pin: async (id) => {
      calls.push(id);
      pinned.add(id);
      return id;
    },
  };
  await syncPushReview(state, port, async () => {});
  assert.deepEqual(calls, ["other"]);
  pinned.delete("w");
  await syncPushReview(state, port, async () => {});
  assert.deepEqual(
    state.workspaces.map((w) => w.phase),
    ["acknowledged", "pinned"],
  );
});

test("target identity includes repository, remote, branch and commit, independent of report order", () => {
  const a = { repository: "/a", remote: "origin", branch: "main", commit: "a".repeat(40) };
  const b = { ...a, repository: "/b" };
  assert.equal(pushReviewKey([a, b]), pushReviewKey([b, a]));
  for (const key of Object.keys(a))
    assert.notEqual(pushReviewKey([a]), pushReviewKey([{ ...a, [key]: "different" }]));
  assert.equal(stripTitleDecor("🔵 G[일반]-01 [푸시 확인 대기] 검사"), "검사");
  assert.equal(stripTitleDecor("🔵 G[일반]-01 [푸시 완료] 검사"), "검사");
});

test("new work withdraws only its own automatic pin, preserving manual and replaced pins", async () => {
  for (const kind of ["automatic", "manual", "replaced"]) {
    const state = review();
    let pinnedAt = kind === "manual" ? "manual" : null;
    const calls = [];
    const port = {
      get: async () => ({ pinnedAt }),
      pin: async () => (pinnedAt = "automatic"),
      unpin: async (id, expected) => {
        assert.equal(expected, pinnedAt);
        calls.push(id);
        pinnedAt = null;
        return true;
      },
    };
    await syncPushReview(state, port, async () => {});
    if (kind === "replaced") pinnedAt = "user-new-pin";
    const restored = JSON.parse(JSON.stringify(state));
    await syncPushReview(restored, port, async () => {}, false);
    assert.equal(restored.workspaces[0].phase, "withdrawn");
    assert.deepEqual(calls, kind === "automatic" ? ["w"] : []);
    assert.equal(pinnedAt, { automatic: null, manual: "manual", replaced: "user-new-pin" }[kind]);
    await syncPushReview(restored, port, async () => {});
    assert.equal(
      restored.workspaces[0].phase,
      "withdrawn",
      "old receipt cannot queue a pin on its own",
    );
  }
});

test("failed withdrawal is retried after reload and never removes a replacement manual pin", async () => {
  const state = review();
  Object.assign(state.workspaces[0], { phase: "pinned", ownedPinAt: "auto" });
  let fail = true,
    pinnedAt = "auto";
  const port = {
    get: async () => ({ pinnedAt }),
    unpin: async () => {
      if (fail) throw Error("offline");
      return false;
    },
    pin: async () => assert.fail(),
  };
  await assert.rejects(
    syncPushReview(state, port, async () => {}, false),
    /offline/,
  );
  assert.equal(state.workspaces[0].phase, "pinned");
  fail = false;
  pinnedAt = "manual";
  await syncPushReview(JSON.parse(JSON.stringify(state)), port, async () => {}, false);
  assert.equal(pinnedAt, "manual");
});

test("pin connection stays on loopback, including a wildcard daemon binding", () => {
  for (const host of ["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "[::]"])
    assert.equal(pinDaemonUrl(`${host}:6767`), "ws://127.0.0.1:6767/ws");
  for (const listen of ["remote.example:6767", "127.0.0.1:0", "127.0.0.1:65536", "bad"])
    assert.throws(() => pinDaemonUrl(listen));
});

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "role-start-pin-"));
  const file = path.join(dir, "state.json");
  const agents = new Map([
    [
      "planner",
      {
        id: "planner",
        workspaceId: options.noWorkspace ? null : "initial",
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
  const pins = new Map(options.manual ? [["initial", "manual"]] : []);
  const pinCalls = [],
    unpinCalls = [];
  const stored = async () => JSON.parse(await readFile(file, "utf8"));
  const port = {
    inspect: async (id) => agents.get(id) ?? null,
    projectName: async () => "project",
    workspaceName: async () => "task",
    rename: async () => {},
    history: async () => ({ text: "", key: "", messageIds: [], failed: null }),
    async create(w, role, member) {
      const workspaceId = options.separate ? `workspace-${member.id}` : w.plan.workspaceId;
      agents.set(member.id, { ...agents.get("planner"), id: member.id, workspaceId, usage: 0 });
      return workspaceId;
    },
    async send(id) {
      agents.get(id).status = "running";
    },
    pushReview: {
      get: async (id) => ({ pinnedAt: pins.get(id) ?? null }),
      async pin(id) {
        const row = (await stored()).workflows[0].startPin.workspaces.find((w) => w.id === id);
        assert.equal(row.phase, "sent", "persist the attempt before sending a pin RPC");
        pinCalls.push(id);
        const pinnedAt = `start-${pinCalls.length}`;
        pins.set(id, pinnedAt);
        return pinnedAt;
      },
      async unpin(id) {
        unpinCalls.push(id);
        pins.delete(id);
        return true;
      },
    },
  };
  if (options.noPort) delete port.pushReview;
  const probe = {
    snapshot: async () => null,
    changes: async () => "",
    repository: async (cwd) => path.resolve(cwd),
    pushedTarget: async () => true,
  };
  let engine = new WorkflowEngine(file, port, undefined, probe);
  t.after(async () => {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  });
  if (options.disabled)
    await engine.configure({ ...(await engine.settings()), autoPinStarted: false });
  const id = await engine.enroll(
    agents.get("planner"),
    { provider: "claude" },
    {},
    options.mode ?? "general",
  );
  return {
    get engine() {
      return engine;
    },
    id,
    dir,
    file,
    port,
    pins,
    pinCalls,
    unpinCalls,
    stored,
    async reload(edit) {
      await engine.close();
      if (edit) {
        const db = await stored();
        edit(db);
        await writeFile(file, JSON.stringify(db));
      }
      engine = new WorkflowEngine(file, port, undefined, probe);
    },
  };
}

const plan = `<paseo-workflow>${JSON.stringify({
  status: "plan",
  summary: "plan",
  next: "implement",
  handoff: "goal and plan",
})}</paseo-workflow>`;

test("enroll queues a start pin without RPC; tick pins once and reload preserves it", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.engine.settings()).autoPinStarted, true);
  assert.deepEqual((await f.stored()).workflows[0].startPin, {
    key: "start",
    workspaces: [{ id: "initial", phase: "queued", ownedPinAt: null }],
  });
  assert.deepEqual(f.pinCalls, []);
  await f.engine.tick();
  await f.engine.tick();
  assert.deepEqual(f.pinCalls, ["initial"]);
  assert.equal((await f.stored()).workflows[0].startPin.workspaces[0].phase, "pinned");
  await f.reload();
  await f.engine.tick();
  assert.deepEqual(f.pinCalls, ["initial"]);
  assert.deepEqual(f.unpinCalls, []);
});

for (const separate of [false, true])
  test(`federated executor ${separate ? "adds a separate start pin" : "shares the initial pin"}`, async (t) => {
    const f = await fixture(t, { mode: "federated", separate });
    await f.engine.tick();
    await f.engine.ended("planner", "plan", plan, null, "start pin");
    await f.engine.tick();
    await f.engine.tick();
    const w = (await f.stored()).workflows[0];
    const expected = separate ? ["initial", w.execute.workspaceId] : ["initial"];
    assert.deepEqual(f.pinCalls, expected);
    assert.deepEqual(
      w.startPin.workspaces.map((row) => row.id),
      expected,
    );
  });

test("manual release is acknowledged and survives repeated ticks and engine reload", async (t) => {
  const f = await fixture(t);
  await f.engine.tick();
  f.pins.delete("initial");
  await f.engine.tick();
  assert.equal((await f.stored()).workflows[0].startPin.workspaces[0].phase, "acknowledged");
  await f.reload();
  await f.engine.tick();
  await f.engine.tick();
  assert.deepEqual(f.pinCalls, ["initial"]);
  assert.deepEqual(f.unpinCalls, []);
  assert.equal(f.pins.size, 0);
});

test("a pre-existing manual pin is observed without pinning or taking ownership", async (t) => {
  const f = await fixture(t, { manual: true });
  await f.engine.tick();
  assert.deepEqual((await f.stored()).workflows[0].startPin.workspaces, [
    { id: "initial", phase: "pinned", ownedPinAt: null },
  ]);
  await f.engine.setProgress(1, "active", "project");
  assert.equal(f.pins.get("initial"), "manual");
  assert.deepEqual(f.pinCalls, []);
  assert.deepEqual(f.unpinCalls, []);
});

test("disabled start pin persists through settings save/load and enabling never enrolls old work", async (t) => {
  const f = await fixture(t, { disabled: true, mode: "federated", separate: true });
  await f.reload();
  assert.equal((await f.engine.settings()).autoPinStarted, false);
  await f.engine.tick();
  await f.engine.configure({ ...(await f.engine.settings()), autoPinStarted: true });
  await f.engine.ended("planner", "plan", plan, null, "start pin");
  await f.engine.tick();
  assert.equal((await f.stored()).workflows[0].startPin, null);
  assert.deepEqual(f.pinCalls, []);
});

for (const legacy of ["missing", "null"])
  test(`legacy ${legacy} startPin never retroactively pins planner or new executor`, async (t) => {
    const f = await fixture(t, { mode: "federated", separate: true });
    await f.reload((db) => {
      if (legacy === "missing") delete db.workflows[0].startPin;
      else db.workflows[0].startPin = null;
      delete db.settings.autoPinStarted;
    });
    await f.engine.tick();
    await f.engine.ended("planner", "plan", plan, null, "start pin");
    await f.engine.tick();
    assert.equal((await f.stored()).workflows[0].startPin, null);
    assert.equal((await f.engine.settings()).autoPinStarted, true);
    assert.deepEqual(f.pinCalls, []);
  });

for (const released of [false, true])
  test(`lost start pin response survives reload${released ? " after user release" : " while still pinned"}`, async (t) => {
    const f = await fixture(t);
    const pin = f.port.pushReview.pin;
    f.port.pushReview.pin = async (id) => {
      await pin(id);
      throw Error("lost response");
    };
    await f.engine.tick();
    let w = (await f.stored()).workflows[0];
    assert.equal(w.startPin.workspaces[0].phase, "sent");
    assert.match(w.artifactNotice, /새 작업 상단 고정 응답을 확인하지 못했습니다/);
    if (released) f.pins.delete("initial");
    await f.reload();
    await f.engine.tick();
    w = (await f.stored()).workflows[0];
    assert.equal(w.startPin.workspaces[0].phase, released ? "acknowledged" : "pinned");
    assert.deepEqual(f.pinCalls, ["initial"]);
    assert.deepEqual(f.unpinCalls, []);
  });

test("disabling future start pins never withdraws an existing start pin", async (t) => {
  const f = await fixture(t);
  await f.engine.tick();
  await f.engine.configure({ ...(await f.engine.settings()), autoPinStarted: false });
  await f.engine.tick();
  assert.equal(f.pins.get("initial"), "start-1");
  assert.deepEqual(f.unpinCalls, []);
});

test("push completion and later invalidation never withdraw a workflow's start pin", async (t) => {
  const f = await fixture(t);
  // Cover push completion before the first scheduled tick as well.
  const target = {
    repository: f.dir,
    remote: "origin",
    branch: "main",
    commit: "a".repeat(40),
  };
  const report = `푸시대상: ${JSON.stringify([target])}\n작업상태: 푸시`;
  await f.engine.ended("planner", "push", report, null, "", false, "", false, undefined, {
    report,
    changed: false,
    pushes: [{ callId: "push", cwd: f.dir, ...target }],
  });
  let w = (await f.stored()).workflows[0];
  assert.equal(w.progress, "pushed");
  assert.equal(w.pushReview.workspaces[0].phase, "pinned");
  assert.equal(w.pushReview.workspaces[0].ownedPinAt, null);
  assert.deepEqual(f.pinCalls, ["initial"]);
  await f.engine.setProgress(1, "active", "project");
  await f.engine.tick();
  w = (await f.stored()).workflows[0];
  assert.equal(w.pushReview.workspaces[0].phase, "withdrawn");
  assert.equal(w.startPin.workspaces[0].phase, "pinned");
  assert.equal(f.pins.get("initial"), "start-1");
  assert.deepEqual(f.unpinCalls, []);
  await f.reload();
  await f.engine.tick();
  assert.deepEqual(f.pinCalls, ["initial"]);
  assert.deepEqual(f.unpinCalls, []);
});

for (const options of [{ noPort: true }, { noWorkspace: true }])
  test(`start pins require ${options.noPort ? "a pin port" : "a workspace"}`, async (t) => {
    const f = await fixture(t, options);
    await f.engine.tick();
    assert.equal((await f.stored()).workflows[0].startPin, null);
    assert.deepEqual(f.pinCalls, []);
  });
