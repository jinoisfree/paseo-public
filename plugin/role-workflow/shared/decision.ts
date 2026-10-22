import { z } from "zod";
import { repositoryPathsSchema, pushTargetsSchema, verificationSchema } from "./artifacts";

export const decisionSchema = z
  .object({
    executorThinking: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,40}$/)
      .optional(),
    executorModel: z
      .string()
      .regex(/^(?:codex|claude)\/[^\s]+$/)
      .max(120)
      .optional(),
    status: z.enum(["plan", "result", "continue", "complete", "input", "note"]),
    summary: z.string().min(1).max(16000),
    next: z.string().max(32000).default(""),
    handoff: z.string().min(1).max(32000),
    remember: z.array(z.string().max(500)).max(10).default([]),
    checks: z.array(z.string().max(4000)).max(30).default([]),
    repositories: repositoryPathsSchema.optional(),
    pushTargets: pushTargetsSchema.optional(),
    verification: z.array(verificationSchema).max(30).optional(),
    constraints: z
      .array(z.object({ id: z.string().min(1).max(120), text: z.string().max(1000) }))
      .max(10)
      .optional(),
  })
  .strict();
export type Decision = z.infer<typeof decisionSchema>;

/** Carries what was wrong with the block so the agent can be asked to fix exactly that. */
export class DecisionError extends Error {
  constructor(readonly reason: string) {
    super(`응답 끝의 작업 상태를 읽지 못했습니다(${reason}). 내용을 확인하고 재개하세요.`);
  }
}
function describe(error: unknown): string {
  if (error instanceof z.ZodError)
    return `필드 오류: ${error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "블록"} ${issue.message}`)
      .join("; ")}`;
  return `JSON 형식 오류: ${error instanceof Error ? error.message : String(error)}`;
}

export function parseDecision(text: string): Decision {
  const opening = "<paseo-workflow>";
  const closing = /<\/paseo-workflow>\s*$/.exec(text);
  let reason = text.includes(opening)
    ? "상태 블록이 응답의 맨 끝에 있지 않거나 닫는 태그가 없음"
    : "상태 블록이 없음";
  if (closing) {
    let candidate = text.lastIndexOf(opening, closing.index);
    let last = true;
    while (candidate !== -1) {
      let parsed: Decision | null = null;
      try {
        parsed = decisionSchema.parse(
          JSON.parse(text.slice(candidate + opening.length, closing.index)),
        );
      } catch (error) {
        // A tag mentioned inside JSON or an earlier example is not the final block,
        // so only the innermost candidate explains the failure.
        if (last) reason = describe(error);
      }
      if (parsed) {
        if ((parsed.status === "plan" || parsed.status === "continue") && !parsed.next.trim())
          throw new DecisionError("plan·continue의 next가 비어 있음");
        return parsed;
      }
      last = false;
      candidate = candidate === 0 ? -1 : text.lastIndexOf(opening, candidate - 1);
    }
  }
  throw new DecisionError(reason);
}
