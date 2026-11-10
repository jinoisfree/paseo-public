import { z } from "zod";
type ThinkingModel = { thinkingOptions?: readonly { id: string; label: string; isDefault?: boolean }[] };
import { capabilities } from "./capabilities";

/** Every thinking option of the model; an empty id is offered only when the model has none. */
export function pickerThinking(model: ThinkingModel | undefined) {
  if (!model) return [];
  if (!model.thinkingOptions?.length) return [{ id: "", label: "추론 없음", isDefault: true }];
  return model.thinkingOptions.map((option) => ({
    ...option,
    label: `${option.label}${option.isDefault ? " (기본)" : ""}`,
  }));
}

/** The default to preselect: the catalog default, or none when the catalog states none. */
export function pickerDefaultThinking(model: ThinkingModel | undefined) {
  const options = pickerThinking(model);
  return (options.find((option) => option.isDefault) ?? options[0])?.id ?? null;
}

/** Offered until an executor exists, and again while that executor's selection is not ready. */
export function picksExecutor(w: {
  contract?: number;
  mode: string;
  status: string;
  executeAgentId: string | null;
  selection?: { stage?: string } | null;
}) {
  const stranded = !!w.executeAgentId && !!w.selection && w.selection.stage !== "ready";
  return capabilities(w).executorSelection && (!w.executeAgentId || stranded) && w.status !== "completed";
}

/** The in-chat picker card posted when a contract 5 flow becomes federated. */
export const executorPickerCardSchema = z.object({ workflowId: z.string() }).strict();

const REVIEW_PENDING = ["reviewing", "revising"];
const LIMIT_REASON = "검증 한도 처리(미통과로 승인 또는 검토 1회 더)";

/** Raw card values the picker buttons' disabled state is derived from. */
export type PickerBlockerInput = {
  contract: number;
  mode: string;
  firstPlan?: boolean;
  /** Hash of the held plan the card displays; null while no plan is held. */
  approvalHash: string | null;
  /** Review enabled flag persisted by the engine. */
  savedReview: boolean | null;
  /** Review enabled flag drafted in the card. */
  localReview: boolean | null;
  /** The drafted review provider, model and thinking are all chosen and offered. */
  localReviewComplete: boolean;
  stage?: string;
  reviewHash?: string;
  placement: string | null;
  model: string;
  thinking: string | null;
};

/**
 * Why a picker button cannot be pressed. `choose` is what the user can still pick in the card and `wait` is
 * what only the system can finish; both empty means the button is enabled. Busy is not a reason here.
 * The "automatic" button exists only for contract 7 and later.
 */
export function pickerBlockers(input: PickerBlockerInput, kind: "primary" | "automatic"): { choose: string[]; wait: string[] } {
  const { stage } = input;
  const gated = input.firstPlan ?? input.contract >= 6;
  const approved = input.approvalHash !== null;
  const earlyDraft = input.contract >= 7 && input.mode === "federated" && !approved;
  const pending = REVIEW_PENDING.includes(stage ?? "");
  const automatic = kind === "automatic" || earlyDraft;
  const review: string[] = [], wait: string[] = [];
  if (gated && !approved && !earlyDraft) wait.push("현재 계획 대기");
  if (automatic) {
    if (input.localReview === null) review.push("계획 검증 켜기/끄기");
    else if (input.localReview && !input.localReviewComplete && !pending) review.push("검증 제품·모델·추론");
    if (pending) wait.push("계획 검증 진행 중");
    if (stage === "limit") review.push(LIMIT_REASON);
    if (stage === "done") wait.push("계획 검증 기록 완료");
  } else if (input.contract >= 7) {
    const skipped = input.savedReview === false && !pending;
    const passed = approved && stage === "passed" && input.reviewHash === input.approvalHash;
    if (!skipped && !passed) {
      if (pending) wait.push("계획 검증 진행 중");
      else if (stage === "limit") review.push(LIMIT_REASON);
      else if (stage === "passed") wait.push("계획이 바뀌어 재검증 대기");
      else if (stage === "unverified_approved") wait.push("미통과 승인 처리 중");
      else if (stage === "done") wait.push("계획 검증 기록 완료");
      else review.push("계획 검증 확정(검증 선택·시작 또는 검증 끄기 확정)");
    }
  }
  const choose = [...review];
  if (!input.model) choose.push("구현 모델");
  else if (input.thinking === null) choose.push("구현 추론");
  if (automatic && !input.placement) choose.push("겹칠 때 배치");
  return { choose, wait };
}
