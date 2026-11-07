import { readData } from "./data-records";
import type { Settings } from "../shared/contracts";
import type { ManagedPush } from "../shared/managed-push";
import type { Snapshot, Workflow, WorkflowPort } from "./engine";
import type { RepoProbe } from "./git";
import type { ManagedPushRunner } from "./managed-push";
import { pushReviewKey } from "./push-review";
import { checkWorktreeBase, integrateWorktree } from "./worktree";

/** What the approved (managed) push needs from the engine. State maps stay owned by the engine. */
export interface ManagedPushHost {
  runner(): ManagedPushRunner;
  /** Pushes this process is running, by request ID; guards against a second run. */
  executions(): Map<string, ManagedPush>;
  /** Requests whose read-only recheck is in progress. */
  checking(): Set<string>;
  port(): WorkflowPort;
  probe(): RepoProbe | null;
  stopped(): boolean;
  serial<T>(work: () => Promise<T>): Promise<T>;
  db(): Promise<{ workflows: Workflow[] }>;
  save(): Promise<void>;
  now(): number;
  touch(w: Workflow, detail: string): void;
  settings(): Promise<Settings>;
  invalidatePush(w: Workflow, progress?: Workflow["progress"]): void;
  setPushUnverified(w: Workflow, value: boolean): void;
  renameWorkspaces(w: Workflow, marker: boolean): Promise<unknown>;
  queuePushReview(w: Workflow): Promise<void>;
  cleanupWorktree(w: Workflow): Promise<void>;
  quiet(snapshot: Snapshot): boolean;
  busyWriter(w: Workflow): Promise<Workflow | null>;
}

/**
 * The approved push: prepare shows the exact targets, execute runs them once after the user's
 * approval, recheck reads the remote without writing, and results are applied to the task only
 * when they belong to its current push phase.
 */
export class ManagedPushes {
  constructor(private readonly host: ManagedPushHost) {}
  async pushWorkflow(id: string) {
    const w = (await this.host.db()).workflows.find((entry) => entry.id === id);
    if (!w) throw new Error("작업을 찾을 수 없습니다.");
    return w;
  }
  async pushReady(w: Workflow) {
    if (w.mode === "undecided" || w.generalTransition || w.pending || w.inbox)
      throw new Error("현재 작업 전달이 끝난 뒤 푸시 대상을 확인하세요.");
    for (const member of [w.plan, w.execute]) {
      if (!member) continue;
      const snapshot = await this.host.port().inspect(member.id);
      if (!snapshot || snapshot.archived || member.compaction || !this.host.quiet(snapshot))
        throw new Error("실행 중인 대화가 끝난 뒤 푸시하세요.");
    }
    if (await this.host.busyWriter(w)) throw new Error("같은 저장소에서 다른 작업이 진행 중입니다.");
  }
  prepareManagedPush(id: string) {
    return this.host.serial(async () => {
      const w = await this.pushWorkflow(id);
      await this.pushReady(w);
      if (["plan", "active"].includes(w.progress) || w.invalidTargets || !w.pushTargets.length)
        throw new Error("구현·검증 후 푸시할 저장소·원격·브랜치·전체 커밋을 먼저 보고하세요.");
      if (w.managedPush && ["running", "checking", "unknown"].includes(w.managedPush.state))
        throw new Error("기존 푸시 결과를 먼저 확인하세요. 같은 실행을 다시 시작하지 않습니다.");
      if (
        w.managedPush?.state === "pushed" &&
        pushReviewKey(w.managedPush.targets) === pushReviewKey(w.pushTargets)
      )
        return w.managedPush;
      await this.assertWorktreeBase(w, w.pushTargets);
      const record = await this.host.runner().prepare(w.id, w.pushEpoch, w.pushTargets);
      for (const other of (await this.host.db()).workflows) {
        const active = other.managedPush;
        if (other.id === id || !active || !["running", "checking"].includes(active.state)) continue;
        if (
          active.targets.some((left) =>
            record.targets.some(
              (right) => left.remoteUrl === right.remoteUrl && left.branch === right.branch,
            ),
          )
        )
          throw new Error("같은 원격 브랜치에 다른 작업의 푸시가 진행 중입니다.");
      }
      w.managedPush = record;
      w.managedRetry = null;
      this.host.invalidatePush(w);
      await this.host.save();
      await this.host.renameWorkspaces(w, (await this.host.settings()).titleMarker);
      return record;
    });
  }
  private async assertWorktreeBase(w: Workflow, targets: Workflow["pushTargets"]) {
    const base = await checkWorktreeBase(w, this.host.probe(), targets);
    if (!base.ok) {
      this.host.touch(w, base.detail);
      if (w.managedPush?.state === "prepared") w.managedPush = null;
      const key = [...new Set(w.pushTargets.map(target => target.commit))].sort().join(":");
      const notify = base.needsMerge && w.plan && !w.worktreeMergeNotices.includes(key);
      if (notify) w.worktreeMergeNotices.push(key);
      await this.host.save();
      if (notify)
        await this.host.port().send(
          w.plan!.id,
          `작업 ID: ${w.id}\n${base.detail}\n구현 담당에게 최신 기준 브랜치를 worktree 브랜치에 merge하고 충돌을 정리한 뒤 전체 시험을 다시 실행하도록 보완 plan을 지시하세요. 결과를 재검증한 커밋으로 pushTargets를 갱신하세요. 두 작업의 의도 판단이 필요한 충돌은 사용자에게 input으로 묻고, rebase·force로 이력을 다시 쓰지 마세요. 플러그인은 merge를 실행하지 않습니다.`,
          `role-workflow-worktree-merge:${w.id}:${key}`,
        ).catch(() => {});
      throw new Error(base.detail);
    }
  }
  async managedRequest(id: string, requestId: string) {
    const w = await this.pushWorkflow(id);
    const record = await this.host.runner().read(requestId);
    if (record.workflowId !== id || record.epoch !== w.pushEpoch || w.managedPush?.id !== requestId)
      throw new Error("작업 또는 푸시 대상이 바뀌었습니다. 최신 대상을 다시 확인하세요.");
    return { w, record };
  }
  async assertPushUncontended(record: ManagedPush) {
    const records = [
      ...this.host.executions().values(),
      ...(await this.host.db()).workflows.map((w) => w.managedPush),
    ];
    for (const other of records) {
      if (!other || other.id === record.id || !["running", "checking"].includes(other.state))
        continue;
      if (
        other.targets.some((a) =>
          record.targets.some((b) => a.remoteUrl === b.remoteUrl && a.branch === b.branch),
        )
      )
        throw new Error("같은 원격 브랜치에 다른 푸시가 진행 중입니다.");
    }
  }
  async executeManagedPush(id: string, requestId: string, approved: boolean) {
    if (approved !== true) throw new Error("표시한 대상의 명시적 푸시 승인이 필요합니다.");
    await this.host.serial(async () => {
      const { w, record } = await this.managedRequest(id, requestId);
      if (record.state !== "prepared" || this.host.executions().has(requestId)) return;
      await this.pushReady(w);
      await this.assertPushUncontended(record);
      if (pushReviewKey(record.targets) !== pushReviewKey(w.pushTargets))
        throw new Error("푸시 대상이 바뀌었습니다. 최신 대상을 다시 확인하세요.");
      await this.assertWorktreeBase(w, record.targets);
      this.host.executions().set(requestId, { ...record, state: "running" });
      w.managedPush = { ...record, state: "running" };
      this.host.invalidatePush(w);
      try {
        await this.host.save();
      } catch (error) {
        // No runner was called yet. A storage failure must not leave a phantom active push.
        this.host.executions().delete(requestId);
        w.managedPush = record;
        throw error;
      }
    });
    try {
      // Network work does not hold the workflow queue. Its receipt remains bound to this epoch.
      const result = await this.host.runner().execute(requestId);
      await this.host.serial(async () => this.applyManagedPush(await this.pushWorkflow(id), result));
      return result;
    } finally {
      this.host.executions().delete(requestId);
    }
  }
  async recheckManagedPush(id: string, requestId: string) {
    await this.host.serial(async () => this.managedRequest(id, requestId));
    const result = await this.host.runner().recheck(requestId);
    await this.host.serial(async () => this.applyManagedPush(await this.pushWorkflow(id), result));
    return result;
  }
  async applyManagedPush(w: Workflow, record: ManagedPush) {
    // After a reload the new engine reads the durable record; a stale copy must not save over it.
    if (this.host.stopped()) return;
    if (
      record.workflowId !== w.id ||
      record.epoch !== w.pushEpoch ||
      w.managedPush?.id !== record.id
    )
      return; // A late result remains in history; it cannot finish a newer phase.
    w.managedPush = record;
    if (record.state === "unknown" && record.targets.every((t) => t.exitCode === 0)) {
      if (w.managedRetry?.requestId !== record.id)
        w.managedRetry = { requestId: record.id, attempts: 0, after: this.host.now() + 30_000 };
    } else w.managedRetry = null;
    this.host.invalidatePush(w);
    if (record.state === "pushed") {
      await this.managedCompleted(w, record);
    } else {
      w.progress = "done";
      w.artifactNotice =
        record.error ||
        readData({
          prepared: "표시한 대상의 푸시 승인을 기다립니다.",
          running: "승인한 커밋을 푸시하고 있습니다.",
          checking: "실행은 끝났으며 원격 반영을 확인하고 있습니다.",
          failed: "푸시에 실패했습니다. 실행 기록을 확인하세요.",
          unknown: "실행 결과 확인이 필요합니다. 자동으로 다시 푸시하지 않습니다.",
        }, record.state);
    }
    await this.host.save();
    await this.host.renameWorkspaces(w, (await this.host.settings()).titleMarker);
  }
  async managedCompleted(w: Workflow, record: ManagedPush) {
    this.host.setPushUnverified(w, false);
    w.pushTargets = record.targets.map(({ repository, remote, branch, commit }) => ({
      repository,
      remote,
      branch,
      commit,
    }));
    w.invalidTargets = false;
    w.pushCheck = {
      checkedAt: record.updatedAt,
      targets: w.pushTargets.map((target) => ({ ...target, result: "pushed" as const })),
    };
    w.progress = "pushed";
    w.artifactNotice = "";
    await integrateWorktree(w, this.host.probe(), record);
    await this.host.cleanupWorktree(w);
    await this.host.queuePushReview(w);
  }
  async syncManagedPush(w: Workflow) {
    const current = w.managedPush;
    if (!current || this.host.executions().has(current.id)) return;
    try {
      const record = await this.host.runner().read(current.id);
      if (JSON.stringify(record) !== JSON.stringify(current))
        await this.applyManagedPush(w, record);
      await this.retryManagedPush(w);
    } catch {
      // Unreadable receipts must stay visible as unknown, never be reconstructed from prose.
      if (current.state !== "unknown")
        await this.applyManagedPush(w, {
          ...current,
          state: "unknown",
          error: "푸시 기록을 읽지 못했습니다. 원본 기록 복구가 필요합니다.",
        });
    }
  }
  async retryManagedPush(w: Workflow) {
    const retry = w.managedRetry;
    if (
      !retry ||
      retry.after > this.host.now() ||
      retry.attempts >= 5 ||
      this.host.checking().has(retry.requestId)
    )
      return;
    retry.attempts++;
    retry.after = this.host.now() + Math.min(30_000 * 2 ** retry.attempts, 300_000);
    await this.host.save();
    this.host.checking().add(retry.requestId);
    // Recovery only reads the remote. It never invokes execute(), even after a disconnect.
    void this.host.runner()
      .recheck(retry.requestId)
      .then((result) =>
        this.host.serial(async () => this.applyManagedPush(await this.pushWorkflow(w.id), result)),
      )
      .catch(() => {})
      .finally(() => this.host.checking().delete(retry.requestId));
  }
}
