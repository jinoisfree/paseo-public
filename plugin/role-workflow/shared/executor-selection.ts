import { z } from "zod";

export const EXECUTOR_QUESTIONS = {
  provider: { header: "구현 제품", question: "구현 담당 제품을 선택하세요" },
  model: { header: "실행 모델", question: "선택한 제품의 구현 모델을 선택하세요" },
  thinking: { header: "실행 추론", question: "선택한 모델의 추론 수준을 선택하세요" },
} as const;
export type SelectionStage = keyof typeof EXECUTOR_QUESTIONS;
export const selectionStageLabel = { provider: "제품", model: "모델", thinking: "추론", ready: "선택 완료" } as const;
export const executorSelectionSchema = z.object({
  stage: z.enum(["provider", "model", "thinking", "ready"]).default("provider"),
  provider: z.enum(["codex", "claude"]).nullable().default(null),
  model: z.string().default(""),
  // null is unanswered; the empty string is confirmed 'no supported thinking option'.
  thinking: z.string().nullable().default(null),
  pending: z.object({ id: z.string(), stage: z.enum(["provider", "model", "thinking"]) }).nullable().default(null),
  answered: z.array(z.string()).default([]),
  explicitRead: z.boolean().default(false),
  error: z.string().default(""),
});
export type ExecutorSelection = z.infer<typeof executorSelectionSchema>;
