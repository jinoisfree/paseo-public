// Adapted for paseo-public: portable fixtures and explicit notification opt-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRepoProbe } from "../server/git.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

test("probe reads the baseline, what changed since it, and whether commits are pushed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "role-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, "work");
  git(root, "init", "-q", "--bare", "remote.git");
  git(root, "init", "-q", "work");
  for (const [key, value] of [
    ["user.email", "test@example.invalid"],
    ["user.name", "test"],
    ["commit.gpgsign", "false"],
  ])
    git(work, "config", key, value);
  const probe = createRepoProbe();
  assert.equal(await probe.snapshot(root), null, "a plain folder has no baseline");
  assert.equal(await probe.snapshot(work), null, "nor does a repository without a commit");
  await writeFile(path.join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-qm", "first");
  assert.equal(await probe.pushed(work), null, "no upstream means git cannot tell");
  git(work, "remote", "add", "origin", path.join(root, "remote.git"));
  const branch = git(work, "symbolic-ref", "--short", "HEAD").trim();
  // Populate only the disposable local fixture; no user remote is written by tests.
  git(path.join(root, "remote.git"), "fetch", "-q", work, `HEAD:refs/heads/${branch}`);
  git(work, "config", `branch.${branch}.remote`, "origin");
  git(work, "config", `branch.${branch}.merge`, `refs/heads/${branch}`);
  git(work, "fetch", "-q", "origin");
  assert.equal(await probe.pushed(work), true);
  const target = await probe.pushTarget(work);
  assert.equal(await probe.commit(work, target.commit.slice(0, 7)), target.commit);
  assert.equal(
    await probe.commit(work, "HEAD"),
    null,
    "an execution hash cannot be replaced by current HEAD",
  );
  assert.deepEqual(target, {
    repository: await probe.repository(work),
    remote: "origin",
    branch,
    commit: git(work, "rev-parse", "HEAD").trim(),
  });

  await writeFile(path.join(work, "old.txt"), "left by the user\n");
  const baseline = await probe.snapshot(work);
  assert.match(baseline.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    baseline.dirty.map((row) => row.split("\t")[0]),
    ["?? old.txt"],
  );
  assert.match(await probe.changes(work, baseline), /달라진 파일이 감지되지 않았다/);

  await writeFile(path.join(work, "a.txt"), "one\ntwo\n");
  git(work, "commit", "-qam", "second");
  await writeFile(path.join(work, "new.txt"), "made by the executor\n");
  const text = await probe.changes(work, baseline);
  assert.match(text, /새 커밋:\n[0-9a-f]+ second/);
  assert.match(text, /a\.txt \| 1 \+/);
  assert.match(text, /★ \?\? new\.txt/);
  assert.match(text, /\n {2}\?\? old\.txt/);
  assert.doesNotMatch(text, /감지되지 않았다/);
  assert.equal(await probe.pushed(work), false);
  assert.equal(
    await probe.pushedTarget(target),
    true,
    "a later local commit does not change the saved push target",
  );
  git(work, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
  assert.equal(git(work, "rev-list", "--count", "@{u}..HEAD").trim(), "0");
  assert.equal(await probe.pushed(work), false, "a stale local tracking ref cannot fake a push");
  git(path.join(root, "remote.git"), "fetch", "-q", work, `HEAD:refs/heads/${branch}`);
  assert.equal(await probe.pushed(work), true, "only the remote containing HEAD qualifies");
  git(work, "remote", "set-url", "origin", path.join(root, "missing.git"));
  assert.equal(
    await probe.pushed(work),
    null,
    "an unavailable remote never establishes completion",
  );
});

test("a second edit to an already modified file still counts as a change", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "role-git-dirty-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  git(work, "init", "-q");
  for (const [key, value] of [
    ["user.email", "test@example.invalid"],
    ["user.name", "test"],
    ["commit.gpgsign", "false"],
  ])
    git(work, "config", key, value);
  await writeFile(path.join(work, "한글 파일.ts"), "one\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "first");
  // The first cycle left the file uncommitted, which is where a correction cycle starts.
  await writeFile(path.join(work, "한글 파일.ts"), "one\ntwo\n");
  const probe = createRepoProbe();
  const baseline = await probe.snapshot(work);
  assert.match(await probe.changes(work, baseline), /달라진 파일이 감지되지 않았다/);
  await writeFile(path.join(work, "한글 파일.ts"), "one\ntwo\nthree and more\n");
  const text = await probe.changes(work, baseline);
  assert.match(text, /★  M 한글 파일\.ts/);
  assert.doesNotMatch(text, /감지되지 않았다/);
});

test("changes are seen from a subfolder of the repository and inside an untracked folder", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "role-git-sub-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  for (const [key, value] of [
    ["user.email", "test@example.invalid"],
    ["user.name", "test"],
    ["commit.gpgsign", "false"],
  ])
    git(root, "config", key, value);
  const { mkdir } = await import("node:fs/promises");
  const sub = path.join(root, "packages", "app");
  await mkdir(path.join(sub, "new", "deep"), { recursive: true });
  await writeFile(path.join(sub, "a.ts"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  await writeFile(path.join(sub, "a.ts"), "one\ntwo\n");
  await writeFile(path.join(sub, "new", "deep", "b.ts"), "first\n");
  const probe = createRepoProbe();
  const baseline = await probe.snapshot(sub);
  assert.ok(
    baseline.dirty.every((row) => !row.endsWith("\t-")),
    "every changed file was found from the repository root",
  );
  assert.match(await probe.changes(sub, baseline), /달라진 파일이 감지되지 않았다/);
  await writeFile(path.join(sub, "a.ts"), "one\ntwo\nthree and more\n");
  await writeFile(path.join(sub, "new", "deep", "b.ts"), "first\nsecond and more\n");
  const text = await probe.changes(sub, baseline);
  assert.match(text, /★  M packages\/app\/a\.ts/);
  assert.match(text, /★ \?\? packages\/app\/new\/deep\/b\.ts/);
});

async function parentFolder(t) {
  const root = await mkdtemp(path.join(tmpdir(), "role-git-children-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function childRepo(root, name) {
  const child = path.join(root, name);
  git(root, "init", "-q", name);
  git(child, "config", "user.email", "test@example.invalid");
  git(child, "config", "user.name", "test");
  git(child, "config", "commit.gpgsign", "false");
  await writeFile(path.join(child, "a.txt"), "one\n");
  git(child, "add", ".");
  git(child, "commit", "-qm", "first");
  return child;
}
test("parent baseline separates two repositories and only one changes", async (t) => {
  const root = await parentFolder(t);
  const a = await childRepo(root, "alpha");
  await childRepo(root, "beta");
  const probe = createRepoProbe();
  const baseline = await probe.snapshot(root);
  assert.deepEqual(
    baseline.repositories.map((r) => r.name),
    ["alpha", "beta"],
  );
  assert.match(await probe.changes(root, baseline), /달라진 파일이 감지되지 않았다/);
  await writeFile(path.join(a, "new.txt"), "new");
  const text = await probe.changes(root, baseline);
  assert.match(text, /조사 범위.*alpha, beta/);
  assert.match(text, /저장소: alpha[\s\S]*★ \?\? new.txt[\s\S]*저장소: beta/);
  assert.doesNotMatch(text, /감지되지 않았다/);
});
test("parent scan ignores symlinks, node_modules, hidden directories and grandchildren", async (t) => {
  const { mkdir, symlink } = await import("node:fs/promises");
  const root = await parentFolder(t);
  const outside = await parentFolder(t);
  const target = await childRepo(outside, "target");
  await symlink(target, path.join(root, "linked"));
  await childRepo(root, "node_modules");
  await childRepo(root, ".hidden");
  await mkdir(path.join(root, "plain"));
  await childRepo(path.join(root, "plain"), "nested");
  const probe = createRepoProbe();
  assert.equal(await probe.snapshot(root), null);
  await childRepo(root, "included");
  assert.deepEqual(
    (await probe.snapshot(root)).repositories.map((r) => r.name),
    ["included"],
  );
});
test("an empty folder has no baseline", async (t) => {
  assert.equal(await createRepoProbe().snapshot(await parentFolder(t)), null);
});
test("old single-repository baseline retains the exact evidence format", async (t) => {
  const root = await parentFolder(t);
  const child = await childRepo(root, "work");
  const head = git(child, "rev-parse", "HEAD").trim();
  const baseline = { head, dirty: [] };
  const probe = createRepoProbe();
  assert.deepEqual(await probe.snapshot(child), baseline);
  assert.equal(
    await probe.changes(child, baseline),
    `플러그인이 git에서 직접 수집한 변경 증거 (실행 전 커밋 ${head.slice(0, 8)} 기준, 실행 보고와 대조할 것):\n실행 전과 비교해 달라진 파일이 감지되지 않았다. 보고된 변경이 실제로 있는지 확인할 것.`,
  );
});
test("a missing child keeps other evidence and never claims no changes", async (t) => {
  const root = await parentFolder(t);
  const a = await childRepo(root, "alpha");
  await childRepo(root, "beta");
  const probe = createRepoProbe();
  const baseline = await probe.snapshot(root);
  await rm(a, { recursive: true });
  const text = await probe.changes(root, baseline);
  assert.match(text, /저장소: alpha\n변경 증거를 수집하지 못했다/);
  assert.match(text, /저장소: beta\n플러그인이 git/);
  assert.doesNotMatch(text, /감지되지 않았다/);
});
test("child scan is bounded to eight directories and discloses the incomplete range", async (t) => {
  const { mkdir } = await import("node:fs/promises");
  const root = await parentFolder(t);
  await childRepo(root, "00repo");
  for (let i = 1; i <= 8; i++) await mkdir(path.join(root, `dir${i}`));
  const probe = createRepoProbe();
  const baseline = await probe.snapshot(root);
  assert.equal(baseline.incomplete, true);
  const text = await probe.changes(root, baseline);
  assert.match(text, /조사 범위 제한/);
  assert.doesNotMatch(text, /감지되지 않았다/);
});
