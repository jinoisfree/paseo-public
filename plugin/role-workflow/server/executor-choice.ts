import { executorDefaults, oppositeProvider } from "../shared/assignment";
import { capabilities } from "../shared/capabilities";
import type { Settings } from "../shared/contracts";
import { EXECUTOR_QUESTIONS, selectionStageLabel, type SelectionStage } from "../shared/executor-selection";
import type { GeneralAgent } from "../shared/general-agent";
import { applyLegacySelection, applySelectionBatch, pendingFields, selectionQuestions, validateSelection } from "./executor-selection";
import type { Workflow, WorkflowPort } from "./engine";

/** What choosing the executor's product, model and thinking needs from the engine. */
export interface ExecutorChoiceHost {
  port(): Pick<WorkflowPort, "models">;
  save(): Promise<void>;
  touch(w: Workflow, detail: string): void;
  settings(): Promise<Settings>;
}

/**
 * The executor choice for federated work: answers from the question tool or the plugin screen,
 * validated against the provider catalog, and applied to the executor's configuration.
 */
export class ExecutorChoice {
  constructor(private readonly host: ExecutorChoiceHost) {}
  catalog(w: Workflow, provider: "codex" | "claude") {
    const port = this.host.port();
    if (!port.models) return Promise.reject(new Error("모델 카탈로그를 읽을 수 없습니다. 재조회 후 선택하세요."));
    return port.models(provider, w.cwd);
  }
  async acceptSelection(w: Workflow, id: string, values: Partial<Record<SelectionStage, string>>,
    fields = selectionQuestions({questions:Object.keys(values).map(stage => ({question:EXECUTOR_QUESTIONS[stage as SelectionStage].question}))}),
    explicit = false) {
    const state = w.selection!;
    id = id.replace(/^permission-/, "");
    if (state.answered.includes(id) || (state.pending && state.pending.id !== id) || (!state.pending && state.stage === "ready" && !explicit)) return;
    const pending = state.pending;
    const scope = pending ? pendingFields(pending) : fields;
    const received = pending?.received ?? [];
    const fresh = Object.fromEntries(scope.filter(f => !received.includes(f.stage) && values[f.stage] !== undefined)
      .map(f => [f.stage, values[f.stage]])) as Partial<Record<SelectionStage, string>>;
    if (!Object.keys(fresh).length) return;
    try {
      // Already-open v4 sequential questions retain their zero/one option semantics.
      // Bundled questions and their follow-ups always require explicit thinking answers.
      if (!state.responses && scope.length === 1 && !explicit) {
        const stage = scope[0].stage;
        if (["provider", "model", "thinking", "ready"].indexOf(stage) > ["provider", "model", "thinking", "ready"].indexOf(state.stage)) return;
        await applyLegacySelection(state, stage, fresh[stage]!, provider => this.catalog(w, provider));
      } else await applySelectionBatch(state, fresh, provider => this.catalog(w, provider));
    } catch (error) { state.error = error instanceof Error ? error.message : String(error); }
    const completed = [...new Set([...received, ...Object.keys(fresh) as SelectionStage[]])];
    if (scope.every(f => completed.includes(f.stage))) {
      state.answered.push(id); state.pending = null;
    } else state.pending = {id, fields:scope, received:completed};
    if (this.selectedExecutor(w)) {
      w.asker = null;
      if (w.status === "needs_input") w.status = "active";
      this.host.touch(w, `구현 담당 선택 확인: ${state.provider}/${state.model} · 추론 ${state.thinking || "없음"}. 최초 담당 설정은 유지합니다.`);
    } else this.host.touch(w, state.error || `구현 담당 선택: ${selectionStageLabel[state.stage]} 답변을 기다립니다.`);
    await this.host.save();
  }
  rememberSelectionQuestion(w: Workflow, id: string, input: unknown) {
    const state = w.selection!;
    const fields = selectionQuestions(input);
    if (!fields.length || state.answered.includes(id)) return;
    if (state.pending?.id === id) return;
    if (state.pending) {
      // A replacement question retires the old partial envelope; late answers cannot
      // overwrite fields already accepted by the replacement request.
      if (!(state.pending.received?.length)) { state.error = "다른 선택 질문의 답변을 기다리고 있습니다."; return; }
      state.answered.push(state.pending.id);
    }
    state.pending = {id, fields, received:[]};
  }
  async selectionReady(w: Workflow): Promise<boolean> {
    const state = w.selection!;
    if (capabilities(w).firstPlanGate && !w.execute && !w.lastInstruction &&
        (!w.heldApproval || !w.approvedHold || w.approvedHold !== w.heldApproval.id)) {
      w.status = "needs_input";
      w.asker = "plan";
      this.host.touch(w, "계획이 나오면 그 계획을 확인하고 구현 담당을 고르면 전달합니다. 계획 메시지나 자동 작업 화면에서 현재 계획을 확인하세요.");
      await this.host.save();
      return false;
    }
    try {
      if (!state.pending && await validateSelection(state, provider => this.catalog(w, provider))) return true;
    } catch (error) { state.error = error instanceof Error ? error.message : String(error); }
    w.status = "needs_input";
    w.asker = "plan";
    this.host.touch(w, capabilities(w).screenSelection
      ? `${state.error ? state.error + " " : ""}대화의 구현 담당 선택 카드나 자동 작업 화면에서 구현 제품·모델·추론을 선택하세요. 선택하면 보관한 계획을 바로 전달합니다.`
      : state.error || `구현 담당 ${selectionStageLabel[state.stage]} 선택을 실제 답변으로 확정해야 합니다. 질문 도구로 선택하거나 실행 가능한 모델/추론을 직접 입력하세요.`);
    await this.host.save();
    return false;
  }
  selectedExecutor(w: Workflow): GeneralAgent | null {
    if (capabilities(w).current) {
      const s = w.selection;
      return s?.stage === "ready" && !s.pending && s.provider && s.thinking !== null
        ? { provider: s.provider, model: s.model, thinking: s.thinking } : null;
    }
    return w.contract >= 3 ? w.generalState.selected : null;
  }
  executorProvider(w: Workflow) {
    const selected = this.selectedExecutor(w);
    if (selected) return selected.provider;
    // Existing standalone executors have no planner and keep their provider.
    return w.plan
      ? oppositeProvider(w.plan.config.provider)
      : oppositeProvider(oppositeProvider(w.execute!.config.provider));
  }
  async restoreExecutor(w: Workflow) {
    const member = w.execute!;
    if (capabilities(w).executorSelection && !(await this.selectionReady(w))) return;
    const defaults = executorDefaults(await this.host.settings(), this.executorProvider(w));
    const selected = this.selectedExecutor(w);
    member.config.provider = selected ? (selected.model ? `${selected.provider}/${selected.model}` : selected.provider) : defaults.model;
    member.config.modeId = defaults.mode;
    const thinking = selected ? selected.thinking : defaults.thinking;
    if (thinking) member.config.thinkingOptionId = thinking;
    else delete member.config.thinkingOptionId;
  }
}
