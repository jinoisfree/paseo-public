import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../shared/contracts";
import type { Workflow, WorkflowPort } from "./engine";
import type { RepoProbe } from "./git";
import { archiveMembersPresent, archiveWorkspacePinned, archiveWorkspaceShared } from "./archive";

export const CLEANUP_RETRY_MS = 60_000;
export interface WorktreeCleanupHost {
  port(): WorkflowPort;
  probe(): RepoProbe | null;
  db(): Promise<{ workflows: Workflow[] }>;
  save(): Promise<void>;
  settings(): Promise<Settings>;
  now(): number;
  stateFolder(): string;
  touch(w: Workflow, detail: string): void;
}
type Readiness = { stage: "ready" | "pending" | "skipped" | "done"; detail: string; ownedPinAt?: string };

/** Archive only the integrated executor workspace; durable checkpoints survive a lost RPC reply. */
export class WorktreeCleanup {
  constructor(private readonly host: WorktreeCleanupHost) {}
  async run(w: Workflow): Promise<void> {
    if (w.mode !== "federated" || w.isolation !== "worktree" || !w.worktree || w.progress !== "pushed") return;
    if (w.worktreeCleanup && ["done", "skipped"].includes(w.worktreeCleanup.stage)) return;
    w.worktreeCleanup ??= { stage: "pending", attempts: 0, detail: "", at: new Date(this.host.now()).toISOString(), evidenceFiles: null };
    const state = w.worktreeCleanup;
    if (state.attempts >= 3 || (state.attempts > 0 && this.host.now() - Date.parse(state.at) < CLEANUP_RETRY_MS)) return;
    const record = async (stage: typeof state.stage, detail: string) => {
      if (stage === "done") {
        for (const row of [...w.startPin?.workspaces ?? [], ...w.pushReview?.workspaces ?? []]) {
          if (row.id === w.worktree!.workspaceId) {
            row.phase = "acknowledged";
            row.ownedPinAt = null;
          }
        }
      }
      if (state.stage !== stage || state.detail !== detail) {
        state.stage = stage;
        state.detail = detail;
        state.at = new Date(this.host.now()).toISOString();
      }
      if (w.detail !== detail) this.host.touch(w, detail);
      await this.host.save();
    };
    let attempted = false;
    try {
      let ready = await this.readiness(w);
      if (ready.stage !== "ready") { await record(ready.stage, ready.detail); return; }
      if (!this.host.port().archiveWorkspace) throw new Error("현재 연결이 워크스페이스 보관을 지원하지 않습니다");
      state.stage = "pending";
      state.evidenceFiles = null;
      state.attempts++;
      state.at = new Date(this.host.now()).toISOString();
      attempted = true;
      await this.host.save();
      const source = path.join(w.worktree.path, "evidence");
      const destination = path.join(this.host.stateFolder(), "evidence", safeSegment(w.id), "worktree", safeSegment(w.worktree.workspaceId));
      state.evidenceFiles = await preserveEvidence(source, destination);
      state.detail = `evidence ${state.evidenceFiles}개 파일 보존 완료`;
      await this.host.save();
      // Re-read membership, active conversations, Git status and ancestry after the copy.
      ready = await this.readiness(w);
      if (ready.stage === "ready" && ready.ownedPinAt)
        ready = await this.releaseOwnedPin(w, ready.ownedPinAt);
      if (ready.stage !== "ready") {
        state.attempts--;
        await record(ready.stage, ready.detail);
        return;
      }
      await this.host.port().archiveWorkspace(w.worktree.workspaceId);
      const confirmed = await this.host.port().inspect(w.execute!.id);
      if (confirmed?.archived !== true || confirmed.workspaceId !== w.worktree.workspaceId)
        throw new Error("워크스페이스 보관 결과를 확인하지 못했습니다");
      await record("done", this.doneDetail(w));
    } catch (error) {
      if (!attempted) state.attempts++;
      state.at = new Date(this.host.now()).toISOString();
      const reason = error instanceof Error ? error.message : String(error);
      await record("failed", `따로 작업 공간을 자동으로 정리하지 못했습니다: ${reason}. 직접 보관하세요.`);
    }
  }
  private async releaseOwnedPin(w: Workflow, ownedPinAt: string): Promise<Readiness> {
    const pending = (): Readiness => ({ stage: "pending", detail: "플러그인이 고정한 작업 공간의 고정 해제를 확인하지 못해 보존합니다. 다음 점검 때 다시 확인합니다." });
    try {
      const port = this.host.port().pushReview;
      const id = w.worktree!.workspaceId;
      if (!port?.unpin || !await port.unpin(id, ownedPinAt)) return pending();
      const current = await port.get(id);
      if (!current || current.pinnedAt !== null) return pending();
      for (const row of [...w.startPin?.workspaces ?? [], ...w.pushReview?.workspaces ?? []]) {
        if (row.id === id && row.ownedPinAt === ownedPinAt) {
          row.phase = "acknowledged";
          row.ownedPinAt = null;
        }
      }
      await this.host.save();
      // A user may have pinned or resumed the conversation during the unpin RPC.
      const ready = await this.readiness(w);
      return ready.ownedPinAt ? pending() : ready;
    } catch {
      return pending();
    }
  }
  private doneDetail(w: Workflow) {
    return `따로 작업 공간을 정리했습니다(코드는 ${w.pushTargets.find(t => t.commit === w.integration?.commit)?.branch ?? "기준 브랜치"}에 반영됨).`;
  }
  private async readiness(w: Workflow): Promise<Readiness> {
    try {
      return await this.inspectReadiness(w);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { stage: "pending", detail: `따로 작업 공간 상태를 확인하지 못해 보존합니다: ${reason}. 다음 점검 때 다시 확인합니다.` };
    }
  }
  private async inspectReadiness(w: Workflow): Promise<Readiness> {
    const preserve = (detail: string, stage: "pending" | "skipped" = "skipped"): Readiness => ({ stage, detail });
    if (!(await this.host.settings()).autoArchiveWorktree) return preserve("따로 작업 공간 자동 정리 설정이 꺼져 있어 보존합니다.");
    const commit = w.integration?.commit;
    if (!w.integration?.ok || !commit || w.managedPush?.state !== "pushed" ||
      !w.managedPush.targets.some(t => t.commit === commit && t.verified === true) ||
      !w.pushCheck?.targets.some(t => t.commit === commit && t.result === "pushed"))
      return preserve("푸시 확인과 기준 브랜치 반영이 일치하지 않아 따로 작업 공간을 보존합니다.");
    if (w.pending || w.inbox || w.held || w.asker || w.selectionPlan || w.limitPlan || w.planConflict || w.generalTransition ||
      w.execute?.compaction || w.plan?.compaction)
      return preserve("미정리 작업이나 압축이 끝나면 따로 작업 공간 정리를 다시 확인합니다.", "pending");
    const tree = w.worktree!;
    const member = w.execute;
    if (!member?.workspaceId || member.workspaceId !== tree.workspaceId || tree.workspaceId === w.plan?.workspaceId)
      return preserve("구현 담당 작업 공간의 소속을 확인하지 못해 보존합니다.");
    const flows = (await this.host.db()).workflows;
    if (archiveWorkspaceShared(flows, w.id, [tree.workspaceId])) return preserve("다른 작업이 함께 쓰는 작업 공간을 보존합니다.");
    const inspection = await this.host.port().archiveInspection([tree.workspaceId]);
    if (!archiveMembersPresent([member], inspection.conversations)) throw new Error("구현 대화 소속을 확인하지 못했습니다");
    if (inspection.conversations.some(a => a.workspaceId === tree.workspaceId && a.id !== member.id))
      return preserve("다른 대화가 있는 작업 공간을 보존합니다.");
    const snapshot = await this.host.port().inspect(member.id);
    if (!snapshot || snapshot.workspaceId !== tree.workspaceId) throw new Error("구현 대화 상태를 확인하지 못했습니다");
    if (snapshot.archived) {
      if (w.worktreeCleanup?.evidenceFiles !== null && w.worktreeCleanup?.evidenceFiles !== undefined)
        return { stage: "done", detail: this.doneDetail(w) };
      return preserve("이미 보관된 작업 공간의 증거 보존을 확인하지 못했습니다.");
    }
    const conversation = inspection.conversations.find(a => a.id === member.id)!;
    const workspace = inspection.workspaces.find(ws => ws.id === tree.workspaceId);
    if (!workspace) throw new Error("구현 작업 공간을 확인하지 못했습니다");
    const ownedPinAt = [...w.startPin?.workspaces ?? [], ...w.pushReview?.workspaces ?? []]
      .find(row => row.id === tree.workspaceId && row.ownedPinAt && row.ownedPinAt === workspace.pinnedAt)?.ownedPinAt;
    if (archiveWorkspacePinned(workspace)) {
      if (!ownedPinAt)
        return preserve("고정된 작업 공간은 보존합니다. 고정을 해제하면 따로 작업 공간 정리를 다시 확인합니다.", "pending");
      if (!this.host.port().pushReview?.unpin)
        return preserve("플러그인 고정 해제를 지원하지 않아 따로 작업 공간을 보존합니다.", "pending");
    }
    if (workspace.archiving || !["idle", "closed"].includes(conversation.status) || conversation.permission !== false ||
      conversation.activeTurn !== false || snapshot.permission || !["idle", "closed"].includes(snapshot.status))
      return preserve("구현 대화의 실행·권한 대기가 끝나면 따로 작업 공간 정리를 다시 확인합니다.", "pending");
    const probe = this.host.probe();
    const [baseline, identity, origin] = await Promise.all([probe?.snapshot(tree.path), probe?.identity?.(tree.path), probe?.identity?.(w.cwd)]);
    if (!baseline || baseline.incomplete || !identity || !origin || identity.common !== origin.common || identity.root !== tree.path || !probe?.isAncestor) throw new Error("worktree 상태를 확인하지 못했습니다");
    if (baseline.dirty.length) return preserve("커밋하지 않은 변경이나 파일이 있어 따로 작업 공간을 보존합니다.");
    const included = await probe.isAncestor(tree.path, identity.head, commit);
    if (included === null) throw new Error("worktree 커밋의 반영 여부를 확인하지 못했습니다");
    if (!included) return preserve("반영되지 않은 로컬 커밋이 있어 따로 작업 공간을 보존합니다.");
    return { stage: "ready", detail: "", ...(ownedPinAt ? { ownedPinAt } : {}) };
  }
}

function safeSegment(value: string) {
  if (!value || value === "." || value === ".." || path.basename(value) !== value) throw new Error("증거 보존 경로가 올바르지 않습니다");
  return value;
}
async function evidenceFiles(folder: string, prefix = ""): Promise<{ name: string; size: number; mtime: number }[]> {
  const rows: { name: string; size: number; mtime: number }[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const name = path.join(prefix, entry.name);
    const info = await lstat(path.join(folder, entry.name));
    if (info.isSymbolicLink()) throw new Error("evidence의 심볼릭 링크는 보존 전에 직접 확인해야 합니다");
    if (info.isDirectory()) rows.push(...await evidenceFiles(path.join(folder, entry.name), name));
    else if (info.isFile()) rows.push({ name, size: info.size, mtime: info.mtimeMs });
    else throw new Error("evidence에 일반 파일이 아닌 항목이 있습니다");
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
/** The destination is outside every checkout; count and size checks must finish before archive. */
export async function preserveEvidence(source: string, destination: string): Promise<number> {
  const sourceInfo = await lstat(source).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!sourceInfo) return 0;
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("evidence가 일반 폴더가 아닙니다");
  const files = await evidenceFiles(source);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = path.join(destination, file.name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(source, file.name), target);
    if ((await lstat(target)).size !== file.size) throw new Error("evidence 복사 결과가 일치하지 않습니다");
  }
  if (JSON.stringify(await evidenceFiles(source)) !== JSON.stringify(files)) throw new Error("복사 중 evidence가 변경되어 작업 공간을 보존합니다");
  const copied = await evidenceFiles(destination);
  if (!files.every(file => copied.some(other => other.name === file.name && other.size === file.size)))
    throw new Error("evidence 파일 수를 확인하지 못했습니다");
  return files.length;
}
