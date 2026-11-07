import { test } from "node:test";
import assert from "node:assert/strict";
import { appendTimelineCard } from "../server/timeline-cards.ts";
import { createPort } from "../server/paseo-port.ts";
import { timelineCardSchemas } from "../shared/timeline-cards.ts";
const cases = [
  ["mode-picker", { workflowId: "w" }, ["workflowId"]],
  ["executor-picker", { workflowId: "w" }, ["workflowId"]],
  ["placement-picker", { workflowId: "w", number: 2, title: "other" }, ["number", "title", "workflowId"]],
  ["general-agent", { choice: { provider: "codex", model: "m", thinking: "high" }, message: "selected", planner: { provider: "claude", model: "p", thinking: "" } }, ["choice", "message", "planner"]],
];
for (const [kind, data, keys] of cases)
test(`AC-204: ${kind} appends only its strict shared data keys; unknown keys append zero times`, async () => {
  const calls = [];
  const api = { agents: { ref: () => ({ timeline: { append: async item => calls.push(item) } }) } };
  await appendTimelineCard(api, "P", "card", kind, data);
  assert.deepEqual(Object.keys(calls[0].data).sort(), keys);
  assert.deepEqual(calls[0].data, data);
  calls.length = 0;
  await assert.rejects(appendTimelineCard(api, "P", "card", kind, { ...data, env: { SECRET: "never append" } }));
  assert.deepEqual(calls, []);
  if (kind === "general-agent") {
    await assert.rejects(appendTimelineCard(api, "P", "card", kind, { ...data, choice: { ...data.choice, env: "hidden" } }));
    assert.deepEqual(calls, []);
  }
});
test("AC-204: the actual placement port rejects an oversized blocker before timeline append", async () => {
  const calls = [];
  const port = createPort(() => ({ agents: { ref: () => ({ timeline: { append: async item => calls.push(item) } }) } }));
  await assert.rejects(port.placementPicker("P", "w", { number: 2, title: "other", env: "private" }));
  assert.deepEqual(calls, []);
  assert.deepEqual(Object.keys(timelineCardSchemas).sort(), ["executor-picker", "general-agent", "mode-picker", "placement-picker"]);
});


test("AC-204: actual mode, executor, placement and general ports append the same strict card payloads", async () => {
  const calls = [];
  const port = createPort(() => ({ agents: { ref: () => ({ timeline: { append: async item => calls.push(item) } }) } }));
  await port.modePicker("P", "w");
  await port.executorPicker("P", "w");
  await port.placementPicker("P", "w", { number: 2, title: "other" });
  await port.generalNotice("P", cases[3][1].choice, "selected", "notice", cases[3][1].planner);
  for (let i = 0; i < cases.length; i++) {
    assert.equal(calls[i].kind, cases[i][0]);
    assert.deepEqual(Object.keys(calls[i].data).sort(), cases[i][2]);
    assert.deepEqual(calls[i].data, cases[i][1]);
  }
});

test("AC-204: the client-transformed workflow card also rejects unknown outer data keys", async () => {
  const { workflowCardSchema } = await import("../shared/workflow-card.ts");
  const data = { decision: { status: "note", summary: "summary", next: "", handoff: "context", checks: [] }, raw: "report", prose: "text" };
  assert.deepEqual(Object.keys(workflowCardSchema.parse(data)).sort(), ["decision", "prose", "raw"]);
  assert.equal(workflowCardSchema.safeParse({ ...data, env: "private" }).success, false);
});
