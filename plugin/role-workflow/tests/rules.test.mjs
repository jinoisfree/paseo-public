import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { materializeRules } from "../server/rules.ts";
import { RULES, RULES_VERSION } from "../server/rules-content.ts";
import { composePrompt } from "../server/roles.ts";
import { generalPrompt } from "../server/start-guide.ts";
import { modeSelectPrompt, stripManagedBlocks, pushApprovalPrompt } from "../server/protocol.ts";

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-rules-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function contents(readme) {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(RULES).map(async (name) => [
        name,
        await readFile(path.join(path.dirname(readme), name), "utf8"),
      ]),
    ),
  );
}

test("materialization publishes complete versioned rules without touching other data", async (t) => {
  const dir = await directory(t);
  await writeFile(path.join(dir, "state.json"), "sentinel");
  const readme = await materializeRules(dir);
  assert.equal(readme, path.join(dir, "rules", RULES_VERSION, "README.md"));
  assert.deepEqual(await contents(readme), RULES);
  assert.equal(await readFile(path.join(dir, "state.json"), "utf8"), "sentinel");
  assert.deepEqual(await readdir(path.join(dir, "rules")), [RULES_VERSION]);
});

test("matching materialization preserves file and directory identity and timestamps", async (t) => {
  const dir = await directory(t);
  const readme = await materializeRules(dir);
  const before = await Promise.all([
    stat(readme, { bigint: true }),
    stat(path.dirname(readme), { bigint: true }),
  ]);
  assert.equal(await materializeRules(dir), readme);
  const after = await Promise.all([
    stat(readme, { bigint: true }),
    stat(path.dirname(readme), { bigint: true }),
  ]);
  assert.deepEqual(
    after.map(({ ino, mtimeNs }) => [ino, mtimeNs]),
    before.map(({ ino, mtimeNs }) => [ino, mtimeNs]),
  );
});

test("corrupted or missing rule files are repaired as a complete version", async (t) => {
  const dir = await directory(t);
  const readme = await materializeRules(dir);
  await writeFile(readme, "corrupt");
  await rm(path.join(path.dirname(readme), "20-implementation.md"));
  assert.equal(await materializeRules(dir), readme);
  assert.deepEqual(await contents(readme), RULES);
  assert.deepEqual(await readdir(path.join(dir, "rules")), [RULES_VERSION]);
});

test("concurrent materialization shares publication and leaves no staging directories", async (t) => {
  const dir = await directory(t);
  const paths = await Promise.all(Array.from({ length: 12 }, () => materializeRules(dir)));
  assert.ok(paths[0]);
  assert.ok(paths.every((value) => value === paths[0]));
  assert.deepEqual(await contents(paths[0]), RULES);
  assert.deepEqual(await readdir(path.join(dir, "rules")), [RULES_VERSION]);
});

test("write failure logs an error and omits only the rules block", async (t) => {
  const dir = await directory(t);
  await writeFile(path.join(dir, "rules"), "blocked");
  const log = t.mock.method(console, "error", () => {});
  const readme = await materializeRules(dir);
  assert.equal(readme, null);
  assert.equal(log.mock.callCount(), 1);
  assert.match(log.mock.calls[0].arguments[0], /규칙 문서 비치 실패/);
  const prompt = composePrompt("claude", "project", { automated: true, rulesReadme: readme });
  assert.doesNotMatch(prompt, /<paseo-agent-rules-v1>/);
  assert.match(prompt, /<paseo-role-workflow-v1>/);
  assert.match(prompt, /<paseo-automation-v1>/);
});

test("both federated roles receive one ungated path-only rules block on every composition", async (t) => {
  const readme = await materializeRules(await directory(t));
  for (const role of ["plan", "execute"]) {
    const parts = { role, automated: true, mode: modeSelectPrompt("claude"), rulesReadme: readme };
    const prompt = composePrompt("claude", "project", parts);
    assert.equal(composePrompt("claude", prompt, parts), prompt);
    assert.equal(prompt.split("<paseo-agent-rules-v1>").length - 1, 1);
    const block = /<paseo-agent-rules-v1>([^]*?)<\/paseo-agent-rules-v1>/.exec(prompt)[1];
    assert.ok(block.includes(JSON.stringify(readme)));
    assert.doesNotMatch(block, /연합개발 전용/);
    assert.equal(await readFile(readme, "utf8"), RULES["README.md"]);
    assert.ok(prompt.indexOf("<paseo-agent-rules-v1>") < prompt.indexOf("<paseo-mode-select-v1>"));
    assert.doesNotMatch(prompt, /핵심 수학 알고리즘|판정 보고는 다음 작업의 인계 문서/);
    assert.doesNotMatch(stripManagedBlocks(prompt), /paseo-agent-rules/);
  }
});

test("general prompts receive and replace the same ungated rules block", async (t) => {
  const dir = await directory(t);
  const readme = await materializeRules(dir);
  const prompt = await generalPrompt(dir, "project", "guide", pushApprovalPrompt(), readme);
  assert.equal(await generalPrompt(dir, prompt, "guide", pushApprovalPrompt(), readme), prompt);
  assert.equal(prompt.split("<paseo-agent-rules-v1>").length - 1, 1);
  assert.ok(prompt.includes(JSON.stringify(readme)));
  assert.ok(prompt.indexOf("<paseo-agent-rules-v1>") < prompt.indexOf("<paseo-general-v1>"));
  assert.doesNotMatch(
    prompt,
    /連合|\[연합개발 전용\]|<paseo-role-workflow-v1>|<paseo-automation-v1>/,
  );
});
