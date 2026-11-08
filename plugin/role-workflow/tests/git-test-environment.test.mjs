import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { devNull, tmpdir } from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { gitTestEnvironment } from "./git-test-environment.mjs";

test("R11-3: fixture Git ignores inherited global/system/count and repository routing without changing its parent", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "git-environment-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, "hostile.gitconfig");
  await writeFile(config, '[user]\n name = inherited poison\n[url "blocked://"]\n pushInsteadOf = /\n');
  const parent = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "count poison",
    GIT_CONFIG_PARAMETERS: "'user.name=parameter poison'", GIT_DIR: "/not-a-repository", GIT_WORK_TREE: "/wrong-folder" };
  const before = structuredClone(parent);
  const env = gitTestEnvironment(parent);
  assert.equal(env.GIT_CONFIG_GLOBAL, devNull);
  assert.equal(env.GIT_CONFIG_SYSTEM, devNull);
  for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_WORK_TREE"])
    assert.equal(env[key], undefined, key);
  const output = execFileSync("git", ["config", "--list", "--show-origin"], { cwd: dir, env }).toString();
  assert.doesNotMatch(output, /poison|blocked/);
  assert.deepEqual(parent, before);
  assert.equal(gitTestEnvironment(parent, { GIT_CONFIG_GLOBAL: config }).GIT_CONFIG_GLOBAL, config,
    "push-guard integration may deliberately install its temporary guard config");
});
