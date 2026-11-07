import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import contribute from "../index.server.ts";
import { settingsSchema } from "../shared/contracts.ts";
import {
  originalGlobalConfigs,
  permissionCommands,
  PUSH_DENIED_MESSAGE,
  PUSH_GUARD_SCHEME,
  pushGuardEnv,
  runsGitPush,
} from "../server/push-guard.ts";

const run = promisify(execFile);
async function directory(t, prefix = "push-guard-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("shell commands that run git push are recognized, quoted text and other subcommands are not", () => {
  for (const command of [
    "git push origin HEAD:main",
    "git -C '/repo with space' push origin abc:refs/heads/main",
    'git -C "/repo" -c core.sshCommand=ssh push',
    "cd /repo && git push --force",
    "/usr/bin/git --git-dir=/repo/.git push",
    "git status; git push",
    "bash -lc git push",
    "echo $(git push)",
  ])
    assert.equal(runsGitPush(command), true, command);
  for (const command of [
    'git commit -m "push the fix"',
    "git log --grep push",
    "git stash push",
    "git ls-remote origin refs/heads/main",
    "git merge-base --is-ancestor a origin/main",
    "gh pr create",
    "npm run push",
  ])
    assert.equal(runsGitPush(command), false, command);
});

test("permission inputs expose Claude and Codex shell commands", () => {
  assert.deepEqual(permissionCommands({ command: "git push" }), ["git push"]);
  assert.deepEqual(permissionCommands({ cmd: ["bash", "-lc", "git push"] }), ["bash -lc git push"]);
  assert.deepEqual(permissionCommands({ file_path: "/x" }), []);
  assert.deepEqual(permissionCommands(undefined), []);
});

test("the guard keeps the user's global config, in Git's order, or an explicit GIT_CONFIG_GLOBAL", () => {
  const guard = "/state/push-guard.gitconfig";
  assert.deepEqual(originalGlobalConfigs({ HOME: "/h" }, guard), ["/h/.config/git/config", "/h/.gitconfig"]);
  assert.deepEqual(originalGlobalConfigs({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, guard), ["/x/git/config", "/h/.gitconfig"]);
  assert.deepEqual(originalGlobalConfigs({ HOME: "/h", GIT_CONFIG_GLOBAL: "/custom" }, guard), ["/custom"]);
  assert.deepEqual(originalGlobalConfigs({ HOME: "/h", GIT_CONFIG_GLOBAL: guard }, guard), []);
});

test("a guarded shell cannot push to any remote while fetch and the user's config still work", async (t) => {
  const dir = await directory(t);
  const home = path.join(dir, "home");
  await mkdir(home);
  await writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = Guarded User\n\temail = guard@example.invalid\n");
  const remote = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  const plain = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  delete plain.GIT_CONFIG_GLOBAL;
  await run("git", ["init", "-q", "--bare", remote], { env: plain });
  await run("git", ["clone", "-q", remote, work], { env: plain });
  await run("git", ["commit", "-q", "--allow-empty", "-m", "first"], { cwd: work, env: plain });

  const env = await pushGuardEnv(path.join(dir, "state"), {}, plain);
  const guarded = { ...plain, ...env };
  assert.equal(env.GIT_CONFIG_GLOBAL, path.join(dir, "state", "push-guard.gitconfig"));
  assert.match(await readFile(env.GIT_CONFIG_GLOBAL, "utf8"), new RegExp(`${PUSH_GUARD_SCHEME}://`));
  assert.equal((await run("git", ["config", "user.name"], { cwd: work, env: guarded })).stdout.trim(), "Guarded User");

  for (const args of [["push", "origin", "HEAD:main"], ["push", remote, "HEAD:main"]]) {
    const failed = await run("git", args, { cwd: work, env: guarded }).then(
      () => null,
      (error) => error,
    );
    assert.ok(failed, `git ${args.join(" ")} must fail`);
    assert.match(failed.stderr, new RegExp(PUSH_GUARD_SCHEME));
  }
  assert.equal((await run("git", ["ls-remote", remote], { env: plain })).stdout, "", "nothing reached the remote");
  await run("git", ["fetch", "-q", "origin"], { cwd: work, env: guarded });
  await run("git", ["push", "-q", "origin", "HEAD:main"], { cwd: work, env: plain });
  assert.notEqual((await run("git", ["ls-remote", remote], { env: plain })).stdout, "", "the unguarded push still works");
});

async function hooks(t, settings) {
  const dir = await directory(t, "push-guard-hook-");
  const previous = process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
  process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = dir;
  const registered = new Map(),
    rpcs = new Map(),
    responses = [];
  const context = {
    paseo: {
      agents: {
        ref: (id) => ({
          respondToPermission: async (input) => responses.push({ id, ...input }),
          refresh: async () => null,
        }),
      },
    },
  };
  const close = contribute({
    addHook: (name, fn) => {
      registered.set(name, fn);
      return () => {};
    },
    handle: (contract, fn) => rpcs.set(contract.name, fn),
  });
  t.after(async () => {
    await close();
    if (previous === undefined) delete process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
    else process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = previous;
  });
  await rpcs.get("workflow.configure")(settingsSchema.parse({ autoStart: false, ...settings }), context);
  const open = (provider) =>
    registered.get("agent.open.before")(
      { request: { agentId: "A", provider, reason: "resume", env: { KEEP: "1" } } },
      context,
    );
  const permission = (input) =>
    registered.get("agent.permission.before")(
      { agent: { id: "A" }, request: { id: "perm-1", kind: "tool", name: "Bash", input } },
      context,
    );
  return { dir, open, permission, responses };
}

test("agent sessions open with the push guard by default and without it when the setting is off", async (t) => {
  const on = await hooks(t, {});
  for (const provider of ["claude", "codex"]) {
    const request = await on.open(provider);
    assert.equal(request.env.KEEP, "1");
    assert.equal(request.env.GIT_CONFIG_GLOBAL, path.join(on.dir, "push-guard.gitconfig"));
  }
  assert.equal((await on.open("opencode")).env.GIT_CONFIG_GLOBAL, undefined);
  const off = await hooks(t, { shellPushGuard: false });
  assert.equal((await off.open("claude")).env.GIT_CONFIG_GLOBAL, undefined);
});

test("a git push permission request is denied while other commands are left to the user", async (t) => {
  const on = await hooks(t, {});
  await on.permission({ command: "git -C /repo push origin abc:refs/heads/main" });
  assert.deepEqual(on.responses, [
    { id: "A", requestId: "perm-1", response: { behavior: "deny", message: PUSH_DENIED_MESSAGE } },
  ]);
  await on.permission({ command: "git status" });
  assert.equal(on.responses.length, 1);
  const off = await hooks(t, { shellPushGuard: false });
  await off.permission({ command: "git push" });
  assert.deepEqual(off.responses, []);
});

test("sessions opening at the same moment all get the guard", async (t) => {
  const dir = await directory(t);
  const state = path.join(dir, "state");
  // Different user configs force every call to rewrite the file concurrently.
  const results = await Promise.all(
    Array.from({ length: 24 }, (_, i) => pushGuardEnv(state, {}, { HOME: path.join(dir, `home-${i % 3}`) })),
  );
  for (const env of results) assert.equal(env.GIT_CONFIG_GLOBAL, path.join(state, "push-guard.gitconfig"));
  assert.match(await readFile(path.join(state, "push-guard.gitconfig"), "utf8"), new RegExp(PUSH_GUARD_SCHEME));
});
