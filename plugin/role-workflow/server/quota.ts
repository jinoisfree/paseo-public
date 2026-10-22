import { z } from "zod";
import type { PaseoProviderUsageResult } from "@getpaseo/client";
type ProviderUsage = PaseoProviderUsageResult["providers"][number];

export const quotaPauseSchema = z.object({
  role: z.enum(["plan", "execute"]),
  provider: z.enum(["codex", "claude"]),
  stoppedAt: z.number(),
  retryAt: z.number().nullable(),
  account: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  accountRetry: z.boolean().default(false),
  nextCheckAt: z.number(),
  lastCheckedAt: z.number().nullable(),
  prompt: z.string().nullable(),
  phase: z.enum(["plan", "execute", "review"]),
});
export type QuotaPause = z.infer<typeof quotaPauseSchema>;
export const QUOTA_CHECK_MS = 60_000;
export const QUOTA_ACCOUNT_SETTLE_MS = 120_000;
export const QUOTA_MAX_AGE = 14 * 24 * 60 * 60_000;
export function quotaDelay(attempts: number): number {
  return [5, 15, 30, 60][Math.min(Math.max(attempts - 1, 0), 3)] * 60_000;
}

/** Only messages observed in Codex failures or the installed Claude SDK are accepted. */
export function usageLimit(provider: string, failure: string): { retryAt: number | null } | null {
  const text = failure.replaceAll("’", "'");
  const recognized =
    provider === "codex"
      ? /you've hit your usage limit\b/i.test(text)
      : // @anthropic-ai/claude-agent-sdk/sdk.mjs, installed with Paseo 0.10.3.
        provider === "claude" && /you're out of extra usage\b/i.test(text);
  if (!recognized) return null;
  return { retryAt: retryTime(text) };
}

function retryTime(text: string): number | null {
  const match =
    /try again at (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b/i.exec(
      text,
    );
  if (!match) return null;
  const month = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].indexOf(match[1].toLowerCase());
  const day = Number(match[2]),
    year = Number(match[3]),
    hour = Number(match[4]),
    minute = Number(match[5]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const time = new Date(
    year,
    month,
    day,
    (hour % 12) + (match[6].toUpperCase() === "PM" ? 12 : 0),
    minute,
  );
  return time.getFullYear() === year && time.getMonth() === month && time.getDate() === day
    ? time.getTime()
    : null;
}

/** Every applicable window must be known and have headroom; credits alone are not enough. */
export function usageAvailable(usage: ProviderUsage): boolean | null {
  if (usage.status !== "available" || usage.error) return null;
  const required = usage.providerId === "codex" ? ["session", "weekly"] : ["five_hour", "weekly"];
  const windows = usage.windows.filter((window) => window.id !== "code_review");
  if (!required.every((id) => windows.some((window) => window.id === id))) return null;
  const remaining = windows.map(
    (window) => window.remainingPct ?? (window.usedPct == null ? null : 100 - window.usedPct),
  );
  if (remaining.some((value) => value !== null && value <= 0)) return false;
  return remaining.every(
    (value) => value !== null && Number.isFinite(value) && value > 0 && value <= 100,
  )
    ? true
    : null;
}

function sameQuota(previous: QuotaPause | null, failure: Pick<QuotaPause, "role" | "provider">) {
  if (previous?.role !== failure.role || previous.provider !== failure.provider) return null;
  return previous;
}

export function recordQuotaFailure(
  previous: QuotaPause | null,
  failure: Pick<QuotaPause, "role" | "provider" | "retryAt" | "account" | "prompt" | "phase">,
  now: number,
): QuotaPause {
  const saved = sameQuota(previous, failure);
  const changed =
    saved?.account != null && failure.account !== null && saved.account !== failure.account;
  const attempts = saved?.attempts ?? 0;
  const record: QuotaPause = {
    ...failure,
    stoppedAt: saved?.stoppedAt ?? now,
    account: failure.account ?? saved?.account ?? null,
    prompt: failure.prompt ?? saved?.prompt ?? null,
    attempts,
    accountRetry: saved?.accountRetry ?? false,
    nextCheckAt: now + (attempts ? quotaDelay(attempts) : QUOTA_CHECK_MS),
    lastCheckedAt: null,
  };
  if (changed) {
    record.attempts = 0;
    record.accountRetry = true;
    record.nextCheckAt = now + QUOTA_ACCOUNT_SETTLE_MS;
  }
  return record;
}

export function quotaCheckDue(record: QuotaPause, now: number): boolean {
  return (
    now - record.stoppedAt < QUOTA_MAX_AGE &&
    (record.lastCheckedAt === null || now - record.lastCheckedAt >= QUOTA_CHECK_MS)
  );
}
