import { randomUUID } from "node:crypto";
import { capabilities } from "../shared/capabilities";
import { compressionDecision, contextRatio } from "../shared/compression";
import type { Settings } from "../shared/contracts";
import { isFinished } from "./archive";
import type { Member, Snapshot, Workflow, WorkflowPort } from "./engine";

/** What context compaction needs from the engine. The maps stay owned by the engine. */
export interface CompactionHost {
  port(): Pick<WorkflowPort, "compact" | "inspect" | "history">;
  save(): Promise<void>;
  touch(w: Workflow, detail: string): void;
  serial<T>(work: () => Promise<T>): Promise<T>;
  settings(): Promise<Settings>;
  /** Running compactions by conversation; an entry exists only while the request is in flight. */
  compacting: Map<string, Promise<void>>;
  compressionReasons: Map<string, string>;
}

/**
 * Compacts idle conversations when their context use crosses the configured policy, records the
 * outcome on the member, and offers a retry when a compaction fails or its result is unknown.
 */
export class Compaction {
  constructor(private readonly host: CompactionHost) {}
  async prepareCompaction(w: Workflow, member: Member, snapshot: Snapshot | null, label: string): Promise<boolean> {
    // Use the same fresh raw sample for display and policy; never retain stale usage.
    const ratio = snapshot ? (snapshot.contextUsage === undefined ? snapshot.usage : contextRatio(snapshot.contextUsage)) : null;
    member.usage = typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 ? ratio : null;
    const compression = compressionDecision(snapshot?.config?.provider ?? member.config.provider, await this.host.settings(), snapshot);
    this.host.compressionReasons.set(member.id, compression.reason);
    if (member.compaction) {
      if (!this.host.compacting.has(member.id)) {
        member.compactionError = "압축 중 연결이 끊겨 완료 여부를 확인해야 합니다.";
        throw new Error(capabilities(w).standalone ? "압축 복구·재시도로 완료 상태를 확인하세요." : "압축 중 연결이 끊겼습니다. 대화 상태를 확인하고 재개하면 압축을 다시 시도합니다.");
      }
      return true;
    }
    if (
      compression.due &&
      member.lastTurnKey &&
      member.compactedForTurn !== member.lastTurnKey &&
      snapshot?.status === "idle" &&
      !snapshot.permission
    ) {
      member.compaction = `role-workflow-compact:${randomUUID()}`;
      member.compactionTurnKey = member.lastTurnKey;
      member.compactionError = "";
      this.host.touch(w, `${label} 대화의 컨텍스트를 압축하고 있습니다.`);
      await this.host.save();
      this.startCompaction(w, member);
      return true;
    }
    return false;
  }
  async maintainStandalone(w: Workflow) {
    if (!capabilities(w).standalone || w.status !== "active" || isFinished(w) || !w.plan?.workspaceId || w.execute) return;
    const snapshot = await this.host.port().inspect(w.plan.id);
    if (!snapshot || snapshot.archived || snapshot.status !== "idle" || snapshot.permission) return;
    if ((snapshot.config?.provider ?? w.plan.config.provider).split("/")[0] === "codex" && !w.plan.compaction) {
      this.host.compressionReasons.set(w.plan.id, "Codex 단일 대화는 Codex 자체 압축을 사용합니다.");
      return;
    }
    try { await this.prepareCompaction(w, w.plan, snapshot, "현재"); }
    catch (error) {
      w.status = "error";
      this.host.touch(w, `컨텍스트 압축 유지보수: ${String(error)}`);
      await this.host.save();
    }
  }
  finishCompaction(w: Workflow, member: Member, turnKey: string) {
    member.compaction = null;
    member.compactionTurnKey = "";
    member.compactionError = "";
    member.compactedForTurn = turnKey;
    member.compactions++;
    this.host.touch(w, "컨텍스트 압축을 마쳤습니다. 같은 대화에서 작업을 이어갑니다.");
  }
  async retryCompaction(w: Workflow) {
    const member = w.plan!;
    if (w.status !== "error" || (!member.compaction && !member.compactionError)) throw new Error("복구할 압축 오류가 없습니다.");
    const snapshot = await this.host.port().inspect(member.id);
    if (!snapshot || snapshot.archived || snapshot.status !== "idle" || snapshot.permission || this.host.compacting.has(member.id))
      throw new Error("대화가 열려 있고 유휴 상태이며 질문 대기가 없을 때 압축을 복구할 수 있습니다.");
    if (member.compaction) {
      const history = await this.host.port().history(member.id, member.compaction);
      if (history.maintenance && history.maintenanceId === member.compaction && history.compacted && history.failed === null) {
        this.finishCompaction(w, member, member.compactionTurnKey || member.lastTurnKey);
      } else {
        // A message ID is correlation, not proof that the host deduplicates sends.
        // Retry only an exact request with an explicit terminal native failure.
        if (!history.maintenance || history.maintenanceId !== member.compaction || history.compacted ||
            !history.text.includes("Failed to compact context:"))
          throw new Error("압축 완료·실패를 확인할 수 없어 재전송하지 않습니다. 대화에서 직접 /compact를 실행한 뒤 압축 복구를 누르세요.");
        member.compaction = `role-workflow-compact:${randomUUID()}`;
        member.compactionError = "";
        w.status = "active";
        await this.host.save();
        this.startCompaction(w, member);
        return;
      }
    }
    member.compactionError = "";
    w.status = "active";
    await this.host.save();
  }
  startCompaction(w: Workflow, member: Member) {
    const turnKey = member.compactionTurnKey || member.lastTurnKey;
    const job = this.host.port()
      .compact(member.id, member.compaction!)
      .then(
        () =>
          this.host.serial(async () => {
            this.finishCompaction(w, member, turnKey);
            await this.host.save();
          }),
        (error) =>
          this.host.serial(async () => {
            if (!capabilities(w).standalone) member.compaction = null;
            member.compactionError = String(error);
            w.transientPause = null;
            if (w.status !== "paused" && !isFinished(w)) w.status = "error";
            this.host.touch(w, `컨텍스트 압축 실패: ${String(error)}. ${capabilities(w).standalone ? "압축 복구·재시도를 사용하세요." : "확인 후 재개하세요."}`);
            await this.host.save();
          }),
      )
      .finally(() => this.host.compacting.delete(member.id));
    this.host.compacting.set(member.id, job);
    // The durable error state is surfaced in the dashboard; prevent detached rejections.
    void job.catch(() => {});
  }
}
