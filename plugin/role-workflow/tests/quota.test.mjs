import { test } from "node:test";
import assert from "node:assert/strict";
import { usageLimit, usageAvailable } from "../server/quota.ts";
import { transientFailure, transientDelay } from "../server/transient.ts";
import { quotaAccount, createPort } from "../server/paseo-port.ts";
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("quota classifier accepts only observed provider messages and parses local time strictly", () => {
  assert.deepEqual(
    usageLimit("codex", "You’ve hit your usage limit. try again at Oct 14th, 2026 9:36 PM."),
    { retryAt: new Date(2026, 9, 14, 21, 36).getTime() },
  );
  for (const date of ["Oct 14th, 2026 13:36 PM", "Feb 30th, 2026 9:00 AM", "later"])
    assert.deepEqual(usageLimit("codex", `You've hit your usage limit. try again at ${date}`), {
      retryAt: null,
    });
  assert.deepEqual(usageLimit("claude", "You're out of extra usage"), { retryAt: null });
  for (const error of [
    "network error",
    "rate limit",
    "context window limit",
    "You've hit your usage limit",
  ])
    assert.equal(usageLimit("claude", error), null);
});
const usage = (windows) => ({ providerId: "codex", status: "available", error: null, windows });
test("transient failures classify capacity, server, transport and app-server errors without quota", () => {
  for (const failure of [
    "Selected model is at capacity. Please try a different model.",
    "OVERLOADED",
    "API error 529",
    "HTTP 500",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "504 gateway timeout",
    "request timeout",
    "Request timed out",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "socket hang up",
    "network error",
    "fetch failed",
    "DaemonConnectionError: Transport not connected (status: disconnected)",
    "disconnected",
    "Codex app-server exited with code 127 and signal null",
  ])
    assert.equal(transientFailure(failure), true, failure);
  for (const failure of [
    "",
    "canceled",
    "permission denied",
    "context window limit",
    "HTTP 401",
    "HTTP 403",
    "HTTP 404",
    "HTTP 429 rate limit",
    "rate limit: overloaded",
    "Too many requests: 503",
    "You've hit your usage limit: timeout",
    "You’re out of extra usage: network error",
    "자동 응답 횟수 한도에 도달했습니다.",
    "전달 여부를 확인할 수 없습니다.",
  ])
    assert.equal(transientFailure(failure), false, failure);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(transientDelay),
    [1, 3, 10, 30, 60, 60].map((n) => n * 60_000),
  );
});
const free = [
  { id: "session", remainingPct: 20 },
  { id: "weekly", usedPct: 30 },
];
test("usage must have known headroom in all relevant windows", () => {
  assert.equal(usageAvailable(usage(free)), true);
  assert.equal(usageAvailable(usage([...free, { id: "code_review", remainingPct: 0 }])), true);
  assert.equal(
    usageAvailable(
      usage([
        { id: "session", remainingPct: 100 },
        { id: "weekly", remainingPct: 0 },
      ]),
    ),
    false,
  );
  assert.equal(usageAvailable(usage([{ id: "session", remainingPct: 100 }])), null);
  assert.equal(
    usageAvailable(usage([{ id: "session", remainingPct: 100 }, { id: "weekly" }])),
    null,
  );
  assert.equal(usageAvailable({ ...usage(free), status: "error" }), null);
  assert.equal(usageAvailable({ ...usage(free), error: "fetch failed" }), null);
  assert.equal(
    usageAvailable({
      ...usage(free),
      providerId: "claude",
      windows: [
        { id: "five_hour", remainingPct: 20 },
        { id: "weekly", remainingPct: 30 },
      ],
    }),
    true,
  );
});
test("account identity reads link targets only and treats refreshed regular files as unknown", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "quota-account-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "codex-home"));
  const active = path.join(home, "codex-home/auth.json");
  const a = path.join(home, "a.json"),
    b = path.join(home, "b.json");
  await writeFile(a, "not even JSON");
  await writeFile(b, "not even JSON");
  await symlink(a, active);
  assert.equal(await quotaAccount("codex", home), await realpath(a));
  await unlink(active);
  await writeFile(active, "refreshed regular file");
  assert.equal(await quotaAccount("codex", home), null);
  await unlink(active);
  await symlink(b, active);
  assert.equal(await quotaAccount("codex", home), await realpath(b));
  assert.equal(await quotaAccount("claude", home), null);
});
test("usage recovery is disabled for Claude even with available, failed or stale data", async () => {
  let calls = 0;
  const port = createPort(() => ({
    providers: {
      listUsage: async () => {
        calls++;
        return {
          fetchedAt: new Date().toISOString(),
          providers: [
            {
              ...usage(free),
              providerId: "claude",
              windows: [
                { id: "five_hour", remainingPct: 20 },
                { id: "weekly", remainingPct: 30 },
              ],
            },
          ],
        };
      },
    },
  }));
  assert.equal(await port.quotaAvailable("claude"), null);
  assert.equal(await port.quotaAvailable("claude"), null);
  assert.equal(calls, 0);
  const failed = createPort(() => ({
    providers: {
      listUsage: async () => {
        throw Error("offline");
      },
    },
  }));
  assert.equal(await failed.quotaAvailable("claude"), null);
  const stale = createPort(() => ({
    providers: {
      listUsage: async () => ({
        fetchedAt: "2020-01-01T00:00:00Z",
        providers: [
          {
            ...usage(free),
            providerId: "claude",
            windows: [
              { id: "five_hour", remainingPct: 20 },
              { id: "weekly", remainingPct: 30 },
            ],
          },
        ],
      }),
    },
  }));
  assert.equal(await stale.quotaAvailable("claude"), null);
});

test("Codex quota lookup stays unknown without calling the usage API even when available", async () => {
  let calls = 0;
  const port = createPort(() => ({
    providers: {
      listUsage: async () => {
        calls++;
        return { fetchedAt: new Date().toISOString(), providers: [usage(free)] };
      },
    },
  }));
  assert.equal(await port.quotaAvailable("codex"), null);
  assert.equal(calls, 0);
});
