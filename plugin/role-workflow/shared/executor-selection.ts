import { z } from "zod";

export const EXECUTOR_QUESTIONS = {
  provider: { header: "구현 제품", question: "구현 담당 제품을 선택하세요" },
  model: { header: "실행 모델", question: "선택한 제품의 구현 모델을 선택하세요" },
  thinking: { header: "실행 추론", question: "선택한 모델의 추론 수준을 선택하세요" },
} as const;
export type SelectionStage = keyof typeof EXECUTOR_QUESTIONS;
export const selectionStageLabel = { provider: "제품", model: "모델", thinking: "추론", ready: "선택 완료" } as const;
const stageSchema = z.enum(["provider", "model", "thinking"]);
export const selectionFieldSchema = z.object({ stage: stageSchema, keys: z.array(z.string()) });
export type SelectionField = z.infer<typeof selectionFieldSchema>;
export const executorSelectionSchema = z.object({
  stage: z.enum(["provider", "model", "thinking", "ready"]).default("provider"),
  provider: z.enum(["codex", "claude"]).nullable().default(null),
  model: z.string().default(""),
  // null is unanswered; the empty string is confirmed 'no supported thinking option'.
  thinking: z.string().nullable().default(null),
  // stage is retained only to read already-open sequential questions.
  pending: z.object({ id: z.string(), stage: stageSchema.optional(), fields: z.array(selectionFieldSchema).optional(), received: z.array(stageSchema).default([]) }).nullable().default(null),
  responses: z.object({ provider: z.string().optional(), model: z.string().optional(), thinking: z.string().optional() }).optional(),
  answered: z.array(z.string()).default([]),
  explicitRead: z.boolean().default(false),
  error: z.string().default(""),
});
export type ExecutorSelection = z.infer<typeof executorSelectionSchema>;
