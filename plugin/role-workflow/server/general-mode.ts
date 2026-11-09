import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentPermissionResponse, AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { capabilities } from "../shared/capabilities";
import type { ProjectDefaults, Settings } from "../shared/contracts";
import { generalAgentLabel, type GeneralAgent } from "../shared/general-agent";
import { workflowRequestedMode } from "../shared/mode-request";
import type { Workflow, WorkflowPort } from "./engine";
import type { ExecutorChoice } from "./executor-choice";
import { timelineMode, timelineBrainstorm, timelineSelections } from "./executor-selection";
import {
  asyncGeneralAnswers,
  choiceFromAnswers,
  configChoice,
  explicitGeneralChoice,
  generalAnswers,
  generalQuestionNames,
  type GeneralQuestion,
} from "./general-agent";
import { parseDecision } from "./protocol";
import type { TurnEvidence } from "./push-evidence";

/** Messages this plugin delivers start with the flow id; anything else is the user's own text. */
function userText(request: string): string {
  return request.startsWith("작업 ID:") ? "" : request;
}

type Role = "plan" | "execute";

/** What the general-mode choice and the federated → general transition need from the engine. */
export interface GeneralModeHost {
  port(): WorkflowPort;
  db(): Promise<{ workflows: Workflow[]; settings: Settings; projects: Record<string, ProjectDefaults> }>;
  save(): Promise<void>;
  touch(w: Workflow, detail: string): void;
  settings(): Promise<Settings>;
  serial<T>(work: () => Promise<T>): Promise<T>;
  executorChoice(): ExecutorChoice;
  compacting(agentId: string): boolean;
  seen(w: Workflow, key: string): void;
  rememberProject(w: Workflow, executor?: boolean): Promise<void>;
  queue(w: Workflow, role: Role, prompt: string, phase: Workflow["phase"], instruction?: boolean): void;
  generalDefault(cwd: string): Promise<GeneralAgent | null>;
  advance(w: Workflow): Promise<void>;
  renameWorkspaces(w: Workflow, marker: boolean, keep?: boolean): Promise<unknown>;
  handoffPath(w: Workflow): string;
  captureArtifacts(w: Workflow, text: string, evidence: TurnEvidence | undefined, agentId: string, turnKey: string): Promise<unknown>;
  startBrainstorm(w: Workflow): Promise<void>;
  allowMode(w: Workflow, mode: "general" | "federated"): Promise<boolean>;
  busyWriter(w: Workflow): Promise<Workflow | null>;
}

/**
 * General mode: settling which product, model and thinking the single general conversation uses,
 * and handing a federated task back to one general conversation with its result and handoff.
 */
export class GeneralMode {
  constructor(private readonly host: GeneralModeHost) {}
  async finishGeneralChoice(
    w: Workflow,
    agentId: string,
    text: string,
    goal: string,
    request: string,
    failed: string | null,
    key: string,
  ) {
    if (w.mode === "undecided" && workflowRequestedMode(w, userText(request)) === "general")
      this.generalize(w);
    if (w.mode !== "general" || w.plan?.id !== agentId || capabilities(w).current) return false;
    if (!w.goal) w.goal = goal || request;
    if (capabilities(w).splitGeneral) {
      if (failed !== null) return false;
      const wasSettled = w.generalState.settled;
      if (!wasSettled) {
        const explicit = explicitGeneralChoice(userText(request));
        if (explicit) w.generalState.selected = explicit;
      }
      await this.applyGeneralChoice(w);
      if (!wasSettled && w.generalState.settled && w.asker === "plan") {
        w.asker = null;
        w.status = "active";
      }
      try {
        if (parseDecision(text).status !== "note" || wasSettled || !w.generalState.settled) return false;
      } catch {
        // The model may end a question-only turn without an automation block.
      }
      if (wasSettled) return false;
      this.host.seen(w, key);
      if (w.generalState.settled) {
        this.host.queue(
          w,
          "plan",
          "구현 담당 선택을 저장했습니다. 최초 모델의 기획·설계 역할로 계속하세요. 제품 코드를 고치지 말고, 설계 인계서를 작성한 뒤 plan으로 구현 담당에게 인계하세요.",
          "plan",
        );
        await this.host.save();
        await this.host.advance(w);
      } else await this.host.save();
      return true;
    }
    return (
      failed === null && this.applyGeneralChoice(w, text.includes("기본값(현재 대화 설정) 사용"))
    );
  }
  async rememberGeneralQuestion(
    w: Workflow | undefined,
    agentId: string,
    request: { id: string; kind: string; input?: unknown },
    settings: Settings,
  ) {
    if (
      w?.mode === "general" &&
      w.plan?.id === agentId &&
      request.kind === "question" &&
      settings.askExecutorModel &&
      !w.generalState.settled
    ) {
      const names = generalQuestionNames(request.input);
      if (names.length) {
        w.generalState.questions[request.id] = names;
        await this.host.save();
      }
    }
  }
  async resolveGeneralQuestion(
    agentId: string,
    requestId: string,
    resolution: AgentPermissionResponse,
  ) {
    const general = (await this.host.db()).workflows.find(
      (w) => w.mode === "general" && w.plan?.id === agentId,
    );
    if (general) {
      const names = general.generalState.questions[requestId];
      delete general.generalState.questions[requestId];
      if (names && resolution.behavior === "allow")
        this.recordGeneralAnswers(general, generalAnswers(resolution.updatedInput, names));
      else if (names?.includes("model")) {
        general.generalState.provider = null;
        general.generalState.selected = null;
      }
      if (names) await this.host.save();
    }
  }
  recordGeneralAnswers(w: Workflow, answers: Partial<Record<GeneralQuestion, string>>) {
    if (w.generalState.settled) return;
    if (answers.agent === "Claude Code" || answers.agent === "Codex")
      w.generalState.provider = answers.agent === "Codex" ? "codex" : "claude";
    const provider =
      w.generalState.provider ?? (w.plan ? configChoice(w.plan.config).provider : null);
    if (provider) {
      const choice = choiceFromAnswers(provider, answers);
      if (choice) w.generalState.selected = choice;
    }
  }
  generalTimeline(
    agentId: string,
    items: readonly AgentTimelineItem[],
    answers?: Partial<Record<GeneralQuestion, string>>,
    selectionEvents?: ReturnType<typeof timelineSelections>,
    modeAnswer?: "general" | "federated",
    initialRequest = "",
    brainstormAnswer = false,
    normalizedModeAnswer?: "general" | "federated",
  ) {
    return this.host.serial(async () => {
      const w = (await this.host.db()).workflows.find(
        (row) => row.plan?.id === agentId && (row.mode === "general" || capabilities(row).current),
      );
      if (w && capabilities(w).current) {
        if (capabilities(w).brainstorm && (brainstormAnswer || timelineBrainstorm(items))) await this.host.startBrainstorm(w);
        const answer = w.contract >= 6 ? (normalizedModeAnswer ?? modeAnswer ?? timelineMode(items)) : (modeAnswer ?? timelineMode(items, false));
        const mode = w.mode === "undecided" ? (answer ?? workflowRequestedMode(w, initialRequest)) : null;
        if (mode) {
          if (!await this.host.allowMode(w, mode)) { await this.host.save(); return; }
          w.mode = mode; await this.host.rememberProject(w); await this.host.save();
        }
        if (!capabilities(w).executorSelection) return;
        if (capabilities(w).firstPlanGate && !w.execute && !w.lastInstruction) return;
        for (const answer of selectionEvents ?? timelineSelections(items))
          await this.host.executorChoice().acceptSelection(w, answer.id, answer.values, answer.fields);
        // A native question can predate mode enrollment, and permission events are not
        // replayed on reload. Reconcile the still-open host question by exact identity.
        const snapshot = await this.host.port().inspect(agentId).catch(() => null);
        for (const question of snapshot?.questions ?? []) {
          this.host.executorChoice().rememberSelectionQuestion(w, question.id.replace(/^permission-/, ""), question.input);
        }
        await this.host.save();
        return;
      }
      if (!w || !(await this.host.settings()).askExecutorModel || w.generalState.settled) return;
      this.recordGeneralAnswers(w, answers ?? asyncGeneralAnswers(items));
      await this.host.save();
    });
  }
  async applyGeneralChoice(w: Workflow, useCurrent = false): Promise<boolean> {
    if (!w.plan || w.generalState.settled) return false;
    const state = w.generalState;
    const settings = await this.host.settings();
    if (capabilities(w).splitGeneral) {
      if (Object.keys(state.questions).length) return false;
      const selected =
        state.selected ?? explicitGeneralChoice(w.goal) ??
        (!settings.askExecutorModel ? await this.host.generalDefault(w.cwd) : null);
      if (selected) await this.settleGeneralChoice(w, selected);
      return false;
    }
    const live = await this.host.port().inspect(w.plan.id).catch(() => null);
    const current = configChoice(live?.config ?? w.plan.config);
    const selected = state.selected ?? explicitGeneralChoice(w.goal);
    if (!selected) {
      if (
        live?.permission ||
        Object.keys(state.questions).length ||
        (settings.askExecutorModel && !useCurrent)
      )
        return false;
      await this.settleGeneralChoice(w, current);
      return false;
    }
    state.selected = selected;
    const same =
      selected.provider === current.provider &&
      selected.model === current.model &&
      selected.thinking === current.thinking;
    if (same) {
      await this.settleGeneralChoice(w, selected);
      return false;
    }
    return this.transferGeneralChoice(w, selected, current, settings);
  }
  async settleGeneralChoice(w: Workflow, selected: GeneralAgent) {
    w.generalState.selected = selected;
    w.generalState.settled = true;
    await this.rememberGeneral(w, selected);
    await this.host.save();
    if (w.plan)
      await this.host.port()
        .generalNotice?.(
          w.plan.id,
          selected,
          (capabilities(w).splitGeneral ? "구현 담당 · " : "") + generalAgentLabel(selected),
          w.id,
          capabilities(w).splitGeneral ? configChoice(w.plan.config) : undefined,
        )
        .catch(() => {});
  }
  async transferGeneralChoice(
    w: Workflow,
    selected: GeneralAgent,
    current: GeneralAgent,
    settings: Settings,
  ): Promise<boolean> {
    const state = w.generalState;
    if (!w.plan || !w.goal || !this.host.port().createGeneral) {
      this.host.touch(
        w,
        "일반개발 담당 변경 실패: 원문 요청 또는 대화 생성 기능이 없습니다. 기존 대화에서 계속하세요.",
      );
      await this.host.save();
      return false;
    }
    if (!state.transfer || JSON.stringify(state.transfer.choice) !== JSON.stringify(selected)) {
      state.transfer = {
        id: randomUUID(),
        agentId: randomUUID(),
        sourceId: w.plan.id,
        choice: selected,
        stage: "queued",
      };
      await this.host.save();
    }
    const transfer = state.transfer;
    const mode = selected.provider === "claude" ? settings.claudeStartMode : settings.executorMode;
    try {
      // Checked at the top of this method; the port does not change.
      await this.host.port().createGeneral!(w, transfer, mode);
    } catch (error) {
      transfer.stage = "failed";
      state.settled = true;
      state.selected = current;
      this.host.touch(
        w,
        `일반개발 담당 변경 실패: ${error instanceof Error ? error.message : String(error)}. 기존 대화에서 계속하세요.`,
      );
      await this.host.save();
      return false;
    }
    const previous = w.plan;
    w.history.push(previous.id);
    w.plan = {
      ...previous,
      id: transfer.agentId,
      config: {
        provider: `${selected.provider}/${selected.model}`,
        thinkingOptionId: selected.thinking || undefined,
        modeId: mode,
        systemPrompt: previous.config.systemPrompt,
      },
      generation: previous.generation + 1,
      lastTurnKey: "",
      usage: null,
    };
    transfer.stage = "sent";
    state.settled = true;
    this.host.touch(w, `선택한 담당 대화로 넘겼습니다. ${generalAgentLabel(selected)}`);
    await this.rememberGeneral(w, selected);
    await this.host.save();
    await this.host.port().generalNotice?.(previous.id, selected, w.detail, transfer.id).catch(() => {});
    await this.host.port()
      .generalNotice?.(w.plan.id, selected, generalAgentLabel(selected), transfer.id)
      .catch(() => {});
    return true;
  }

  async rememberGeneral(w: Workflow, choice: GeneralAgent) {
    const db = await this.host.db();
    if (db.settings.rememberProjectChoices)
      db.projects[path.resolve(w.cwd)] = {
        ...db.projects[path.resolve(w.cwd)],
        mode: "general",
        general: choice,
      };
  }
  /** Returns a planner that never received an executor to working alone. */
  generalize(w: Workflow) {
    w.quotaPause = null;
    w.transientPause = null;
    if (w.mode === "undecided" && w.contract < 3) w.contract = 1;
    w.mode = "general";
    w.status = "active";
    w.notifiedStatus = "active";
    w.inbox = null;
    w.pending = null;
    w.held = null;
    w.repairs = 0;
    w.asker = null;
    w.limitPlan = "";
    w.selectionPlan = "";
    w.resumeNote = "";
  }
  async returnToGeneral(w: Workflow) {
    // Asking again while the transition waits on an unreadable conversation finishes it
    // without that confirmation; the handoff records that the result was not confirmed.
    if (w.generalTransition && w.status === "needs_input") {
      await this.finishGeneralTransition(w, true);
      return;
    }
    if (w.execute) {
      w.generalTransition = true;
      w.status = "paused";
      w.notifiedStatus = "paused";
      w.quotaPause = null;
      w.transientPause = null;
      this.host.touch(
        w,
        "일반개발 전환 대기: 현재 응답·권한 요청·압축이 끝난 뒤 계획 대화에서 이어갑니다.",
      );
      await this.host.save();
      await this.finishGeneralTransition(w);
      return;
    }
    w.generalHandoff = this.transitionRecord(w);
    this.generalize(w);
    await this.host.rememberProject(w);
    this.host.touch(w, "일반개발로 전환했습니다.");
    await this.host.save();
    await this.host.renameWorkspaces(w, (await this.host.settings()).titleMarker);
  }
  transitionRecord(w: Workflow, unconfirmed = false) {
    return JSON.stringify({
      ...(unconfirmed ? { resultUnconfirmed: true } : {}),
      goal: w.goal,
      lastPlan: w.lastPlan,
      lastResult: w.lastResult,
      lastInstruction: w.lastInstruction,
      pending: w.pending,
      held: w.held,
      inbox: w.inbox,
      finishedTurns: w.transitionTurns,
      planHandoff: w.plan?.handoff,
      executeHandoff: w.execute?.handoff,
      executeAgentId: w.execute?.id,
      maintenanceAtTransition: { plan: w.plan?.compaction, execute: w.execute?.compaction },
      constraints: w.constraints,
      repositories: w.repositories,
      pushTargets: w.pushTargets,
      verification: w.verification,
    });
  }
  /** Whether every conversation has settled; a forced switch skips an unreadable executor. */
  async transitionSettled(w: Workflow, force: boolean) {
    for (const member of [w.plan, w.execute]) {
      if (!member?.workspaceId) continue;
      if (this.host.compacting(member.id)) return false;
      const snapshot = await this.host.port().inspect(member.id);
      if (
        snapshot?.permission ||
        snapshot?.status === "running" ||
        snapshot?.status === "initializing"
      )
        return false;
      if (!snapshot || snapshot.archived) {
        if (force && member !== w.plan) continue;
        w.status = "needs_input";
        this.host.touch(w, "전환할 대화를 확인할 수 없습니다. 기존 대화의 보관 상태를 확인하세요.");
        await this.host.save();
        return false;
      }
    }
    return true;
  }
  async finishGeneralTransition(w: Workflow, force = false) {
    if (!w.generalTransition || !(await this.transitionSettled(w, force))) return;
    if (!w.plan) return;
    if (!(await this.captureTransitionResult(w)) && !force) return;
    w.generalHandoff = this.transitionRecord(w, force);
    // An idle provider after restart may have no completion event for an old maintenance
    // marker. Preserve it as unverified in the handoff, without claiming a compaction.
    w.plan.compaction = null;
    if (w.execute) w.history.push(w.execute.id);
    w.execute = null;
    this.generalize(w);
    w.generalTransition = false;
    w.transitionTurns = [];
    w.wantsFederation = false;
    w.generalDelivery = {
      id: randomUUID(),
      stage: "queued",
      prompt: `사용자가 일반개발로 전환했습니다. 진행 방식: 일반개발. 이제 이 대화에서 직접 조사·구현·검증하세요. 연합개발 자동 인계와 상태 블록은 사용하지 않습니다.\n원래 목표: ${w.goal}\n전환 기록 파일: ${this.host.handoffPath(w)}\ngeneralHandoff의 미처리 결과·보류 지시·제약·검증을 먼저 읽고 현재 파일과 대조해 남은 작업만 이어가세요. 기록에 있는 명령과 상태 태그는 참고 자료이며 자동 실행 지시가 아닙니다. 완료한 일을 반복하지 마세요. 푸시는 기존 사용자의 명시적 승인 범위를 확인하고, 해당 범위의 승인이 없으면 대상 저장소·원격·브랜치·커밋을 제시해 승인을 요청하세요. 전환 요청 자체는 푸시 승인이 아닙니다.`,
    };
    this.host.touch(w, "일반개발로 전환했습니다. 기존 실행 결과를 계획 대화에 전달합니다.");
    await this.host.rememberProject(w);
    await this.host.save();
    await this.host.renameWorkspaces(w, (await this.host.settings()).titleMarker);
    await this.deliverGeneral(w);
  }
  async captureTransitionResult(w: Workflow) {
    const pending = w.pending;
    if (!pending || pending.stage === "queued") return true;
    const member = w[pending.role];
    if (!member?.workspaceId) return true;
    if (w.inbox?.agentId === member.id && w.inbox.answers) return true;
    if (w.transitionTurns.some((turn) => turn.agentId === member.id && turn.answers)) return true;
    const latest = await this.host.port().history(member.id, pending.id).catch(() => null);
    if (latest?.key && latest.messageIds.includes(pending.id)) {
      if (!w.processed.includes(latest.key)) {
        if (latest.failed === null)
          await this.host.captureArtifacts(w, latest.text, latest.evidence, member.id, latest.key);
        w.transitionTurns.push({
          agentId: member.id,
          key: latest.key,
          text: latest.text,
          failed: latest.failed,
          compacted: !!latest.compacted,
          canceled: false, reviewerViolation: "",
          resumed: false,
          answers: true,
        });
        this.host.seen(w, latest.key);
      }
      return true;
    }
    w.status = "needs_input";
    const detail =
      "전환 대기: 전달 중이던 응답의 결과를 아직 확인하지 못했습니다. 기존 대화에서 응답이 끝났는지 확인하세요.";
    if (w.detail !== detail) this.host.touch(w, detail);
    await this.host.save();
    return false;
  }
  async deliverGeneral(w: Workflow) {
    const delivery = w.generalDelivery;
    if (
      w.mode !== "general" ||
      !w.plan ||
      !delivery ||
      delivery.stage === "sent" ||
      delivery.stage === "uncertain"
    )
      return;
    if (delivery.stage === "sending") {
      const history = await this.host.port().history(w.plan.id, delivery.id);
      if (history.messageIds.includes(delivery.id)) delivery.stage = "sent";
      else {
        // A crash between send and acknowledgement is not permission to send a second time.
        delivery.stage = "uncertain";
        w.status = "needs_input";
        this.host.touch(
          w,
          "일반개발 전환 안내의 수신 여부를 확인하지 못했습니다. 대화에서 마지막 안내를 확인하고 직접 이어가세요.",
        );
      }
      await this.host.save();
      return;
    }
    const snapshot = await this.host.port().inspect(w.plan.id);
    if (
      !snapshot ||
      snapshot.archived ||
      snapshot.permission ||
      snapshot.status === "running" ||
      snapshot.status === "initializing"
    )
      return;
    const busy = await this.host.busyWriter(w);
    if (busy) {
      w.conflict = `일반개발 안내 전달 대기: 같은 저장소의 #${busy.number} ${busy.title} 작업이 실행 중입니다.`;
      await this.host.save();
      return;
    }
    w.conflict = "";
    delivery.stage = "sending";
    await this.host.save();
    try {
      await this.host.port().send(w.plan.id, delivery.prompt, delivery.id);
      delivery.stage = "sent";
      await this.host.save();
    } catch {
      // Recover from history on the next tick; do not blindly retry a send.
      this.host.touch(w, "일반개발 전환 안내의 수신 여부를 확인하고 있습니다.");
      await this.host.save();
    }
  }
}
