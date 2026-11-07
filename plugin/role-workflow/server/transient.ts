import { z } from "zod";
import { usageLimit } from "./quota";

export const transientPauseSchema = z.object({
  role: z.enum(["plan", "execute"]),
  phase: z.enum(["plan", "execute", "review"]),
  failure: z.string(),
  attempts: z.number().int().nonnegative(),
  nextCheckAt: z.number(),
  firstAt: z.number(),
  kind: z.enum(["turn", "error"]),
});
export function transientFailure(text: string): boolean {
  if (usageLimit("codex", text) || usageLimit("claude", text)) return false;
  if (/rate[ -]?limit|too many requests|\b429\b/i.test(text)) return false;
  return /at capacity|overloaded|\b(?:529|500|502|503|504)\b|\b(?:timeout|timed\s+out)\b|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)\b|socket hang up|network error|fetch failed|DaemonConnectionError|Transport not connected|\bdisconnected\b|app-server exited/i.test(
    text,
  );
}
export function transientDelay(attempts: number): number {
  return [1, 3, 10, 30, 60][Math.min(Math.max(attempts, 0), 4)] * 60_000;
}
