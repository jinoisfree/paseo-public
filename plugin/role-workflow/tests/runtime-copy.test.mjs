import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runtimeCopyStatus } from "../server/runtime-copy.ts";
import { gitTestEnvironment } from "./git-test-environment.mjs";

const run = promisify(execFile);

test("AT-RG-04: runtime drift uses only local Git data and caches it for sixty seconds", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "runtime-copy-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "run");
  const env = gitTestEnvironment();
  const git = (cwd, ...args) => run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, env });
  await git(dir, "init", "-q", "-b", "main", root);
  const tracked = path.join(root, "tracked");
  await writeFile(tracked, "initial\n");
  await git(root, "add", "tracked");
  await git(root, "commit", "-qm", "base");
  await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  await writeFile(path.join(root, "untracked"), "ignored by status\n");

  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const readFresh = () => {
    now += 60_000;
    return runtimeCopyStatus(root);
  };
  const normal = { state: "ok", root, branch: "main", dirty: 0, ahead: 0, worktrees: 0, reasons: [] };
  const normalRead = runtimeCopyStatus(root);
  assert.deepEqual(await normalRead, normal);
  await git(root, "checkout", "-qb", "topic");
  now += 59_999;
  assert.equal(runtimeCopyStatus(root), normalRead, "a cached call reuses the probe promise instead of running Git");
  now++;
  assert.deepEqual(await runtimeCopyStatus(root), { ...normal, state: "drift", branch: "topic", reasons: ["branch"] });
  await git(root, "checkout", "--detach");
  assert.deepEqual(await readFresh(), { ...normal, state: "drift", branch: null, reasons: ["branch"] });
  await git(root, "checkout", "main");
  await writeFile(tracked, "changed\n");
  assert.deepEqual(await readFresh(), { ...normal, state: "drift", dirty: 1, reasons: ["dirty"] });
  await git(root, "commit", "-qam", "local-only");
  assert.deepEqual(await readFresh(), { ...normal, state: "drift", ahead: 1, reasons: ["ahead"] });
  await git(root, "reset", "--hard", "refs/remotes/origin/main");
  await git(root, "worktree", "add", "--detach", path.join(dir, "linked"));
  assert.deepEqual(await readFresh(), { ...normal, state: "drift", worktrees: 1, reasons: ["worktrees"] });
  await git(root, "checkout", "topic");
  await git(root, "commit", "--allow-empty", "-m", "local-only");
  await writeFile(tracked, "changed again\n");
  assert.deepEqual(await readFresh(), {
    ...normal, state: "drift", branch: "topic", dirty: 1, ahead: 1, worktrees: 1,
    reasons: ["branch", "dirty", "ahead", "worktrees"],
  });
  await git(root, "update-ref", "-d", "refs/remotes/origin/main");
  assert.equal((await readFresh()).state, "unknown");
  assert.equal((await runtimeCopyStatus(dir)).state, "unknown");
  assert.equal((await runtimeCopyStatus(null)).state, "unknown");
});
