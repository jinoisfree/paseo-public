import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowEngine } from "../server/engine.ts";
import { createPort, readCompletedTurn } from "../server/paseo-port.ts";
import { GENERAL_QUESTIONS as Q, generalAgentLabel } from "../shared/general-agent.ts";
import { asyncGeneralAnswers, explicitGeneralChoice } from "../server/general-agent.ts";
import { generalAgentPrompt } from "../server/general-agent-prompt.ts";
import { executorModelPrompt } from "../server/protocol.ts";

async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "general-agent-"));
  const previous = Object.fromEntries(
    ["HOME", "PASEO_HOME", "PASEO_ROLE_WORKFLOW_STATE_DIR", "XDG_CONFIG_HOME"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env.HOME = process.env.PASEO_HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  delete process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
  const live = {
    id: "source",
    workspaceId: "same-workspace",
    projectId: "project",
    cwd: home,
    title: "task",
    status: "idle",
    archived: false,
    permission: false,
    usage: 0,
    config: { provider: "claude/current", thinkingOptionId: "high" },
  };
  const calls = [],
    notices = [],
    agents = new Map();
  const port = {
    inspect: async () => live,
    createGeneral: async (w, transfer, mode) => {
      calls.push({
        transfer: structuredClone(transfer),
        workspace: w.plan.workspaceId,
        request: w.goal,
        mode,
      });
      if (options.fail) throw Error("creation unavailable");
      agents.set(transfer.id, transfer.agentId);
    },
    generalNotice: async (...args) => notices.push(args),
    projectName: async () => "project",
    workspaceName: async () => "task",
    rename: async () => {},
    history: async () => ({ text: "", key: "", messageIds: [], failed: null }),
  };
  const file = path.join(home, "role-workflow", "state.json");
  const engine = new WorkflowEngine(file, port);
  await engine.configure({
    ...(await engine.settings()),
    claudeStartMode: "stored-claude-mode",
    executorMode: "stored-codex-mode",
    ...options.settings,
  });
  const id = await engine.enroll(live, live.config, {}, "general", true);
  t.after(async () => {
    await engine.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  const view = async () => (await engine.list()).workflows[0];
  const answer = async (name, value, requestId = name) => {
    await engine.permission("source", {
      id: requestId,
      kind: "question",
      input: {
        questions: [
          {
            question: Q[name].question,
            header: Q[name].header,
            options: [{ label: "Claude Code" }, { label: "Codex" }],
          },
        ],
      },
    });
    await engine.permissionResolved("source", requestId, {
      behavior: "allow",
      updatedInput: { answers: { [Q[name].header]: value } },
    });
  };
  const choose = async (provider, model, thinking = "high") => {
    await answer("agent", provider === "codex" ? "Codex" : "Claude Code");
    await engine.permission("source", {
      id: "pair",
      kind: "question",
      input: {
        questions: ["model", "thinking"].map((name) => ({
          question: Q[name].question,
          header: Q[name].header,
          options: [{ label: "choice" }],
        })),
      },
    });
    await engine.permissionResolved("source", "pair", {
      behavior: "allow",
      updatedInput: {
        answers: { [Q.model.header]: `${provider}/${model}`, [Q.thinking.header]: thinking },
      },
    });
  };
  const finish = (goal = "Original request\nKeep this exact line.", text = "선택했습니다.") =>
    engine.ended("source", "first-turn", text, null, goal, false, goal);
  return {
    home,
    engine,
    id,
    file,
    live,
    port,
    view,
    choose,
    answer,
    finish,
    calls,
    notices,
    agents,
  };
}

test("general selection matching the live config keeps the current conversation and remembers it", async (t) => {
  const f = await fixture(t);
  await f.choose("claude", "current");
  await f.finish();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.view()).planAgentId, "source");
  assert.deepEqual((await f.view()).generalAgent, {
    provider: "claude",
    model: "current",
    thinking: "high",
  });
  assert.deepEqual(await f.engine.generalDefault(f.home), (await f.view()).generalAgent);
});
for (const [provider, mode] of [
  ["codex", "stored-codex-mode"],
  ["claude", "stored-claude-mode"],
]) {
  test(`different ${provider} selection creates one conversation beside the source with the original request`, async (t) => {
    const f = await fixture(t);
    await f.choose(provider, "chosen");
    await f.finish();
    await f.finish();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].workspace, "same-workspace");
    assert.equal(f.calls[0].mode, mode);
    assert.equal(f.calls[0].request, "Original request\nKeep this exact line.");
    assert.ok(!f.calls[0].request.startsWith("작업 ID:"));
    assert.equal((await f.view()).planAgentId, f.calls[0].transfer.agentId);
    assert.match((await f.view()).detail, /선택한 담당 대화로 넘겼습니다/);
    assert.equal(f.notices[0][0], "source");
    await f.engine.close();
    const restarted = new WorkflowEngine(f.file, f.port);
    t.after(() => restarted.close());
    const view = (await restarted.list()).workflows[0];
    assert.deepEqual(view.generalAgent, { provider, model: "chosen", thinking: "high" });
    await restarted.started(view.planAgentId);
    await restarted.tick();
    assert.equal(f.calls.length, 1);
  });
}

test("queued general creation survives restart and reuses the durable creation identity", async (t) => {
  const f = await fixture(t);
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  const w = db.workflows[0];
  const choice = { provider: "codex", model: "chosen", thinking: "high" };
  w.goal = "exact original";
  w.generalState.selected = choice;
  w.generalState.transfer = {
    id: "durable-intent",
    agentId: "durable-agent",
    sourceId: "source",
    choice,
    stage: "queued",
  };
  f.agents.set("durable-intent", "durable-agent"); // the daemon created it before the old process crashed
  await writeFile(f.file, JSON.stringify(db));
  const restarted = new WorkflowEngine(f.file, f.port);
  t.after(() => restarted.close());
  await restarted.tick();
  await restarted.tick();
  assert.equal(f.agents.size, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].transfer.id, "durable-intent");
  assert.equal((await restarted.list()).workflows[0].planAgentId, "durable-agent");
});

test("general creation failure retains the source conversation and exposes the error", async (t) => {
  const f = await fixture(t, { fail: true });
  await f.choose("codex", "chosen");
  await f.finish();
  assert.equal((await f.view()).planAgentId, "source");
  assert.match((await f.view()).detail, /일반개발 담당 변경 실패.*creation unavailable/);
  await f.engine.tick();
  assert.equal(f.calls.length, 1);
});

test("no answer or no question tool keeps current settings without creating another conversation", async (t) => {
  const f = await fixture(t);
  await f.engine.permission("source", {
    id: "dismissed",
    kind: "question",
    input: { questions: [{ question: Q.agent.question, header: Q.agent.header, options: [] }] },
  });
  await f.engine.permissionResolved("source", "dismissed", {
    behavior: "deny",
    message: "no answer",
  });
  await f.finish(undefined, "기본값(현재 대화 설정) 사용");
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.view()).generalAgent, {
    provider: "claude",
    model: "current",
    thinking: "high",
  });
});

test("disabled model questions ignore selection tool answers and retain the current settings", async (t) => {
  const f = await fixture(t, { settings: { askExecutorModel: false } });
  await f.choose("codex", "chosen");
  await f.finish();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.view()).generalAgent.provider, "claude");
});

test("explicit first-request selection needs no question answers", async (t) => {
  const f = await fixture(t);
  const request = "Codex 모델 chosen 추론 high\nKeep the original request";
  await f.finish(request);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request, request);
});

test("old workflow and project state read without new general fields", async (t) => {
  const f = await fixture(t);
  await f.engine.close();
  const db = JSON.parse(await readFile(f.file, "utf8"));
  delete db.workflows[0].generalState;
  db.projects[f.home] = { mode: "general" };
  await writeFile(f.file, JSON.stringify(db));
  const restarted = new WorkflowEngine(f.file, f.port);
  t.after(() => restarted.close());
  assert.equal((await restarted.list()).workflows[0].generalAgent.provider, "claude");
  assert.equal(await restarted.generalDefault(f.home), null);
});

test("rememberProjectChoices false leaves project defaults unchanged", async (t) => {
  const f = await fixture(t, { settings: { rememberProjectChoices: false } });
  await f.choose("claude", "current");
  await f.finish();
  assert.equal(await f.engine.generalDefault(f.home), null);
  assert.deepEqual((await f.engine.list()).projects, {});
});

function nativeAnswer(question, answer) {
  const detail = question + "\n" + answer;
  return [
    {
      type: "tool_call",
      name: "request_user_input_async",
      callId: question,
      status: "completed",
      error: null,
      detail: { type: "plain_text", text: detail },
    },
    { type: "user_message", text: "Answers to your questions:\n\n" + detail },
  ];
}
test("native Codex choices require completed tools and exactly matching follow-up messages", () => {
  const valid = nativeAnswer(Q.model.question, "codex/chosen");
  assert.deepEqual(asyncGeneralAnswers(valid), { model: "codex/chosen" });
  assert.deepEqual(asyncGeneralAnswers([valid[1]]), {});
  assert.deepEqual(asyncGeneralAnswers([{ ...valid[0], status: "running" }, valid[1]]), {});
  assert.deepEqual(
    asyncGeneralAnswers([valid[0], { ...valid[1], text: valid[1].text + " changed" }]),
    {},
  );
  assert.equal(explicitGeneralChoice("Codex 모델 chosen 비교?"), null);
  assert.equal(explicitGeneralChoice("`codex/chosen` 예시"), null);
  assert.equal(explicitGeneralChoice("설명해 주세요\ncodex/chosen"), null);
  assert.deepEqual(explicitGeneralChoice("codex/chosen 추론 high"), {
    provider: "codex",
    model: "chosen",
    thinking: "high",
  });
});

test("Codex asynchronous choice survives an empty turn-ended timeline from newer apps", async (t) => {
  const f = await fixture(t);
  const items = [
    ...nativeAnswer(Q.agent.question, "Codex"),
    ...nativeAnswer(Q.model.question, "codex/chosen"),
  ];
  const saved = {
    text: "selected",
    key: "turn",
    request: "first",
    goal: "original",
    messageIds: [],
    failed: null,
    generalAnswers: asyncGeneralAnswers(items),
  };
  const turn = await readCompletedTurn([], f.home, async () => saved);
  await f.engine.generalTimeline("source", [], turn.generalAnswers);
  await f.finish();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].transfer.choice.provider, "codex");
});

test("remembered general choice leads the agent options and its model catalog", () => {
  const choice = { provider: "codex", model: "chosen", thinking: "high" };
  const models = [
    { id: "other", label: "Other", isDefault: true },
    { id: "chosen", label: "Chosen" },
  ];
  const rendered = executorModelPrompt(models, "codex/chosen", false, true, true);
  const prompt = generalAgentPrompt({ claude: "", codex: rendered }, choice, true);
  assert.match(prompt, /선택지: Codex, Claude Code/);
  assert.ok(prompt.indexOf("Chosen (codex/chosen)") < prompt.indexOf("Other (codex/other)"));
  assert.match(prompt, /일반개발 전용/);
  assert.match(prompt, /기본값\(현재 대화 설정\) 사용/);
  assert.equal(generalAgentLabel(choice), "Codex · chosen · high");
});

test("general port uses the same workspace, selected config and stable initial-message keys", async () => {
  const calls = [];
  const port = createPort(() => ({
    providers: { listModes: async () => ({ modes: [{ id: "stored" }] }) },
    workspaces: {
      ref: (id) => ({
        agents: {
          create: async (options) => {
            calls.push({ id, options });
            return { id: options.agentId };
          },
        },
      }),
    },
  }));
  const w = {
    plan: { workspaceId: "same", config: {} },
    cwd: "/example/project",
    goal: "raw original\nrequest",
  };
  const transfer = {
    id: "intent",
    agentId: "target",
    sourceId: "source",
    stage: "queued",
    choice: { provider: "codex", model: "chosen", thinking: "high" },
  };
  await port.createGeneral(w, transfer, "stored");
  await port.createGeneral(w, transfer, "stored");
  assert.deepEqual(calls[0], calls[1]);
  const { options } = calls[0];
  assert.equal(calls[0].id, "same");
  assert.equal(options.config.provider, "codex/chosen");
  assert.equal(options.config.thinkingOptionId, "high");
  assert.equal(options.config.modeId, "stored");
  assert.equal(options.env.PASEO_ROLE_WORKFLOW_GENERAL_READY, "1");
  assert.equal(options.prompt, w.goal);
  assert.equal(options.idempotencyKey, "role-workflow-general:intent");
  assert.equal(options.clientMessageId, "role-workflow-general-request:intent");
});

test("an unanswered asynchronous question never settles the current agent prematurely", async (t) => {
  const f = await fixture(t);
  await f.engine.permission("source", {
    id: "waiting",
    kind: "question",
    input: { questions: [{ question: Q.agent.question, header: Q.agent.header, options: [] }] },
  });
  f.live.permission = true;
  await f.finish();
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).workflows[0].generalState.settled, false);
});

test("pending native question metadata survives a plugin restart", async (t) => {
  const f = await fixture(t);
  await f.answer("agent", "Codex");
  await f.engine.permission("source", {
    id: "pending-model",
    kind: "question",
    input: {
      questions: [
        { question: Q.model.question, header: Q.model.header, options: [] },
        { question: Q.thinking.question, header: Q.thinking.header, options: [] },
      ],
    },
  });
  await f.engine.close();
  const restarted = new WorkflowEngine(f.file, f.port);
  t.after(() => restarted.close());
  await restarted.permissionResolved("source", "pending-model", {
    behavior: "allow",
    updatedInput: { answers: { [Q.model.header]: "codex/chosen", [Q.thinking.header]: "high" } },
  });
  await restarted.ended("source", "answered", "selected", null, "original request");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].transfer.choice, {
    provider: "codex",
    model: "chosen",
    thinking: "high",
  });
});
