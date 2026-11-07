import { test } from "node:test";
import assert from "node:assert/strict";
import { CALL_BUDGETS_MS, withCallBudgets } from "../server/paseo-port.ts";

test("a daemon call that never answers rejects at its budget instead of holding the queue", async () => {
  const port = {
    inspect: () => new Promise(() => {}),
    send: async (id) => `sent ${id}`,
    compact: () => new Promise(() => {}),
  };
  const bounded = withCallBudgets(port, { inspect: 30, send: 30 });
  const started = Date.now();
  await assert.rejects(bounded.inspect("A"), /Paseo 응답 시간 초과\(inspect, 0초\)/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(await bounded.send("A"), "sent A");
  // Calls without a budget keep their own bounds and are passed through untouched.
  assert.equal(bounded.compact, port.compact);
});

test("budgets keep the original receiver and arguments", async () => {
  const port = {
    prefix: "ws:",
    async rename(id, title) {
      return `${this.prefix}${id}:${title}`;
    },
  };
  assert.equal(await withCallBudgets(port, { rename: 1000 }).rename("1", "t"), "ws:1:t");
});

test("every lifecycle-critical call has a budget, and sends are bounded tighter than creation", () => {
  for (const name of ["inspect", "send", "history", "create", "createWorktree", "rename"])
    assert.ok(CALL_BUDGETS_MS[name] > 0, name);
  assert.ok(CALL_BUDGETS_MS.send < CALL_BUDGETS_MS.create);
  assert.equal(CALL_BUDGETS_MS.compact, undefined, "compaction keeps its own 180-second bound");
});
