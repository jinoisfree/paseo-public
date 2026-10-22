import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendRoleInstructions,
  CLAUDE_INSTRUCTIONS,
  CODEX_INSTRUCTIONS,
} from "../server/roles.ts";

test("Claude receives planning and Codex receives execution instructions", () => {
  assert.equal(
    appendRoleInstructions("claude"),
    `<paseo-role-workflow-v1>\n${CLAUDE_INSTRUCTIONS}\n</paseo-role-workflow-v1>`,
  );
  assert.equal(
    appendRoleInstructions("codex"),
    `<paseo-role-workflow-v1>\n${CODEX_INSTRUCTIONS}\n</paseo-role-workflow-v1>`,
  );
});
test("preserves existing instructions, is idempotent, and replaces the role on provider change", () => {
  const claude = appendRoleInstructions("claude", "프로젝트 지침을 지켜라.");
  assert.ok(claude.startsWith("프로젝트 지침을 지켜라.\n\n"));
  assert.equal(appendRoleInstructions("claude", claude), claude);
  assert.equal(
    appendRoleInstructions("codex", claude),
    appendRoleInstructions("codex", "프로젝트 지침을 지켜라."),
  );
});
test("other providers keep their instructions unchanged", () => {
  assert.equal(appendRoleInstructions("pi", "original"), "original");
  assert.equal(appendRoleInstructions("opencode"), undefined);
});

test("connected roles hand over through the state block for either provider", async () => {
  const { composePrompt } = await import("../server/roles.ts");
  const plan = composePrompt("codex", "project rules", { role: "plan", automated: true });
  const execute = composePrompt("claude", "project rules", { role: "execute", automated: true });
  assert.match(plan, /문제 분석·계획·검토 담당/);
  assert.match(plan, /Claude에게 줄 실행 지시는 응답 끝 상태 블록의 next에만 쓴다/);
  assert.match(execute, /구현·검증 담당/);
  assert.match(execute, /별도의 Codex 대화에서 준비한다/);
  assert.match(execute, /작업 결과는 응답 끝 상태 블록으로 보고한다/);
  for (const text of [plan, execute]) {
    assert.ok(text.startsWith("project rules"));
    assert.ok(text.includes("<paseo-automation-v1>"));
    assert.ok(!text.includes("연합개발 전용"));
    for (const manual of ["전달할 명령", "전달할 결과", "복사하여 전달", "붙여넣으면"])
      assert.ok(!text.includes(manual), manual);
  }
  assert.equal(composePrompt("codex", plan, { role: "plan", automated: true }), plan);
  assert.equal(composePrompt("claude", plan, { role: "execute", automated: true }), execute);
});

test("unconnected conversations keep the copy-and-paste wording", async () => {
  const { composePrompt } = await import("../server/roles.ts");
  const manual = composePrompt("claude", "project rules", { automated: false });
  assert.equal(manual, appendRoleInstructions("claude", "project rules"));
  assert.match(manual, /Codex에게 전달할 명령/);
  assert.ok(!manual.includes("<paseo-automation-v1>"));
  assert.equal(composePrompt("pi", "original", { automated: true }), "original");
});

test("a mode block leads the prompt and marks every federated block as conditional", async () => {
  const { composePrompt } = await import("../server/roles.ts");
  const { modeSelectPrompt, executorModelPrompt } = await import("../server/protocol.ts");
  const model = executorModelPrompt([{ id: "m", label: "Model" }], "codex", true);
  const prompt = composePrompt("claude", "project rules", {
    role: "plan",
    automated: true,
    mode: modeSelectPrompt("claude"),
    trailing: model,
  });
  const order = [
    "project rules",
    "<paseo-mode-select-v1>",
    "<paseo-role-workflow-v1>",
    "<paseo-automation-v1>",
    "<paseo-executor-model-v1>",
  ].map((marker) => prompt.indexOf(marker));
  assert.deepEqual(
    order,
    order.toSorted((a, b) => a - b),
  );
  assert.ok(order.every((index) => index >= 0));
  assert.equal((prompt.match(/\[연합개발 전용\]/g) || []).length, 3);
  for (const tag of ["role-workflow", "automation", "executor-model"])
    assert.match(prompt, new RegExp(`<paseo-${tag}-v1>\\n\\[연합개발 전용\\]`));
  assert.equal(
    composePrompt("claude", prompt, {
      role: "plan",
      automated: true,
      mode: modeSelectPrompt("claude"),
      trailing: model,
    }),
    prompt,
  );
});
