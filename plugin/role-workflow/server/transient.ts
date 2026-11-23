import { z } from "zod";
import { usageLimit, permanentFailure } from "./quota";

export const transientPauseSchema = z.object({
  role: z.enum(["plan", "execute", "reviewer"]),
  phase: z.enum(["plan", "execute", "review"]),
  failure: z.string(),
  prompt: z.string().nullable().default(null),
  instruction: z.boolean().default(false),
  budgetCharged: z.boolean().default(false),
  sourcePendingId: z.string().nullable().default(null),
  lastCheckedAt: z.number().nullable().default(null),
  attempts: z.number().int().nonnegative(),
  checksFailed: z.number().int().nonnegative().default(0),
  nextCheckAt: z.number(),
  firstAt: z.number(),
  kind: z.enum(["turn", "error"]),
});
export function transientFailure(text: string, code?: string): boolean {
  if (permanentFailure(text, code)) return false;
  if (usageLimit("codex", text, code) || usageLimit("claude", text, code)) return false;
  if (code === "rate_limit_exceeded" || /rate[ -]?limit|too many requests|\b429\b/i.test(text)) return true;
  return /at capacity|overloaded|\b(?:529|500|502|503|504)\b|\b(?:timeout|timed\s+out)\b|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)\b|socket hang up|network error|fetch failed|DaemonConnectionError|Transport not connected|\bdisconnected\b|app-server exited/i.test(
    text,
  );
}
export function transientDelay(attempts: number): number {
  return [1, 3, 10, 30, 60][Math.min(Math.max(attempts, 0), 4)] * 60_000;
}
