// Fake Anthropic Messages API for the role-workflow e2e. The approach (one local port, a control
// file re-read per request, a JSONL request log) follows babo-jeonguk/paseo-usage-auto-resume (MIT).
// Control file: { "mode": "text" | "limit", "text": "reply" }
// usage: node fake-models.mjs <port> <controlFile> <logFile>
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";

const [port, controlFile, logFile] = process.argv.slice(2);
const control = () => {
  try {
    return JSON.parse(readFileSync(controlFile, "utf8"));
  } catch {
    return {};
  }
};
const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((block) => block.text ?? "").filter(Boolean).join(" ");

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    const json = (status, value, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    if (!req.url.startsWith("/v1/messages")) return json(404, { error: "fixture" });
    if (req.url.includes("count_tokens")) return json(200, { input_tokens: 10 });
    const { mode = "text", text = "Done." } = control();
    const last = textOf((parsed.messages ?? []).filter((m) => m.role === "user").at(-1)?.content);
    appendFileSync(
      logFile,
      JSON.stringify({ at: new Date().toISOString(), mode, system: JSON.stringify(parsed.system ?? "").length, last: last.slice(-2000) }) + "\n",
    );
    if (mode === "limit") {
      const reset = Math.floor(Date.now() / 1000) + 5400;
      return json(
        429,
        { type: "error", error: { type: "rate_limit_error", message: "usage limit" } },
        {
          "retry-after": "5400",
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": String(reset),
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
        },
      );
    }
    const id = `msg_fixture_${Date.now()}`;
    const model = parsed.model ?? "claude-fixture";
    const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    if (!parsed.stream)
      return json(200, { id, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const [event, data] of [
      ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
      ["message_stop", { type: "message_stop" }],
    ])
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`fake models on ${port}`));
