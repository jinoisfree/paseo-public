import { z } from "zod";
import { executorSelectionSchema } from "./executor-selection";

export const planReviewVerdictSchema = z.object({
  planHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  verdict: z.enum(["APPROVED", "BLOCKED"]),
  findings: z.array(z.object({
    id: z.string().min(1), severity: z.enum(["차단", "권고"]),
    text: z.string().min(1).max(2000), evidence: z.string().min(1).max(2000),
  }).strict()).max(30),
}).strict().superRefine((value, ctx) => {
  const blocked = value.findings.some(f => f.severity === "차단");
  if ((value.verdict === "BLOCKED") !== blocked)
    ctx.addIssue({ code: "custom", message: "BLOCKED는 차단 지적이 필요하고 APPROVED는 차단 지적을 허용하지 않습니다." });
});
export const reviewSelectionSchema = executorSelectionSchema.extend({ enabled: z.boolean().nullable().default(null) });
export const planReviewSchema = z.object({
  stage: z.enum(["off", "waiting_choice", "reviewing", "revising", "passed", "limit", "unverified_approved", "done"]).default("waiting_choice"),
  round: z.number().int().nonnegative().default(0),
  maxRounds: z.number().int().positive().default(2),
  hash: z.string().default(""),
  verdict: planReviewVerdictSchema.nullable().default(null),
  path: z.string().default(""),
  outcome: z.enum(["passed", "unverified_approved", "off"]).nullable().default(null),
  error: z.string().default(""),
});
export type PlanReview = z.infer<typeof planReviewSchema>;
export type ReviewSelection = z.infer<typeof reviewSelectionSchema>;

export function reviewerEligibility(planner: string, provider: string, model: string,
  enabled: boolean, modes: readonly string[], mode: string): string | null {
  if (!enabled) return "꺼진 제품입니다.";
  // Codex exposes auto in its mode catalog; its reviewer gets a per-agent read-only
  // sandbox independently of that mode. Keep native read-only catalogs compatible.
  if (!(provider === "codex" ? ["auto", "read-only"].includes(mode) : mode === "plan")) return "읽기 전용 권한 모드가 아닙니다.";
  if (!modes.includes(mode)) return `읽기 전용 권한 모드 ${mode}를 사용할 수 없습니다.`;
  if (planner === provider) return "계획 담당 모델을 확인한 뒤 같은 제품의 검증 모델을 선택하세요.";
  if (planner === `${provider}/${model}`) return "계획 담당과 다른 (제품, 모델)을 선택하세요.";
  return null;
}
