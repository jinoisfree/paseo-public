#!/usr/bin/env node
import "../plugin/role-workflow/tests/test-home.mjs";
import { gitTestEnvironment } from "../plugin/role-workflow/tests/git-test-environment.mjs";
// Manual end-to-end check: an isolated Paseo daemon (temporary PASEO_HOME, random port) loads this
// checkout's role-workflow and talks to a fake Claude model, so no real account or quota is used.
// The harness shape follows babo-jeonguk/paseo-usage-auto-resume (MIT).
// usage: node e2e/run.mjs [--paseo <cli>] [--keep]
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "../plugin/role-workflow");
const argv = process.argv.slice(2);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const paseo = option("--paseo") ?? "/Applications/Paseo.app/Contents/Resources/bin/paseo";
const keep = argv.includes("--keep");

const root = await mkdtemp(join(tmpdir(), "rw-e2e-"));
const home = join(root, "home");
const work = join(root, "work");
const control = join(root, "control.json");
const modelLog = join(root, "models.jsonl");
const daemonLog = join(root, "daemon.out");
await mkdir(home, { recursive: true });
await mkdir(work, { recursive: true });

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = (file, args, options = {}) =>
  new Promise((done) =>
    execFile(file, args, { timeout: 180_000, maxBuffer: 16 << 20, ...options, env: file === "git" ? gitTestEnvironment(options.env ?? baseEnv) : options.env ?? baseEnv }, (error, stdout, stderr) =>
      done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
    ),
  );
async function waitFor(what, check, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

const [daemonPort, modelPort] = [await freePort(), await freePort()];
const target = `127.0.0.1:${daemonPort}`;
const baseEnv = gitTestEnvironment();
for (const key of Object.keys(baseEnv))
  if (/^(PASEO_|ANTHROPIC_|CLAUDE_)/.test(key)) delete baseEnv[key];
const publicConfig = join(root, "public.config.json");
writeFileSync(publicConfig, JSON.stringify({ phoneNotifications: false, phoneNotificationEndpoint: "https://example.invalid/push" }));
const env = { ...baseEnv, PASEO_HOME: home, PASEO_PUBLIC_CONFIG: publicConfig };
const cli = (...args) => run(paseo, [...args, "--home", home], { env });

writeFileSync(control, JSON.stringify({ mode: "text", text: "2" }));
await mkdir(join(root, "codex-home"), { recursive: true });
writeFileSync(
  join(root, "codex-home", "config.toml"),
  [
    // A known model family, so Codex offers its shell tool; requests still go to the fake provider.
    'model = "gpt-5.4"',
    'model_provider = "fake"',
    "[model_providers.fake]",
    'name = "fake"',
    `base_url = "http://127.0.0.1:${modelPort}/v1"`,
    'env_key = "FAKE_KEY"',
    'wire_api = "responses"',
    "",
  ].join("\n"),
);
await run("git", ["init", "-q"], { cwd: work });
await run("git", ["-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: work });
const remote = join(root, "remote.git");
await run("git", ["init", "-q", "--bare", remote]);
await run("git", ["remote", "add", "origin", remote], { cwd: work });
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({
    version: 1,
    daemon: { listen: target, relay: { enabled: false }, mcp: { enabled: false } },
    pluginsEnabled: true,
    features: { webUi: { enabled: false }, dictation: { enabled: false }, voiceMode: { enabled: false } },
    agents: {
      providers: {
        claude: {
          env: {
            CLAUDE_CODE_OAUTH_TOKEN: "e2e-fixture-only",
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
            CLAUDE_CONFIG_DIR: join(root, "claude-config"),
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_TELEMETRY: "1",
            DISABLE_AUTOUPDATER: "1",
            DISABLE_ERROR_REPORTING: "1",
          },
        },
        codex: { env: { CODEX_HOME: join(root, "codex-home"), FAKE_KEY: "e2e-fixture-only" } },
      },
    },
  }),
);

const children = [];
const detached = (file, args, extra = {}) => {
  const out = openSync(extra.log ?? "/dev/null", "a");
  const child = spawn(file, args, { stdio: ["ignore", out, out], detached: true, env: extra.env ?? baseEnv });
  closeSync(out);
  children.push(child);
  return child;
};
const stop = async (child) => {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
};
let daemon;
const startDaemon = async () => {
  daemon = detached(paseo, ["daemon", "run", "--home", home], {
    log: daemonLog,
    env: { ...env, PASEO_LISTEN: target, PASEO_RELAY_ENABLED: "false", PASEO_WEB_UI_ENABLED: "false" },
  });
  await waitFor("daemon", async () => (await cli("ls", "--json")).code === 0);
};
const readyCount = async () =>
  ((await cli("plugin", "logs", "role-workflow")).stdout.match(/Plugin ready/g) ?? []).length;
const state = () => JSON.parse(readFileSync(join(home, "role-workflow", "state.json"), "utf8"));
const agentFile = (id) => {
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const file = join(dir, name);
      return statSync(file).isDirectory() ? walk(file) : name === `${id}.json` ? [file] : [];
    });
  return walk(join(home, "agents"))[0];
};
const runAgent = async (prompt, provider = "claude") => {
  const result = await cli("run", "--provider", provider, "--cwd", work, "--wait-timeout", "120s", "--json", prompt);
  const id = /"agentId":\s*"([^"]+)"/.exec(result.stdout)?.[1];
  if (!id) throw new Error(`agent did not start: ${result.stdout}${result.stderr}`.slice(0, 600));
  return id;
};
let client = null;
const rpc = async (method, input = {}) => {
  client ??= await waitFor("plugin RPC connection", async () => {
    const candidate = new DaemonClient({ url: `ws://${target}/ws`, clientId: "rw-e2e", clientType: "cli", reconnect: { enabled: false } });
    try {
      await candidate.connect();
      return candidate;
    } catch {
      await candidate.close().catch(() => {});
      return null;
    }
  });
  return client.invokePluginRpc("role-workflow", method, input);
};
const workflowBlock = (status, next) =>
  `<paseo-workflow>${JSON.stringify({ status, summary: status, next, handoff: "e2e", checks: [] })}</paseo-workflow>`;
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.log(`FAIL ${name}: ${error?.message ?? error}`);
  }
}

let questionAgent = "";
let generalAgent = "";
let defaultSettings;
let policyBeforeRestart;
const policyFile=join(home,"owner","policy.json");
const policy=()=>JSON.parse(readFileSync(policyFile,"utf8"));
const configureSettings=async settings=>{
  const current=await rpc("workflow.status",{});
  return rpc("workflow.configure",{settings,expectedRevision:current.settingsRevision});
};
const legacySettings={...JSON.parse(readFileSync(join(pluginDir,"shared/presets/recommended.json"),"utf8")).roleWorkflow,maxTurns:73};
await mkdir(join(home,"role-workflow"),{recursive:true});
writeFileSync(join(home,"role-workflow","state.json"),JSON.stringify({version:1,revision:3,settings:legacySettings,workflows:[]}));
try {
  detached(process.execPath, [join(here, "fake-models.mjs"), String(modelPort), control, modelLog]);
  await startDaemon();
  const version = (await run(paseo, ["--version"])).stdout.trim();
  console.log(`paseo ${version}, root ${root}`);

  await step("plugin installs and becomes ready", async () => {
    const installed = await cli("plugin", "install", pluginDir);
    assert(installed.code === 0, `install failed: ${installed.stderr || installed.stdout}`);
    await waitFor("Plugin ready", async () => (await readyCount()) >= 1);
    assert(/role-workflow\s+running/.test((await cli("plugin", "ls")).stdout), "plugin is not running");
    const { settings } = await rpc("workflow.status", {});
    defaultSettings = structuredClone(settings);
    assert(settings.autoPinStarted && settings.autoPinPushed && settings.autoArchivePushed, "automatic pin and archive defaults must remain enabled");
  });

  await step("airport C26: codex-usage compiles and registers as a second plugin", async()=>{
    const result=await cli("plugin","install",resolve(here,"../plugin/codex-usage"));
    assert(result.code===0,result.stderr||result.stdout);
    await waitFor("codex usage plugin",async()=>{
      const rows=JSON.parse((await cli("plugin","ls","--json")).stdout);
      return rows.some(p=>p.id==="codex-usage"&&p.status==="running"&&!p.error);
    });
  });

  await step("airport C3: settings and notification migration records one source once", async()=>{
    const current=policy();
    assert(current.migratedFrom.stateSettingsSha256===createHash("sha256").update(JSON.stringify(legacySettings)).digest("hex"),"migration hash mismatch");
    assert(JSON.stringify(current.roleWorkflow)===JSON.stringify({maxTurns:73}),"migration did not store differences only");
    assert(current.notifications.phoneNotifications===false,"old notifications were not migrated");
    const before=readFileSync(policyFile,"utf8");
    await rpc("workflow.status",{});await rpc("workflow.status",{});
    assert(readFileSync(policyFile,"utf8")===before,"same migration input changed the policy");
    assert(JSON.stringify(state().settings)===JSON.stringify(legacySettings),"state settings changed during migration");
  });
  await step("airport C5: concurrent saves with one revision conflict instead of overwriting",async()=>{
    const current=await rpc("workflow.status",{});
    const attempts=await Promise.allSettled([74,75].map(maxTurns=>rpc("workflow.configure",{settings:{...current.settings,maxTurns},expectedRevision:current.settingsRevision})));
    assert(attempts.filter(r=>r.status==="fulfilled").length===1,"concurrent saves did not conflict");
    assert(policy().revision===current.settingsRevision+1,"revision advanced more than once");
    await configureSettings(defaultSettings);
    assert(JSON.stringify(state().settings)===JSON.stringify(legacySettings),"state settings did not freeze");
  });
  await step("airport C3: plugin remove and install preserve policy and migration marker",async()=>{
    const before=readFileSync(policyFile,"utf8");
    assert((await cli("plugin","remove","role-workflow")).code===0,"remove failed");
    assert(readFileSync(policyFile,"utf8")===before,"plugin remove deleted policy");
    assert((await cli("plugin","install",pluginDir)).code===0,"reinstall failed");
    await waitFor("reinstalled plugin",async()=>{try{return (await rpc("workflow.status",{})).settingsRevision!==null;}catch{return false;}});
    assert(readFileSync(policyFile,"utf8")===before,"reinstall remigrated policy");
  });
  await step("airport C2/C6: malformed policy reports its path and never accepts an overwrite",async()=>{
    const before=readFileSync(policyFile,"utf8");
    try {
      for(const broken of ["{broken",JSON.stringify({...JSON.parse(before),roleWorkflow:{maxTurns:0}})]) {
        writeFileSync(policyFile,broken);
        const status=await rpc("workflow.status",{});
        assert(status.error?.includes(policyFile),"policy error or path was hidden");
        let rejected=false;
        try {await rpc("workflow.configure",{settings:defaultSettings,expectedRevision:0});}catch{rejected=true;}
        assert(rejected,"save accepted after failed status");
        assert(readFileSync(policyFile,"utf8")===broken,"invalid policy was overwritten");
      }
    } finally {writeFileSync(policyFile,before);await rpc("workflow.status",{});}
  });

  await step("without overlap a federated executor opens in the planner workspace tab", async () => {
    writeFileSync(control, JSON.stringify({ mode: "role", scenario: "shared-tab",
      plan: [workflowBlock("plan", "탭에서 더미 구현")],
      execute: [workflowBlock("result", "탭 구현 완료")],
    }));
    try {
      const planner = await runAgent("연합개발로 진행해줘. 탭 배치 계획을 세워줘.");
      let flow = await waitFor("federated tab workflow", async () => state().workflows.find(w => w.plan?.id === planner && w.mode === "federated" && (w.selectionPlan || w.processed.length)));
      if (!flow.selectionPlan) {
        await cli("send", planner, "계획을 확정해줘.");
        flow = await waitFor("held tab plan", async () => state().workflows.find(w => w.id === flow.id && w.selectionPlan));
      }
      writeFileSync(control, JSON.stringify({ mode: "role", scenario: "shared-tab-review",
        plan: [workflowBlock("input", "e2e 확인 끝")], execute: [workflowBlock("result", "탭 구현 완료")],
      }));
      const { models } = await rpc("workflow.models", { provider: "claude" });
      const model = models.find(m => m.isDefault) ?? models[0];
      const thinking = model.thinkingOptions.find(o => o.isDefault)?.id ?? model.thinkingOptions[0]?.id ?? "";
      const selected = await rpc("workflow.select-executor", { id: flow.id, provider: "claude", model: model.id, thinking, holdId: flow.heldApproval?.id });
      assert(flow.contract === 6 && flow.heldApproval?.id > 0, "fresh flow did not hold a contract6 plan");
      assert(selected.ok, selected.detail);
      flow = await waitFor("shared executor tab", async () => state().workflows.find(w => w.id === flow.id && w.execute?.workspaceId), 60_000);
      assert(flow.isolation === "shared", `isolation ${flow.isolation}`);
      assert(flow.execute.workspaceId === flow.plan.workspaceId, "the executor opened in a separate workspace");
      assert(flow.worktree === null && flow.placement === null, "unexpected placement choice/worktree");
      const executorFile = await waitFor("tab executor agent file", async () => agentFile(flow.execute.id));
      assert(JSON.parse(readFileSync(executorFile, "utf8")).cwd === work, "tab executor cwd changed");
      await waitFor("tab review back to planner", async () => state().workflows.find(w => w.id === flow.id && w.lastResult && w.status === "needs_input"), 120_000);
    } finally {
      writeFileSync(control, JSON.stringify({ mode: "text", text: "2" }));
    }
  });

  await step("a question is answered and the conversation is enrolled with the injected prompt", async () => {
    questionAgent = await runAgent("1+1은? 숫자만 답하세요.");
    const saved = readFileSync(agentFile(questionAgent), "utf8");
    assert(saved.includes("paseo-work-mode-v4"), "work-mode block missing from the system prompt");
    assert(saved.includes("첫 응답 전에 질문 도구로 진행 방식을 단독 질문한다"), "the first-reply mode question is missing");
    const flow = await waitFor("enrollment", async () => state().workflows.find((w) => w.plan?.id === questionAgent));
    assert(flow.mode === "undecided", `expected undecided, got ${flow.mode}`);
    assert(readFileSync(modelLog, "utf8").includes("1+1은"), "the fake model never saw the prompt");
  });

  await step("a turn naming the mode is processed after it ends", async () => {
    generalAgent = await runAgent("일반개발로 진행해줘. 1+1은? 숫자만 답하세요.");
    await waitFor("general mode", async () => {
      const flow = state().workflows.find((w) => w.plan?.id === generalAgent);
      return flow?.mode === "general" && flow.processed.length > 0;
    });
  });

  await step("an agent's shell cannot git push; remote refs stay unchanged", async () => {
    const before = (await run("git", ["ls-remote", remote], { env })).stdout;
    writeFileSync(control, JSON.stringify({ mode: "tool", command: "git push origin HEAD:main", text: "push attempted" }));
    try {
      await runAgent("일반개발로 진행해줘. 원격에 푸시해줘.");
    } finally {
      writeFileSync(control, JSON.stringify({ mode: "text", text: "2" }));
    }
    const calls = readFileSync(modelLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert(calls.some((call) => call.callsTool), "the fake model never asked for the push");
    const results = calls.filter((call) => call.toolResult).map((call) => call.toolResult).join("\n");
    assert(/role-workflow-approval-required|role-workflow: 에이전트는 git push/.test(results), `push was not blocked: ${results.slice(0, 400)}`);
    assert((await run("git", ["ls-remote", remote], { env })).stdout === before, "the agent changed remote refs");
  });

  let worktreeFlow;
  let cleanupObservation;
  await step("a federated executor works in its own worktree of the same repository", async () => {
    writeFileSync(
      control,
      JSON.stringify({
        mode: "role", scenario: "overlap-worktree",
        plan: [workflowBlock("plan", "feature.txt를 추가한다")],
        execute: [workflowBlock("result", "구현 완료")],
      }),
    );
    try {
      const planner = await runAgent("연합개발로 진행해줘. feature.txt를 추가하는 계획을 세워줘.");
      let flow = await waitFor("federated workflow", async () => {
        const found = state().workflows.find((w) => w.plan?.id === planner);
        return found?.mode === "federated" && (found.selectionPlan || found.processed.length) ? found : null;
      });
      if (!flow.selectionPlan) {
        // The turn that names the mode only sets it; the next planner turn carries the plan.
        await cli("send", planner, "계획을 확정해줘.");
        flow = await waitFor("held plan", async () => {
          const found = state().workflows.find((w) => w.id === flow.id);
          return found?.selectionPlan ? found : null;
        });
      }
      writeFileSync(control, JSON.stringify({ mode: "role", scenario: "overlap-worktree-review",
        plan: [workflowBlock("input", "e2e 확인 끝")], execute: [workflowBlock("result", "구현 완료")],
      }));
      const { models } = await rpc("workflow.models", { provider: "claude" });
      const model = models.find((m) => m.isDefault) ?? models[0];
      assert(model, "no Claude model in the catalog");
      const thinking = model.thinkingOptions.find((o) => o.isDefault)?.id ?? model.thinkingOptions[0]?.id ?? "";
      const selected = await rpc("workflow.select-executor", { id: flow.id, provider: "claude", model: model.id, thinking, holdId: flow.heldApproval?.id });
      assert(selected.ok, `executor selection failed: ${selected.detail}`);
      flow = await waitFor("overlapping placement choice", async () => state().workflows.find(w => w.id === flow.id && w.placement?.stage === "choice"));
      assert(flow.isolation === "undecided" && !flow.execute.workspaceId, "executor started before the choice");
      const card = await waitFor("placement card in the timeline", async () => {
        const page = await createPaseoApi(client).agents.ref(planner).timeline.refetch({ direction: "tail", limit: 30 });
        return (page.entries ?? page.items ?? []).map(entry => entry.item ?? entry).find(item => item.type === "plugin" && item.kind === "placement-picker");
      });
      assert(card.data?.workflowId === flow.id, "placement card belongs to another task");
      assert(JSON.stringify(Object.keys(card.data).sort()) === JSON.stringify(["number", "title", "workflowId"]), "placement card leaked workflow fields");
      const placement = await rpc("workflow.select-placement", { id: flow.id, placement: "worktree" });
      assert(placement.ok, `placement failed: ${placement.detail}`);
      flow = await waitFor("executor in a worktree", async () => {
        const found = state().workflows.find((w) => w.id === flow.id);
        return found?.worktree && found.execute?.workspaceId ? found : null;
      }, 60_000);
      assert(flow.isolation === "worktree", `isolation ${flow.isolation}`);
      const worktrees = (await run("git", ["worktree", "list", "--porcelain"], { cwd: work })).stdout;
      assert(worktrees.includes(`worktree ${flow.worktree.path}`), `worktree missing:\n${worktrees}`);
      const common = async (cwd) =>
        (await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })).stdout.trim();
      assert((await common(flow.worktree.path)) === (await common(work)), "the worktree belongs to another repository");
      assert(/^role-workflow\//.test(flow.worktree.branch), `branch ${flow.worktree.branch}`);
      const executorFile = await waitFor("executor agent file", async () => agentFile(flow.execute.id));
      const executorCwd = JSON.parse(readFileSync(executorFile, "utf8")).cwd;
      assert(executorCwd === flow.worktree.path, `executor cwd ${executorCwd}`);
      await waitFor("review back to the planner", async () => {
        const found = state().workflows.find((w) => w.id === flow.id);
        // The executor's result was processed and the planner answered the review.
        return found?.lastResult && found.status === "needs_input" ? found : null;
      }, 120_000);
      worktreeFlow = state().workflows.find(w => w.id === flow.id);
    } finally {
      writeFileSync(control, JSON.stringify({ mode: "text", text: "2" }));
    }
  });

  const fixtureGit = async (cwd, args) => {
    const result = await run("git", args, { cwd, env });
    assert(result.code === 0, result.stderr);
    return result.stdout.trim();
  };
  const reportTarget = async (flow, commit) => {
    const targets = [{ repository: flow.worktree.path, remote: "origin", branch: await fixtureGit(work, ["branch", "--show-current"]), commit }];
    writeFileSync(control, JSON.stringify({ mode: "text", text: `푸시대상: ${JSON.stringify(targets)}\n${workflowBlock("note", "대상 기록")}` }));
    const result = await cli("send", flow.plan.id, "이 검증 대상 커밋을 기록해줘.");
    assert(result.code === 0, result.stderr);
    await waitFor("reported push target", async () => state().workflows.find(w => w.id === flow.id && w.pushTargets[0]?.commit === commit && !w.pending));
    await rpc("workflow.progress", { number: flow.number, project: work, progress: "done" });
  };
  await step("AC-12/AC-13/AC-301: base advancement blocks approval until the executor merges it", async () => {
    const flow = worktreeFlow;
    assert(flow?.worktree, "worktree scenario did not finish");
    try {
      const candidate = await fixtureGit(flow.worktree.path, ["rev-parse", "HEAD"]);
      const baseBranch = await fixtureGit(work, ["branch", "--show-current"]);
      await fixtureGit(work, ["update-ref", `refs/remotes/origin/${baseBranch}`, candidate]);
      await reportTarget(flow, candidate);
      const advanced = await run("git", ["-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "base advances before approval"], { cwd: work });
      assert(advanced.code === 0, advanced.stderr);
      const head = await fixtureGit(work, ["rev-parse", "HEAD"]);
      const before = await fixtureGit(work, ["show-ref"]);
      let blocked = false;
      try { await rpc("workflow.push-prepare", { id: flow.id }); }
      catch (error) { blocked = /기준 브랜치.*앞서 있어 먼저 합쳐야 합니다/.test(String(error)); }
      assert(blocked, "approval preparation accepted a commit missing the advanced base");
      await waitFor("base merge notice", async () => {
        const found = state().workflows.find(w => w.id === flow.id);
        return found?.worktreeMergeNotices.length === 1 && !found.managedPush && found;
      });
      assert(await fixtureGit(work, ["show-ref"]) === before, "approval gate wrote a Git ref");
      // The harness represents the executor performing its approved merge plan; the plugin never merges.
      const merged = await run("git", ["merge", "--ff-only", "--no-edit", head], { cwd: flow.worktree.path });
      assert(merged.code === 0, merged.stderr);
      await reportTarget(flow, await fixtureGit(flow.worktree.path, ["rev-parse", "HEAD"]));
      const prepared = await rpc("workflow.push-prepare", { id: flow.id });
      assert(prepared.state === "prepared" && prepared.targets[0].commit === head, "merged target was not prepared");
      assert((await run("git", ["ls-remote", remote])).stdout === "", "approval preparation wrote to the remote");
    } finally {
      writeFileSync(control, JSON.stringify({ mode: "text", text: "2" }));
    }
  });

  await step("AC-302/AC-304: default settings block approval and execution when another clone advances only the bare remote", async () => {
    const flow = state().workflows.find(w => w.id === worktreeFlow?.id);
    assert(flow?.worktree, "worktree scenario did not finish");
    const { settings } = await rpc("workflow.status", {});
    assert(JSON.stringify(settings) === JSON.stringify(defaultSettings), "remote advancement must run with all default settings");
    const branch = await fixtureGit(work, ["branch", "--show-current"]);
    const tracking = await fixtureGit(work, ["rev-parse", `refs/remotes/origin/${branch}`]);
    const candidate = flow.pushTargets[0].commit;
    const oldApproval = await rpc("workflow.push-prepare", { id: flow.id });
    const clone = join(root, "another-clone");
    await fixtureGit(root, ["clone", "-q", "--no-hardlinks", "--branch", branch, work, clone]);
    await fixtureGit(clone, ["remote", "set-url", "origin", remote]);
    await fixtureGit(clone, ["-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "another clone advances the remote"]);
    const ahead = await fixtureGit(clone, ["rev-parse", "HEAD"]);
    // This clone belongs to the isolated fixture and can write only its temporary local bare remote.
    assert(remote.startsWith(`${root}/`), "test remote must be inside the disposable fixture");
    await fixtureGit(clone, ["push", "-q", "origin", `${ahead}:refs/heads/${branch}`]);
    const before = await fixtureGit(work, ["show-ref"]);
    const notices = flow.worktreeMergeNotices.length;
    let executionBlocked = false;
    try { await rpc("workflow.push-execute", { id: flow.id, requestId: oldApproval.id, approved: true }); }
    catch (error) { executionBlocked = /원격 기준이 앞서/.test(String(error)); }
    assert(executionBlocked, "execution ignored the actual advanced remote tip");
    await waitFor("planner finishes remote merge notice", async () => {
      const current = state().workflows.find(w => w.id === flow.id);
      const { agent } = await createPaseoApi(client).agents.ref(flow.plan.id).refresh();
      return current?.worktreeMergeNotices.length === notices + 1 && !current.managedPush && agent.status === "idle" && !agent.activeTurn;
    });
    let preparationBlocked = false;
    try { await rpc("workflow.push-prepare", { id: flow.id }); }
    catch (error) { preparationBlocked = /원격 기준이 앞서/.test(String(error)); }
    assert(preparationBlocked, "preparation ignored the actual advanced remote tip");
    assert(state().workflows.find(w => w.id === flow.id).worktreeMergeNotices.length === notices + 1, "merge notice was repeated");
    assert(await fixtureGit(work, ["show-ref"]) === before, "plugin fetched or changed refs");
    assert(await fixtureGit(work, ["rev-parse", `refs/remotes/origin/${branch}`]) === tracking, "tracking ref did not stay stale");
    assert((await fixtureGit(root, ["ls-remote", remote, `refs/heads/${branch}`])).startsWith(ahead), "plugin changed the remote");
    try {
      // Planned executor work in the fixture; the plugin never fetches or merges.
      await fixtureGit(flow.worktree.path, ["fetch", "-q", "--no-write-fetch-head", remote, ahead]);
      await fixtureGit(flow.worktree.path, ["merge", "--ff-only", "--no-edit", ahead]);
      await reportTarget(flow, await fixtureGit(flow.worktree.path, ["rev-parse", "HEAD"]));
      const prepared = await rpc("workflow.push-prepare", { id: flow.id });
      assert(prepared.state === "prepared" && prepared.targets[0].commit === ahead, "included actual tip did not pass");
      writeFileSync(join(root, "remote-advance-observation.json"), JSON.stringify({ allDefaultSettings: true, candidate, remoteTip: ahead, tracking, executionBlocked, preparationBlocked, noticeCount: 1, preparedAfterMerge: prepared.state }, null, 2));
    } finally {
      writeFileSync(control, JSON.stringify({ mode: "text", text: "2" }));
    }
  });

  await step("a loosely named mode gets the card; choosing it continues the request as federated", async () => {
    writeFileSync(
      control,
      JSON.stringify({
        mode: "role", scenario: "mode-card",
        plan: ["무엇을 테스트할지 알려 주세요.", workflowBlock("plan", "더미 작업으로 흐름을 점검한다")],
      }),
    );
    try {
      const planner = await runAgent("연합개발 테스트");
      const flow = await waitFor("mode card", async () => {
        const found = state().workflows.find((w) => w.plan?.id === planner);
        return found?.modePickerPosted ? found : null;
      });
      assert(flow.mode === "undecided", `mode ${flow.mode} before the card`);
      await rpc("workflow.status", {});
      const card = await waitFor("mode card in the timeline", async () => {
        const page = await createPaseoApi(client).agents.ref(planner).timeline.refetch({ direction: "tail", limit: 20 });
        return (page.entries ?? page.items ?? []).map((entry) => entry.item ?? entry).find((item) => item.type === "plugin" && item.kind === "mode-picker");
      });
      assert(card.data?.workflowId === flow.id, `card for ${card.data?.workflowId}`);
      const chosen = await rpc("workflow.select-mode", { id: flow.id, mode: "federated" });
      assert(chosen.ok, `select-mode failed: ${chosen.detail}`);
      await waitFor("plan after the mode notice", async () => {
        const found = state().workflows.find((w) => w.id === flow.id);
        return found?.mode === "federated" && found.selectionPlan ? found : null;
      }, 120_000);
      const calls = readFileSync(modelLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert(calls.some((call) => call.last.includes("진행 방식: 연합개발 (사용자가 화면에서 선택)")), "the planner never got the mode notice");
    } finally {
      writeFileSync(control, JSON.stringify({ mode: "text", text: "2" }));
    }
  });

  await step("codex: a question is enrolled with the injected instructions", async () => {
    const agent = await runAgent("1+1은? 숫자만 답하세요.", "codex");
    const saved = readFileSync(agentFile(agent), "utf8");
    assert(saved.includes("paseo-work-mode-v4"), "work-mode block missing from the Codex system prompt");
    await waitFor("codex enrollment", async () => state().workflows.find((w) => w.plan?.id === agent));
    const calls = readFileSync(modelLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const codex = calls.filter((call) => call.api === "responses");
    assert(codex.length > 0, "Codex never called the fake model");
    assert(codex.some((call) => call.instructions.includes("paseo-work-mode-v4")), "the instructions did not reach the model");
  });

  await step("codex: the agent's shell cannot git push; remote refs stay unchanged", async () => {
    const before = (await run("git", ["ls-remote", remote], { env })).stdout;
    writeFileSync(control, JSON.stringify({ mode: "tool", command: "git push origin HEAD:main", text: "push attempted" }));
    try {
      await runAgent("일반개발로 진행해줘. 원격에 푸시해줘.", "codex");
    } finally {
      writeFileSync(control, JSON.stringify({ mode: "text", text: "2" }));
    }
    const calls = readFileSync(modelLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const codex = calls.filter((call) => call.api === "responses");
    assert(codex.some((call) => call.callsTool), `the fake model found no shell tool: ${JSON.stringify(codex.at(-1)?.tools)}`);
    const results = codex.filter((call) => call.toolResult).map((call) => call.toolResult).join("\n");
    assert(/role-workflow-approval-required|role-workflow: 에이전트는 git push/.test(results), `push was not blocked: ${results.slice(0, 400)}`);
    assert((await run("git", ["ls-remote", remote], { env })).stdout === before, "the agent changed remote refs");
  });

  await step("AC-107/B-1/R-2 [archiveAfterDays=0]: manual archive preserves an unfinished dirty worktree and its planner", async () => {
    const flow = state().workflows.find(w => w.id === worktreeFlow?.id);
    assert(flow?.worktree && flow.progress === "done", "worktree fixture is not ready for archive preview");
    const { settings } = await rpc("workflow.status", {});
    const dirty = join(flow.worktree.path, "must-preserve.txt");
    writeFileSync(dirty, "uncommitted fixture data\n");
    try {
      await configureSettings({ ...settings, archiveAfterDays: 0 });
      const preview = await rpc("workflow.archive-finished", { apply: false, ids: [] });
      assert(!preview.rows.some(row => row.id === flow.id), "dirty worktree became an archive candidate");
      assert(preview.blocked.some(row => row.id === flow.id && row.reason === "푸시 전 작업의 따로 작업 공간은 자동 정리하지 않습니다. 필요하면 커밋을 확인한 뒤 Paseo에서 직접 보관하세요(무시된 파일과 커밋하지 않은 파일은 지워집니다)."), "archive screen has no preservation reason");
      const result = await rpc("workflow.archive-finished", { apply: true, ids: [flow.id] });
      assert(!result.archivedIds.includes(flow.id), "unfinished worktree was archived");
      const api = createPaseoApi(client);
      assert(!(await api.agents.ref(flow.plan.id).refresh()).agent.archivedAt, "planner was archived");
      assert(!(await api.agents.ref(flow.execute.id).refresh()).agent.archivedAt, "executor was archived");
      assert(readFileSync(dirty, "utf8") === "uncommitted fixture data\n", "DATA LOSS RISK: dirty file disappeared");
    } finally {
      await rm(dirty, { force: true });
      await configureSettings(settings);
    }
  });

  await step("AC-203/AC-207: all default settings and pins keep the planner while approved local push archives the clean executor workspace", async () => {
    const flow = state().workflows.find(w => w.id === worktreeFlow?.id);
    assert(flow?.worktree, "worktree scenario did not finish");
    const { settings } = await rpc("workflow.status", {});
    assert(JSON.stringify(settings) === JSON.stringify(defaultSettings), "AC-203 requires every setting to keep its initial default");
    assert(settings.autoArchivePushed && settings.autoArchiveWorktree, "default archive settings must remain enabled");
    assert(settings.autoPinStarted && settings.autoPinPushed, "AC-108 must run with default automatic pin settings");
    const common = (await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: work })).stdout.trim();
    appendFileSync(join(common, "info", "exclude"), "\nevidence/\n");
    await mkdir(join(flow.worktree.path, "evidence"), { recursive: true });
    writeFileSync(join(flow.worktree.path, "evidence", "cleanup.log"), "fixture evidence must survive archive\n");
    writeFileSync(join(flow.worktree.path, "cleanup-feature.txt"), "committed code must survive archive\n");
    const added = await run("git", ["add", "cleanup-feature.txt"], { cwd: flow.worktree.path });
    assert(added.code === 0, added.stderr);
    const committed = await run("git", ["-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "fixture implementation ready for cleanup"], { cwd: flow.worktree.path });
    assert(committed.code === 0, committed.stderr);
    const newCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: flow.worktree.path })).stdout.trim();
    const cleanupTargets = [{ ...flow.pushTargets[0], commit: newCommit }];
    const verdict = join(root, "fixture-verdict.md");
    writeFileSync(verdict, "fixture only: 완료 / 단일 모델\n");
    writeFileSync(control, JSON.stringify({ mode: "text", text: `푸시대상: ${JSON.stringify(cleanupTargets)}\n<paseo-workflow>${JSON.stringify({ status: "complete", summary: "fixture ready", next: "", handoff: "fixture", checks: [], verdict: { path: verdict, judgement: "완료", condition: "단일 모델" } })}</paseo-workflow>` }));
    try {
      const completed = await cli("send", flow.plan.id, "이 fixture의 검증을 끝내고 푸시 승인을 기다려줘.");
      assert(completed.code === 0, completed.stderr);
      await waitFor("settled fixture review", async () => state().workflows.find(w => w.id === flow.id && w.status === "completed" && !w.asker && !w.pending && !w.inbox));
      const prepared = await rpc("workflow.push-prepare", { id: flow.id });
      // Test-only approval for the isolated local bare remote, never a user's repository.
      const result = await rpc("workflow.push-execute", { id: flow.id, requestId: prepared.id, approved: true });
      assert(result.state === "pushed", `fixture push failed: ${result.error}`);
      const cleaned = await waitFor("worktree cleanup done", async () => {
        const w = state().workflows.find(w => w.id === flow.id);
        if (w?.worktreeCleanup?.stage === "skipped") throw new Error(w.worktreeCleanup.detail);
        return w?.worktreeCleanup?.stage === "done" ? w : null;
      }, 60_000);
      assert(cleaned.integration?.ok, "planner checkout was not integrated");
      assert(readFileSync(join(work, "cleanup-feature.txt"), "utf8") === "committed code must survive archive\n", "DATA LOSS RISK: implementation is missing from planner checkout");
      const api = createPaseoApi(client);
      const plan = (await api.agents.ref(flow.plan.id).refresh()).agent;
      const executor = (await api.agents.ref(flow.execute.id).refresh()).agent;
      const spaces = await api.workspaces.list({ page: { limit: 200 } });
      assert(spaces.entries.find(ws => ws.id === flow.plan.workspaceId)?.pinnedAt, "planner workspace lost its default automatic pin");
      assert(cleaned.startPin?.workspaces.every(row => row.id !== flow.worktree.workspaceId), "executor entered the start pin targets");
      assert(cleaned.pushReview?.workspaces.every(row => row.id !== flow.worktree.workspaceId), "executor entered the push review pin targets");
      assert(!plan.archivedAt, "planner conversation was archived");
      assert(executor.archivedAt, "executor conversation is not archived");
      assert(spaces.entries.some(ws => ws.id === flow.plan.workspaceId), "planner workspace disappeared");
      assert(!spaces.entries.some(ws => ws.id === flow.worktree.workspaceId), "executor workspace is still in the sidebar directory");
      const copied = join(home, "role-workflow", "evidence", flow.id, "worktree", flow.worktree.workspaceId, "cleanup.log");
      assert(readFileSync(copied, "utf8") === "fixture evidence must survive archive\n", "evidence was not preserved");
      const branch = await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${flow.worktree.branch}`], { cwd: work });
      assert(branch.code === 0 || branch.code === 1, "could not observe the branch after archive");
      const included = await run("git", ["merge-base", "--is-ancestor", cleaned.integration.commit, "HEAD"], { cwd: work });
      assert(included.code === 0, "DATA LOSS RISK: integrated commit is missing from planner checkout");
      cleanupObservation = { allDefaultSettings: JSON.stringify(settings) === JSON.stringify(defaultSettings), autoArchivePushed: settings.autoArchivePushed, autoArchiveWorktree: settings.autoArchiveWorktree, autoPinStarted: settings.autoPinStarted, autoPinPushed: settings.autoPinPushed, plannerPinned: !!spaces.entries.find(ws => ws.id === flow.plan.workspaceId)?.pinnedAt, workflowId: flow.id, workspaceId: flow.worktree.workspaceId, directoryExists: existsSync(flow.worktree.path), branchExists: branch.code === 0, executorArchived: !!executor.archivedAt, plannerArchived: !!plan.archivedAt, evidenceFiles: cleaned.worktreeCleanup.evidenceFiles, attempts: cleaned.worktreeCleanup.attempts, at: cleaned.worktreeCleanup.at, integratedCommit: cleaned.integration.commit, workspaceRestoreApi: "not exposed by 0.15 public API; archived agent record remains readable" };
      writeFileSync(join(root, "worktree-cleanup-observation.json"), JSON.stringify(cleanupObservation, null, 2));
      console.log(`observation ${JSON.stringify(cleanupObservation)}`);
    } finally {
      writeFileSync(control, JSON.stringify({ mode: "text", text: "2" }));
    }
  });

  await step("AC-4/5/15/23: brainstorm, exact chat choice, held plan card and real timeline identities", async () => {
    // Compile the actual client decision parser/hash and server read helper; don't duplicate them.
    const helperFile = join(root, "brainstorm-helpers.mjs");
    await build({ stdin: { contents: `export { parseDecision } from "./shared/decision"; export { decisionHash } from "./shared/plan-approval"; export { pickerCardPresence } from "./server/timeline-cards";`, resolveDir: pluginDir }, bundle: true, platform: "node", format: "esm", outfile: helperFile });
    const { parseDecision, decisionHash, pickerCardPresence } = await import(pathToFileURL(helperFile).href);
    writeFileSync(control, JSON.stringify({ mode: "role", scenario: "brainstorm-discussion", plan: [workflowBlock("note", "")] }));
    try {
      const planner = await runAgent("브레인스토밍");
      let flow = await waitFor("brainstorm flag", async () => state().workflows.find(w => w.plan?.id === planner && w.brainstorm));
      assert(flow.contract === 6 && flow.mode === "undecided", "brainstorm changed the persisted mode");
      await rpc("workflow.status", {});
      const api = createPaseoApi(client);
      const timeline = async () => (await api.agents.ref(planner).timeline.refetch({ direction: "tail", limit: 200 })).entries.map(e => e.item);
      assert(!(await timeline()).some(i => i.type === "plugin" && ["mode-picker", "executor-picker"].includes(i.kind)), "brainstorm posted a picker");
      await cli("send", planner, "연합개발");
      flow = await waitFor("brainstorm to federation", async () => state().workflows.find(w => w.id === flow.id && w.mode === "federated"));
      assert(flow.plan.id === planner && !flow.execute && !flow.heldApproval, "federation started an executor before a plan");
      assert(!(await timeline()).some(i => i.type === "plugin" && i.kind === "executor-picker"), "federation posted a premature executor picker");
      writeFileSync(control, JSON.stringify({ mode: "role", scenario: "brainstorm-plan", plan: [workflowBlock("plan", "확인한 보관 계획을 구현한다")] }));
      await cli("send", planner, "계획을 확정해줘.");
      flow = await waitFor("held plan and posted marker", async () => state().workflows.find(w => w.id === flow.id && w.heldApproval && w.pickerPostedFor === w.heldApproval.id));
      const expectedId = `role-workflow-executor-picker:${flow.id}:${flow.heldApproval.id}`;
      let items = await timeline();
      const cards = items.filter(i => i.type === "plugin" && i.kind === "executor-picker");
      assert(cards.length === 1 && cards[0].id === expectedId, "daemon timeline did not return the posted PluginTimelineItem.id");
      const message = items.findLast(i => { if (i.type !== "assistant_message") return false; try { return decisionHash(parseDecision(i.text)) === flow.heldApproval.decisionHash; } catch { return false; } });
      assert(message, "client message hash differs from server inbox hash");
      assert(await pickerCardPresence(api, planner, expectedId, flow.heldApproval.decisionHash) === "present", "read-before-post did not find the real card");
      const reload = await cli("plugin", "reload", "role-workflow");
      assert(reload.code === 0, reload.stderr);
      await waitFor("plugin reloaded", async () => { const r = await rpc("workflow.status", {}); return r.workflows.some(w => w.id === flow.id && w.heldApproval?.id === flow.heldApproval.id); });
      items = await timeline();
      assert(items.filter(i => i.type === "plugin" && i.id === expectedId).length === 1, "reload duplicated the held picker");
      assert(!state().workflows.find(w => w.id === flow.id).execute, "reload dispatched an unapproved plan");
      writeFileSync(join(root, "brainstorm-identities.json"), JSON.stringify({ workflowId: flow.id, hold: flow.heldApproval, card: cards[0], clientDecisionHash: decisionHash(parseDecision(message.text)), serverDecisionHash: flow.heldApproval.decisionHash, presence: "present", cardsAfterReload: 1 }, null, 2));
      writeFileSync(control, JSON.stringify({ mode: "role", scenario: "brainstorm-general", plan: [workflowBlock("note", "")] }));
      const general = await runAgent("브레인스토밍");
      await cli("send", general, "일반개발");
      const direct = await waitFor("brainstorm to general", async () => state().workflows.find(w => w.plan?.id === general && w.mode === "general"));
      assert(!direct.execute && direct.plan.id === general, "general mode created a second conversation");
    } finally { writeFileSync(control, JSON.stringify({ mode: "text", text: "2" })); }
  });

  await step("state and plugin survive a daemon restart", async () => {
    const flows = state().workflows.length;
    policyBeforeRestart=readFileSync(policyFile,"utf8");
    await client?.close().catch(() => {});
    client = null;
    await stop(daemon);
    await startDaemon();
    // Plugin logs belong to one daemon run, so a fresh "Plugin ready" proves the reload.
    await waitFor("Plugin ready after restart", async () => (await readyCount()) >= 1);
    assert(/role-workflow\s+running/.test((await cli("plugin", "ls")).stdout), "plugin is not running");
    assert(state().workflows.length === flows, "workflows changed across the restart");
    const flow = state().workflows.find((w) => w.plan?.id === generalAgent);
    assert(flow?.mode === "general", "general mode was not kept");
    if (cleanupObservation) {
      const cleaned = state().workflows.find(w => w.id === cleanupObservation.workflowId);
      assert(cleaned?.worktreeCleanup?.stage === "done", "cleanup completion was lost on restart");
      assert(cleaned.worktreeCleanup.attempts === cleanupObservation.attempts && cleaned.worktreeCleanup.at === cleanupObservation.at, "restart attempted cleanup again");
    }
  });

  await step("airport C3/C4: daemon restart keeps policy and does not repeat migration",async()=>{
    assert(readFileSync(policyFile,"utf8")===policyBeforeRestart,"policy changed on daemon restart");
    assert(JSON.stringify(state().settings)===JSON.stringify(legacySettings),"frozen rollback snapshot changed on restart");
  });

  await step("the plugin logged no errors", async () => {
    const logs = (await cli("plugin", "logs", "role-workflow")).stdout + (await cli("plugin", "logs", "codex-usage")).stdout;
    const errors = logs.split("\n").filter((line) => /\bstderr\b|role-workflow:/.test(line));
    assert(errors.length === 0, errors.join("\n").slice(0, 800));
  });
} finally {
  await client?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child);
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(join(root, "results.json"), JSON.stringify({ paseo, results }, null, 2));
  console.log(`${results.length - failed}/${results.length} passed`);
  if (failed || keep) console.log(`kept ${root}`);
  else await rm(root, { recursive: true, force: true });
  process.exitCode = failed || results.length === 0 ? 1 : 0;
}
if (!existsSync(paseo)) console.error(`Paseo CLI not found: ${paseo}`);
