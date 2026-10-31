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
  assert.match(plan, /기획설계·검증 역할/);
  assert.match(plan, /실행 지시는 상태 블록 next에만 쓴다/);
  assert.match(execute, /구현 역할/);
  assert.match(execute, /별도의 Codex 대화에서 준비한다/);
  assert.match(execute, /인계 보고와 멈춤 보고는 result로 낸다/);
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

test("automated role blocks refer to role documents without embedding rule bodies", async () => {
  const { plannerInstructions, executorInstructions } = await import("../server/roles.ts");
  const plan = plannerInstructions("Codex", true);
  const execute = executorInstructions("Claude", true);
  for (const name of ["10-planning.md", "30-verification.md", "40-paseo-role-workflow.md"])
    assert.ok(plan.includes(name));
  for (const name of ["20-implementation.md", "40-paseo-role-workflow.md"])
    assert.ok(execute.includes(name));
  assert.match(plan, /제품 코드는 고치지 않는다/);
  assert.match(plan, /사용자가 명시 승인한 푸시만 직접 실행/);
  for (const prompt of [plan, execute]) {
    assert.match(prompt, /한국어로 설명한다. 전달은 호스트의 자동 작업 흐름이 담당한다/);
    assert.doesNotMatch(prompt, /핵심 수학 알고리즘|단일 세션 검증|REQ\/AC|위험도.*기준 예시/);
  }
});
