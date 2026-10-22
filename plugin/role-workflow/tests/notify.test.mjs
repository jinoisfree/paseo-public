// Adapted for paseo-public: portable fixtures and explicit notification opt-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { createNotifier, postJson } from "../server/notify.ts";
const event = {
  kind: "permission",
  title: "  title\n line ",
  body: "body ".repeat(100),
  agentId: "a",
  workspaceId: "w",
};
test("notifier filters expiration, preserves token file and uses attention payload", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "notify-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "push-tokens.json");
  const source = JSON.stringify({
    subscriptions: [
      { token: "SECRET", expiresAt: "2030-01-01" },
      { token: "expired", expiresAt: "2020-01-01" },
      { token: "bad", expiresAt: "invalid" },
      null,
    ],
  });
  await writeFile(file, source);
  await writeFile(path.join(home, "server-id"), "server\n");
  const requests = [];
  const notifier = createNotifier({ enabled: true, endpoint: "https://example.invalid/push",
    home,
    now: () => Date.parse("2026-01-01"),
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      return new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 });
    },
  });
  assert.equal(await notifier.activeCount(), 1);
  assert.deepEqual(await notifier.send(event), { tokens: 1, status: 200, ok: true, error: null });
  const payload = JSON.parse(requests[0].body);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].to, "SECRET");
  assert.equal(payload[0].title, "title line");
  assert.ok(payload[0].body.length <= 220);
  assert.deepEqual(payload[0].data, {
    serverId: "server",
    workspaceId: "w",
    agentId: "a",
    reason: "permission",
  });
  assert.equal(payload[0].sound, "default");
  assert.equal(await readFile(file, "utf8"), source);
});
test("missing/corrupt token file sends nothing; exceptions, HTTP and ticket errors are sanitized", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "notify-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const logs = [];
  const notifier = createNotifier({ enabled: true, endpoint: "https://example.invalid/push",
    home,
    fetch: async () => {
      throw Error("SECRET");
    },
    log: (s) => logs.push(s),
  });
  assert.equal((await notifier.send(event)).tokens, 0);
  await writeFile(path.join(home, "push-tokens.json"), "broken");
  assert.equal(await notifier.activeCount(), 0);
  await writeFile(
    path.join(home, "push-tokens.json"),
    JSON.stringify({ subscriptions: [{ token: "SECRET", expiresAt: "2030-01-01" }] }),
  );
  for (const fetch of [
    async () => {
      throw Error("SECRET");
    },
    async () => new Response("SECRET", { status: 500 }),
    async () =>
      new Response(
        JSON.stringify({
          data: [{ status: "error", message: "SECRET", details: { error: "DeviceNotRegistered" } }],
        }),
      ),
  ]) {
    const result = await createNotifier({ enabled: true, endpoint: "https://example.invalid/push", home, fetch, log: (s) => logs.push(s) }).send(event);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
  assert.ok(!logs.join("").includes("SECRET"));
});
test("notifier batches at 100 and maps stop/completion reasons", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "notify-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(
    path.join(home, "push-tokens.json"),
    JSON.stringify({
      subscriptions: Array.from({ length: 101 }, (_, i) => ({
        token: `t${i}`,
        expiresAt: "2030-01-01",
      })),
    }),
  );
  const batches = [];
  const n = createNotifier({ enabled: true, endpoint: "https://example.invalid/push",
    home,
    fetch: async (_, init) => {
      const p = JSON.parse(init.body);
      batches.push(p);
      return new Response(JSON.stringify({ data: p.map(() => ({ status: "ok" })) }));
    },
  });
  await n.send({ ...event, kind: "stopped" });
  assert.deepEqual(
    batches.map((b) => b.length),
    [100, 1],
  );
  assert.equal(batches[0][0].data.reason, "error");
  await n.send({ ...event, kind: "completed" });
  assert.equal(batches[2][0].data.reason, "finished");
});

test("postJson sends the body over node:http(s) and reports status, json and socket errors", async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, type: req.headers["content-type"], body });
      if (req.url === "/slow") return; // never answers; the abort signal must end it
      res.statusCode = req.url === "/fail" ? 500 : 200;
      res.end(JSON.stringify({ data: [{ status: "ok" }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '[{"to":"x"}]',
  };
  const ok = await postJson(`${base}/ok`, init, httpRequest);
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { data: [{ status: "ok" }] });
  assert.deepEqual(seen[0], { method: "POST", type: "application/json", body: '[{"to":"x"}]' });
  const failed = await postJson(`${base}/fail`, init, httpRequest);
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 500);
  await assert.rejects(
    postJson(`${base}/slow`, { ...init, signal: AbortSignal.timeout(100) }, httpRequest),
  );
  await assert.rejects(postJson("http://127.0.0.1:1/closed", init, httpRequest));
});
test("notifier treats a rejected transport as a sanitized failed send, not a crash", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "notify-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(
    path.join(home, "push-tokens.json"),
    JSON.stringify({ subscriptions: [{ token: "SECRET", expiresAt: "2030-01-01" }] }),
  );
  const logs = [];
  const result = await createNotifier({ enabled: true, endpoint: "https://example.invalid/push",
    home,
    fetch: (url, init) => postJson("http://127.0.0.1:1/closed", init, httpRequest),
    log: (s) => logs.push(s),
  }).send(event);
  assert.deepEqual(result, {
    tokens: 1,
    status: null,
    ok: false,
    error: "알림 전송 실패 또는 시간 초과",
  });
  assert.ok(!logs.join("").includes("SECRET"));
});


test("public distribution leaves phone notifications off until configured", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "notify-opt-in-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "push-tokens.json"), JSON.stringify({ subscriptions: [{ token: "fixture", expiresAt: "2030-01-01" }] }));
  const configPath = path.join(home, "config.json");
  const notifier = createNotifier({home, configPath});
  assert.equal(await notifier.activeCount(), 0);
  await writeFile(configPath, JSON.stringify({phoneNotifications:true, phoneNotificationEndpoint:"https://example.invalid/push"}));
  assert.equal(await notifier.activeCount(), 1);
  await writeFile(configPath, JSON.stringify({phoneNotifications:false, phoneNotificationEndpoint:"https://example.invalid/push"}));
  assert.equal(await notifier.activeCount(), 0);
});
