import { configureFixture } from "./owner-fixture.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import contribute from "../index.server.ts";
import { settingsSchema } from "../shared/contracts.ts";
import { RULES, RULES_VERSION } from "../server/rules-content.ts";

// Each test runs in a new home, including notification/config lookups via os.homedir().
async function freshUser(
  t,
  { catalog = false, general = false, blocked = false, ask = true } = {},
) {
  const home = await mkdtemp(path.join(tmpdir(), "workflow-fresh-"));
  const previous = Object.fromEntries(
    ["HOME", "PASEO_HOME", "PASEO_ROLE_WORKFLOW_STATE_DIR", "XDG_CONFIG_HOME"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  let close;
  t.after(async () => {
    try {
      if (close) await close();
    } finally {
      await chmod(home, 0o700);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(home, { recursive: true, force: true });
    }
  });
  process.env.HOME = home;
  process.env.PASEO_HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  delete process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
  assert.equal(homedir(), home);
  assert.deepEqual(await readdir(home), [], "no state, guides, rules or project records");
  const defaults = settingsSchema.parse({});
  assert.equal(defaults.askMode, true);
  assert.equal(defaults.askExecutorModel, true);
  assert.equal(defaults.defaultMode, "federated");
  const errors = t.mock.method(console, "error", () => {});
  if (blocked) {
    if (process.getuid?.() === 0) {
      // Root bypasses mode bits; a file at the directory destination denies publication too.
      await mkdir(path.join(home, "role-workflow"));
      await writeFile(path.join(home, "role-workflow", "rules"), "blocked");
    } else {
      await chmod(home, 0o500);
    }
  }
  const hooks = new Map();
  const rpcs = new Map();
  const events = new Map();
  const calls = [];
  const context = {
    paseo: catalog
      ? {
          providers: {
            listAvailable: async()=>({providers:[{provider:"claude",available:true},{provider:"codex",available:true}]}),
            async listModels(provider, options) {
              calls.push(structuredClone([provider, options]));
              return { models: [{ id: "sample-model", label: "Sample model", isDefault: true }] };
            },
          },
        }
      : {providers:{listAvailable:async()=>({providers:[{provider:"claude",available:true},{provider:"codex",available:true}]}),listModels:async()=>({models:[{id:"fixture"}]})}},
  };
  close = contribute({
    addHook: (name, fn) => {
      (name === "agent.create.before" || name === "agent.open.before" ? hooks : events).set(name, fn);
      return () => {};
    },
    handle: (contract, fn) => rpcs.set(contract.name, fn),
  });
  const initial = await rpcs.get("workflow.status")({}, context);
  if (blocked) assert.match(initial.error, /지시서/);
  else assert.equal(initial.error, null);
  assert.deepEqual(initial.settings, defaults);
  assert.deepEqual(initial.projects, {});
  assert.deepEqual(initial.workflows, []);
  if (general || !ask) {
    // This scenario alone represents a saved general-mode choice in the temporary state.
    await configureFixture(rpcs, context,
      settingsSchema.parse({
        ...defaults,
        ...(general ? { askMode: false, defaultMode: "general" } : {}),
        askExecutorModel: ask,
      }),
    );
  }
  return {
    home,
    calls,
    errors,
    async enroll(provider, choice = "연합개발") {
      const source = {
        id: "fresh-source",
        provider,
        cwd: home,
        title: "Task",
        status: "idle",
        pendingPermissions: [],
        workspaceId: "workspace",
        parentAgentId: null,
        archivedAt: null,
      };
      context.paseo.agents = { ref: () => ({ refresh: async () => ({ agent: source }) }) };
      context.paseo.workspaces = {
        ref: () => ({ refresh: async () => ({ projectId: "project", name: "Task" }) }),
      };
      const response = await hooks.get("agent.create.before")(
        { request: { config: { provider, cwd: home } } },
        context,
      );
      await hooks.get("agent.open.before")(
        { request: { agentId: source.id, env: response.env, reason: "create" } },
        context,
      );
      await events.get("agent.create.after")({ agent: source }, context);
      // A default fresh conversation begins undecided; choosing federation retains its new contract.
      if (!general) {
        await events.get("agent.permission.before")(
          {
            agent: source,
            request: {
              id: "mode",
              kind: "question",
              input: {
                questions: [
                  {
                    question: "진행 방식을 선택하세요",
                    header: "방식",
                    options: [{ label: "일반개발" }, { label: "연합개발" }],
                  },
                ],
              },
            },
          },
          context,
        );
        await events.get("agent.permission.after")(
          {
            agent: source,
            requestId: "mode",
            resolution: { behavior: "allow", updatedInput: { answers: { 방식: choice } } },
          },
          context,
        );
      }
      return {
        prompt: response.config.systemPrompt,
        state: JSON.parse(await readFile(path.join(home, "role-workflow", "state.json"), "utf8"))
          .workflows[0],
      };
    },
    async prompt(provider, env) {
      const request = { config: { provider, cwd: home }, ...(env ? { env } : {}) };
      const first = await hooks.get("agent.create.before")({ request }, context);
      assert.equal(first.config.provider, provider);
      const prompt = first.config.systemPrompt;
      assert.equal(typeof prompt, "string");
      const second = await hooks.get("agent.create.before")(
        { request: { ...request, config: { ...request.config, systemPrompt: prompt } } },
        context,
      );
      assert.equal(second.config.systemPrompt, prompt, "reapplying must not duplicate blocks");
      // /push is a documented slash command, not an absolute file path.
      const redacted = prompt
        .replaceAll(home, "<temporary-home>")
        .replace(/(^|[\s'"(])\/push\b/g, "$1<push-command>");
      assert.doesNotMatch(redacted, /[/](?:Users|Volumes|home)[/]/);
      assert.deepEqual(
        [...redacted.matchAll(/(?:^|[\s"'`:(])(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>]*/gu)].map(
          (match) => match[0],
        ),
        [],
        "absolute prompt paths must stay inside the temporary home",
      );
      assert.doesNotMatch(prompt, /[\w.%+-]+@[\w.-]+\.[a-z]{2,}/i);
      assert.doesNotMatch(prompt, /github\.com\/(?!example\/)[^/\s]+\//i);
      return prompt;
    },
  };
}

function block(prompt, tag) {
  const open = `<paseo-${tag}-v1>`;
  assert.equal(prompt.split(open).length - 1, 1, `${tag} occurs once`);
  const start = prompt.indexOf(open) + open.length;
  const end = prompt.indexOf(`</paseo-${tag}-v1>`, start);
  assert.ok(end >= start, `${tag} is closed`);
  return prompt.slice(start, end);
}

async function assertRules(prompt, home) {
  const guide = block(prompt, "agent-rules");
  assert.doesNotMatch(guide, /연합개발 전용/);
  const readme = JSON.parse(/규칙 원본: ("[^\n]+")\./.exec(guide)[1]);
  const directory = path.join(home, "role-workflow", "rules", RULES_VERSION);
  assert.equal(readme, path.join(directory, "README.md"));
  assert.equal(Object.keys(RULES).length, 8);
  assert.deepEqual((await readdir(directory)).sort(), Object.keys(RULES).sort());
  for (const [name, body] of Object.entries(RULES)) {
    assert.equal(await readFile(path.join(directory, name), "utf8"), body);
  }
}

for (const provider of ["claude", "codex"]) for (const catalog of [false,true])
test(`fresh ${provider} contract6 gates roles to federation with catalog=${catalog}`,async t=>{
 const f=await freshUser(t,{catalog});const prompt=await f.prompt(provider);await assertRules(prompt,f.home);
 assert.match(prompt,/<paseo-work-mode-v4>/);assert.match(prompt,/실제 답변 전/);
 assert.match(block(prompt,"role-workflow"),/연합개발 전용/);assert.match(block(prompt,"automation"),/연합개발 전용/);
 assert.match(prompt,/<paseo-executor-selection-v5>/);assert.doesNotMatch(prompt,/<paseo-general-agent-v1>|<paseo-executor-model-v1>|<paseo-executor-selection-v4>/);
 // The executor is picked on the plugin screen, so starting never reads or lists the catalog.
 assert.doesNotMatch(prompt,/sample-model|카탈로그를 읽지 못/);assert.deepEqual(f.calls,[]);
 assert.equal(f.errors.mock.callCount(),0);
});

test("fresh managed executor receives rules and the execution role without mode questions", async (t) => {
  const f = await freshUser(t);
  const prompt = await f.prompt("codex", {
    PASEO_ROLE_WORKFLOW_MANAGED: "1",
    PASEO_ROLE_WORKFLOW_ROLE: "execute",
  });
  await assertRules(prompt, f.home);
  assert.match(block(prompt, "role-workflow"), /구현 역할/);
  block(prompt, "automation");
  assert.doesNotMatch(prompt, /<paseo-mode-select-v1>|<paseo-executor-model-v1>/);
  assert.equal(f.errors.mock.callCount(), 0);
});

test("fresh general mode implements in the initial conversation without role or selection blocks",async t=>{
 const f=await freshUser(t,{general:true});const prompt=await f.prompt("claude");await assertRules(prompt,f.home);
 assert.match(prompt,/직접 조사·구현·자체 검증/);assert.doesNotMatch(prompt,/<paseo-role-workflow-v1>|<paseo-automation-v1>|<paseo-executor-selection-v[45]>/);
 assert.equal(f.errors.mock.callCount(),0);
});

test("fresh unwritable home still creates a conversation and omits only the rules block", async (t) => {
  const f = await freshUser(t, { blocked: true });
  const prompt = await f.prompt("claude");
  assert.doesNotMatch(prompt, /<paseo-agent-rules-v1>/);
  for (const tag of ["role-workflow", "automation"])
    block(prompt, tag);
  assert.equal(f.errors.mock.callCount(), 1);
  assert.match(f.errors.mock.calls[0].arguments[0], /규칙 문서 비치 실패/);
});

for(const ask of [true,false])test(`fresh saved general askExecutorModel=${ask} never asks or queries implementation choices`,async t=>{
 const f=await freshUser(t,{general:true,catalog:true,ask});const prompt=await f.prompt("claude");
 assert.match(prompt,/최초 대화/);assert.match(prompt,/자체 점검/);assert.doesNotMatch(prompt,/<paseo-general-agent-v1>|<paseo-executor-selection-v4>/);assert.deepEqual(f.calls,[]);
});

test("the selected replacement conversation receives general rules without asking again", async (t) => {
  const f = await freshUser(t, { catalog: true });
  const prompt = await f.prompt("codex", { PASEO_ROLE_WORKFLOW_GENERAL_READY: "1" });
  await assertRules(prompt, f.home);
  block(prompt, "general");
  assert.doesNotMatch(
    prompt,
    /<paseo-general-agent-v1>|<paseo-role-workflow-v1>|<paseo-mode-select-v1>|<paseo-automation-v1>/,
  );
  assert.deepEqual(f.calls, []);
});

for (const provider of ["claude", "codex"])
  test(`fresh ${provider} federation enrollment uses contract 7 and exactly one verdict instruction`, async (t) => {
    const f = await freshUser(t);
    const result = await f.enroll(provider);
    assert.equal(result.state.contract, 7);
    assert.equal(result.state.mode, "federated");
    assert.equal(result.state.completeRepairs, 0);
    assert.equal(
      block(result.prompt, "automation").split("계획 담당이 complete를 낼 때 verdict").length - 1,
      1,
    );
  });

test("fresh saved general enrollment uses contract7 standalone behavior",async t=>{
 const f=await freshUser(t,{general:true});const result=await f.enroll("claude");
 assert.equal(result.state.contract,7);assert.equal(result.state.mode,"general");assert.equal(result.state.execute,null);
 assert.doesNotMatch(result.prompt,/<paseo-automation-v1>/);
});
test("fresh ask-mode general choice retains contract7 without role separation",async t=>{
 const f=await freshUser(t);const result=await f.enroll("codex","일반개발");
 assert.equal(result.state.mode,"general");assert.equal(result.state.contract,7);assert.equal(result.state.execute,null);
});

// N-1: verify the real creation hook, separately from explicit-version engine fixtures.
test("N-1: new federation and general registrations receive contract7 with unchanged standalone behavior",async t=>{
 const {capabilities}=await import('../shared/capabilities.ts');
 for(const general of [false,true]){
  const f=await freshUser(t,{general});const result=await f.enroll('claude');
  assert.equal(result.state.contract,7);assert.equal(result.state.execute,null);
  assert.equal(capabilities(result.state).planReview,!general);
  assert.equal(capabilities(result.state).standalone,general);
  if(general)assert.doesNotMatch(result.prompt,/<paseo-automation-v1>/);
 }
});
