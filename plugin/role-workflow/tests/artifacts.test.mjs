import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRepoProbe } from "../server/git.ts";
import { proseArtifacts } from "../shared/artifacts.ts";
import { repositoryPaths, inspectVerification } from "../server/artifacts.ts";
import { pathsOverlap } from "../server/workspaces.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
async function repo(t) {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "work");
  const work = path.join(root, "work");
  git(work, "config", "user.name", "test");
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "commit.gpgsign", "false");
  await writeFile(path.join(work, "file.txt"), "one");
  git(work, "add", ".");
  git(work, "commit", "-qm", "first");
  return { root, work, head: git(work, "rev-parse", "HEAD"), probe: createRepoProbe() };
}

test("push targets verify the specified repository, remote, branch and commit, independent of HEAD", async (t) => {
  const { root, work, head, probe } = await repo(t);
  git(root, "init", "-q", "--bare", "remote.git");
  git(root, "init", "-q", "--bare", "other.git");
  const remote = path.join(root, "remote.git");
  git(remote, "fetch", "-q", work, "HEAD:refs/heads/release");
  git(work, "remote", "add", "target", remote);
  git(work, "remote", "add", "other", path.join(root, "other.git"));
  const target = { repository: work, remote: "target", branch: "release", commit: head };
  assert.equal(await probe.pushed(root), null);
  assert.equal(await probe.pushedTarget(target), true);
  assert.notEqual(await probe.pushedTarget({ ...target, remote: "other" }), true);
  assert.notEqual(await probe.pushedTarget({ ...target, branch: "different" }), true);
  await writeFile(path.join(work, "file.txt"), "two");
  git(work, "commit", "-qam", "second");
  const second = git(work, "rev-parse", "HEAD");
  assert.equal(
    await probe.pushedTarget(target),
    true,
    "the previously approved commit is still present",
  );
  assert.equal(await probe.pushedTarget({ ...target, commit: second }), false);
  git(remote, "fetch", "-q", work, "HEAD:refs/heads/release");
  assert.equal(
    await probe.pushedTarget(target),
    true,
    "a known descendant contains the target commit",
  );
  assert.equal(await probe.pushedTarget({ ...target, commit: second }), true);
  git(work, "remote", "set-url", "target", path.join(root, "gone.git"));
  assert.equal(await probe.pushedTarget(target), null);
});

test("canonical roots merge nested and symlink paths while separate worktrees stay independent", async (t) => {
  const { root, work, probe } = await repo(t);
  await mkdir(path.join(work, "src"));
  await symlink(work, path.join(root, "linked"));
  const roots = await repositoryPaths(probe, root, ["work/src", "linked"]);
  assert.equal(roots.length, 1);
  git(work, "worktree", "add", "-q", "-b", "parallel", path.join(root, "parallel"));
  const [other] = await repositoryPaths(probe, root, ["parallel"]);
  assert.equal(pathsOverlap(roots[0], other), false);
  assert.equal(pathsOverlap(roots[0], `${roots[0]}-other`), false);
  await assert.rejects(repositoryPaths(probe, root, ["not-a-repository"]), /Git 저장소/);
});

test("401 changed paths and truncated child baselines never establish no progress", async (t) => {
  const { root, work, probe } = await repo(t);
  await Promise.all(
    Array.from({ length: 401 }, (_, n) =>
      writeFile(path.join(work, `untracked-${String(n).padStart(3, "0")}`), "first"),
    ),
  );
  const baseline = await probe.snapshot(work);
  assert.equal(baseline.dirty.length, 400);
  assert.equal(baseline.incomplete, true);
  const parent = await probe.snapshot(root);
  assert.equal(parent.incomplete, true);
  await writeFile(path.join(work, "untracked-400"), "second unseen edit");
  for (const [cwd, before] of [
    [work, baseline],
    [root, parent],
  ]) {
    const evidence = await probe.changes(cwd, before);
    assert.doesNotMatch(evidence, /달라진 파일이 감지되지 않았다/);
    assert.match(evidence, /조사 범위 제한/);
  }
});

test("quoted and fenced target metadata is inert, malformed metadata is flagged", () => {
  const target = [
    { repository: "/tmp/work", remote: "origin", branch: "main", commit: "a".repeat(40) },
  ];
  const line = `푸시대상: ${JSON.stringify(target)}`;
  for (const text of [
    `> ${line}`,
    `\`\`\`\n${line}\n\`\`\``,
    `\`\`\`\n${line}`,
    `<paseo-workflow>${line}</paseo-workflow>`,
  ])
    assert.equal(proseArtifacts(text).pushTargets, undefined);
  assert.deepEqual(proseArtifacts(`작업저장소: src\n${line}`).pushTargets, target);
  assert.equal(proseArtifacts("푸시대상: {bad}").invalidTargets, true);
});

test("verification distinguishes matching, changed, failed and unavailable evidence", async (t) => {
  const { root, work, head, probe } = await repo(t);
  await writeFile(path.join(root, "test.log"), "passed");
  const item = {
    command: "npm test",
    cwd: "work",
    commit: head,
    exitCode: 0,
    logPath: "../test.log",
    criterion: "regression",
  };
  assert.equal((await inspectVerification(probe, root, item)).state, "matched");
  assert.equal((await inspectVerification(probe, root, { ...item, exitCode: 1 })).state, "failed");
  assert.equal(
    (await inspectVerification(probe, root, { ...item, exitCode: null })).state,
    "unavailable",
  );
  assert.equal(
    (await inspectVerification(probe, root, { ...item, logPath: "missing.log" })).state,
    "unavailable",
  );
  await writeFile(path.join(work, "file.txt"), "different");
  assert.equal((await inspectVerification(probe, root, item)).state, "changed");
});
