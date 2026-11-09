import { createHash } from "node:crypto";
import type { Workflow, WorkflowPort } from "./engine";
import type { RepoProbe } from "./git";
import { inspectPushRecovery, type PushRecoveryInput, type PushRecoveryResult } from "./push-recovery";
import { pushReviewKey } from "./push-review";

const PUSH_AUDIT_VERSION = 1;
const PUSH_AUDIT_TIMEOUT_MS = 30_000;
const PUSH_AUDIT_INTERVAL_MS = 600_000;
interface PushAuditTicket {
  workflowId: string;
  fingerprint: string;
  input: PushRecoveryInput;
}

/** What the post-turn push audit needs from the engine. */
export interface PushAuditHost {
  port(): WorkflowPort;
  probe(): RepoProbe | null;
  stopped(): boolean;
  now(): number;
  save(): Promise<void>;
  serial<T>(work: () => Promise<T>): Promise<T>;
  db(): Promise<{ workflows: Workflow[] }>;
  setPushUnverified(w: Workflow, value: boolean): void;
  queuePushReview(w: Workflow): Promise<void>;
  pendingTitles(): Set<string>;
}

/**
 * Re-reads a finished response's shell activity to confirm pushes the agent ran itself, one task
 * at a time and outside the serial queue, then applies the result only if the task has not changed.
 */
export class PushAudit {
  private flight: object | null = null;
  private cancel: (() => void) | null = null;
  constructor(private readonly host: PushAuditHost) {}
  /** Stops waiting for an audit in flight (engine close). */
  stop() {
    this.cancel?.();
  }
  invalidatePushAudit(w: Workflow) {
    if (w.mode === "undecided") return;
    w.pushAuditGeneration++;
    w.pushAudit = null;
  }
  pushAuditEligible(w: Workflow) {
    const blocked = [
      w.managedPush,
      w.pending,
      w.inbox,
      w.generalTransition,
      w.invalidTargets,
      w.conflict,
      w.plan?.compaction,
      w.execute?.compaction,
      w.reviewer?.compaction,
    ];
    return (
      w.progress === "done" &&
      w.mode !== "undecided" &&
      ["active", "completed"].includes(w.status) &&
      !blocked.some(Boolean) &&
      !!(w.plan || w.execute)
    );
  }
  pushAuditFingerprint(w: Workflow) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          w.pushAuditGeneration,
          w.cwd,
          w.mode,
          w.status,
          w.phase,
          w.progress,
          [...w.repositories].sort(),
          pushReviewKey(w.pushTargets),
          [w.plan, w.execute, w.reviewer].map(
            (member) => member && [member.id, member.generation, member.config.provider],
          ),
        ]),
      )
      .digest("hex");
  }
  async beginPushAudit(): Promise<PushAuditTicket | null> {
    if (this.host.stopped() || !this.host.port().pushAuditHistory || !this.host.probe()) return null;
    const candidates = (await this.host.db()).workflows
      .filter((w) => this.pushAuditEligible(w))
      .sort((a, b) => this.pushAuditDue(a) - this.pushAuditDue(b));
    for (const w of candidates) {
      const fingerprint = this.pushAuditFingerprint(w);
      const previous =
        w.pushAudit?.version === PUSH_AUDIT_VERSION && w.pushAudit.fingerprint === fingerprint
          ? w.pushAudit
          : null;
      if (previous && previous.after > this.host.now()) continue;
      const retrying = previous && ["retry", "checking"].includes(previous.outcome);
      if (retrying && previous.attempts >= 5) {
        this.exhaustPushAudit(w);
        await this.host.save();
        continue;
      }
      w.pushAudit = {
        version: PUSH_AUDIT_VERSION,
        fingerprint,
        attempts: retrying ? previous.attempts + 1 : 1,
        after: this.host.now() + PUSH_AUDIT_TIMEOUT_MS,
        outcome: "checking",
      };
      const members: PushRecoveryInput["members"] = [];
      if (w.plan) members.push({ id: w.plan.id, role: "plan" });
      if (w.execute) members.push({ id: w.execute.id, role: "execute" });
      if (w.reviewer) members.push({ id: w.reviewer.id, role: "reviewer" });
      await this.host.save();
      return {
        workflowId: w.id,
        fingerprint,
        input: {
          cwd: w.cwd,
          mode: w.mode as "general" | "federated",
          repositories: [...w.repositories],
          targets: structuredClone(w.pushTargets),
          members,
        },
      };
    }
    return null;
  }
  pushAuditDue(w: Workflow) {
    return w.pushAudit?.version === PUSH_AUDIT_VERSION &&
      w.pushAudit.fingerprint === this.pushAuditFingerprint(w)
      ? w.pushAudit.after
      : 0;
  }
  exhaustPushAudit(w: Workflow) {
    if (!w.pushAudit) return;
    w.pushAudit.outcome = "retry";
    w.pushAudit.after = Number.MAX_SAFE_INTEGER;
    if (w.pushUnverified || w.pushReceipt || w.pushTargets.length) this.host.setPushUnverified(w, true);
    w.artifactNotice =
      "푸시 기록 자동 재확인을 완료하지 못했습니다. 새 작업 기록이 도착하면 다시 확인합니다.";
  }
  async applyPushAudit(ticket: PushAuditTicket, result: PushRecoveryResult) {
    if (this.host.stopped()) return;
    const w = (await this.host.db()).workflows.find((row) => row.id === ticket.workflowId);
    if (
      !w ||
      !this.pushAuditEligible(w) ||
      this.pushAuditFingerprint(w) !== ticket.fingerprint ||
      w.pushAudit?.fingerprint !== ticket.fingerprint
    )
      return;
    const audit = w.pushAudit;
    audit.outcome = result.state;
    audit.after = this.host.now() + PUSH_AUDIT_INTERVAL_MS;
    if (result.state === "pushed") {
      w.pushTargets = result.targets;
      w.pushReceipt = result.receipt;
      w.pushCheck = result.check;
      w.pushRetry = null;
      w.progress = "pushed";
      this.host.setPushUnverified(w, false);
      w.artifactNotice = "";
      await this.host.queuePushReview(w);
      this.host.pendingTitles().add(w.id);
    } else {
      if (result.state === "retry") {
        audit.after =
          audit.attempts >= 5
            ? Number.MAX_SAFE_INTEGER
            : this.host.now() + Math.min(30_000 * 2 ** (audit.attempts - 1), 300_000);
      }
      if (result.state === "unverified") this.host.setPushUnverified(w, true);
      if (result.state !== "none") w.artifactNotice = result.reason;
      if (result.state === "retry" && audit.attempts >= 5) this.exhaustPushAudit(w);
    }
    await this.host.save();
  }
  /** Claim work briefly, perform every history/Git read outside the shared workflow queue. */
  async auditPushes() {
    if (this.host.stopped() || this.flight) return;
    const flight = {};
    this.flight = flight;
    let retained = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ticket = await this.host.serial(() => this.beginPushAudit());
      if (!ticket) return;
      const work = inspectPushRecovery(ticket.input, this.host.port(), this.host.probe()!).catch(() => ({
        state: "retry" as const,
        reason: "푸시 기록 조회를 완료하지 못해 잠시 뒤 다시 확인합니다.",
      }));
      const timeout = new Promise<null>((resolve) => {
        this.cancel = () => resolve(null);
        timer = setTimeout(() => resolve(null), PUSH_AUDIT_TIMEOUT_MS);
      });
      const result = await Promise.race([work, timeout]);
      if (result === null) {
        // A timed-out RPC may still be running. Keep its slot until it settles, and drop its result.
        retained = true;
        void work.finally(() => {
          if (this.flight === flight) this.flight = null;
        });
      }
      await this.host.serial(() =>
        this.applyPushAudit(
          ticket,
          result ?? {
            state: "retry",
            reason:
              "푸시 기록 조회 시간이 초과되었습니다. 실행을 반복하지 않고 확인만 재시도합니다.",
          },
        ),
      );
    } finally {
      clearTimeout(timer);
      this.cancel = null;
      if (!retained && this.flight === flight) this.flight = null;
    }
  }
  /** A planner's complete counts even while the flow is paused and its inbox is unread. */
}
