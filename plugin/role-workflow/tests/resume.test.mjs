import { test } from "node:test";
import assert from "node:assert/strict";
import { resumePill, resumeResult } from "../shared/resume.ts";
const workflow = {
  id: "work",
  planAgentId: "plan",
  executeAgentId: "execute",
  mode: "federated",
  status: "paused",
  detail: "한도 도달",
};
for (const status of ["paused", "needs_input", "error", "active", "completed"]) {
  for (const agent of ["plan", "execute", "unrelated"]) {
    test(`resume pill for ${status} ${agent}`, () => {
      const expected = agent !== "unrelated" && ["paused", "needs_input", "error"].includes(status);
      assert.deepEqual(
        resumePill([{ ...workflow, status }], agent),
        expected
          ? {
              id: "work",
              detail: "한도 도달",
              label: status === "needs_input" ? "답변 필요" : "재개",
            }
          : null,
      );
    });
  }
}
test("general and undecided workflows have no resume pill", () => {
  for (const mode of ["general", "undecided"])
    assert.equal(resumePill([{ ...workflow, mode }], "plan"), null);
});
test("current workflow takes precedence over completed matches", () => {
  assert.equal(resumePill([{ ...workflow, status: "completed" }, workflow], "execute").id, "work");
  assert.equal(resumePill([{ ...workflow, status: "active" }, workflow], "execute"), null);
  assert.equal(resumePill([], "plan"), null);
});
test("resume result reports success or the actual stopped reason", () => {
  assert.match(resumeResult({ ok: true, status: "active", detail: "실행 중" }), /재개했습니다/);
  for (const status of ["paused", "needs_input", "error", "completed"])
    assert.throws(() => resumeResult({ ok: true, status, detail: "멈춘 이유" }), /멈춘 이유/);
});
