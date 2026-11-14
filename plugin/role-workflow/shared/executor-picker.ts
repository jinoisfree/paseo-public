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
const LIMIT_REASON = "검증 횟수 소진 — '검증 통과 없이 구현' 또는 '검증 1회 더'";

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
  if (gated && !approved && !earlyDraft) wait.push("계획이 아직 나오지 않음");
  if (automatic) {
    if (input.localReview === null) review.push("계획 검증 받을지");
    else if (input.localReview && !input.localReviewComplete && !pending) review.push("검증할 AI(제품·모델·추론)");
    if (pending) wait.push("다른 AI가 계획을 검증하는 중");
    if (stage === "limit") review.push(LIMIT_REASON);
    if (stage === "done") wait.push("계획 검증이 이미 끝남");
  } else if (input.contract >= 7) {
    const skipped = input.savedReview === false && !pending;
    const passed = approved && stage === "passed" && input.reviewHash === input.approvalHash;
    if (!skipped && !passed) {
      if (pending) wait.push("다른 AI가 계획을 검증하는 중");
      else if (stage === "limit") review.push(LIMIT_REASON);
      else if (stage === "passed") wait.push("계획이 바뀌어 다시 검증해야 함");
      else if (stage === "unverified_approved") wait.push("검증 통과 없이 구현 요청을 처리하는 중");
      else if (stage === "done") wait.push("계획 검증이 이미 끝남");
      else review.push("계획 검증 확정 — '이 AI로 검증 시작' 또는 '검증 없이 진행'");
    }
  }
  const choose = [...review];
  if (!input.model) choose.push("구현 모델");
  else if (input.thinking === null) choose.push("구현 추론 수준");
  if (automatic && !input.placement) choose.push("다른 작업과 겹칠 때 방법");
  return { choose, wait };
}

export const BLINK_MS = 600;
export type FocusTarget = "review-toggle" | "review-provider" | "review-model" | "review-thinking" | "review-confirm" | "review-limit"
  | "executor-model" | "executor-thinking" | "placement" | "primary" | "automatic";
export type PickerFocusInput = {
  busy: boolean; stage?: string; earlyDraft: boolean; reviewRequired: boolean; automaticShown: boolean;
  localReview: boolean | null; reviewProvider: string | null; reviewModel: string; reviewThinking: string | null;
  model: string; thinking: string | null; placement: string | null;
  primaryEnabled: boolean; automaticEnabled: boolean; limitApproveEnabled: boolean; limitExtraEnabled: boolean;
  reviewConfirmEnabled: boolean; primaryChoose: string[];
};

/** The next available choice, ordered independently of either action's blocker list. */
export function pickerFocus(i: PickerFocusInput): FocusTarget | null {
  if (i.busy) return null;
  if (i.stage === "limit" && (i.limitApproveEnabled || i.limitExtraEnabled)) return "review-limit";
  if (i.reviewRequired && !["reviewing", "revising", "limit", "done", "unverified_approved"].includes(i.stage ?? "")) {
    if (i.localReview === null) return "review-toggle";
    if (i.localReview) {
      if (!i.reviewProvider) return "review-provider";
      if (!i.reviewModel) return "review-model";
      if (i.reviewThinking === null) return "review-thinking";
    }
  }
  if (!i.model) return "executor-model";
  if (i.thinking === null) return "executor-thinking";
  if (i.primaryEnabled) return "primary";
  if ((i.earlyDraft || i.automaticShown) && !i.placement) return "placement";
  if (i.automaticShown && i.automaticEnabled) return "automatic";
  if (i.reviewConfirmEnabled && i.primaryChoose.some(reason => reason.startsWith("계획 검증 확정 —"))) return "review-confirm";
  return null;
}
