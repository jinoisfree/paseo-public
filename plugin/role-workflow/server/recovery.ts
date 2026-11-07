import { readData } from "./data-records";
import type { Settings } from "../shared/contracts";
import { capabilities } from "../shared/capabilities";
import type { Workflow, WorkflowPort } from "./engine";
import { recordQuotaFailure, usageLimit, quotaDelay, quotaCheckDue, QUOTA_ACCOUNT_SETTLE_MS } from "./quota";
import { transientFailure, transientDelay } from "./transient";

type Role = "plan" | "execute";

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
    const provider = readData(w, role)?.config.provider.split("/")[0];
    const limit = usageLimit(provider ?? "", inbox.failed ?? "");
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
        prompt: w.pending?.role === role ? w.pending.prompt : null,
        phase: w.pending?.role === role ? w.pending.phase : w.phase,
      },
      now,
    );
  }

  async retryQuota(w: Workflow) {
    const record = w.quotaPause;
    if (!record || w.status !== "paused" || !capabilities(w).automatic) return;
    const settings = await this.host.settings();
    if (!settings.autoResumeQuota) return;
    if (w.cycles >= settings.maxCycles || w.turns >= settings.maxTurns) {
      w.quotaPause = null;
      this.host.touch(w, `${this.host.limitDetail(w)}\n한도에 도달해 사용 한도 자동 재개를 멈췄습니다. 한도를 확인하고 직접 재개하세요.`);
      return;
    }
    const now = this.host.now();
    if (!quotaCheckDue(record, now)) return;
    record.lastCheckedAt = now;
    const account = await this.host.port().quotaAccount(record.provider).catch(() => null);
    let reason = "";
    if (record.account !== null && account !== null && record.account !== account) {
      record.account = account;
      record.attempts = 0;
      record.nextCheckAt = now + QUOTA_ACCOUNT_SETTLE_MS;
      record.accountRetry = true;
    }
    if (record.attempts >= 5 || now < record.nextCheckAt) return;
    if (record.accountRetry) reason = "계정 변경 후 재시도";
    if (!reason && record.retryAt !== null && now >= record.retryAt) reason = "재시도 시각 경과";
    if (!reason && (await this.host.port().quotaAvailable(record.provider).catch(() => null)) === true)
      reason = "사용량 회복";
    if (!reason) return;
    const detail = w.detail;
    record.attempts++;
    record.nextCheckAt = now + quotaDelay(record.attempts);
    try {
      const resumed = await this.host.resume(w, "", true);
      if (resumed !== "active") throw new Error("automatic resume refused");
      this.host.touch(w, `사용 한도 자동 재개 (${reason}): ${w.detail}`);
    } catch {
      w.quotaPause = null;
      w.status = "paused";
      this.host.touch(w, detail);
    }
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
      w.pending?.stage === "sending" ||
      w.cycles >= settings.maxCycles ||
      w.turns >= settings.maxTurns
    ) return "permanent";
    if ([w.plan, w.execute].some(member => member?.compaction && this.host.compacting(member.id)))
      return "temporary";
    return null;
  }
  async recordTransient(w: Workflow, role: Role, failure: string, kind: "turn" | "error") {
    const previous = w.transientPause;
    w.transientPause = null;
    if (w.status !== "active" || (await this.transientBlock(w))) return;
    if (!transientFailure(failure)) {
      if (kind === "error") w.transientPause = previous;
      return;
    }
    try {
      if (!(await this.transientConversationsReady(w))) return;
    } catch {
      // A disconnected daemon cannot confirm conversation state until the retry preflight.
    }
    const same = previous?.role === role && previous.phase === w.phase;
    const attempts = same ? previous.attempts : 0;
    w.transientPause = {
      role,
      phase: w.phase,
      failure,
      kind,
      attempts,
      firstAt: same ? previous.firstAt : this.host.now(),
      nextCheckAt: this.host.now() + transientDelay(attempts),
    };
  }
  describeTransient(w: Workflow, failure = "") {
    const record = w.transientPause;
    if (!record) {
      if (transientFailure(failure)) this.stopTransient(w, failure);
      return;
    }
    let detail: string;
    if (record.attempts >= 5) {
      w.transientPause = null;
      // Exhaustion is a new stop even when all five resumes were refused before activation.
      w.notifiedStatus = "active";
      detail = `일시 오류 자동 재개 5회 실패: ${record.failure}. 대화를 확인하고 재개하세요.`;
    } else {
      const time = new Date(record.nextCheckAt);
      const hour = String(time.getHours()).padStart(2, "0");
      const minute = String(time.getMinutes()).padStart(2, "0");
      detail = `일시 오류로 중단: ${record.failure} · 자동 재개 ${record.attempts + 1}/5 · 다음 시도 ${hour}:${minute}`;
    }
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
    if (block === "permanent") {
      this.stopTransient(w, record.failure);
      return;
    }
    if (this.host.now() < record.nextCheckAt) return;
    if (block === "temporary") {
      record.nextCheckAt = this.host.now() + transientDelay(0);
      this.describeTransient(w);
      return;
    }
    const status = w.status;
    const detail = w.detail;
    record.attempts++;
    record.nextCheckAt = this.host.now() + transientDelay(record.attempts);
    try {
      if (!(await this.transientConversationsReady(w))) {
        this.stopTransient(w, record.failure);
        return;
      }
      const resumed = await this.host.resume(w, "", true);
      if (resumed === "active") return;
      // A newly discovered question or an uncertain delivery keeps its own stop intact.
      if (resumed === "needs_input" || (await this.transientBlock(w))) {
        this.stopTransient(w, record.failure, w.detail);
        return;
      }
      if (!w.transientPause && record.attempts >= 5) {
        w.status = status;
        return;
      }
    } catch {
      // Connection failures and refused resumes consume the same bounded retry budget.
    }
    w.status = status;
    w.detail = detail;
    w.transientPause = record;
    this.describeTransient(w);
  }
  async transientConversationsReady(w: Workflow) {
    for (const member of [w.plan, w.execute]) {
      if (!member || (member === w.execute && member.workspaceId === null)) continue;
      const snapshot = await this.host.port().inspect(member.id);
      if (!snapshot || snapshot.archived || snapshot.permission) return false;
    }
    return true;
  }
}
