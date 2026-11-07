import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import contribute from "../index.server.ts";
import { settingsSchema } from "../shared/contracts.ts";

async function fixture(t, project) {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-start-mode-"));
  if (project)
    await writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({ version: 1, settings: {}, projects: { [dir]: project }, workflows: [] }),
    );
  const previous = process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
  process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = dir;
  const hooks = new Map(),
    events = new Map(),
    rpcs = new Map(),
    calls = [];
  const close = contribute({
    addHook: (name, fn) => {
      (name === "agent.create.before" || name === "agent.open.before" ? hooks : events).set(name, fn);
      return () => {};
    },
    handle: (contract, fn) => rpcs.set(contract.name, fn),
  });
  t.after(async () => {
    await close();
    if (previous === undefined) delete process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
    else process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const context = {
    paseo: {
      providers: {
        listModes: async (...args) => {
          calls.push(structuredClone(args));
          return { modes: [{ id: "bypassPermissions" }, { id: "acceptEdits" }] };
        },
        listModels: async () => ({ models: [] }),
      },
    },
  };
  return {
    dir,
    context,
    hooks,
    events,
    calls,
    configure: (settings) =>
      rpcs.get("workflow.configure")(settingsSchema.parse(settings), context),
    create: (config = {}, env = {}) =>
      hooks.get("agent.create.before")(
        { request: { config: { provider: "claude", cwd: dir, ...config }, env } },
        context,
      ),
    enroll: async (result) => {
      context.paseo.agents = {
        ref: (id) => ({
          refresh: async () => ({
            agent: {
              id,
              workspaceId: "workspace",
              cwd: dir,
              title: "task",
              status: "idle",
              archivedAt: null,
              pendingPermissions: [],
            },
          }),
        }),
      };
      context.paseo.workspaces = {
        ref: () => ({ refresh: async () => ({ projectId: "project", name: "task" }) }),
      };
      await hooks.get("agent.open.before")(
        { request: { agentId: "agent", env: result.env, reason: "create" } },
        context,
      );
      await events.get("agent.create.after")(
        { agent: { id: "agent", parentAgentId: null, workspaceId: "workspace" } },
        context,
      );
      return JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    },
  };
}

for (const modeId of ["auto", "default", "acceptEdits", undefined]) {
  test(`new Claude ${modeId ?? "unspecified"} mode uses bypass by default and saves it in the seed`, async (t) => {
    const f = await fixture(t);
    const result = await f.create({ modeId });
    assert.equal(result.config.modeId, "bypassPermissions");
    assert.deepEqual(f.calls, [["claude", { cwd: f.dir }]]);
    assert.deepEqual(Object.keys(result).sort(), ["config", "env"]);
    const saved = await f.enroll(result);
    assert.equal(saved.workflows[0].plan.config.modeId, "bypassPermissions");
  });
}

for (const [name, config, env] of [
  ["plan", { modeId: "plan" }, {}],
  ["managed", { modeId: "default" }, { PASEO_ROLE_WORKFLOW_MANAGED: "1" }],
  ["disabled", { modeId: "default" }, { PASEO_ROLE_WORKFLOW_DISABLE: "1" }],
  ["Codex", { provider: "codex", modeId: "auto" }, {}],
]) {
  test(`${name} conversations keep their mode without a catalog lookup`, async (t) => {
    const f = await fixture(t);
    const result = await f.create(config, env);
    assert.equal(result.config.modeId, config.modeId);
    assert.deepEqual(f.calls, []);
  });
}

test("clearing claudeStartMode disables the override", async (t) => {
  const f = await fixture(t);
  await f.configure({ claudeStartMode: "" });
  assert.equal((await f.create({ modeId: "default" })).config.modeId, "default");
  assert.deepEqual(f.calls, []);
});

for (const provider of ["claude", "codex"])
  for (const mode of ["general", "federated"])
    for (const askMode of [true, false])
      test(`${provider} saved ${mode} respects the mode-question setting (${askMode}) and offers the saved executor first`, async (t) => {
        const executor = provider === "claude" ? "codex" : "claude";
        const project = { mode, [executor]: { model: `${executor}/saved`, thinking: "high" } };
        const f = await fixture(t, project);
        f.context.paseo.providers.listModels = async () => ({
          models: [{ id: "other", label: "Other" }, { id: "saved", label: "Saved" }],
        });
        await f.configure({ askMode, askExecutorModel: true });
        const result = await f.create({ provider });
        if (askMode) {
          assert.match(result.config.systemPrompt,/진행 방식을 단독 질문/);
          assert.match(result.config.systemPrompt,/일반개발, 연합개발/);
          assert.doesNotMatch(result.config.systemPrompt,/저장된 설정을 사용하며 다시 묻지 않는다/);
          // Contract 5 leaves the executor to the plugin screen; no catalog enters the prompt.
          assert.doesNotMatch(result.config.systemPrompt,new RegExp(`${executor}/saved`));
          assert.match(result.config.systemPrompt,/플러그인 화면에서 고른다/);
        } else assert.doesNotMatch(result.config.systemPrompt,/질문 도구로 진행 방식을 단독 질문/);
        const saved = await f.enroll(result);
        assert.equal(saved.workflows[0].mode, askMode ? "undecided" : mode);
        assert.equal(saved.settings.askMode, askMode);
        assert.deepEqual(saved.projects[f.dir], project);
      });

test("a configured mode applies independently of automatic enrollment and workflow direction", async (t) => {
  const f = await fixture(t);
  for (const settings of [
    { autoStart: false },
    { askMode: false, defaultMode: "general" },
    { askMode: false, defaultMode: "federated" },
  ]) {
    await f.configure({ ...settings, claudeStartMode: "acceptEdits" });
    const result = await f.create({ modeId: "default" });
    assert.equal(result.config.modeId, "acceptEdits");
    if (settings.autoStart === false) assert.equal(result.env.PASEO_ROLE_WORKFLOW_SEED, undefined);
  }
});

for (const [name, lookup] of [
  ["returned error", async () => ({ error: "offline", modes: [{ id: "bypassPermissions" }] })],
  [
    "exception",
    async () => {
      throw new Error("offline");
    },
  ],
  ["missing mode", async () => ({ modes: [{ id: "default" }] })],
  ["missing method", undefined],
  ["timeout", () => new Promise(() => {})],
]) {
  test(`mode lookup ${name} preserves the requested mode`, async (t) => {
    const f = await fixture(t);
    f.context.paseo.providers.listModes = lookup;
    const result = await f.create({ modeId: "default" });
    assert.equal(result.config.modeId, "default");
  });
}

test("old settings gain the Claude start default and an empty value stays empty", () => {
  const old = settingsSchema.parse({});
  delete old.claudeStartMode;
  assert.equal(settingsSchema.parse(old).claudeStartMode, "bypassPermissions");
  assert.equal(settingsSchema.parse({ claudeStartMode: "  " }).claudeStartMode, "");
});

for(const provider of ["claude","codex"])for(const askMode of [true,false])
test(`${provider} startup leaves product/model/thinking to the plugin screen askMode=${askMode}`,async t=>{
 const f=await fixture(t);let listed=0;f.context.paseo.providers.listModels=async()=>{listed++;return {models:[{id:"model",label:"Model",thinkingOptions:[{id:"medium",label:"Medium"}]}]};};
 await f.configure({askMode,askExecutorModel:true});const {config}=await f.create({provider});
 assert.match(config.systemPrompt,/<paseo-executor-selection-v5>/);assert.match(config.systemPrompt,/플러그인 화면에서 고른다/);
 assert.doesNotMatch(config.systemPrompt,/<paseo-executor-selection-v4>|3질문|codex\/model|claude\/model/);assert.equal(listed,0);
 assert.doesNotMatch(config.systemPrompt,/모델·추론 두 질문을 한 번의 호출/);
 if(askMode)assert.match(config.systemPrompt,/진행 방식을 단독 질문/);else assert.match(config.systemPrompt,/진행 방식은 연합개발이다/);
});
test("startup never reads the catalog or puts a saved executor in the prompt",async t=>{
 const f=await fixture(t,{mode:"federated",codex:{model:"codex/saved",thinking:"high"}});
 f.context.paseo.providers.listModels=async()=>{throw Error("catalog offline");};
 await f.configure({askMode:true,askExecutorModel:true});const {config}=await f.create();
 assert.match(config.systemPrompt,/<paseo-executor-selection-v5>/);assert.doesNotMatch(config.systemPrompt,/codex\/saved/);
 assert.doesNotMatch(config.systemPrompt,/저장된 설정을 사용하며 다시 묻지 않는다/);
});
test("the legacy model-question switch cannot skip screen selection",async t=>{
 const f=await fixture(t);await f.configure({askMode:true,askExecutorModel:false});const {config}=await f.create();
 assert.match(config.systemPrompt,/진행 방식을 단독 질문/);assert.match(config.systemPrompt,/<paseo-executor-selection-v5>/);
 assert.doesNotMatch(config.systemPrompt,/실행 모델·추론은 저장된 설정을 사용/);
});
