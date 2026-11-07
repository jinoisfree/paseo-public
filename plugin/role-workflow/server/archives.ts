import { unlink } from "node:fs/promises";
import path from "node:path";
import { capabilities } from "../shared/capabilities";
import type { ArchiveCandidate, ArchiveEntry, Settings } from "../shared/contracts";
import { archiveCandidates, isFinished } from "./archive";
import type { Database, Workflow, WorkflowPort } from "./engine";

/** What archiving finished tasks needs from the engine. */
export interface ArchivesHost {
  port(): WorkflowPort;
  db(): Promise<Database>;
  save(): Promise<void>;
  serial<T>(work: () => Promise<T>): Promise<T>;
  settings(): Promise<Settings>;
  handoffPath(w: Workflow): string;
  savedHandoffs(): Map<string, string>;
}

/**
 * Archived conversations and finished tasks: dropping undecided tasks whose conversation is gone,
 * moving finished ones to the archive list, and archiving their workspaces when it is safe.
 */
export class Archives {
  private checkedAt = -Infinity;
  constructor(private readonly host: ArchivesHost) {}
  archived(agentId: string) {
    return this.host.serial(async () => {
      const w = (await this.host.db()).workflows.find(
        (candidate) => candidate.plan?.id === agentId || candidate.execute?.id === agentId,
      );
      if (!w) return;
      if (isFinished(w)) await this.collectArchived(w);
      else if (!capabilities(w).automatic && w.plan?.id === agentId) await this.removeUndecided(w);
    });
  }
  async removeUndecided(w: Workflow, entry?: ArchiveEntry) {
    const db = await this.host.db();
    const previous = db.workflows;
    const previousArchives = db.archives;
    db.workflows = previous.filter((candidate) => candidate.id !== w.id);
    if (entry)
      db.archives = [...db.archives.filter((a) => a.id !== entry.id), entry]
        .toSorted((a, b) => b.archivedAt.localeCompare(a.archivedAt))
        .slice(0, 500);
    try {
      await this.host.save();
    } catch (error) {
      db.workflows = previous;
      db.archives = previousArchives;
      throw error;
    }
    this.host.savedHandoffs().delete(w.id);
    await unlink(this.host.handoffPath(w)).catch(() => {});
  }
  async cleanupArchived() {
    const candidates = (await this.host.db()).workflows.filter(
      (w) => !capabilities(w).automatic || isFinished(w),
    );
    for (const w of candidates) {
      try {
        if (isFinished(w)) await this.collectArchived(w);
        else if (w.plan && (await this.host.port().inspect(w.plan.id))?.archived === true)
          await this.removeUndecided(w);
      } catch {
        console.error("role-workflow: undecided cleanup failed");
      }
    }
  }
  archiveEntry(w: Workflow, archivedAt = new Date().toISOString()): ArchiveEntry {
    const members = [w.plan, w.execute].filter((m) => m !== null);
    return {
      id: w.id,
      number: w.number,
      title: w.title,
      projectId: w.projectId,
      folder: path.basename(w.cwd),
      progress: w.progress as "done" | "pushed" | "no_push",
      workspaceIds: [...new Set(members.flatMap((m) => (m.workspaceId ? [m.workspaceId] : [])))],
      agentIds: [...new Set([...members.map((m) => m.id), ...w.history])],
      archivedAt,
    };
  }
  async collectArchived(w: Workflow): Promise<boolean> {
    const members = [w.plan, w.execute].filter((m) => m !== null);
    if (!isFinished(w) || !members.length) return false;
    const times: number[] = [];
    for (const member of members) {
      const snapshot = await this.host.port().inspect(member.id);
      if (snapshot?.archived !== true) return false;
      if (snapshot.archivedAt && Number.isFinite(Date.parse(snapshot.archivedAt)))
        times.push(Date.parse(snapshot.archivedAt));
    }
    const archivedAt =
      times.length === members.length ? new Date(Math.max(...times)).toISOString() : undefined;
    await this.removeUndecided(w, this.archiveEntry(w, archivedAt));
    return true;
  }
  async archiveRows(progress: "done" | "pushed", ids?: readonly string[]) {
    const db = await this.host.db();
    const workflows = db.workflows.filter(
      (w) => isFinished(w) && w.progress === progress && (!ids || ids.includes(w.id)),
    );
    if (!workflows.length) return [];
    const workspaceIds = [
      ...new Set(
        workflows.flatMap((w) =>
          [w.plan, w.execute].flatMap((m) => (m?.workspaceId ? [m.workspaceId] : [])),
        ),
      ),
    ];
    const inspection = await this.host.port().archiveInspection(workspaceIds);
    return archiveCandidates(
      db.workflows,
      inspection,
      progress,
      db.settings.archiveAfterDays,
      Date.now(),
      ids,
    );
  }
  async applyArchive(rows: ArchiveCandidate[], progress: "done" | "pushed") {
    const archivedIds: string[] = [];
    const errors: { id: string; error: string }[] = [];
    for (const row of rows) {
      try {
        // Refresh again immediately before the first mutation of this flow.
        const current = (await this.archiveRows(progress, [row.id]))[0];
        if (!current) continue;
        const w = (await this.host.db()).workflows.find((candidate) => candidate.id === row.id);
        if (!w) continue;
        for (const workspaceId of current.workspaceIds) {
          // A previous half may already be archived. Recheck the remaining half as well.
          const fresh = (await this.archiveRows(progress, [row.id]))[0];
          if (!fresh?.workspaceIds.includes(workspaceId))
            throw new Error("보관 조건이 변경되어 남은 워크스페이스를 보존했습니다.");
          await this.host.port().archiveWorkspace(workspaceId);
        }
        // The archive RPC confirmed every workspace; queued archive events can now no-op.
        await this.removeUndecided(w, this.archiveEntry(w));
        archivedIds.push(row.id);
      } catch (error) {
        errors.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { rows, archivedIds, errors };
  }
  archiveFinished(apply = false, ids: readonly string[] = []) {
    return this.host.serial(async () => {
      if (apply && !ids.length) return { rows: [], archivedIds: [], errors: [] };
      const rows = await this.archiveRows("done", apply ? ids : undefined);
      return apply ? this.applyArchive(rows, "done") : { rows, archivedIds: [], errors: [] };
    });
  }
  async checkArchives() {
    const now = Date.now();
    if (now - this.checkedAt < 10 * 60 * 1000) return;
    this.checkedAt = now;
    for (const w of (await this.host.db()).workflows) {
      if (isFinished(w)) await this.collectArchived(w).catch(() => false);
    }
    if (!(await this.host.settings()).autoArchivePushed) return;
    try {
      const result = await this.applyArchive(await this.archiveRows("pushed"), "pushed");
      for (const error of result.errors)
        console.error("role-workflow: archive failed", error.id, error.error);
    } catch {
      console.error("role-workflow: archive inspection failed; workspaces preserved");
    }
  }
}
