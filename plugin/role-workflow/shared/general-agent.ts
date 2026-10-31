import { z } from "zod";

export const GENERAL_QUESTIONS = {
  agent: { header: "구현 담당", question: "일반개발의 구현을 맡을 에이전트를 선택하세요" },
  model: { header: "구현 모델", question: "일반개발 구현 모델을 선택하세요" },
  thinking: { header: "구현 추론", question: "일반개발 구현 추론 강도를 선택하세요" },
} as const;
// Persisted conversations keep their original immutable prompts and question text.
export const LEGACY_GENERAL_QUESTIONS = {
  agent: { header: "일반 담당", question: "일반개발을 맡을 에이전트를 선택하세요" },
  model: { header: "일반 모델", question: "일반개발 담당 모델을 선택하세요" },
  thinking: { header: "일반 추론", question: "일반개발 담당 추론 강도를 선택하세요" },
} as const;
export const generalAgentSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  model: z.string(),
  thinking: z.string().default(""),
});
export type GeneralAgent = z.infer<typeof generalAgentSchema>;
export const generalStateSchema = z.object({
  selected: generalAgentSchema.nullable().default(null),
  provider: z.enum(["claude", "codex"]).nullable().default(null),
  questions: z.record(z.string(), z.array(z.enum(["agent", "model", "thinking"]))).default({}),
  settled: z.boolean().default(false),
  transfer: z
    .object({
      id: z.string(),
      agentId: z.string(),
      sourceId: z.string(),
      choice: generalAgentSchema,
      stage: z.enum(["queued", "sent", "failed"]),
    })
    .nullable()
    .default(null),
});
export const generalCardSchema = z.object({
  choice: generalAgentSchema,
  planner: generalAgentSchema.optional(),
  message: z.string(),
});
export function generalAgentLabel(
  choice: Pick<GeneralAgent, "provider" | "model"> & { thinking?: string },
): string {
  return `${choice.provider === "claude" ? "Claude Code" : "Codex"} · ${choice.model || "현재 모델"} · ${choice.thinking || "모델 기본값"}`;
}
