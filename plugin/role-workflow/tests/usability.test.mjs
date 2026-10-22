import { test } from "node:test";
import assert from "node:assert/strict";
import { requestedMode } from "../shared/mode-request.ts";
import { workflowCardSchema } from "../shared/workflow-card.ts";
import { transformWorkflowReport } from "../client/workflow-report.ts";
import { visibleWorkflows, workflowLabel } from "../shared/workflow-list.ts";

test("mode requests distinguish explicit choices from comparisons, quotes, questions and negations", () => {
  for (const text of [
    "연합개발",
    "연합개발로 전환해줘",
    "연합개발로 바꿔줘",
    "연합개발로 진행해 주세요",
    "연합개발로 전환한다. 추가 지시",
  ])
    assert.equal(requestedMode(text), "federated", text);
  for (const text of [
    "일반개발",
    "일반개발로 진행해",
    "연합개발로 전환하지 말고 일반개발로 해",
    "연합개발 하지마",
    "연합개발로 전환하지 마",
  ])
    assert.equal(requestedMode(text), "general", text);
  for (const text of [
    "현재 paseo의 연합개발, 일반개발의 효율성을 개선해",
    "연합개발과 일반개발의 차이를 설명해 줘",
    "연합개발로 할까 고민 중",
    "연합개발로 전환해줘?",
    "연합개발로 진행하는 방법 설명해",
    "'연합개발로 전환해줘'라고 쓰면 되나",
    "```\n연합개발\n```",
    "작업 ID: test\n연합개발",
    "연합개발로 진행하면 비용이 줄어?",
    "연합개발로 전환하지 말라는 뜻이야?",
    "연합개발 취소하면 어떤 일이 생겨?",
  ])
    assert.equal(requestedMode(text), null, text);
});

const decision = {
  status: "result",
  summary: "구현 완료",
  next: "검토",
  handoff: "변경 파일 a.ts",
  checks: ["node --test: exit 0"],
  remember: [],
};
const block = (d = decision) => `<paseo-workflow>${JSON.stringify(d)}</paseo-workflow>`;
const transform = (text, phase = "complete") =>
  transformWorkflowReport({ item: { type: "assistant_message", text }, phase });
test("workflow cards preserve prose and exact raw output while keeping execution results distinct from completion", () => {
  const source = `**변경했습니다.**\n\n${block()}`;
  const output = transform(source);
  assert.equal(output.items.length, 1);
  const data = workflowCardSchema.parse(output.items[0].data);
  assert.equal(data.prose, "**변경했습니다.**");
  assert.equal(data.raw, block());
  assert.equal(data.decision.status, "result");
  assert.deepEqual(data.decision.checks, decision.checks);
  const withTag = block({ ...decision, handoff: "literal <paseo-workflow> in a string" });
  assert.equal(transform(withTag).items[0].data.raw, withTag);
});
test("streaming, malformed, quoted, local file and interactive messages keep native rendering", () => {
  assert.equal(transform(block(), "streaming"), undefined);
  for (const text of [
    "ordinary text",
    "<paseo-workflow>{broken}</paseo-workflow>",
    `${block()} trailing prose`,
    "```json\n" + block(),
    `[a.ts](/tmp/a.ts)\n${block()}`,
    `\`\`\`mermaid\ngraph TD\n\`\`\`\n${block()}`,
    `![picture](https://example.com/a.png)\n${block()}`,
  ])
    assert.equal(transform(text), undefined, text);
});
test("dashboard sorts actionable work first and recognizes general completion without changing engine status", () => {
  const row = (id, mode, status, progress, updatedAt = "2026-10-13") => ({
    id,
    mode,
    status,
    progress,
    updatedAt,
  });
  const rows = [
    row("done", "general", "active", "done", "2026-10-14"),
    row("working", "general", "active", "active"),
    row("waiting", "federated", "needs_input", "active"),
    row("paused", "federated", "paused", "active"),
    row("pushed", "federated", "completed", "pushed"),
  ];
  assert.deepEqual(
    visibleWorkflows(rows, "all").map((w) => w.id),
    ["waiting", "working", "paused", "done", "pushed"],
  );
  assert.deepEqual(
    visibleWorkflows(rows, "general").map((w) => w.id),
    ["working", "done"],
  );
  assert.equal(workflowLabel(rows[0]), "구현 완료 · 미푸시");
  assert.equal(rows[0].status, "active");
});

test("old push completion never hides a current wait, error or overlapping work", () => {
  for (const [status, expected] of [
    ["needs_input", "답변 필요"],
    ["error", "확인 필요"],
    ["paused", "일시정지"],
  ]) {
    const waiting = {
      id: "waiting",
      mode: "federated",
      progress: "pushed",
      status,
      updatedAt: "a",
    };
    assert.equal(workflowLabel(waiting), expected);
    assert.equal(
      visibleWorkflows(
        [{ ...waiting, id: "done", status: "completed", updatedAt: "z" }, waiting],
        "all",
      )[0].id,
      "waiting",
    );
  }
  assert.equal(
    workflowLabel({ mode: "general", progress: "pushed", status: "active", conflict: "busy" }),
    "동시 작업 확인",
  );
});
