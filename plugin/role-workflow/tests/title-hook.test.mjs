import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import contribute from "../index.server.ts";
import { settingsSchema } from "../shared/contracts.ts";
test("title prompt follows toggle and skips managed or nonautomated conversations", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "title-hook-"));
  const previous = process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
  process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = dir;
  const hooks = new Map(),
    rpcs = new Map();
  const close = contribute({
    before: (name, fn) => {
      hooks.set(name, fn);
      return () => {};
    },
    on: () => () => {},
    handle: (contract, fn) => rpcs.set(contract.name, fn),
  });
  const context = { paseo: {} };
  try {
    for (const enabled of [false, true]) {
      await rpcs.get("workflow.configure")(
        settingsSchema.parse({ koreanTitle: enabled, askExecutorModel: false }),
        context,
      );
      const request = { config: { provider: "claude", cwd: dir } };
      const result = await hooks.get("agent.create")({ request }, context);
      assert.equal(result.config.systemPrompt.includes("<paseo-title-v1>"), enabled);
      assert.match(result.config.systemPrompt, /<paseo-push-approval-v1>/);
      assert.match(result.config.systemPrompt, /명시적 승인을 받은 뒤에만/);
    }
    for (const env of [
      { PASEO_ROLE_WORKFLOW_MANAGED: "1" },
      { PASEO_ROLE_WORKFLOW_DISABLE: "1" },
    ]) {
      const result = await hooks.get("agent.create")(
        { request: { config: { provider: "claude", cwd: dir }, env } },
        context,
      );
      assert.equal(result.config.systemPrompt.includes("<paseo-title-v1>"), false);
      assert.equal(
        result.config.systemPrompt.includes("<paseo-progress-v1>"),
        env.PASEO_ROLE_WORKFLOW_MANAGED === "1",
      );
    }
    for (const titleMarker of [true, false]) {
      await rpcs.get("workflow.configure")(
        settingsSchema.parse({ titleMarker, askExecutorModel: false }),
        context,
      );
      for (const provider of ["claude", "codex"]) {
        const request = { config: { provider, cwd: dir } };
        const result = await hooks.get("agent.create")({ request }, context);
        assert.equal(result.config.systemPrompt.includes("<paseo-progress-v1>"), titleMarker);
        assert.match(result.config.systemPrompt, /<paseo-push-approval-v1>/);
      }
    }
  } finally {
    await close();
    if (previous === undefined) delete process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
    else process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("model RPC lists selectable models and thinking defaults, returns failures without throwing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "models-hook-"));
  const previous = process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
  process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = dir;
  const rpcs = new Map();
  const close = contribute({
    before: () => () => {},
    on: () => () => {},
    handle: (contract, fn) => rpcs.set(contract.name, fn),
  });
  try {
    const calls = [];
    const listModels = async (...args) => {
      calls.push(args);
      return {
        models: [
          {
            id: "a",
            label: "A",
            isDefault: true,
            defaultThinkingOptionId: "high",
            thinkingOptions: [
              { id: "low", label: "Low", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
          { id: "hidden", label: "Hidden", isSelectable: false },
        ],
      };
    };
    const call = (fn) =>
      rpcs.get("workflow.models")({}, { paseo: { providers: { listModels: fn } } });
    assert.deepEqual(await call(listModels), {
      models: [
        {
          id: "a",
          label: "A",
          isDefault: true,
          thinkingOptions: [
            { id: "low", label: "Low", isDefault: false },
            { id: "high", label: "High", isDefault: true },
          ],
        },
      ],
      error: null,
    });
    assert.deepEqual(calls, [["codex"]]);
    for (const fn of [
      async () => ({ error: "offline" }),
      async () => {
        throw Error("private detail");
      },
    ]) {
      const response = await call(fn);
      assert.deepEqual(response.models, []);
      assert.ok(response.error);
      assert.ok(!response.error.includes("private detail"));
    }
  } finally {
    await close();
    if (previous === undefined) delete process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
    else process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("dashboard model choice preserves compatible thinking and clears incompatible values", async () => {
  const { selectExecutorModel, selectedModel } = await import("../shared/model-selection.ts");
  const catalog = [
    { id: "a", isDefault: true, thinkingOptions: [{ id: "high" }] },
    { id: "b", thinkingOptions: [{ id: "low" }] },
  ];
  const settings = settingsSchema.parse({ executorThinking: "high" });
  assert.equal(selectExecutorModel(settings, "codex/a", catalog).executorThinking, "high");
  assert.equal(selectExecutorModel(settings, "codex/b", catalog).executorThinking, "");
  assert.equal(selectExecutorModel(settings, "codex/unknown", catalog).executorThinking, "");
  assert.equal(selectExecutorModel(settings, "codex", catalog).executorThinking, "high");
  assert.equal(selectedModel(catalog, "codex").id, "a");
});

test("both initial providers plan, managed executors keep their role, and model RPC uses requested provider", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reverse-hook-"));
  const previous = process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
  process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = dir;
  const hooks = new Map(),
    rpcs = new Map(),
    calls = [];
  const close = contribute({
    before: (name, fn) => {
      hooks.set(name, fn);
      return () => {};
    },
    on: () => () => {},
    handle: (contract, fn) => rpcs.set(contract.name, fn),
  });
  const context = {
    paseo: {
      providers: {
        listModels: async (provider) => {
          calls.push(provider);
          return { models: [{ id: "m", label: "Model", isDefault: true }] };
        },
      },
    },
  };
  try {
    for (const provider of ["claude", "codex"]) {
      const other = provider === "claude" ? "codex" : "claude";
      const request = {
        config: { provider, cwd: dir, systemPrompt: "project rules" },
        labels: { custom: "keep" },
      };
      const initial = await hooks.get("agent.create")({ request }, context);
      assert.match(initial.config.systemPrompt, /기획설계·검증 역할/);
      assert.match(initial.config.systemPrompt, /<paseo-mode-select-v1>/);
      if (provider === "codex")
        assert.match(initial.config.systemPrompt, /request_user_input_async/);
      assert.match(
        initial.config.systemPrompt,
        provider === "claude" ? /실제 답변이 도착하기 전에는/ : /실제 모델 답변이 도착하기 전에는/,
      );
      assert.ok(initial.config.systemPrompt.includes(`${other}/m`));
      assert.equal(calls.at(-1), other);
      assert.deepEqual(Object.keys(initial).sort(), ["config", "env"]);
      const managed = await hooks.get("agent.create")(
        {
          request: {
            ...request,
            env: { PASEO_ROLE_WORKFLOW_MANAGED: "1", PASEO_ROLE_WORKFLOW_ROLE: "execute" },
          },
        },
        context,
      );
      assert.deepEqual(Object.keys(managed).sort(), ["config", "env"]);
      const unrelated = await hooks.get("agent.create")(
        { request: { ...request, config: { ...request.config, provider: "opencode" } } },
        context,
      );
      assert.deepEqual(Object.keys(unrelated).sort(), ["config", "env"]);
      assert.match(managed.config.systemPrompt, /구현 역할/);
      assert.ok(!managed.config.systemPrompt.includes("<paseo-mode-select-v1>"));
      assert.ok(!managed.env.PASEO_ROLE_WORKFLOW_SEED);
      await rpcs.get("workflow.models")({ provider }, context);
      assert.equal(calls.at(-1), provider);
    }
  } finally {
    await close();
    if (previous === undefined) delete process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
    else process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude dashboard selections leave GPT execution settings untouched", async () => {
  const { selectExecutorModel } = await import("../shared/model-selection.ts");
  const settings = settingsSchema.parse({
    executorModel: "codex/keep",
    executorThinking: "xhigh",
    claudeExecutorThinking: "high",
  });
  const catalog = [{ id: "a", isDefault: true, thinkingOptions: [{ id: "high" }] }];
  const chosen = selectExecutorModel(settings, "claude/a", catalog, "claude");
  assert.equal(chosen.claudeExecutorThinking, "high");
  assert.equal(chosen.executorModel, "codex/keep");
  assert.equal(chosen.executorThinking, "xhigh");
  assert.equal(
    selectExecutorModel(chosen, "claude/missing", catalog, "claude").claudeExecutorThinking,
    "",
  );
});

test("the start setting decides the question, the enrolled mode and which blocks are conditional", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "start-mode-"));
  const previous = {
    state: process.env.PASEO_ROLE_WORKFLOW_STATE_DIR,
    home: process.env.PASEO_HOME,
  };
  process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = dir;
  process.env.PASEO_HOME = dir;
  const hooks = new Map(),
    events = new Map(),
    rpcs = new Map();
  const close = contribute({
    before: (name, fn) => {
      hooks.set(name, fn);
      return () => {};
    },
    on: (name, fn) => {
      events.set(name, fn);
      return () => {};
    },
    handle: (contract, fn) => rpcs.set(contract.name, fn),
  });
  const context = {
    paseo: {
      providers: {
        listModels: async () => ({ models: [{ id: "m", label: "Model", isDefault: true }] }),
      },
      agents: {
        ref: (id) => ({
          refresh: async () => ({
            agent: {
              id,
              workspaceId: `workspace-${id}`,
              cwd: dir,
              title: "task",
              status: "idle",
              archivedAt: null,
              pendingPermissions: [],
            },
          }),
        }),
      },
      workspaces: {
        ref: () => ({ refresh: async () => ({ projectId: "project", name: "task" }) }),
      },
    },
  };
  const start = async (agentId, settings) => {
    await rpcs.get("workflow.configure")(settingsSchema.parse(settings), context);
    const created = await hooks.get("agent.create")(
      { request: { config: { provider: "claude", cwd: dir, systemPrompt: "x".repeat(3000) } } },
      context,
    );
    await hooks.get("agent.session_open")(
      { request: { agentId, env: created.env, reason: "create" } },
      context,
    );
    await events.get("agent.created")(
      { agent: { id: agentId, parentAgentId: null, workspaceId: `workspace-${agentId}` } },
      context,
    );
    return { prompt: created.config.systemPrompt, label: created.labels };
  };
  const conditional = (prompt) => (prompt.match(/\[연합개발 전용\]/g) || []).length;
  try {
    const asked = await start("asked", {});
    assert.match(asked.prompt, /첫 응답을 쓰기 전에 한 번만 질문 도구로 진행 방식을 묻는다/);
    assert.match(asked.prompt, /진행 방식 질문은 모델·추론 질문과 묶지 않는다/);
    assert.doesNotMatch(asked.prompt, /세 질문/);
    assert.equal(conditional(asked.prompt), 1);
    assert.ok(
      asked.prompt.indexOf("<paseo-mode-select-v1>") <
        asked.prompt.indexOf("<paseo-role-workflow-v1>"),
    );
    assert.equal(asked.label, undefined);

    const general = await start("general", { askMode: false, defaultMode: "general" });
    assert.match(general.prompt, /저장된 진행 방식은 일반개발이다\. 진행 방식을 묻지 않는다/);
    assert.doesNotMatch(general.prompt, /질문 도구로 진행 방식을 묻는다/);
    assert.equal(conditional(general.prompt), 0);
    assert.match(general.prompt, /<paseo-role-workflow-v1>/);
    assert.match(general.prompt, /<paseo-automation-v1>/);
    assert.match(general.prompt, /최초 대화는 기획·설계·검증을 유지/);
    assert.doesNotMatch(general.prompt, /<paseo-general-v1>|<paseo-executor-model-v1>/);
    assert.equal(general.label, undefined);

    const federated = await start("federated", { askMode: false });
    assert.match(federated.prompt, /저장된 진행 방식은 연합개발이다/);
    assert.equal(conditional(federated.prompt), 1);
    assert.match(
      federated.prompt,
      /연합개발로 정해진 직후, 조사를 시작하기 전에 질문 도구를 한 번만/,
    );
    assert.equal(federated.label, undefined);

    for (const { prompt } of [asked, federated]) {
      assert.match(prompt, /실행 지시는 상태 블록 next에만 쓴다/);
      assert.ok(!prompt.includes("전달할 명령"));
    }
    const state = await rpcs.get("workflow.status")({}, context);
    assert.deepEqual(
      state.workflows.map((w) => [w.planAgentId, w.mode]),
      [
        ["asked", "undecided"],
        ["general", "general"],
        ["federated", "federated"],
      ],
    );
    assert.equal(state.error, null);
    const saved = JSON.parse(
      await (await import("node:fs/promises")).readFile(path.join(dir, "state.json"), "utf8"),
    );
    assert.deepEqual(saved.workflows[0].plan.config, { provider: "claude" });
  } finally {
    await close();
    for (const [key, name] of [
      ["state", "PASEO_ROLE_WORKFLOW_STATE_DIR"],
      ["home", "PASEO_HOME"],
    ]) {
      if (previous[key] === undefined) delete process.env[name];
      else process.env[name] = previous[key];
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed rules publication preserves new conversation creation without the guide block", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "rules-hook-"));
  const previous = process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
  process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = dir;
  await writeFile(path.join(dir, "rules"), "blocked");
  const errors = t.mock.method(console, "error", () => {});
  const hooks = new Map();
  const close = contribute({
    before(name, fn) {
      hooks.set(name, fn);
      return () => {};
    },
    on: () => () => {},
    handle: () => {},
  });
  try {
    const result = await hooks.get("agent.create")(
      { request: { config: { provider: "claude", cwd: dir } } },
      { paseo: {} },
    );
    assert.match(result.config.systemPrompt, /<paseo-role-workflow-v1>/);
    assert.doesNotMatch(result.config.systemPrompt, /<paseo-agent-rules-v1>/);
    assert.equal(errors.mock.callCount(), 1);
  } finally {
    await close();
    if (previous === undefined) delete process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
    else process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
