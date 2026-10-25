// Adapted for paseo-public: phone notifications require explicit user configuration.
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import path from "node:path";
import type { NotificationEvent } from "./engine";

interface PostInit {
  method: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  body: string;
}
interface PostResponse {
  ok: boolean;
  status: number;
  json(): ReturnType<Response["json"]>;
}
type Fetcher = (url: string, init: PostInit) => Promise<PostResponse>;

interface Options {
  enabled?: boolean;
  endpoint?: string;
  configPath?: string;
  home?: string;
  fetch?: Fetcher;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * POST through node:https instead of the global fetch. Electron's bundled undici
 * (Node 24.20) once threw setTypeOfService EINVAL from a socket event handler,
 * outside any promise, which killed the whole plugin process. node:https reports
 * socket failures as request errors, so a failed notification stays a failed
 * notification.
 */
export function postJson(
  url: string,
  init: PostInit,
  request = httpsRequest,
): Promise<PostResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: init.method, headers: init.headers, signal: init.signal },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}
interface Result {
  tokens: number;
  status: number | null;
  ok: boolean;
  error: string | null;
}
export function createNotifier(options: Options = {}) {
  const home = options.home ?? process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
  const fetcher: Fetcher = options.fetch ?? postJson,
    now = options.now ?? Date.now;
  const log = options.log ?? console.error;
  async function destination(): Promise<string | null> {
    let config: { phoneNotifications?: boolean; phoneNotificationEndpoint?: string } = {};
    try {
      config = JSON.parse(await readFile(options.configPath ?? path.join(homedir(), ".config/paseo-public/config.json"), "utf8"));
    } catch { /* Missing configuration leaves phone notifications off. */ }
    const enabled = options.enabled ?? config.phoneNotifications === true;
    const endpoint = options.endpoint ?? config.phoneNotificationEndpoint;
    if (!enabled || !endpoint) return null;
    try { return new URL(endpoint).protocol === "https:" ? endpoint : null; }
    catch { return null; }
  }
  async function tokens(): Promise<string[]> {
    if (!await destination()) return [];
    try {
      const value = JSON.parse(await readFile(path.join(home, "push-tokens.json"), "utf8"));
      if (!Array.isArray(value.subscriptions)) return [];
      return [
        ...new Set<string>(
          value.subscriptions
            .filter(
              (s: { token?: unknown; expiresAt?: unknown }) =>
                typeof s?.token === "string" &&
                s.token.length > 0 &&
                typeof s.expiresAt === "string" &&
                Date.parse(s.expiresAt) > now(),
            )
            .map((s: { token: string }) => s.token),
        ),
      ];
    } catch {
      return [];
    }
  }
  const limit = (s: string, n: number) =>
    Array.from(s.replace(/\s+/g, " ").trim()).slice(0, n).join("");
  return {
    async activeCount() {
      return (await tokens()).length;
    },
    async send(event: NotificationEvent): Promise<Result> {
      const active = await tokens();
      const endpoint = await destination();
      const result: Result = { tokens: active.length, status: null, ok: true, error: null };
      if (!active.length || !endpoint) return result;
      let serverId = "";
      try {
        serverId = (await readFile(path.join(home, "server-id"), "utf8")).trim();
      } catch {
        /* Optional for unpaired homes. */
      }
      const data = {
        serverId,
        workspaceId: event.workspaceId,
        agentId: event.agentId,
        reason: { permission: "permission", stopped: "error", completed: "finished", waiting: "permission" }[event.kind],
      };
      for (let i = 0; i < active.length; i += 100) {
        try {
          const response = await fetcher(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            signal: AbortSignal.timeout(10000),
            body: JSON.stringify(
              active.slice(i, i + 100).map((to) => ({
                to,
                title: limit(event.title, 80),
                body: limit(event.body, 220),
                data,
                sound: "default",
              })),
            ),
          });
          if (result.ok) result.status = response.status;
          if (!response.ok) {
            result.ok = false;
            result.error = `HTTP ${response.status}`;
          } else {
            const payload = await response.json();
            const tickets = Array.isArray(payload.data) ? payload.data : [payload.data];
            const errors = tickets.filter(
              (ticket: { status?: string } | null) => !ticket || ticket.status !== "ok",
            );
            if (errors.length || payload.errors?.length) {
              result.ok = false;
              const knownCodes = new Set([
                "DeviceNotRegistered",
                "MessageTooBig",
                "MessageRateExceeded",
                "MismatchSenderId",
                "InvalidCredentials",
              ]);
              const codes = errors.flatMap((ticket: { details?: { error?: string } } | null) =>
                ticket?.details?.error && knownCodes.has(ticket.details.error)
                  ? [ticket.details.error]
                  : [],
              );
              result.error = `Expo ticket errors: ${errors.length || payload.errors.length}${codes.length ? ` (${[...new Set(codes)].join(", ")})` : ""}`;
            }
          }
        } catch {
          result.ok = false;
          result.error = "알림 전송 실패 또는 시간 초과";
        }
      }
      // Never log Expo messages or exception text: either may contain a token.
      try {
        log(
          `role-workflow notification: tokens=${result.tokens} status=${result.status} ok=${result.ok} error=${result.error}`,
        );
      } catch {
        /* Logging must not interrupt a workflow. */
      }
      return result;
    },
  };
}
