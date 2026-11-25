import { isolateOwnerHome, configureFixture } from "./owner-fixture.mjs";
import { gitTestEnvironment } from "./git-test-environment.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import contribute from "../index.server.ts";
import { settingsSchema, status } from "../shared/contracts.ts";
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
  const plain = gitTestEnvironment({ ...process.env, HOME: home }, { GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") });
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

async function hooks(t, settings, installationDirectory) {
  const dir = await directory(t, "push-guard-hook-");
  const previous = process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;
  process.env.PASEO_ROLE_WORKFLOW_STATE_DIR = dir;
  isolateOwnerHome(t, dir);
  await mkdir(process.env.PASEO_HOME, { recursive: true });
  await writeFile(path.join(process.env.PASEO_HOME, "config.json"), JSON.stringify({
    plugins: { "role-workflow": { source: "directory", path: installationDirectory ?? dir } },
  }));
  const registered = new Map(),
    rpcs = new Map(),
    responses = [];
  const context = {
    paseo: {
      agents: {
        ref: (id) => ({
          respondToPermission: async (input) => responses.push(structuredClone({ id, input })),
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
  await configureFixture(rpcs, context, settingsSchema.parse({ autoStart: false, ...settings }));
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
  return { dir, open, permission, responses, status: () => rpcs.get(status.name)({}, context) };
}

test("AT-RG-01–02c: real Git blocks RUN ref changes and permits fetch and development writes", async (t) => {
  const dir = await realpath(await directory(t));
  const seed = path.join(dir, "seed");
  const origin = path.join(dir, "origin.git");
  const runtime = path.join(dir, "RUN [with space]");
  const plain = gitTestEnvironment(process.env, {
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  });
  const git = (cwd, args, env = plain) => run("git", args, { cwd, env });
  await git(dir, ["init", "-q", "-b", "main", seed]);
  await writeFile(path.join(seed, "tracked"), "first\n");
  await git(seed, ["add", "tracked"]);
  await git(seed, ["commit", "-qm", "first"]);
  await git(seed, ["commit", "-q", "--allow-empty", "-m", "second"]);
  await git(dir, ["clone", "-q", "--bare", seed, origin]);
  await git(dir, ["clone", "-q", origin, runtime]);
  await writeFile(path.join(seed, "tracked"), "upstream\n");
  await git(seed, ["commit", "-qam", "upstream"]);
  await git(origin, ["fetch", "-q", seed, "main:main"]);
  const head = (await git(runtime, ["rev-parse", "HEAD"])).stdout.trim();
  const upstream = (await git(seed, ["rev-parse", "HEAD"])).stdout.trim();
  const guarded = { ...plain, ...await pushGuardEnv(path.join(dir, "state"), {}, plain, { runtimeRoot: runtime }) };
  const snapshot = () => git(runtime, ["show-ref", "--head"]).then(({ stdout }) => stdout);
  const denied = (cwd, args) => assert.rejects(git(cwd, args, guarded), (error) => {
    assert.ok(Number.isInteger(error.code) && error.code !== 0);
    assert.match(error.stderr, /운영 사본.*개발 원본.*자동 업데이트/);
    return true;
  });

  await t.test("AT-RG-01b: fetch advances the tracking ref", async () => {
    await git(runtime, ["fetch", "origin"], guarded);
    assert.equal((await git(runtime, ["rev-parse", "refs/remotes/origin/main"])).stdout.trim(), upstream);
  });
  await t.test("AT-RG-01d: fetch with a new tag fails and explains how to fetch without tags", async () => {
    await git(seed, ["commit", "--allow-empty", "-m", "release"]);
    await git(origin, ["fetch", "-q", "--no-tags", seed, "main:main"]);
    const release = (await git(origin, ["rev-parse", "main"])).stdout.trim();
    await git(origin, ["tag", "v1", release]);
    const before = await snapshot();

    await assert.rejects(git(runtime, ["fetch", "origin"], guarded), (error) => {
      assert.ok(Number.isInteger(error.code) && error.code !== 0);
      assert.match(error.stderr, /git fetch --no-tags/);
      return true;
    });
    assert.equal(await snapshot(), before);

    await git(runtime, ["fetch", "--no-tags", "origin"], guarded);
    assert.equal((await git(runtime, ["rev-parse", "refs/remotes/origin/main"])).stdout.trim(), release);
    assert.equal((await git(runtime, ["for-each-ref", "refs/tags"])).stdout, "");
  });
  await t.test("AT-RG-01: all prescribed writes fail and leave refs unchanged", async () => {
    const before = await snapshot();
    for (const args of [
      ["commit", "--allow-empty", "--no-verify", "-m", "blocked"],
      ["merge", "--ff-only", "origin/main"],
      ["reset", "--soft", "HEAD~1"],
      ["branch", "x"],
      ["worktree", "add", "-b", "y", path.join(dir, "blocked-tree")],
      ["tag", "t"],
      ["stash"],
      ["update-ref", "refs/heads/z", "HEAD"],
    ]) {
      if (args[0] === "stash") await writeFile(path.join(runtime, "tracked"), "dirty\n");
      await denied(runtime, args);
      assert.equal(await snapshot(), before, args.join(" "));
      // Some Git commands edit worktree files before attempting the ref transaction.
      await git(runtime, ["reset", "--hard", head]);
    }
  });
  await t.test("AT-RG-01c: attached and detached worktrees reject commits", async () => {
    for (const [name, options] of [["attached", ["-b", "attached"]], ["detached", ["--detach"]]]) {
      const tree = path.join(dir, name);
      await git(runtime, ["worktree", "add", ...options, tree]);
      await denied(tree, ["commit", "--allow-empty", "-m", "blocked"]);
      assert.equal((await git(tree, ["rev-parse", "HEAD"])).stdout.trim(), head);
    }
  });
  await t.test("AT-RG-02: development merge and commit succeed", async () => {
    const dev = path.join(dir, "development");
    await git(dir, ["clone", "-q", origin, dev]);
    await git(dev, ["reset", "--hard", head]);
    await git(dev, ["merge", "--ff-only", "origin/main"], guarded);
    await git(dev, ["commit", "--allow-empty", "-m", "development"], guarded);
  });
  await t.test("AT-RG-02c: the symlink has the same guard", async () => {
    const link = path.join(dir, "run-link");
    await symlink(runtime, link);
    await denied(dir, ["-C", link, "branch", "blocked-link"]);
  });
  await t.test("AT-RG-02b: the same RUN permits an unguarded commit", async () => {
    const { GIT_CONFIG_GLOBAL: _config, ...unguarded } = plain;
    await git(runtime, ["commit", "--allow-empty", "-m", "unguarded"], unguarded);
  });
});

test("AT-RG-03: an actual Git installation gets the runtime guard independently of push", async (t) => {
  const dir = await realpath(await directory(t));
  await run("git", ["init", "-q", "-b", "main", dir], { env: gitTestEnvironment() });
  const plugin = path.join(dir, "plugin", "role-workflow");
  await mkdir(plugin, { recursive: true });
  for (const shellPushGuard of [false, true]) {
    const fixture = await hooks(t, { shellPushGuard }, plugin);
    for (const provider of ["claude", "codex"]) {
      const request = await fixture.open(provider);
      const file = await readFile(request.env.GIT_CONFIG_GLOBAL, "utf8");
      assert.equal(file.includes("pushInsteadOf"), shellPushGuard);
      assert.ok(file.includes(`[includeIf "gitdir/i:${dir}/"]`));
      const git = await run("git", ["config", "--get", "core.hooksPath"], {
        cwd: dir, env: gitTestEnvironment(process.env, request.env),
      });
      assert.equal(git.stdout.trim(), path.join(fixture.dir, "run-guard", "hooks"));
    }
  }
  const noGit = await hooks(t, {});
  const request = await noGit.open("claude");
  const file = await readFile(request.env.GIT_CONFIG_GLOBAL, "utf8");
  assert.ok(file.includes("pushInsteadOf"));
  assert.ok(!file.includes("includeIf"));
  const installed = await hooks(t, {}, plugin);
  assert.deepEqual((await installed.status()).runtimeCopy, {
    state: "unknown", root: dir, branch: null, dirty: 0, ahead: 0, worktrees: 0, reasons: [],
  });
  assert.equal((await noGit.status()).runtimeCopy.root, null);
});

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
    { id: "A", input: { requestId: "perm-1", response: { behavior: "deny", message: PUSH_DENIED_MESSAGE } } },
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
