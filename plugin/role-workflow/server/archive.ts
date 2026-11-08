import type { ArchiveCandidate } from "../shared/contracts";

export interface ArchiveConversation {
  id: string;
  workspaceId: string;
  archived: boolean;
  status: string;
  permission: boolean | null;
  activeTurn: boolean | null;
  lastActivityAt: string | null;
}
export interface ArchiveWorkspace {
  cwd?: string;
  id: string;
  pinnedAt?: string | null;
  archiving: boolean;
  status: string;
}
export interface ArchiveInspection {
  // A complete, successful directory query. Missing records are never invented.
  workspaces: ArchiveWorkspace[];
  conversations: ArchiveConversation[];
}
export interface ArchiveFlow {
  id: string;
  number: number;
  title: string;
  projectId: string;
  cwd: string;
  mode: string;
  brainstorm?: boolean;
  progress: string;
  status: string;
  isolation?: string;
  worktreeCleanup?: { stage: string } | null;
  plan: { id: string; workspaceId: string | null; compaction?: string | null } | null;
  execute: { id: string; workspaceId: string | null; compaction?: string | null } | null;
  pending?: unknown;
  inbox?: unknown;
  held?: unknown;
  asker?: unknown;
  generalTransition?: boolean;
  generalDelivery?: { stage: string } | null;
}
export function isFinished(w: Pick<ArchiveFlow, "progress" | "mode" | "brainstorm">): boolean {
  return (
    (w.mode !== "undecided" || (!!w.brainstorm && w.progress === "no_push")) &&
    (w.progress === "done" || w.progress === "pushed" || w.progress === "no_push")
  );
}
function hasUnsettledWork(w: ArchiveFlow): boolean {
  return !!(
    w.pending ||
    w.inbox ||
    w.held ||
    w.asker ||
    w.generalTransition ||
    (w.generalDelivery && w.generalDelivery.stage !== "sent")
  );
}

/** Shared ownership and member identity checks used by both archive paths. */
export function archiveWorkspaceShared(workflows: readonly ArchiveFlow[], ownerId: string, ids: readonly string[]) {
  return workflows.some(other => other.id !== ownerId && [other.plan, other.execute].some(member =>
    member?.workspaceId && ids.includes(member.workspaceId)));
}
export function archiveMembersPresent(
  members: { id: string; workspaceId: string | null }[], conversations: ArchiveConversation[],
) {
  return members.every(member => conversations.some(a => a.id === member.id && a.workspaceId === member.workspaceId));
}

export function archiveBlockReason(w: Pick<ArchiveFlow, "isolation" | "worktreeCleanup" | "progress">): string | null {
  if (w.isolation !== "worktree" || w.worktreeCleanup?.stage === "done") return null;
  return w.progress === "done" || w.progress === "no_push"
    ? "푸시 전 작업의 따로 작업 공간은 자동 정리하지 않습니다. 필요하면 커밋을 확인한 뒤 Paseo에서 직접 보관하세요(무시된 파일과 커밋하지 않은 파일은 지워집니다)."
    : "따로 작업 공간 정리가 끝나지 않아 보관하지 않습니다";
}
export function archiveWorkspacePinned(workspace: ArchiveWorkspace): boolean {
  return workspace.pinnedAt !== null;
}

/** Unknown pinning, activity or conversation state always preserves the workspace. */
export function archiveCandidate(
  w: ArchiveFlow,
  inspection: ArchiveInspection,
  progress: "done" | "pushed",
  days: number,
  now = Date.now(),
): ArchiveCandidate | null {
  if (
    !!archiveBlockReason(w) ||
    !isFinished(w) ||
    w.progress !== progress ||
    !Number.isSafeInteger(days) ||
    days < 0 ||
    !Number.isFinite(now) ||
    !["active", "paused", "completed"].includes(w.status) ||
    hasUnsettledWork(w)
  )
    return null;
  const members = [w.plan, w.execute].filter((m) => m !== null);
  if (!members.length || members.some((m) => !m.workspaceId || m.compaction)) return null;
  const workspaceIds = [...new Set(members.map((m) => m.workspaceId!))];
  const conversations = inspection.conversations.filter((a) =>
    workspaceIds.includes(a.workspaceId),
  );
  if (
    !archiveMembersPresent(members, conversations)
  )
    return null;
  const activeIds = activeWorkspaceIds(workspaceIds, inspection, conversations);
  const last = latestActivity(conversations, now);
  if (!activeIds || last === null || now - last < days * 86400000) return null;
  return {
    id: w.id,
    number: w.number,
    title: w.title,
    projectId: w.projectId,
    folder: w.cwd.split(/[\\/]/).findLast(Boolean) ?? w.cwd,
    progress,
    workspaceIds: activeIds,
    agentIds: members.map((m) => m.id),
    lastActivityAt: new Date(last).toISOString(),
  };
}

export function archiveCandidates(
  workflows: readonly ArchiveFlow[],
  inspection: ArchiveInspection,
  progress: "done" | "pushed",
  days: number,
  now = Date.now(),
  ids?: readonly string[],
): ArchiveCandidate[] {
  return workflows.flatMap((w) => {
    if (ids && !ids.includes(w.id)) return [];
    const shared = archiveWorkspaceShared(workflows, w.id,
      [w.plan?.workspaceId, w.execute?.workspaceId].filter((id): id is string => !!id));
    const row = shared ? null : archiveCandidate(w, inspection, progress, days, now);
    return row ? [row] : [];
  });
}

function activeWorkspaceIds(
  workspaceIds: string[],
  inspection: ArchiveInspection,
  conversations: ArchiveConversation[],
): string[] | null {
  const activeIds: string[] = [];
  for (const id of workspaceIds) {
    const workspace = inspection.workspaces.find((ws) => ws.id === id);
    const agents = conversations.filter((a) => a.workspaceId === id);
    if (!workspace) {
      // A separately archived half may be absent only when all its agents confirm archive.
      if (!agents.length || agents.some((a) => a.archived !== true)) return null;
      continue;
    }
    if (
      archiveWorkspacePinned(workspace) ||
      workspace.archiving ||
      !["done", "attention"].includes(workspace.status)
    )
      return null;
    activeIds.push(id);
  }
  return activeIds.length ? activeIds : null;
}

function latestActivity(conversations: ArchiveConversation[], now: number): number | null {
  let last = -Infinity;
  for (const a of conversations) {
    if (
      a.archived !== true &&
      (a.archived !== false ||
        !["idle", "closed"].includes(a.status) ||
        a.permission !== false ||
        a.activeTurn !== false)
    )
      return null;
    if (!a.lastActivityAt) return null;
    const time = Date.parse(a.lastActivityAt);
    if (!Number.isFinite(time) || time > now) return null;
    last = Math.max(last, time);
  }
  return Number.isFinite(last) ? last : null;
}
