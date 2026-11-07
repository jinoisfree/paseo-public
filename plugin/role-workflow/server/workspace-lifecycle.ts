import type { PaseoApi } from "@getpaseo/client";
import type { Workflow, WorkflowPort } from "./engine";
import type { PushReviewPort } from "./push-review";

export type CleanupReadiness = { stage: "ready" | "pending" | "skipped" | "done" | "failed"; detail: string; ownedPinAt?: string };
interface Host {
  port(): WorkflowPort;
  db(): Promise<{ workflows: Workflow[] }>;
  cleanupReadiness?(w: Workflow): Promise<CleanupReadiness>;
}

/** The only mutation boundary for workspace archive and automatic pins. */
export class WorkspaceLifecycle {
  constructor(private readonly host: Host) {}
  get supportsArchive() { return typeof this.host.port().archiveWorkspace === "function"; }
  get supportsUnpin() { return typeof this.host.port().pushReview?.unpin === "function"; }
  get(id: string) { return this.host.port().pushReview?.get(id) ?? Promise.resolve(null); }
  private async executor(id: string) {
    return (await this.host.db()).workflows.find(w => w.isolation === "worktree" &&
      (w.execute?.workspaceId === id || w.worktree?.workspaceId === id));
  }
  async pinWorkspace(id: string): Promise<string> {
    if (await this.executor(id)) throw new Error("따로 작업 공간은 자동 고정하지 않습니다.");
    const port = this.host.port().pushReview;
    if (!port) throw new Error("작업 공간 고정을 지원하지 않습니다.");
    // Do not take ownership of a pin placed since the caller's last inspection.
    const current = await port.get(id);
    if (!current || current.pinnedAt !== null) throw new Error("고정 상태가 바뀌어 보존합니다.");
    return port.pin(id);
  }
  async unpinOwned(id: string, expected: string): Promise<boolean> {
    const port = this.host.port().pushReview;
    if (!port?.unpin || !expected) return false;
    const rows = (await this.host.db()).workflows.flatMap(w =>
      [...w.startPin?.workspaces ?? [], ...w.pushReview?.workspaces ?? []]);
    if (!rows.some(row => row.id === id && row.ownedPinAt === expected)) return false;
    const current = await port.get(id);
    if (!current || current.pinnedAt !== expected) return false;
    if (!await port.unpin(id, expected)) return false;
    return (await port.get(id))?.pinnedAt === null;
  }
  private async idleWorkspace(id: string) {
    const inspection = await this.host.port().archiveInspection([id]);
    const workspace = inspection.workspaces.find(ws => ws.id === id);
    const agents = inspection.conversations.filter(a => a.workspaceId === id);
    if (!workspace || workspace.pinnedAt !== null || workspace.archiving || !agents.length || agents.some(a =>
      a.archived !== true && (a.activeTurn !== false || a.permission !== false || !["idle", "closed"].includes(a.status)))) return null;
    return agents;
  }
  async archive(id: string): Promise<void> {
    if (await this.executor(id)) throw new Error("따로 작업 공간은 안전 정리 확인을 거쳐야 보관할 수 있습니다.");
    if (!await this.idleWorkspace(id)) throw new Error("보관 직전 실행·권한·고정 상태가 바뀌어 보존합니다.");
    await this.host.port().archiveWorkspace(id);
  }
  /** Only the engine-wired cleanup verifier can provide this call's single-use ready proof. */
  async archiveCleaned(w: Workflow): Promise<CleanupReadiness> {
    const id = w.worktree?.workspaceId;
    let proof: CleanupReadiness;
    try {
      if (!id || await this.executor(id) !== w) return { stage: "pending", detail: "따로 작업 공간 소속이 바뀌어 보존합니다." };
      if (!this.host.cleanupReadiness) return { stage: "pending", detail: "안전 정리 확인 증표가 없어 보존합니다." };
      proof = await this.host.cleanupReadiness(w);
      if (proof.stage !== "ready") return proof;
      // Last activity query is after every copy/unpin/Git check, immediately before mutation.
      const agents = await this.idleWorkspace(id);
      if (!agents || agents.length !== 1 || agents[0].id !== w.execute?.id)
        return { stage: "pending", detail: "보관 직전 실행·권한 상태가 바뀌어 따로 작업 공간을 보존합니다." };
      if (await this.executor(id) !== w) return { stage: "pending", detail: "보관 직전 소속이 바뀌어 보존합니다." };
    } catch {
      return { stage: "pending", detail: "보관 직전 상태를 조회하지 못해 보존합니다. 다음 점검 때 다시 확인합니다." };
    }
    await this.host.port().archiveWorkspace(id);
    return proof;
  }
}

/** Existing 0.15 transports, kept behind the same mutation boundary. */
export function lifecycleTransport(getApi: () => PaseoApi, pins?: { pin: PushReviewPort["pin"]; unpin(id: string): Promise<void> }) {
  return {
    async archiveWorkspace(workspaceId: string) {
      const result = await getApi().workspaces.ref(workspaceId).archive();
      if (result.error || !result.archivedAt || result.workspaceId !== workspaceId)
        throw new Error(result.error || "워크스페이스 보관을 확인하지 못했습니다.");
    },
    ...(pins ? { pushReview: {
      pin: pins.pin,
      async get(id: string) {
        const workspace = await getApi().workspaces.ref(id).refresh();
        return workspace ? { pinnedAt: workspace.pinnedAt ?? null } : null;
      },
      async unpin(id: string, expected: string) {
        const workspace = await getApi().workspaces.ref(id).refresh();
        if (!workspace || workspace.pinnedAt !== expected) return false;
        await pins.unpin(id);
        return true;
      },
    } } : {}),
  };
}
