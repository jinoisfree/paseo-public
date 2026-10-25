import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedPushRunner } from "../server/managed-push.ts";

const execute = promisify(execFile);
async function git(cwd, args) {
  try {
    const result = await execute("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      exitCode: typeof error.code === "number" ? error.code : null,
    };
  }
}
async function checked(cwd, args) {
  const result = await git(cwd, args);
  assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "managed-push-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const records = path.join(root, "records");
  await mkdir(repository);
  await checked(root, ["init", "--bare", "-q", remote]);
  await checked(repository, ["init", "-q", "--initial-branch=main"]);
  await checked(repository, ["config", "user.name", "Managed Push Test"]);
  await checked(repository, ["config", "user.email", "managed-push@example.invalid"]);
  await checked(repository, ["remote", "add", "origin", remote]);
  let sequence = 0;
  const commit = async () => {
    await writeFile(path.join(repository, "file.txt"), `revision ${++sequence}\n`);
    await checked(repository, ["add", "file.txt"]);
    await checked(repository, ["commit", "-qm", `revision ${sequence}`]);
    return checked(repository, ["rev-parse", "HEAD"]);
  };
  const hash = await commit();
  const target = { repository, remote: "origin", branch: "main", commit: hash };
  const calls = [];
  const driver = async (cwd, args) => {
    calls.push({ cwd, args });
    return git(cwd, args);
  };
  const runner = new ManagedPushRunner(records, driver);
  return { root, repository, remote, records, hash, target, commit, calls, driver, runner };
}
const pushes = (calls) => calls.filter((call) => call.args.includes("push"));
const recordPath = (f, id) => path.join(f.records, id, "record.json");
async function replaceRecord(f, record) {
  await writeFile(recordPath(f, record.id), `${JSON.stringify(record)}\n`);
}

test("prepare validates canonical immutable targets without pushing or changing Git", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, "alias");
  await symlink(f.repository, alias);
  const prepared = await f.runner.prepare("flow", 4, [
    { ...f.target, repository: alias, branch: "refs/heads/main" },
  ]);
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.epoch, 4);
  assert.equal(prepared.targets[0].repository, f.repository);
  assert.equal(prepared.targets[0].remoteUrl, f.remote);
  assert.equal(prepared.targets[0].branch, "main");
  assert.equal(prepared.targets[0].commit, f.hash);
  assert.equal(prepared.approvedAt, null);
  assert.equal(pushes(f.calls).length, 0);
  assert.equal((await git(f.remote, ["rev-parse", "--verify", "refs/heads/main"])).exitCode, 128);
  assert.equal(await checked(f.repository, ["status", "--porcelain"]), "");
  assert.deepEqual(await f.runner.read(prepared.id), prepared);
  assert.deepEqual(await f.runner.recheck(prepared.id), prepared);
  assert.equal((await stat(f.records)).mode & 0o777, 0o700);
  assert.equal((await stat(recordPath(f, prepared.id))).mode & 0o777, 0o600);
});

test("executes the approved commit after HEAD advances and disables automatic tag pushes", async (t) => {
  const f = await fixture(t);
  await checked(f.repository, ["config", "push.followTags", "true"]);
  await checked(f.repository, ["tag", "-am", "must stay local", "v1", f.hash]);
  const prepared = await f.runner.prepare("flow", 0, [f.target]);
  const later = await f.commit();
  const done = await f.runner.execute(prepared.id);
  assert.equal(done.state, "pushed");
  assert.equal(done.targets[0].exitCode, 0);
  assert.equal(done.targets[0].verified, true);
  assert.ok(done.approvedAt);
  assert.equal(await checked(f.remote, ["rev-parse", "refs/heads/main"]), f.hash);
  assert.equal(await checked(f.repository, ["rev-parse", "HEAD"]), later);
  assert.equal(await checked(f.remote, ["tag", "--list"]), "");
  assert.equal(pushes(f.calls).length, 1);
  assert.deepEqual(pushes(f.calls)[0].args.slice(-2), [f.remote, `${f.hash}:refs/heads/main`]);
  assert.equal(f.runner.isRunning(prepared.id), false);
  assert.match(
    await readFile(path.join(f.records, prepared.id, "target-1-push.log"), "utf8"),
    /exitCode=0/,
  );
  assert.equal(
    (await stat(path.join(f.records, prepared.id, "target-1-push.log"))).mode & 0o777,
    0o600,
  );
});

test("writes the push exit result durably before remote verification", async (t) => {
  const f = await fixture(t);
  let id;
  let checkedRecord = false;
  const runner = new ManagedPushRunner(f.records, async (cwd, args) => {
    if (args.includes("ls-remote")) {
      const durable = JSON.parse(await readFile(recordPath(f, id), "utf8"));
      assert.equal(durable.targets[0].exitCode, 0);
      assert.equal(durable.state, "checking");
      assert.ok(durable.targets[0].finishedAt);
      checkedRecord = true;
    }
    return f.driver(cwd, args);
  });
  const prepared = await runner.prepare("flow", 0, [f.target]);
  id = prepared.id;
  assert.equal((await runner.execute(id)).state, "pushed");
  assert.equal(checkedRecord, true);
});

test("duplicate calls, another manager and a reload cannot push the same request twice", async (t) => {
  const f = await fixture(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const runner = new ManagedPushRunner(f.records, async (cwd, args) => {
    if (args.includes("push")) {
      began();
      await gate;
    }
    return f.driver(cwd, args);
  });
  const prepared = await runner.prepare("flow", 0, [f.target]);
  const first = runner.execute(prepared.id);
  const duplicate = runner.execute(prepared.id);
  assert.equal(first, duplicate);
  await started;
  assert.equal(runner.isRunning(prepared.id), true);
  const other = new ManagedPushRunner(f.records, f.driver);
  assert.equal((await other.execute(prepared.id)).state, "unknown");
  assert.equal(other.isRunning(prepared.id), false);
  assert.equal((await other.recheck(prepared.id)).state, "unknown");
  release();
  assert.equal((await first).state, "pushed");
  assert.equal((await duplicate).state, "pushed");
  assert.equal((await other.execute(prepared.id)).state, "pushed");
  assert.equal((await other.recheck(prepared.id)).state, "pushed");
  assert.equal(pushes(f.calls).length, 1);
});

test("rejects changed remote configuration before any push", async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, "other.git");
  await checked(f.root, ["init", "--bare", "-q", other]);
  const prepared = await f.runner.prepare("flow", 0, [f.target]);
  await checked(f.repository, ["remote", "set-url", "--push", "origin", other]);
  const failed = await f.runner.execute(prepared.id);
  assert.equal(failed.state, "failed");
  assert.equal(pushes(f.calls).length, 0);
  assert.equal((await git(other, ["rev-parse", "--verify", "refs/heads/main"])).exitCode, 128);
  await checked(f.repository, ["remote", "set-url", "--push", "origin", f.remote]);
  assert.equal((await f.runner.execute(prepared.id)).state, "failed");
  assert.equal(pushes(f.calls).length, 0);
});

test("a rejected ancestor push is already included and continues to the next target", async (t) => {
  const f = await fixture(t);
  const later = await f.commit();
  await checked(f.repository, ["push", "origin", `${later}:refs/heads/main`]);
  const prepared = await f.runner.prepare("flow", 0, [f.target, { ...f.target, branch: "second" }]);
  const done = await f.runner.execute(prepared.id);
  assert.equal(done.state, "pushed");
  assert.equal(done.targets[0].exitCode, 1);
  assert.equal(done.targets[0].verified, true);
  assert.equal(done.targets[0].alreadyIncluded, true);
  assert.equal(done.targets[0].error, "");
  assert.equal(done.targets[1].exitCode, 0);
  assert.equal(done.targets[1].alreadyIncluded, false);
  assert.match(
    await readFile(path.join(f.records, prepared.id, "target-1-push.log"), "utf8"),
    /non-fast-forward/,
  );
  assert.equal(await checked(f.remote, ["rev-parse", "refs/heads/main"]), later);
  assert.equal(pushes(f.calls).length, 2);
  const offline = new ManagedPushRunner(f.records, () => {
    throw new Error("must not probe confirmed success");
  });
  assert.deepEqual(await offline.recheck(prepared.id), done);
});

async function rejectedFixture(t, diverged, offline = false) {
  const f = await fixture(t);
  const remoteHead = await f.commit();
  await checked(f.repository, ["push", "origin", `${remoteHead}:refs/heads/main`]);
  if (diverged) {
    await checked(f.repository, ["checkout", "-qb", "diverged", f.hash]);
    f.target.commit = await f.commit();
  }
  const runner = new ManagedPushRunner(f.records, async (cwd, args) =>
    offline && args.includes("ls-remote")
      ? { stdout: "", stderr: "offline", exitCode: 128 }
      : f.driver(cwd, args),
  );
  const prepared = await runner.prepare("flow", 0, [f.target]);
  const result = await runner.execute(prepared.id);
  return { ...f, result, remoteHead };
}

test("a rejected divergent commit stays failed after execution and read-only recheck", async (t) => {
  const f = await rejectedFixture(t, true);
  assert.equal(f.result.state, "failed");
  assert.equal(f.result.targets[0].verified, false);
  assert.equal(f.result.targets[0].alreadyIncluded, false);
  const checkedAgain = await f.runner.recheck(f.result.id);
  assert.equal(checkedAgain.state, "failed");
  assert.equal(checkedAgain.targets[0].alreadyIncluded, false);
  assert.equal(pushes(f.calls).length, 1);
  assert.equal(await checked(f.remote, ["rev-parse", "refs/heads/main"]), f.remoteHead);
});

for (const diverged of [false, true]) {
  test(`recheck of a durable failed push ${diverged ? "stays failed for divergence" : "recognizes an included ancestor"} without repushing`, async (t) => {
    const f = await rejectedFixture(t, diverged, true);
    assert.equal(f.result.state, "failed");
    assert.equal(f.result.targets[0].exitCode, 1);
    const logPath = path.join(f.records, f.result.id, "target-1-push.log");
    const log = await readFile(logPath, "utf8");
    // Old records predate alreadyIncluded; schema migration must preserve their evidence.
    delete f.result.targets[0].alreadyIncluded;
    await replaceRecord(f, f.result);
    const rechecked = await f.runner.recheck(f.result.id);
    assert.equal(rechecked.state, diverged ? "failed" : "pushed");
    assert.equal(rechecked.targets[0].alreadyIncluded, !diverged);
    assert.equal(rechecked.targets[0].exitCode, 1);
    assert.equal(await readFile(logPath, "utf8"), log);
    assert.equal(pushes(f.calls).length, 1);
    assert.deepEqual(await f.runner.read(f.result.id), rechecked);
  });
}

test("recheck does not overwrite another runner's in-flight nonzero result", async (t) => {
  const f = await rejectedFixture(t, false, true);
  f.result.state = "checking";
  await replaceRecord(f, f.result);
  const before = await readFile(recordPath(f, f.result.id), "utf8");
  const calls = f.calls.length;
  assert.equal((await f.runner.recheck(f.result.id)).state, "unknown");
  assert.equal(await readFile(recordPath(f, f.result.id), "utf8"), before);
  assert.equal(f.calls.length, calls);
});

test("unknown process exits are never treated as a successful push or retried", async (t) => {
  const f = await fixture(t);
  const runner = new ManagedPushRunner(f.records, async (cwd, args) => {
    const result = await f.driver(cwd, args);
    return args.includes("push") ? { ...result, exitCode: null } : result;
  });
  const prepared = await runner.prepare("flow", 0, [f.target]);
  assert.equal((await runner.execute(prepared.id)).state, "unknown");
  assert.equal(await checked(f.remote, ["rev-parse", "refs/heads/main"]), f.hash);
  assert.equal((await runner.execute(prepared.id)).state, "unknown");
  assert.equal(pushes(f.calls).length, 1);
  // Only the real remote settles it: once it holds the approved commit, recheck records that.
  const settled = await runner.recheck(prepared.id);
  assert.equal(settled.state, "pushed");
  assert.equal(settled.targets[0].verified, true);
  assert.equal(pushes(f.calls).length, 1);
});

test("an unknown exit whose commit never reached the remote stays unknown without repushing", async (t) => {
  const f = await fixture(t);
  const runner = new ManagedPushRunner(f.records, async (cwd, args) =>
    args.includes("push") ? { stdout: "", stderr: "", exitCode: null } : f.driver(cwd, args),
  );
  const prepared = await runner.prepare("flow", 0, [f.target]);
  assert.equal((await runner.execute(prepared.id)).state, "unknown");
  assert.equal((await runner.recheck(prepared.id)).state, "unknown");
  assert.equal((await git(f.remote, ["rev-parse", "--verify", "refs/heads/main"])).exitCode, 128);
});

test("URL-named remote sections, local credential helpers and ssh commands refuse the push", async (t) => {
  for (const [key, value] of [
    ["pushurl", "/elsewhere.git"],
    ["url", "/elsewhere.git"],
    ["receivepack", "touch /tmp/never"],
  ]) {
    const f = await fixture(t);
    await checked(f.repository, ["config", `remote.${f.remote}.${key}`, value]);
    await assert.rejects(f.runner.prepare("flow", 0, [f.target]), /고정된 푸시 주소/);
  }
  for (const [key, value] of [
    ["credential.helper", "!echo password=x"],
    ["core.sshCommand", "ssh -o ProxyCommand=true"],
  ]) {
    const f = await fixture(t);
    await checked(f.repository, ["config", key, value]);
    await assert.rejects(f.runner.prepare("flow", 0, [f.target]), /고정된 푸시 주소/);
  }
  // Added after approval: the push is refused before it runs.
  const f = await fixture(t);
  const prepared = await f.runner.prepare("flow", 0, [f.target]);
  await checked(f.repository, ["config", `remote.${f.remote}.pushurl`, "/elsewhere.git"]);
  assert.notEqual((await f.runner.execute(prepared.id)).state, "pushed");
  assert.equal(pushes(f.calls).length, 0);
});

test("repository hooks do not run during an approved push", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, "hook-ran");
  const hook = path.join(f.repository, ".git", "hooks", "pre-push");
  await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  const prepared = await f.runner.prepare("flow", 0, [f.target]);
  assert.equal((await f.runner.execute(prepared.id)).state, "pushed");
  await assert.rejects(stat(marker));
});

test("reload recovers a durable zero exit through read-only verification without repushing", async (t) => {
  const f = await fixture(t);
  const runner = new ManagedPushRunner(f.records, async (cwd, args) =>
    args.includes("ls-remote")
      ? { stdout: "", stderr: "offline", exitCode: 128 }
      : f.driver(cwd, args),
  );
  const prepared = await runner.prepare("flow", 0, [f.target]);
  const interrupted = await runner.execute(prepared.id);
  assert.equal(interrupted.state, "unknown");
  assert.equal(interrupted.targets[0].exitCode, 0);
  interrupted.state = "checking";
  await replaceRecord(f, interrupted);
  const restored = new ManagedPushRunner(f.records, f.driver);
  assert.equal((await restored.read(prepared.id)).state, "unknown");
  assert.equal((await restored.recheck(prepared.id)).state, "pushed");
  assert.equal(pushes(f.calls).length, 1);
  const later = await f.commit();
  await checked(f.repository, ["push", "origin", `${later}:refs/heads/main`]);
  assert.equal((await restored.recheck(prepared.id)).state, "pushed");
  assert.equal(pushes(f.calls).length, 1);
});

test("a crash immediately after claiming prevents execution even when the record says prepared", async (t) => {
  const f = await fixture(t);
  const prepared = await f.runner.prepare("flow", 0, [f.target]);
  await writeFile(path.join(f.records, prepared.id, "claim"), "crash simulation\n");
  const restored = new ManagedPushRunner(f.records, f.driver);
  assert.equal((await restored.read(prepared.id)).state, "unknown");
  assert.equal((await restored.execute(prepared.id)).state, "unknown");
  assert.equal((await restored.recheck(prepared.id)).state, "unknown");
  assert.equal(pushes(f.calls).length, 0);
});

test("stops additional targets if durable result storage fails", async (t) => {
  const f = await fixture(t);
  let id;
  const runner = new ManagedPushRunner(f.records, async (cwd, args) => {
    const result = await f.driver(cwd, args);
    if (args.includes("push")) {
      await rm(recordPath(f, id));
      await mkdir(recordPath(f, id));
    }
    return result;
  });
  const prepared = await runner.prepare("flow", 0, [f.target, { ...f.target, branch: "second" }]);
  id = prepared.id;
  const result = await runner.execute(id);
  assert.equal(result.state, "unknown");
  assert.equal(pushes(f.calls).length, 1);
  assert.equal((await git(f.remote, ["rev-parse", "--verify", "refs/heads/second"])).exitCode, 128);
});

test("executes multiple targets sequentially and exposes durable workflow history", async (t) => {
  const f = await fixture(t);
  const first = await f.runner.prepare("flow", 0, [f.target, { ...f.target, branch: "second" }]);
  const result = await f.runner.execute(first.id);
  assert.equal(result.state, "pushed");
  assert.equal(pushes(f.calls).length, 2);
  assert.equal(await checked(f.remote, ["rev-parse", "refs/heads/second"]), f.hash);
  const second = await f.runner.prepare("flow", 1, [f.target]);
  await f.runner.prepare("other-flow", 0, [f.target]);
  assert.deepEqual(
    (await f.runner.history("flow")).map((row) => row.id),
    [second.id, first.id],
  );
});

test("rejects invalid commits, branches, duplicate destinations and credential-bearing URLs", async (t) => {
  const f = await fixture(t);
  for (const target of [
    { ...f.target, commit: "HEAD" },
    { ...f.target, commit: f.hash.slice(0, 8) },
    { ...f.target, branch: "main:other" },
    { ...f.target, branch: "refs/tags/v1" },
  ])
    await assert.rejects(() => f.runner.prepare("flow", 0, [target]));
  await checked(f.repository, ["tag", "-am", "tag object", "v1"]);
  const tag = await checked(f.repository, ["rev-parse", "v1"]);
  await assert.rejects(() => f.runner.prepare("flow", 0, [{ ...f.target, commit: tag }]));
  await assert.rejects(() => f.runner.prepare("flow", 0, [f.target, f.target]));
  for (const url of [
    "https://secret-token@example.invalid/repo.git",
    "https://user:secret@example.invalid/repo.git",
    "https://example.invalid/repo.git?token=secret",
    "ext::echo secret",
  ]) {
    await checked(f.repository, ["remote", "set-url", "origin", url]);
    await assert.rejects(
      () => f.runner.prepare("flow", 0, [f.target]),
      (error) => {
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
  }
  await checked(f.repository, ["remote", "set-url", "origin", f.remote]);
  await checked(f.repository, ["remote", "set-url", "--add", "--push", "origin", f.remote]);
  await checked(f.repository, ["remote", "set-url", "--add", "--push", "origin", f.remote]);
  await assert.rejects(() => f.runner.prepare("flow", 0, [f.target]));
  assert.equal(pushes(f.calls).length, 0);
});

test("the default driver performs the same bounded local bare-repository operation", async (t) => {
  const f = await fixture(t);
  const runner = new ManagedPushRunner(f.records);
  const prepared = await runner.prepare("default-driver", 0, [f.target]);
  assert.equal((await runner.execute(prepared.id)).state, "pushed");
  assert.equal(await checked(f.remote, ["rev-parse", "refs/heads/main"]), f.hash);
});

test("refuses chained URL rewrites and recheck cannot follow a newly redirected address", async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, "other.git");
  const third = path.join(f.root, "third.git");
  await checked(f.root, ["init", "--bare", "-q", other]);
  await checked(f.root, ["init", "--bare", "-q", third]);
  const interrupted = new ManagedPushRunner(f.records, async (cwd, args) =>
    args.includes("ls-remote")
      ? { stdout: "", stderr: "offline", exitCode: 128 }
      : f.driver(cwd, args),
  );
  const prepared = await interrupted.prepare("flow", 0, [f.target]);
  assert.equal((await interrupted.execute(prepared.id)).state, "unknown");
  await checked(f.repository, ["config", `url.${other}.insteadOf`, f.remote]);
  assert.equal((await f.runner.recheck(prepared.id)).state, "unknown");
  await checked(f.repository, ["config", `url.${third}.insteadOf`, other]);
  await assert.rejects(() => f.runner.prepare("flow", 1, [f.target]), /URL/);
  assert.equal(pushes(f.calls).length, 1);
});

test("a finalized push stays confirmed without probing an unavailable or changed remote", async (t) => {
  const f = await fixture(t);
  const prepared = await f.runner.prepare("flow", 0, [f.target]);
  const pushed = await f.runner.execute(prepared.id);
  assert.equal(pushed.state, "pushed");
  const saved = await readFile(recordPath(f, prepared.id), "utf8");
  const log = await readFile(path.join(f.records, prepared.id, "target-1-push.log"), "utf8");
  await checked(f.repository, ["remote", "set-url", "origin", path.join(f.root, "missing.git")]);
  let attempts = 0;
  const offline = new ManagedPushRunner(f.records, async () => {
    attempts++;
    return { stdout: "", stderr: "remote unavailable", exitCode: 128 };
  });
  assert.deepEqual(await offline.recheck(prepared.id), pushed);
  assert.equal(attempts, 0);
  assert.equal(await readFile(recordPath(f, prepared.id), "utf8"), saved);
  assert.equal(await readFile(path.join(f.records, prepared.id, "target-1-push.log"), "utf8"), log);
});

test("the default driver runs git without stdin and records exit codes", async (t) => {
  const f = await fixture(t);
  const runner = new ManagedPushRunner(f.records);
  const prepared = await runner.prepare("flow", 0, [f.target]);
  const done = await runner.execute(prepared.id);
  assert.equal(done.state, "pushed");
  assert.equal(done.targets[0].exitCode, 0);
  assert.equal(await checked(f.remote, ["rev-parse", "refs/heads/main"]), f.hash);
});
