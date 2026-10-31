import { access } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import type { verdictSchema, verdictRecordSchema, verdictViewSchema } from "../shared/artifacts";

export const VERDICT_REPAIR =
  "완료 판정 정보가 없거나 맞지 않습니다(<사유>). 작업을 다시 하지 말고 30-verification 7.2에 따른 verdict.md 경로와 판정·검증 조건을 verdict에 담은 상태 블록만 다시 출력하세요. 완료가 아니면 complete 대신 plan 또는 input을 쓰세요.";

export async function verdictProblem(cwd: string, verdict?: z.infer<typeof verdictSchema>) {
  if (!verdict) return "판정 없음";
  if (verdict.judgement !== "완료") return `판정이 ${verdict.judgement}`;
  try {
    await access(path.resolve(cwd, verdict.path));
    return "";
  } catch {
    return "판정 보고 경로 없음 또는 접근 불가";
  }
}

export function verdictView(w: {
  verdict: z.infer<typeof verdictRecordSchema> | null;
  verdictIssue: string;
}): z.infer<typeof verdictViewSchema> | null {
  if (!w.verdict && !w.verdictIssue) return null;
  let status: z.infer<typeof verdictViewSchema>["status"] = w.verdict?.judgement ?? "판정 없음";
  if (w.verdictIssue) status = w.verdictIssue === "판정 없음" ? "판정 없음" : "판정 불일치";
  return {
    status,
    path: w.verdict?.path ?? null,
    condition: w.verdict?.condition ?? null,
    recordedAt: w.verdict?.recordedAt ?? null,
    reason: w.verdictIssue,
  };
}
