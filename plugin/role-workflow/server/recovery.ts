import type { Settings } from "../shared/contracts";
import { capabilities } from "../shared/capabilities";
import type { Workflow, WorkflowPort } from "./engine";
import { recordQuotaFailure, usageLimit, quotaDelay, quotaCheckDue } from "./quota";
import { transientFailure, transientDelay } from "./transient";

/** Legacy sent/sending entries were charged at their durable send boundary. */
export function pendingCharged(pending: NonNullable<Workflow["pending"]>): boolean {
  return pending.budgetCharged ?? (pending.stage === "sent" || pending.stage === "sending");
}
export function recoveryCharged(record: { budgetCharged?: boolean; sourcePendingId?: string | null } | null): boolean {
  return !!record?.budgetCharged && !!record.sourcePendingId;
}
function instruction(pending: Workflow["pending"]) {
  return { prompt: pending?.prompt ?? null, instruction: pending?.instruction ?? false,
    budgetCharged: pending ? pendingCharged(pending) : false,
    sourcePendingId: pending ? pending.sourcePendingId ?? pending.id : null };
}

type Role = "plan" | "execute" | "reviewer";

/** What usage-limit and transient-error recovery needs from the engine. */
export interface RecoveryHost {
  port(): Pick<WorkflowPort, "quotaAccount" | "quotaAvailable" | "inspect">;
  now(): number;
  settings(): Promise<Settings>;
  touch(w: Workflow, detail: string): void;
  resume(w: Workflow, message: string, automatic: boolean): Promise<Workflow["status"]>;
  limitDetail(w: Workflow): string;
  /** True while a conversation's compaction is still running. */
  compacting(agentId: string): boolean;
}

/**
 * Usage-limit pauses and transient-error pauses: recording them, retrying on schedule within
 * their budgets, and stopping with guidance when a retry is no longer safe. Runs inside the
 * engine's serial queue; it never resends a delivery on its own (resume decides that).
 */
export class Recovery {
  constructor(private readonly host: RecoveryHost) {}
  async quotaFailure(w: Workflow, role: Role, inbox: NonNullable<Workflow["inbox"]>) {
    const provider = w[role]?.config.provider.split("/")[0];
    const limit = usageLimit(provider ?? "", inbox.failed ?? "", inbox.failureCode);
    const previous = w.quotaPause;
    w.quotaPause = null;
    if (inbox.canceled || !limit || (provider !== "codex" && provider !== "claude")) return;
    const now = this.host.now();
    const account = await this.host.port().quotaAccount(provider).catch(() => null);
    w.quotaPause = recordQuotaFailure(
      previous,
      {
        role,
        provider,
        retryAt: limit.retryAt,
        account,
        ...instruction(w.pending?.role === role ? w.pending : null),
        phase: w.pending?.role === role ? w.pending.phase : w.phase,
      },
      now,
    );
  }

  async retryQuota(w: Workflow) {
    const record = w.quotaPause;
    if (!record || w.status !== "paused" || !capabilities(w).automatic) return;
    const settings = await this.host.settings();
    if (!settings.autoResumeQuota) { w.quotaPause = null; return; }
    if (w.cycles >= settings.maxCycles || (w.turns >= settings.maxTurns && !recoveryCharged(record))) {
      w.quotaPause = null;
      this.host.touch(w, `${this.host.limitDetail(w)} 한도를 확인하고 직접 재개하세요.`);
      return;
    }
    const now = this.host.now();
    if (!quotaCheckDue(record, now)) return;
    record.lastCheckedAt = now;
    record.nextCheckAt = Math.max(now + quotaDelay(record.attempts + 1), record.retryAt ?? 0);
    try {
      const ready = await this.conversations(w);
      if (ready === "permanent" || w.asker || w.held || w.generalTransition || w.inbox) {
        w.quotaPause = null;
        this.host.touch(w, "자동 복구를 멈췄습니다. 대화의 보관·질문·승인·전달 상태를 확인하세요.");
        return;
      }
      if (ready) {
        record.checksFailed++;
        record.nextCheckAt = Math.max(record.nextCheckAt, now + quotaDelay(record.checksFailed + 1));
        this.describeQuota(w, "대화 또는 전달 상태 확인 대기"); return;
      }
      if (record.retryAt !== null && now < record.retryAt) return;
      record.checksFailed = 0;
      record.attempts++;
      record.nextCheckAt = now + quotaDelay(record.attempts + 1);
      const resumed = await this.host.resume(w, "", true);
      if (resumed === "active") return;
      if (resumed === "needs_input") { w.quotaPause = null; return; }
    } catch {
      // Failed preflight/resume is not evidence that the outage has ended.
      record.checksFailed++;
      record.nextCheckAt = Math.max(record.nextCheckAt, now + quotaDelay(record.checksFailed + 1));
    }
    w.status = "paused";
    w.quotaPause = record;
    this.describeQuota(w, "확인 또는 재시도 대기");
  }
  describeQuota(w: Workflow, reason = "사용량 한도 대기") {
    const record = w.quotaPause;
    if (!record) return;
    const detail = `${reason} · 재시도 ${record.attempts}회 · 최근 확인 ${record.lastCheckedAt === null ? "아직 없음" : new Date(record.lastCheckedAt).toISOString()} · 다음 시도 ${new Date(record.nextCheckAt).toISOString()} · 사용량 회복을 확인한 것은 아닙니다.`;
    if (w.detail !== detail) this.host.touch(w, detail);
  }
  async transientBlock(w: Workflow): Promise<"permanent" | "temporary" | null> {
    const settings = await this.host.settings();
    if (
      !settings.autoResumeTransient ||
      !capabilities(w).automatic ||
      w.generalTransition ||
      w.asker ||
      w.held ||
      w.quotaPause ||
      w.cycles >= settings.maxCycles ||
      (w.turns >= settings.maxTurns && !recoveryCharged(w.transientPause) && !(w.pending && pendingCharged(w.pending)))
    ) return "permanent";
    if ([w.plan, w.execute, w.reviewer].some(member => member?.compaction && this.host.compacting(member.id)))
      return "temporary";
    return null;
  }
  async recordTransient(w: Workflow, role: Role, failure: string, kind: "turn" | "error", failureCode?: string, failedPending: Workflow["pending"] = w.pending) {
    const previous = w.transientPause;
    if (w.status !== "active") return;
    if (!transientFailure(failure, failureCode)) {
      if (kind === "turn") w.transientPause = null;
      return;
    }
    const request = instruction(failedPending?.role === role ? failedPending : null);
    const same = previous?.role === role && previous.phase === w.phase && previous.sourcePendingId === request.sourcePendingId;
    const attempts = same ? previous.attempts : 0;
    w.transientPause = {
      role,
      ...request,
      lastCheckedAt: null,
      phase: failedPending?.phase ?? w.phase,
      failure,
      kind,
      attempts,
      checksFailed: 0,
      firstAt: same ? previous.firstAt : this.host.now(),
      nextCheckAt: this.host.now() + transientDelay(attempts),
    };
    if ((await this.transientBlock(w)) === "permanent") w.transientPause = null;
    else {
      try { if (await this.conversations(w) === "permanent") w.transientPause = null; }
      catch { /* An unreadable conversation is checked on the saved schedule. */ }
    }
  }
  describeTransient(w: Workflow, failure = "") {
    const record = w.transientPause;
    if (!record) {
      if (transientFailure(failure)) this.stopTransient(w, failure);
      return;
    }
    const detail = `일시 오류로 중단: ${record.failure} · 재시도 ${record.attempts}회 · 최근 확인 ${record.lastCheckedAt === null ? "아직 없음" : new Date(record.lastCheckedAt).toISOString()} · ${record.checksFailed ? "사전 확인 대기 · " : ""}다음 시도 ${new Date(record.nextCheckAt).toISOString()}`;
    if (w.detail !== detail) this.host.touch(w, detail);
  }
  stopTransient(w: Workflow, failure: string, detail = `응답 중단: ${failure}. 대화와 사용자 응답 대기를 확인하고 재개하세요.`) {
    w.transientPause = null;
    this.host.touch(w, detail);
  }
  async retryTransient(w: Workflow) {
    const record = w.transientPause;
    if (!record || !["paused", "error"].includes(w.status)) return;
    const block = await this.transientBlock(w);
    if (block === "permanent") { this.stopTransient(w, record.failure); return; }
    if (this.host.now() < record.nextCheckAt) return;
    const status = w.status;
    record.lastCheckedAt = this.host.now();
    record.nextCheckAt = this.host.now() + transientDelay(record.attempts);
    try {
      const ready = await this.conversations(w);
      if (ready === "permanent") { this.stopTransient(w, record.failure); return; }
      if (block || ready) {
        record.checksFailed++;
        record.nextCheckAt = this.host.now() + transientDelay(Math.max(record.attempts, record.checksFailed));
        this.describeTransient(w); return;
      }
      record.checksFailed = 0;
      record.attempts++;
      record.nextCheckAt = this.host.now() + transientDelay(record.attempts);
      const resumed = await this.host.resume(w, "", true);
      if (resumed === "active") return;
      if (resumed === "needs_input" || (await this.transientBlock(w)) === "permanent") {
        this.stopTransient(w, record.failure, w.detail); return;
      }
    } catch {
      // Retain the original instruction across unavailable history and daemon failures.
      record.checksFailed++;
      record.nextCheckAt = this.host.now() + transientDelay(Math.max(record.attempts, record.checksFailed));
    }
    if (w.status === "active") w.status = status;
    w.transientPause = record;
    if (w.pending?.stage === "sending") {
      this.host.touch(w, `전달 결과를 확인하지 못했습니다. 같은 메시지의 수신 내역만 확인하며 재발송하지 않습니다. 다음 확인 ${new Date(record.nextCheckAt).toISOString()}`);
    } else this.describeTransient(w);
  }
  private async conversations(w: Workflow): Promise<"permanent" | "temporary" | null> {
    for (const member of [w.plan, w.execute, w.reviewer]) {
      if (!member || (member === w.execute && member.workspaceId === null)) continue;
      const snapshot = await this.host.port().inspect(member.id);
      if (snapshot?.archived || snapshot?.permission) return "permanent";
      if (!snapshot || snapshot.status === "running" || snapshot.status === "initializing" || snapshot.activeTurn ||
          (member.compaction && this.host.compacting(member.id))) return "temporary";
    }
    return null;
  }
}
