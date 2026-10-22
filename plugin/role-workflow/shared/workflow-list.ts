import type { z } from "zod";
import type { workflowViewSchema } from "./contracts";
type WorkflowView = z.input<typeof workflowViewSchema>;
export type WorkflowFilter = "all" | "general" | "federated";
export function workflowLabel(w: WorkflowView) {
  if (w.status === "needs_input") return "답변 필요";
  if (w.status === "error") return "확인 필요";
  if (w.generalTransition) return "일반개발 전환 대기";
  if (w.conflict) return "동시 작업 확인";
  if (w.status === "paused") return "일시정지";
  if (w.progress === "pushed") return "푸시 완료";
  if (w.status === "completed" || (w.mode !== "federated" && w.progress === "done"))
    return "구현 완료 · 미푸시";
  if (w.mode === "undecided") return "방식 선택 전";
  if (w.progress === "plan") return "계획";
  return "진행 중";
}
export function visibleWorkflows(workflows: readonly WorkflowView[], filter: WorkflowFilter) {
  const rank = (w: WorkflowView) => {
    if (["needs_input", "error"].includes(w.status) || w.conflict) return 0;
    if (w.status === "paused") return 2;
    if (["구현 완료 · 미푸시", "푸시 완료"].includes(workflowLabel(w))) return 3;
    return 1;
  };
  return workflows
    .filter((w) => filter === "all" || w.mode === filter)
    .toSorted((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
}
