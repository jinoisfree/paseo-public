import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPort,
  readTurn,
  readCompletedTurn,
  readArchiveInspection,
} from "../server/paseo-port.ts";
import { createHash } from "node:crypto";
import { parseProgress } from "../server/protocol.ts";
import { proseArtifacts } from "../shared/artifacts.ts";

function fixture() {
  let handler,
    released = false;
  const sent = [];
  const agent = {
    timeline: {
      subscribe(callback) {
        handler = callback;
        const release = () => {
          released = true;
        };
        release.ready = Promise.resolve();
        return release;
      },
    },
    async send(text, options) {
      sent.push({ text, ...options });
    },
  };
  const port = createPort(() => ({ agents: { ref: () => agent } }));
  return { port, sent, emit: (event) => handler({ event }), released: () => released };
}
test("project lookup follows the registered name and falls back to the working folder", async () => {
  const project = {
    projectId: "p",
    projectDisplayName: "sample-development",
    projectCustomName: "설정",
  };
  const api = { projects: { list: async () => ({ projects: [project] }) } };
  const port = createPort(() => api);
  assert.equal(await port.projectName("p", "/repo/subfolder"), "설정");
  project.projectCustomName = null;
  assert.equal(await port.projectName("p", "/repo/subfolder"), "sample-development");
  project.projectDisplayName = "새 이름";
  assert.equal(await port.projectName("p", "/repo/subfolder"), "새 이름");
  assert.equal(await port.projectName("missing", "/repo/subfolder"), "subfolder");
  api.projects.list = async () => {
    throw Error("offline");
  };
  assert.equal(await port.projectName("p", "/repo/AIpet/"), "AIpet");
  assert.equal(await port.projectName("p"), "프로젝트");
});
test("archive port reads pins, canonical activity and all tabs across directory pages", async () => {
  const calls = [];
  const api = {
    workspaces: {
      list: async ({ page }) => ({
        entries: page.cursor
          ? [{ id: "ws", pinnedAt: "pinned", archivingAt: null, status: "done" }]
          : [],
        pageInfo: { nextCursor: page.cursor ? null : "ws-page-2" },
      }),
    },
    agents: {
      list: async ({ page, filter }) => {
        assert.equal(filter.includeArchived, true);
        return {
          entries: [
            {
              agent: {
                id: page.cursor ? "other-tab" : "planner",
                workspaceId: "ws",
                status: "idle",
                pendingPermissions: [],
                activeTurn: null,
                updatedAt: "2026-10-06T00:00:00Z",
                archivedAt: null,
              },
            },
          ],
          pageInfo: { nextCursor: page.cursor ? null : "agents-page-2" },
        };
      },
      ref: (id) => ({
        timeline: {
          refetch: async (options) => {
            calls.push(options);
            return {
              entries: [{ timestamp: "2026-10-01T00:00:00Z" }],
              agent: { id, pendingPermissions: [], activeTurn: null },
              error: null,
              gap: false,
              hasNewer: false,
            };
          },
        },
      }),
    },
  };
  const result = await readArchiveInspection(api, ["ws"]);
  assert.equal(result.workspaces[0].pinnedAt, "pinned");
  assert.deepEqual(
    result.conversations.map((a) => a.id),
    ["planner", "other-tab"],
  );
  assert.equal(result.conversations[0].lastActivityAt, "2026-10-01T00:00:00.000Z");
  assert.deepEqual(calls, [
    { limit: 1, projection: "canonical" },
    { limit: 1, projection: "canonical" },
  ]);
});
test("archive port excludes failed, missing and malformed timelines without guessing from updatedAt", async () => {
  const api = {
    workspaces: { list: async () => ({ entries: [], pageInfo: {} }) },
    agents: {
      list: async () => ({
        entries: [
          {
            agent: {
              id: "a",
              workspaceId: "ws",
              status: "idle",
              pendingPermissions: [],
              updatedAt: "2026-10-01T00:00:00Z",
            },
          },
        ],
        pageInfo: {},
      }),
      ref: () => ({
        timeline: {
          refetch: async () => {
            throw Error("missing");
          },
        },
      }),
    },
  };
  assert.equal((await readArchiveInspection(api, ["ws"])).conversations[0].lastActivityAt, null);
  api.agents.ref = () => ({ timeline: { refetch: async () => ({ error: "failed" }) } });
  assert.equal((await readArchiveInspection(api, ["ws"])).conversations[0].lastActivityAt, null);
});
test("archive port bounds an unanswered timeline read and keeps reading the rest", async () => {
  const ids = ["hung-1", "ok", "hung-2", "hung-3"];
  const api = {
    workspaces: { list: async () => ({ entries: [], pageInfo: {} }) },
    agents: {
      list: async () => ({
        entries: ids.map((id) => ({
          agent: {
            id,
            workspaceId: "ws",
            status: "closed",
            pendingPermissions: [],
            archivedAt: null,
          },
        })),
        pageInfo: {},
      }),
      ref: (id) => ({
        timeline: {
          refetch: () =>
            id.startsWith("hung")
              ? new Promise(() => {})
              : Promise.resolve({
                  entries: [{ timestamp: "2026-10-01T00:00:00Z" }],
                  agent: { id, pendingPermissions: [], activeTurn: null },
                  error: null,
                  gap: false,
                  hasNewer: false,
                }),
        },
      }),
    },
  };
  const started = Date.now();
  const result = await readArchiveInspection(api, ["ws"], { activityTimeoutMs: 50 });
  // Three unanswered reads run side by side: about one timeout, not three.
  assert.ok(Date.now() - started < 140, `took ${Date.now() - started}ms`);
  assert.deepEqual(
    result.conversations.map((a) => [a.id, a.lastActivityAt]),
    [
      ["hung-1", null],
      ["ok", "2026-10-01T00:00:00.000Z"],
      ["hung-2", null],
      ["hung-3", null],
    ],
  );
});
test("archive port verifies archive RPC success and preserves archived snapshots without a workspace", async () => {
  const api = {
    workspaces: {
      ref: () => ({
        refresh: async () => null,
        archive: async () => ({ workspaceId: "ws", archivedAt: "now", error: null }),
      }),
    },
    agents: {
      ref: () => ({
        refresh: async () => ({
          agent: { id: "a", workspaceId: "ws", archivedAt: "now", pendingPermissions: [] },
        }),
      }),
    },
  };
  const port = createPort(() => api);
  assert.equal((await port.inspect("a")).archived, true);
  await port.archiveWorkspace("ws");
  api.workspaces.ref = () => ({ archive: async () => ({ error: "blocked", archivedAt: null }) });
  await assert.rejects(port.archiveWorkspace("ws"), /blocked/);
  api.workspaces.ref = () => ({
    archive: async () => ({ workspaceId: "ws", error: null, archivedAt: null }),
  });
  await assert.rejects(port.archiveWorkspace("ws"), /확인하지/);
});
test("native compaction waits for a completion event rather than command acceptance", async () => {
  const f = fixture();
  let done = false;
  const result = f.port.compact("agent", "compact-id").then(() => {
    done = true;
    return undefined;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.sent, [{ text: "/compact", messageId: "compact-id" }]);
  assert.equal(done, false);
  f.emit({ type: "timeline", item: { type: "compaction", status: "loading" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  f.emit({ type: "timeline", item: { type: "compaction", status: "completed" } });
  await result;
  assert.equal(f.released(), true);
});
test("native command failures release the observer and fail visibly", async () => {
  const f = fixture();
  const result = f.port.compact("agent", "compact-id");
  const rejection = assert.rejects(result, /Failed to compact/);
  await new Promise((resolve) => setImmediate(resolve));
  f.emit({
    type: "timeline",
    item: { type: "assistant_message", text: "Failed to compact context: provider error" },
  });
  await rejection;
  assert.equal(f.released(), true);
});
test("maintenance turns cannot masquerade as new workflow results", () => {
  const user = (text) => ({ type: "user_message", text, messageId: text });
  assert.equal(
    readTurn([user("/compact"), { type: "assistant_message", text: "summary" }]).maintenance,
    true,
  );
  assert.equal(readTurn([user("/compactly is a filename")]).maintenance, false);
  assert.equal(
    readTurn([
      user("task"),
      { type: "assistant_message", text: "first" },
      { type: "assistant_message", text: "second" },
    ]).text,
    "first\nsecond",
  );
});

test("separate messages preserve status and push targets without changing saved turn identities", () => {
  const target = {
    repository: "/work/repo",
    remote: "origin",
    branch: "main",
    commit: "a".repeat(40),
  };
  const messages = [
    `푸시대상: ${JSON.stringify([target])}`,
    "확인했습니다.\n작업상태: 푸시",
    "설치 안내입니다.",
  ];
  const turn = readTurn([
    { type: "user_message", text: "push", messageId: "request" },
    ...messages.map((text) => ({ type: "assistant_message", text })),
  ]);
  assert.equal(parseProgress(turn.text), "pushed");
  assert.deepEqual(proseArtifacts(turn.text).pushTargets, [target]);
  assert.equal(
    turn.key,
    createHash("sha256")
      .update("request\n" + messages.join(""))
      .digest("hex"),
  );
  assert.equal(parseProgress("```\n작업상태: 푸시\n```"), null);
});

function asyncPushTurn() {
  const commit = "a".repeat(40);
  const user = { type: "user_message", text: "푸시하고 설치까지", messageId: "push-request" };
  const push = {
    type: "tool_call",
    callId: "actual-push",
    name: "shell",
    status: "completed",
    error: null,
    detail: {
      type: "shell",
      cwd: "/repo",
      command: `git push origin ${commit}:refs/heads/main`,
      output: `To example:repo.git\n   bbbbbbb..aaaaaaa  ${commit} -> main\n`,
      exitCode: 0,
    },
  };
  const question = {
    type: "tool_call",
    callId: "install-question",
    name: "request_user_input_async",
    status: "completed",
    error: null,
    detail: { type: "plain_text", icon: "brain", text: "설치 방법은?\n파일을 받아 실행" },
  };
  const answer = {
    type: "user_message",
    text: `Answers to your questions:\n\n${question.detail.text}`,
    clientMessageId: "question-answer",
    messageId: "question-answer",
  };
  const report = { type: "assistant_message", text: "푸시 및 설치 파일 전달 완료\n작업상태: 푸시" };
  return { user, push, question, answer, report, items: [user, push, question, answer, report] };
}

test("an exact completed async answer retains same-turn push evidence without changing turn identity", () => {
  const { items, answer, report, push } = asyncPushTurn();
  for (const metadata of [undefined, items.map(() => "turn-1")]) {
    const result = readTurn(items, "/repo", metadata);
    const legacy = readTurn([answer, report], "/repo");
    assert.deepEqual(
      { ...result, evidence: undefined },
      {
        ...legacy,
        goal: items[0].text,
        messageIds: ["push-request", "question-answer", "question-answer"],
        evidence: undefined,
      },
    );
    assert.equal(result.evidence.pushes[0].callId, push.callId);
    assert.equal(result.evidence.pushes[0].commit, "a".repeat(40));
  }
});

test("async answer evidence requires an exact successful question tool and an original request", () => {
  const { user, push, question, answer, report } = asyncPushTurn();
  const invalidQuestions = [
    null,
    { ...question, name: "request_user_input" },
    { ...question, status: "running" },
    { ...question, error: "question failed" },
    { ...question, callId: "" },
    { ...question, detail: { ...question.detail, text: question.detail.text + " " } },
    { type: "assistant_message", text: question.detail.text },
  ];
  for (const invalid of invalidQuestions) {
    const items = [user, push, ...(invalid ? [invalid] : []), answer, report];
    assert.deepEqual(readTurn(items, "/repo").evidence.pushes, []);
  }
  assert.deepEqual(readTurn([push, question, answer, report], "/repo").evidence.pushes, []);
  assert.deepEqual(readTurn([user, push, answer, question, report], "/repo").evidence.pushes, []);
  assert.deepEqual(
    readTurn(
      [user, push, question, { ...answer, text: answer.text + "\n다른 변경도 요청" }, report],
      "/repo",
    ).evidence.pushes,
    [],
  );
});

test("ordinary steering and reused or ambiguous answers cannot inherit an earlier push", () => {
  const { user, push, question, answer, report } = asyncPushTurn();
  const steer = { type: "user_message", text: "새 기능을 추가해줘", messageId: "new-request" };
  for (const items of [
    [user, push, question, steer, answer, report],
    [user, push, question, answer, steer, report],
    [user, push, question, answer, { ...answer, messageId: "repeated" }, report],
    [user, push, question, answer, question, answer, report],
    [user, push, question, { ...question, callId: "second-question" }, answer, report],
  ]) {
    assert.deepEqual(
      readTurn(
        items,
        "/repo",
        items.map(() => "same-turn"),
      ).evidence.pushes,
      [],
    );
  }
});

test("provider turn metadata vetoes matching async text across a different turn", () => {
  const { items } = asyncPushTurn();
  for (const changedIndex of [0, 1, 2, 3, 4]) {
    const metadata = items.map(() => "turn-1");
    metadata[changedIndex] = "turn-2";
    assert.deepEqual(readTurn(items, "/repo", metadata).evidence.pushes, []);
  }
  assert.equal(
    readTurn(items, "/repo", [undefined, "turn-1", "turn-1", "turn-1"]).evidence.pushes.length,
    1,
  );
});

test("multiple distinct async answers retain evidence until a real request intervenes", () => {
  const { user, push, question, answer, report } = asyncPushTurn();
  const secondQuestion = {
    ...question,
    callId: "second-question",
    detail: { ...question.detail, text: "설치 위치는?\n앱 폴더" },
  };
  const secondAnswer = {
    ...answer,
    messageId: "second-answer",
    text: `Answers to your questions:\n\n${secondQuestion.detail.text}`,
  };
  const result = readTurn([user, push, question, answer, secondQuestion, secondAnswer, report]);
  assert.equal(result.evidence.pushes.length, 1);
});

test("completion uses only an identical history snapshot and fails closed when it cannot read one", async () => {
  const { items, answer, report } = asyncPushTurn();
  const saved = readTurn(
    items,
    "/repo",
    items.map(() => "turn-1"),
  );
  const base = readTurn([answer, report], "/repo");
  const result = await readCompletedTurn(items, "/repo", async () => saved);
  assert.deepEqual(result.evidence, saved.evidence);
  assert.equal(result.key, base.key);
  for (const lookup of [
    async () => ({ ...saved, key: "newer-turn" }),
    async () => ({ ...saved, text: "different output" }),
    async () => ({ ...saved, evidence: undefined }),
    async () => {
      throw Error("offline");
    },
  ]) {
    const failed = await readCompletedTurn(items, "/repo", lookup);
    assert.deepEqual(failed.evidence, base.evidence);
    assert.equal(failed.key, base.key);
  }
  let calls = 0;
  await readCompletedTurn(items.slice(0, 3), "/repo", async () => {
    calls++;
    return saved;
  });
  assert.equal(calls, 0);
});

test("explicit model validated before workspace creation, default remains resolved", async () => {
  const calls = [];
  const api = {
    providers: {
      listModels: async (base, options) => {
        calls.push({ base, options });
        return { models: [{ id: "known", isDefault: true }] };
      },
    },
    workspaces: {
      create: async () => ({
        id: "ws",
        agents: { create: async ({ agentId }) => ({ id: agentId }) },
      }),
    },
  };
  const port = createPort(() => api);
  const w = { id: "flow", cwd: "/work", projectId: "p", title: "task" };
  const member = { id: "a", generation: 1, config: { provider: "codex/missing" }, env: {} };
  await assert.rejects(port.create(w, "execute", member), /codex에 missing 모델이 없습니다/);
  assert.deepEqual(calls[0], { base: "codex", options: { cwd: "/work" } });
  member.config.provider = "codex/known";
  assert.equal(await port.create(w, "execute", member), "ws");
  member.config.provider = "codex";
  await port.create(w, "execute", member);
  assert.equal(member.config.provider, "codex/known");
  api.providers.listModels = async () => ({ error: "catalog unavailable" });
  await assert.rejects(port.create(w, "execute", member), /catalog unavailable/);
});

test("thinking validates against selected model and rename uses workspace title API", async () => {
  const created = [];
  const renamed = [];
  const api = {
    providers: {
      listModels: async () => ({
        models: [{ id: "m", isDefault: true, thinkingOptions: [{ id: "medium" }] }],
      }),
    },
    workspaces: {
      ref: (id) => ({ setTitle: async (title) => renamed.push({ id, title }) }),
      create: async (input) => {
        created.push(input);
        return { id: "ws", agents: { create: async ({ agentId }) => ({ id: agentId }) } };
      },
    },
  };
  const port = createPort(() => api);
  const w = { id: "flow", cwd: "/work", projectId: "p", title: "한글 작업" };
  const member = {
    id: "a",
    generation: 1,
    config: { provider: "codex/m", thinkingOptionId: "bad" },
    env: {},
  };
  await assert.rejects(port.create(w, "execute", member), /m에 bad 추론 정도가 없습니다.*medium/);
  assert.equal(created.length, 0);
  member.config.thinkingOptionId = "medium";
  await port.create(w, "execute", member);
  assert.equal(created[0].title, "G[work:실행]-00 한글 작업");
  api.providers.listModels = async () => ({ models: [{ id: "m" }] });
  await assert.rejects(port.create(w, "execute", member), /사용 가능: 없음/);
  await port.rename("ws", "제목");
  assert.deepEqual(renamed, [{ id: "ws", title: "제목" }]);
});

test("created workspace decoration retains generation and current name is readable", async () => {
  const titles = [];
  const port = createPort(() => ({
    providers: { listModels: async () => ({ models: [{ id: "m", isDefault: true }] }) },
    workspaces: {
      ref: () => ({ refresh: async () => ({ name: "현재 제목" }) }),
      create: async (input) => {
        titles.push(input.title);
        return { id: "ws", agents: { create: async ({ agentId }) => ({ id: agentId }) } };
      },
    },
  }));
  const w = {
    id: "f",
    cwd: "/work",
    projectId: "p",
    title: "🟠 계획: 제목",
    number: 7,
    progress: "done",
  };
  const member = { id: "a", generation: 1, config: { provider: "codex/m" }, env: {} };
  await port.create(w, "execute", member, true);
  member.generation = 2;
  await port.create(w, "execute", member, true);
  member.config.provider = "claude/m";
  await port.create(w, "plan", member, true);
  assert.deepEqual(titles, [
    "🟢 G[work:실행]-07 제목",
    "🟢 G[work:실행2]-07 제목",
    "🟢 C[work:계획2]-07 제목",
  ]);
  assert.equal(await port.workspaceName("ws"), "현재 제목");
});

test("readTurn detects completed compaction only after the last user and keeps maintenance", () => {
  const user = { type: "user_message", text: "task", messageId: "u" };
  for (const trigger of ["auto", "manual", undefined]) {
    const item = { type: "compaction", status: "completed", trigger };
    assert.equal(readTurn([user, item]).compacted, true);
    assert.equal(readTurn([item, user]).compacted, false);
  }
  assert.equal(readTurn([user, { type: "compaction", status: "loading" }]).compacted, false);
  const turn = readTurn([
    { ...user, text: "/compact", clientMessageId: "role-workflow-compact:1" },
    { type: "compaction", status: "completed" },
  ]);
  assert.equal(turn.maintenance, true);
  assert.equal(turn.compacted, true);
});

test("Claude execution validates its model, thinking and mode before creating any workspace", async () => {
  const creates = [],
    queries = [];
  const api = {
    providers: {
      listModels: async (provider) => {
        queries.push(provider);
        return {
          models: [
            { id: "hidden", isSelectable: false, isDefault: true },
            { id: "m", thinkingOptions: [{ id: "high" }] },
          ],
        };
      },
      listModes: async (provider) => {
        queries.push(provider);
        return { modes: [{ id: "default" }] };
      },
    },
    workspaces: {
      create: async (input) => {
        creates.push(input);
        return {
          id: "ws",
          agents: {
            create: async (request) => {
              creates.push(request);
              return { id: request.agentId };
            },
          },
        };
      },
    },
  };
  const port = createPort(() => api);
  const w = { id: "f", cwd: "/work", projectId: "p", title: "역방향", number: 8 };
  const member = {
    id: "e",
    generation: 1,
    config: { provider: "claude", modeId: "invalid", thinkingOptionId: "high" },
    env: {},
  };
  await assert.rejects(port.create(w, "execute", member), /권한 모드/);
  assert.equal(creates.length, 0);
  member.config.modeId = "default";
  member.config.provider = "claude/hidden";
  await assert.rejects(port.create(w, "execute", member), /모델이 없습니다/);
  assert.equal(creates.length, 0);
  member.config.provider = "claude";
  await port.create(w, "execute", member);
  assert.equal(creates[0].title, "C[work:실행]-08 역방향");
  assert.equal(creates[1].config.provider, "claude/m");
  assert.equal(creates[1].env.PASEO_ROLE_WORKFLOW_ROLE, "execute");
  assert.equal(creates[1].labels["role-workflow.role"], "execute");
  assert.ok(queries.every((provider) => provider === "claude"));
});

test("history pages back until the message that started a long turn is in view", async () => {
  const tools = (count) => Array.from({ length: count }, () => ({ item: { type: "tool_call" } }));
  const user = { type: "user_message", text: "작업 ID: f", clientMessageId: "delivered" };
  const read = async (pages) => {
    const calls = [];
    const port = createPort(() => ({
      agents: {
        ref: () => ({
          timeline: {
            refetch: async (options) => {
              calls.push(options);
              return pages[Math.min(calls.length, pages.length) - 1];
            },
          },
        }),
      },
    }));
    return { history: await port.history("a"), calls };
  };
  const cursor = (seq) => ({ epoch: "e", seq });
  const answer = { item: { type: "assistant_message", text: "done" } };
  const long = await read([
    { entries: [...tools(199), answer], hasOlder: true, startCursor: cursor(400) },
    { entries: tools(200), hasOlder: true, startCursor: cursor(200) },
    { entries: [{ item: user }, ...tools(199)], hasOlder: true, startCursor: cursor(1) },
  ]);
  assert.deepEqual(long.history.messageIds, ["delivered"]);
  assert.equal(long.history.text, "done");
  assert.deepEqual(long.calls, [
    { limit: 200 },
    { direction: "before", cursor: cursor(400), limit: 200 },
    { direction: "before", cursor: cursor(200), limit: 200 },
  ]);
  const short = await read([
    { entries: [{ item: user }, answer], hasOlder: true, startCursor: cursor(9) },
  ]);
  assert.equal(short.calls.length, 1);
  const replaced = await read([
    { entries: tools(200), hasOlder: true, startCursor: cursor(400) },
    { entries: [{ item: user }], hasOlder: false, startCursor: cursor(1), reset: true },
  ]);
  assert.deepEqual(replaced.history.messageIds, []);
  assert.equal(replaced.calls.length, 2);
  const endless = await read([{ entries: tools(200), hasOlder: true, startCursor: cursor(5) }]);
  assert.equal(endless.calls.length, 25);
});

test("history reaches back to a named delivery past the user's later messages", async () => {
  const tools = (count) => Array.from({ length: count }, () => ({ item: { type: "tool_call" } }));
  const delivered = { type: "user_message", text: "작업 ID: f", clientMessageId: "delivered" };
  const steer = { type: "user_message", text: "여기도 고쳐줘", messageId: "steer" };
  const answer = { item: { type: "assistant_message", text: "done" } };
  const pages = [
    {
      entries: [{ item: steer }, ...tools(198), answer],
      hasOlder: true,
      startCursor: { epoch: "e", seq: 300 },
    },
    {
      entries: [{ item: delivered }, ...tools(199)],
      hasOlder: true,
      startCursor: { epoch: "e", seq: 100 },
    },
  ];
  const read = async (through) => {
    let calls = 0;
    const port = createPort(() => ({
      agents: {
        ref: () => ({
          timeline: { refetch: async () => pages[Math.min(calls++, pages.length - 1)] },
        }),
      },
    }));
    return { history: await port.history("a", through), calls };
  };
  const plain = await read();
  assert.equal(plain.calls, 1);
  assert.deepEqual(plain.history.messageIds, ["steer"]);
  const named = await read("delivered");
  assert.equal(named.calls, 2);
  assert.deepEqual(named.history.messageIds, ["delivered", "steer"]);
  assert.equal(named.history.text, "done");
});

test("history pages through async answers and questions to the original request with turn metadata", async () => {
  const { user, push, question, answer, report } = asyncPushTurn();
  const read = async (questionTurn = "turn-1", through) => {
    const calls = [];
    const entry = (item, turnId = "turn-1") => ({ item, turnId });
    const pages = [
      {
        entries: [entry(answer), entry(report)],
        hasOlder: true,
        startCursor: { epoch: "e", seq: 5 },
      },
      {
        entries: [entry(push), entry(question, questionTurn)],
        hasOlder: true,
        startCursor: { epoch: "e", seq: 3 },
      },
      { entries: [entry(user)], hasOlder: true, startCursor: { epoch: "e", seq: 1 } },
    ];
    const port = createPort(() => ({
      agents: {
        ref: () => ({
          timeline: {
            refetch: async (options) => {
              calls.push(options);
              return pages[calls.length - 1];
            },
          },
        }),
      },
    }));
    return { history: await port.history("agent", through), calls };
  };
  for (const through of [undefined, answer.messageId]) {
    const result = await read("turn-1", through);
    assert.equal(result.calls.length, 3);
    assert.equal(result.history.evidence.pushes[0].callId, push.callId);
    assert.equal(result.history.key, readTurn([answer, report]).key);
  }
  const mismatch = await read("different-turn");
  assert.equal(mismatch.calls.length, 3);
  assert.deepEqual(mismatch.history.evidence.pushes, []);
});

function historicalFixture() {
  const pushTurn = asyncPushTurn();
  const later = [
    { type: "user_message", text: "설치 명령만 알려줘", messageId: "later-request" },
    { type: "assistant_message", text: "받은 설치 파일을 열어 실행하세요." },
  ];
  const rows = [
    { item: { type: "user_message", text: "earlier", messageId: "earlier" }, turnId: "turn-0" },
    { item: { type: "assistant_message", text: "earlier reply" }, turnId: "turn-0" },
    ...pushTurn.items.map((item) => ({ item, turnId: "turn-1" })),
    ...later.map((item) => ({ item, turnId: "turn-2" })),
  ];
  return { ...pushTurn, rows };
}

function historicalPages(rows, sizes = [rows.length]) {
  const entries = rows.map((row, index) => ({
    provider: "codex",
    seqStart: index + 1,
    seqEnd: index + 1,
    ...row,
  }));
  let end = entries.length;
  return sizes.map((size, index) => {
    const start = Math.max(0, end - size);
    const page = {
      agentId: "agent",
      agent: {
        id: "agent",
        cwd: "/repo",
        status: "idle",
        activeTurn: null,
        pendingPermissions: [],
      },
      direction: index ? "before" : "tail",
      projection: "projected",
      epoch: "epoch",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: entries.length, nextSeq: entries.length + 1 },
      startCursor: { epoch: "epoch", seq: start + 1 },
      endCursor: { epoch: "epoch", seq: end },
      hasOlder: start > 0,
      hasNewer: index > 0,
      entries: entries.slice(start, end),
      error: null,
    };
    end = start;
    return page;
  });
}

function historicalPort(pages) {
  const calls = [];
  const port = createPort(() => ({
    agents: {
      ref: () => ({
        timeline: {
          refetch: async (options) => {
            calls.push(options);
            if (calls.length > pages.length) throw Error("unexpected extra history request");
            return pages[calls.length - 1];
          },
        },
      }),
    },
  }));
  return {
    calls,
    read: (messageId = "push-request") => port.historicalPush("agent", messageId),
    audit: () => port.pushAuditHistory("agent"),
  };
}

test("historical push selects the named provider turn and preserves its async answer evidence", async () => {
  const sample = historicalFixture();
  delete sample.push.detail.cwd;
  sample.user.clientMessageId = "source-alias";
  const expected = readTurn(
    sample.items,
    "/repo",
    sample.items.map(() => "turn-1"),
  );
  for (const id of ["push-request", "source-alias"]) {
    const f = historicalPort(historicalPages(sample.rows));
    const result = await f.read(id);
    assert.deepEqual(result.turn, expected);
    assert.equal(result.turn.evidence.pushes[0].cwd, "/repo");
    assert.equal(result.later.length, 1);
    assert.equal(result.later[0].text, "받은 설치 파일을 열어 실행하세요.");
    assert.equal(f.calls.length, 1);
  }
});

test("historical push pages backward past a boundary source to prove it starts its turn", async () => {
  const { rows } = historicalFixture();
  const f = historicalPort(historicalPages(rows, [2, 5, 2]));
  const result = await f.read();
  assert.equal(result.turn.evidence.pushes.length, 1);
  assert.deepEqual(f.calls, [
    { limit: 200 },
    { direction: "before", cursor: { epoch: "epoch", seq: 8 }, limit: 200 },
    { direction: "before", cursor: { epoch: "epoch", seq: 3 }, limit: 200 },
  ]);
});

test("historical push refuses missing, duplicate, middle-of-turn and latest source requests", async () => {
  const { rows } = historicalFixture();
  for (const id of ["absent", "question-answer", "later-request", " "]) {
    await assert.rejects(historicalPort(historicalPages(rows)).read(id), /과거 푸시/);
  }
  const duplicate = structuredClone(rows);
  duplicate.at(-2).item.messageId = "push-request";
  await assert.rejects(historicalPort(historicalPages(duplicate)).read(), /과거 푸시/);
  const within = structuredClone(rows);
  within[1].turnId = "turn-1";
  await assert.rejects(historicalPort(historicalPages(within)).read(), /과거 푸시/);
});

test("historical push rejects incomplete or changing timeline pages", async () => {
  const { rows } = historicalFixture();
  for (const [key, value] of [
    ["error", "read failed"],
    ["reset", true],
    ["gap", true],
    ["staleCursor", true],
    ["hasNewer", true],
    ["projection", "canonical"],
    ["epoch", ""],
    ["agent", { id: "agent", cwd: "/other" }],
  ]) {
    const pages = historicalPages(rows, [2, 7]);
    if (key === "agent") pages[1][key] = value;
    else pages[0][key] = value;
    await assert.rejects(historicalPort(pages).read(), /과거 푸시/);
  }
  for (const mutate of [
    (page) => {
      page.reset = true;
    },
    (page) => {
      page.error = "failed";
    },
    (page) => {
      page.gap = true;
    },
    (page) => {
      page.staleCursor = true;
    },
    (page) => {
      page.epoch = "replaced";
    },
    (page) => {
      page.window.maxSeq++;
    },
    (page) => {
      page.window.nextSeq++;
    },
    (page) => {
      page.window.minSeq++;
    },
    (page) => {
      page.endCursor.seq--;
    },
    (page) => {
      page.startCursor.seq++;
    },
    (page) => {
      page.hasNewer = false;
    },
    (page) => {
      page.entries = [];
    },
  ]) {
    const pages = historicalPages(rows, [2, 7]);
    mutate(pages[1]);
    await assert.rejects(historicalPort(pages).read(), /과거 푸시/);
  }
});

test("historical push rejects absent metadata and discontinuous or reused provider turn ids", async () => {
  const { rows } = historicalFixture();
  for (const mutate of [
    (entries) => {
      delete entries[3].turnId;
    },
    (entries) => {
      entries[3].turnId = "";
    },
    (entries) => {
      entries[3].turnId = "different-turn";
    },
    (entries) => {
      entries.at(-1).turnId = "turn-1";
    },
    (entries) => {
      entries.at(-1).provider = "claude";
    },
    (entries) => {
      entries[3].seqStart = entries[2].seqStart;
    },
  ]) {
    const pages = historicalPages(structuredClone(rows));
    mutate(pages[0].entries);
    await assert.rejects(historicalPort(pages).read(), /과거 푸시/);
  }
});

test("historical push rejects any later non-text work or incomplete text-only turn", async () => {
  const { rows, push } = historicalFixture();
  for (const item of [
    push,
    { type: "compaction", status: "completed" },
    { type: "error", message: "failed" },
    { type: "notification", level: "info", message: "notice" },
    { type: "user_message", text: "new request", messageId: "steer" },
  ]) {
    const changed = structuredClone(rows);
    changed.splice(-1, 0, { item, turnId: "turn-2" });
    await assert.rejects(historicalPort(historicalPages(changed)).read(), /과거 푸시/);
  }
  await assert.rejects(historicalPort(historicalPages(rows.slice(0, -1))).read(), /과거 푸시/);
  const noUser = structuredClone(rows);
  noUser.at(-2).item = { type: "assistant_message", text: "reply without user" };
  await assert.rejects(historicalPort(historicalPages(noUser)).read(), /과거 푸시/);
});

test("historical push treats model reasoning in a later text-only reply as no activity", async () => {
  const { rows } = historicalFixture();
  const changed = structuredClone(rows);
  changed.splice(-1, 0, { item: { type: "reasoning", text: "thinking" }, turnId: "turn-2" });
  const { later } = await historicalPort(historicalPages(changed)).read();
  assert.equal(later.length, 1);
  assert.equal(later[0].evidence.pushes.length, 0);
});

test("historical push cannot select a later ordinary request's push using an earlier source id", async () => {
  const { rows, push } = historicalFixture();
  rows.splice(
    -2,
    0,
    {
      item: { type: "user_message", messageId: "other-push", text: "다른 변경도 푸시해줘" },
      turnId: "turn-1",
    },
    { item: { ...push, callId: "different-push" }, turnId: "turn-1" },
    { item: { type: "assistant_message", text: "다른 푸시 완료" }, turnId: "turn-1" },
  );
  await assert.rejects(historicalPort(historicalPages(rows)).read(), /과거 푸시/);
});

test("historical push bounds its search to 25 pages without guessing a missing source", async () => {
  const rows = Array.from({ length: 26 }, (_, index) => ({
    item: { type: "assistant_message", text: "history" },
    turnId: `turn-${index}`,
  }));
  const f = historicalPort(historicalPages(rows, Array(26).fill(1)));
  await assert.rejects(f.read(), /과거 푸시/);
  assert.equal(f.calls.length, 25);
});

test("automatic push audit retains exact async answer evidence within the latest provider turn", async () => {
  const { rows, items } = historicalFixture();
  const current = rows.slice(0, -2);
  const audit = await historicalPort(historicalPages(current)).audit();
  const expected = readTurn(
    items,
    "/repo",
    items.map(() => "turn-1"),
  );
  assert.deepEqual(audit, {
    ...expected,
    auditRevision: JSON.stringify(["epoch", 7, 8, "turn-1"]),
  });
  assert.equal(audit.evidence.pushes[0].commit, "a".repeat(40));
  assert.equal(audit.failed, null);
});

test("automatic push audit never borrows a prior push across a plain installation follow-up", async () => {
  const { rows } = historicalFixture();
  const f = historicalPort(historicalPages(rows, [2, 7]));
  const audit = await f.audit();
  assert.equal(f.calls.length, 2, "read the previous boundary, without extending the evidence");
  assert.equal(audit.request, "설치 명령만 알려줘");
  assert.equal(audit.text, "받은 설치 파일을 열어 실행하세요.");
  assert.deepEqual(audit.evidence.pushes, []);
  assert.equal(audit.auditRevision, JSON.stringify(["epoch", 9, 10, "turn-2"]));
});

test("automatic push audit preserves ordinary steering boundaries inside one provider turn", async () => {
  const { rows } = historicalFixture();
  rows.at(-2).turnId = rows.at(-1).turnId = "turn-1";
  const audit = await historicalPort(historicalPages(rows)).audit();
  assert.equal(audit.request, "설치 명령만 알려줘");
  assert.deepEqual(audit.evidence.pushes, []);
});

test("automatic push audit pages through an async answer to the actual turn's starting user", async () => {
  const { rows } = historicalFixture();
  const f = historicalPort(historicalPages(rows.slice(0, -2), [2, 3, 2]));
  const audit = await f.audit();
  assert.equal(f.calls.length, 3);
  assert.equal(audit.evidence.pushes.length, 1);
  assert.equal(audit.auditRevision, JSON.stringify(["epoch", 7, 8, "turn-1"]));
});

test("automatic push audit requires a confirmed idle snapshot on every page", async () => {
  const { rows } = historicalFixture();
  for (const patch of [
    { status: "running" },
    { status: "initializing" },
    { status: "error" },
    { activeTurn: { turnId: "turn-2" } },
    { activeTurn: undefined },
    { pendingPermissions: [{}] },
    { pendingPermissions: undefined },
    { archivedAt: "2026-10-15T00:00:00Z" },
  ]) {
    for (const index of [0, 1]) {
      const pages = historicalPages(rows, [2, 7]);
      Object.assign(pages[index].agent, patch);
      await assert.rejects(historicalPort(pages).audit(), /기록/);
    }
  }
});

test("automatic push audit rejects uncertain, replaced, or malformed history pages", async () => {
  const { rows } = historicalFixture();
  for (const mutate of [
    (pages) => {
      pages[0].hasNewer = true;
    },
    (pages) => {
      pages[0].entries.at(-1).turnId = undefined;
    },
    (pages) => {
      pages[0].entries.at(-1).turnId = "";
    },
    (pages) => {
      pages[1].reset = true;
    },
    (pages) => {
      pages[1].gap = true;
    },
    (pages) => {
      pages[1].staleCursor = true;
    },
    (pages) => {
      pages[1].error = "read failed";
    },
    (pages) => {
      pages[1].epoch = "replaced";
    },
    (pages) => {
      pages[1].window.maxSeq++;
    },
    (pages) => {
      pages[1].window.nextSeq++;
    },
    (pages) => {
      pages[1].startCursor.seq++;
    },
    (pages) => {
      pages[1].endCursor.seq--;
    },
    (pages) => {
      pages[1].entries[0].turnId = "turn-2";
    },
    (pages) => {
      pages[1].entries[0].provider = "claude";
    },
  ]) {
    const pages = historicalPages(rows, [2, 7]);
    mutate(pages);
    await assert.rejects(historicalPort(pages).audit(), /기록/);
  }
});

test("automatic push audit rejects cut off or unfinished turns instead of reporting failed null", async () => {
  const { user, push, report } = asyncPushTurn();
  for (const items of [
    [push, report],
    [report],
    [user, push],
    [user, { ...report, text: "" }],
    [user, push, { type: "error", message: "turn failed" }, report],
    [user, { type: "notification", level: "error", message: "failed" }, report],
    [user, { ...push, status: "running" }, report],
    [user, { type: "compaction", status: "loading" }, report],
  ]) {
    const rows = items.map((item) => ({ item, turnId: "turn-1" }));
    await assert.rejects(historicalPort(historicalPages(rows)).audit(), /기록/);
  }
});

test("automatic push audit limits a long unbounded provider turn to 25 pages", async () => {
  const rows = Array.from({ length: 26 }, () => ({
    item: { type: "assistant_message", text: "history" },
    turnId: "turn-1",
  }));
  const f = historicalPort(historicalPages(rows, Array(26).fill(1)));
  await assert.rejects(f.audit(), /시작 경계/);
  assert.equal(f.calls.length, 25);
});

test("automatic push audit ignores missing ids only before a separately bounded latest turn", async () => {
  const { rows } = historicalFixture();
  const current = rows.slice(0, -2);
  const old = { item: { type: "tool_call" }, turnId: undefined };
  // Imported Claude history and an older injected Codex tool lack ids in real timelines.
  for (const older of [
    [old, ...current],
    [...current.slice(0, 2), old, ...current.slice(2)],
  ]) {
    const audit = await historicalPort(historicalPages(older)).audit();
    assert.equal(audit.evidence.pushes.length, 1);
    await assert.rejects(
      historicalPort(historicalPages([...older, ...rows.slice(-2)])).read(),
      /기록/,
      "explicit historical recovery keeps its stricter metadata policy",
    );
  }
  const separated = [...current.slice(0, 2), old, ...current.slice(2)];
  const f = historicalPort(historicalPages(separated, [2, 4, 2]));
  assert.equal((await f.audit()).evidence.pushes.length, 1);
  assert.equal(f.calls.length, 3, "unknown older ids alone cannot establish the boundary");
  await assert.rejects(historicalPort(historicalPages([old, ...current.slice(2)])).audit(), /기록/);
});

test("automatic push audit still rejects an unknown id inside the latest turn", async () => {
  const { rows } = historicalFixture();
  const current = rows.slice(0, -2);
  for (const index of [2, 3, 4, 5, 6]) {
    const changed = structuredClone(current);
    changed[index].turnId = undefined;
    await assert.rejects(historicalPort(historicalPages(changed)).audit(), /기록/);
  }
});

test("automatic push audit recognizes completed compaction lifecycles and preserves their flag", async () => {
  const { user, report } = asyncPushTurn();
  const loading = { type: "compaction", status: "loading" };
  const completed = { type: "compaction", status: "completed" };
  for (const lifecycle of [
    [loading, completed],
    [loading, completed, loading, completed],
  ]) {
    const rows = [user, ...lifecycle, report].map((item) => ({ item, turnId: "turn-1" }));
    const audit = await historicalPort(historicalPages(rows)).audit();
    assert.equal(audit.compacted, true);
    assert.deepEqual(audit.evidence.pushes, []);
  }
  for (const lifecycle of [
    [completed, loading],
    [loading, loading, completed],
  ]) {
    const rows = [user, ...lifecycle, report].map((item) => ({ item, turnId: "turn-1" }));
    await assert.rejects(historicalPort(historicalPages(rows)).audit(), /기록/);
  }
});

test("an executor opens as a tab in its planner's workspace instead of a workspace of its own", async () => {
  const calls = [];
  const port = createPort(() => ({
    providers: { listModels: async () => ({ models: [{ id: "m", isDefault: true }] }) },
    workspaces: {
      ref: (id) => ({
        id,
        agents: {
          create: async (options) => {
            calls.push(["agent", id, options.title, options.labels["role-workflow.role"]]);
            return { id: options.agentId };
          },
        },
      }),
      create: async () => {
        calls.push(["workspace"]);
        throw new Error("no new workspace for a paired executor");
      },
    },
  }));
  const w = { id: "f", cwd: "/work", projectId: "p", title: "제목", number: 3, progress: "active" };
  const member = { id: "exec", generation: 1, config: { provider: "codex/m" }, env: {} };
  const workspaceId = await port.create(
    { ...w, plan: { id: "planner", workspaceId: "plan-workspace" } },
    "execute",
    member,
    true,
  );
  assert.equal(workspaceId, "plan-workspace");
  assert.deepEqual(calls, [["agent", "plan-workspace", "GPT 실행", "execute"]]);
  const claude = { id: "exec2", generation: 1, config: { provider: "claude/m" }, env: {} };
  await port.create(
    { ...w, plan: { id: "planner", workspaceId: "plan-workspace" } },
    "execute",
    claude,
    true,
  );
  assert.equal(calls.at(-1)[2], "Claude 실행");
});
