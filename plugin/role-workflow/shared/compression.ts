import { z } from "zod";

export const ONE_MILLION_TOKENS = 1_000_000;
// Null keeps the existing common threshold. Personal policy values have no defaults.
export const claudeCompressionSchema = z.object({
  threshold: z.number().min(0.05).max(0.9),
  oneMillionTokenLimit: z.number().int().positive().max(ONE_MILLION_TOKENS),
}).nullable().default(null);
export type ClaudeCompression = z.infer<typeof claudeCompressionSchema>;
export type ContextUsage = { contextWindowUsedTokens: number; contextWindowMaxTokens: number };
export function contextUsage(usage?: Partial<ContextUsage> | null): ContextUsage | null {
  const used = usage?.contextWindowUsedTokens;
  const max = usage?.contextWindowMaxTokens;
  return typeof used === "number" && Number.isFinite(used) && used >= 0 &&
    typeof max === "number" && Number.isFinite(max) && max > 0 && Number.isFinite(used / max)
    ? { contextWindowUsedTokens: used, contextWindowMaxTokens: max } : null;
}
export function contextRatio(usage?: Partial<ContextUsage> | null): number | null {
  const current = contextUsage(usage);
  return current ? current.contextWindowUsedTokens / current.contextWindowMaxTokens : null;
}
export type CompressionObservation = { usage: number | null; contextUsage?: ContextUsage | null };
export function compressionDecision(
  provider: string,
  settings: { threshold: number; claudeCompression: ClaudeCompression; codexCompression?: "threshold" | "native" },
  observation: CompressionObservation | null,
) {
  const base = provider.split("/")[0];
  const unavailable = (reason: string) => ({ due: false, policy: "unavailable", reason });
  if (base !== "claude" && base !== "codex") return unavailable("지원 제공자를 확인할 수 없어 자동 압축하지 않습니다.");
  if (base === "codex" && settings.codexCompression === "native")
    return { due: false, policy: "native", reason: "Codex 자체 압축 사용: 플러그인 사용량 기반 선제 압축은 하지 않습니다." };
  const current = contextUsage(observation?.contextUsage);
  const override = base === "claude" ? settings.claudeCompression : null;
  if (override && !current)
    return unavailable("Claude 사용 토큰·컨텍스트 용량이 없거나 잘못되어 자동 압축하지 않습니다. 모델명으로 1M을 추정하지 않습니다.");
  if (override && current) {
    const used = current.contextWindowUsedTokens, max = current.contextWindowMaxTokens;
    if (max === ONE_MILLION_TOKENS) return {
      due: used >= override.oneMillionTokenLimit, policy: "claude-1m",
      reason: `Claude 1M: ${used.toLocaleString("en-US")} / ${max.toLocaleString("en-US")} 토큰 · 압축 기준 ${override.oneMillionTokenLimit.toLocaleString("en-US")} 토큰`,
    };
    return {
      due: used / max >= override.threshold, policy: "claude-ratio",
      reason: `Claude: ${used.toLocaleString("en-US")} / ${max.toLocaleString("en-US")} 토큰 · 압축 기준 ${Math.round(override.threshold * 100)}%`,
    };
  }
  // Old ports exposed only a validated ratio. Actual ports always supply contextUsage,
  // including null for unavailable data, so stale ratios cannot replace invalid raw data.
  const ratio = observation?.contextUsage === undefined ? observation?.usage : contextRatio(current);
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0)
    return unavailable("현재 컨텍스트 사용량이 없거나 잘못되어 자동 압축하지 않습니다.");
  return { due: ratio >= settings.threshold, policy: "common",
    reason: `${base === "codex" ? "Codex" : "Claude 공통 정책"}: 사용량 ${Math.round(ratio * 100)}% · 압축 기준 ${Math.round(settings.threshold * 100)}%` };
}
