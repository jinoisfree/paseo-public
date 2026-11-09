import { resolveModelFromCatalog } from "./model-resolution";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { capabilities } from "../shared/capabilities";
import { reviewerEligibility, type ReviewSelection } from "../shared/plan-review";
import type { Decision } from "../shared/decision";
import type { Settings } from "../shared/contracts";
import type { Workflow, WorkflowPort, Member } from "./engine";
import { applySelectionBatch, validateSelection } from "./executor-selection";

type Role = "plan" | "execute" | "reviewer";
type Inbox = NonNullable<Workflow["inbox"]>;
/** Both verdicts belong beside the planner's handoff/design, or in this task's folder. */
export function planDocumentFolder(id: string, plan: Pick<Decision, "next" | "handoff">): string {
  const document = /(?:^|[\s"'`(])((?:\/|docs\/)[^\s"'`<>)]*\/)(?:handoff|design)\.md/.exec(`${plan.next}\n${plan.handoff}`);
  return document ? document[1] : `docs/changes/${id}/`;
}
export interface PlanReviewHost {
  port(): WorkflowPort;
  settings(): Promise<Settings>;
  queue(w: Workflow, role: Role, prompt: string, phase: Workflow["phase"]): void;
  touch(w: Workflow, detail: string): void;
  startReserved(w: Workflow): Promise<boolean>;
}

/** First-plan verification; delivery, recovery, and compaction stay in the common engine. */
export class PlanReviewGate {
  constructor(private readonly host: PlanReviewHost) {}
  async options(w: Workflow) {
    const settings = await this.host.settings();
    const planner = w.plan ? await this.host.port().inspect(w.plan.id) : null;
    const plannerConfig = planner?.config ?? w.plan?.config;
    let plannerModel = plannerConfig?.provider ?? "";
    if (plannerConfig && !plannerModel.includes("/") && this.host.port().models && (plannerModel === "codex" || plannerModel === "claude")) {
      try {
        plannerModel += "/" + resolveModelFromCatalog(plannerConfig, await this.host.port().models!(plannerModel, w.cwd));
      } catch { /* An unknown default keeps the existing same-provider rejection. */ }
    }
    return Promise.all((["codex", "claude"] as const).map(async provider => {
      const mode = provider === "codex" ? settings.reviewerMode : settings.claudeReviewerMode;
      try {
        const port = this.host.port();
        if (!port.reviewerModes || !port.models) throw new Error("계획 검증 카탈로그를 읽을 수 없습니다.");
        const [availability, models] = await Promise.all([port.reviewerModes(provider, w.cwd), port.models(provider, w.cwd)]);
        const reason = reviewerEligibility("", provider, "", availability.enabled, availability.modes, mode);
        return { provider, mode, reason, models: models.map(model => ({ ...model,
          reason: reason ?? (model.isSelectable === false ? "선택할 수 없는 모델입니다." :
            reviewerEligibility(plannerModel, provider, model.id, true, availability.modes, mode)),
        })) };
      } catch (error) {
        return { provider, mode, reason: String(error), models: [] };
      }
    }));
  }
  async validate(w: Workflow, selection: ReviewSelection) {
    const row = (await this.options(w)).find(row => row.provider === selection.provider);
    const model = row?.models.find(model => model.id === selection.model);
    if (!row || row.reason || !model || model.reason) throw new Error(row?.reason ?? model?.reason ?? "검증 모델을 다시 선택하세요.");
    const valid = await validateSelection(selection, provider => this.host.port().models!(provider, w.cwd));
    if (!valid) throw new Error(selection.error || "검증 모델·추론을 선택하세요.");
    return row.mode;
  }
  async choose(w: Workflow, choice: { enabled: boolean; provider?: "codex" | "claude"; model?: string; thinking?: string; extra?: boolean }) {
    const review = w.planReview;
    if (choice.extra) {
      if (review.stage !== "limit") throw new Error("추가 검토는 검토 한도에서만 선택할 수 있습니다.");
      await this.validate(w, w.reviewSelection);
      review.maxRounds++;
      await this.start(w);
      return;
    }
    if (!choice.enabled) {
      w.implementationReserved = false;
      w.reviewSelection.enabled = false;
      review.outcome = "off"; review.error = "";
      if (w.pending?.role === "reviewer" && w.pending.stage !== "queued") {
        this.host.touch(w, "진행 중인 검증 응답을 기다린 뒤 검증을 끕니다.");
        return;
      }
      // A planner recording instruction also has to finish before approval can dispatch work.
      if (w.pending && w.pending.stage !== "queued") return;
      w.pending = null; review.stage = "off";
      this.restore(w);
      this.host.touch(w, "계획 검증 끔 — 구현 담당을 확정하면 구현을 시작합니다.");
      return;
    }
    if (["reviewing", "revising"].includes(review.stage)) throw new Error("검증 응답 중에는 담당을 변경할 수 없습니다.");
    if (review.round >= review.maxRounds) throw new Error("검토 한도입니다. 검토 1회 더를 명시적으로 선택하세요.");
    const draft = structuredClone(w.reviewSelection);
    draft.enabled = true;
    if (!choice.provider || !choice.model || choice.thinking === undefined) throw new Error("검증 제품·모델·추론을 선택하세요.");
    await applySelectionBatch(draft, { provider: choice.provider, model: choice.model, thinking: choice.thinking || "추론 없음" },
      provider => this.host.port().models!(provider, w.cwd));
    await this.validate(w, draft);
    w.reviewSelection = draft;
    if (w.heldApproval && w.reviewPlan) await this.start(w);
  }
  restore(w: Workflow) {
    if (w.reviewPlan) {
      w.inbox = w.reviewPlan;
      w.selectionPlan = w.reviewPlan.key;
      w.processed = w.processed.filter(key => key !== w.reviewPlan!.key);
    }
    w.status = "needs_input"; w.asker = "plan";
  }
  private async start(w: Workflow) {
    const review = w.planReview, hold = w.heldApproval;
    if (!hold || !w.reviewPlan) throw new Error("검증할 보관 계획이 없습니다.");
    const mode = await this.validate(w, w.reviewSelection);
    const s = w.reviewSelection;
    const provider = `${s.provider}/${s.model}`;
    const generation = (w.reviewer?.generation ?? 0) + 1;
    if (w.reviewer && (w.reviewer.config.provider !== provider || (w.reviewer.config.thinkingOptionId ?? "") !== (s.thinking ?? ""))) {
      w.history.push(w.reviewer.id);
      w.reviewer = null;
    }
    if (!w.reviewer) {
      const member: Member = { id: randomUUID(), workspaceId: null, generation,
        config: { provider, modeId: mode, ...(s.thinking ? { thinkingOptionId: s.thinking } : {}) },
        env: {}, usage: null, lastTurnKey: "", compactedForTurn: "", compaction: null,
        compactionTurnKey: "", compactionError: "", compactions: 0, handoff: "", rememberedThrough: 0 };
      w.reviewer = member;
    }
    w.reviewer.config.modeId = mode;
    review.stage = "reviewing"; review.round++; review.hash = hold.decisionHash; review.error = "";
    w.status = "active"; w.asker = null; w.inbox = null;
    const plan = w.reviewPlan.text;
    this.host.queue(w, "reviewer", `첫 계획을 읽기 전용으로 검증하세요. 파일·커밋·푸시 금지.\n회차: ${review.round}/${review.maxRounds}\nplanHash: ${review.hash}\n작업 문서: ${path.dirname(review.path)}\n${review.round > 1 ? `이전 회차 기록: ${review.path}\n` : ""}보관 계획 전문(summary·handoff·next 포함):\n${plan}\n판정: status=result, planReview={planHash,verdict:APPROVED|BLOCKED,findings:[{id,severity:차단|권고,text,evidence}]}. 차단 지적이 있으면 BLOCKED. 파일은 쓰지 말고 근거를 응답으로만 반환하세요.`, "plan");
    this.host.touch(w, `계획 검증 중 (${review.round}/${review.maxRounds})`);
  }
  async hold(w: Workflow, inbox: Inbox, d: Decision): Promise<boolean> {
    if (!capabilities(w).planReview || w.execute || w.lastInstruction || w.approvedHold === w.heldApproval?.id) return false;
    const review = w.planReview;
    // Keep the folder even when plan review is off: final implementation review needs it.
    review.path = path.join(planDocumentFolder(w.id, d), "plan-review.md");
    if (w.reviewSelection.enabled === false) { review.stage = "off"; review.outcome = "off"; return false; }
    w.reviewPlan = inbox;
    if (w.reviewSelection.enabled === null || w.reviewSelection.stage !== "ready") {
      review.stage = "waiting_choice"; this.restore(w);
      this.host.touch(w, "계획 검증 켜기/끄기를 선택하세요. 구현 승인은 검증 선택 뒤 가능합니다.");
      return true;
    }
    if (["passed", "unverified_approved"].includes(review.stage) && review.hash === w.heldApproval?.decisionHash) {
      this.restore(w); return true;
    }
    if (review.round >= review.maxRounds) {
      review.stage = "limit"; review.hash = w.heldApproval!.decisionHash;
      this.restore(w);
      this.host.touch(w, "계획 검증 한도입니다. 미통과로 승인 / 검토 1회 더 / 취소를 선택하세요.");
    } else await this.start(w);
    return true;
  }
  async receive(w: Workflow, role: Role, d: Decision): Promise<boolean> {
    if (!capabilities(w).planReview) return false;
    const review = w.planReview;
    if (role === "reviewer") {
      if (!w.reviewSelection.enabled || review.stage === "done") { review.stage = "off"; this.restore(w); return true; }
      if (d.status === "input") return false;
      review.error = ""; review.verdict = d.planReview!; review.stage = "revising";
      this.host.queue(w, "plan", `계획 검증 결과를 ${review.path}에 기록하세요. 지적별 수용/반박/보류와 이유를 남기세요.\n${JSON.stringify(d.planReview)}\n${d.planReview!.verdict === "APPROVED" ? "계획을 유지하면 기록 후 note, 계획이 달라지면 새 plan을 반환하세요." : "보완 또는 근거 있는 반박 뒤 plan을 반환하세요."}\n${review.round >= review.maxRounds ? "다음 자동 검토 없음. 보완·기록 뒤 사용자 결정으로 올라갑니다." : "구현은 아직 승인되지 않았습니다."}`, "plan");
      return true;
    }
    if (role === "plan" && !w.reviewSelection.enabled && w.reviewPlan && d.status === "note") { review.stage = "off"; this.restore(w); return true; }
    if (role === "plan" && (review.stage === "revising" || (review.stage === "off" && w.reviewPlan)) && d.status === "note") {
      if (review.stage === "off") { this.restore(w); return true; }
      if (review.verdict?.verdict === "APPROVED") {
        review.stage = "passed"; review.hash = w.heldApproval!.decisionHash;
        this.restore(w); this.host.touch(w, `계획 검증 통과 (${review.round}회). 현재 계획을 승인하면 구현합니다.`);
        await this.host.startReserved(w);
      } else { w.status = "needs_input"; w.asker = "plan"; }
      return true;
    }
    return false;
  }
}
