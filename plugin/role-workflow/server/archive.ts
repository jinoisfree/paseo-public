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
  progress: string;
  status: string;
  plan: { id: string; workspaceId: string | null; compaction?: string | null } | null;
  execute: { id: string; workspaceId: string | null; compaction?: string | null } | null;
  pending?: unknown;
  inbox?: unknown;
  held?: unknown;
  asker?: unknown;
  generalTransition?: boolean;
  generalDelivery?: { stage: string } | null;
}
export function isFinished(w: Pick<ArchiveFlow, "progress" | "mode">): boolean {
  return w.mode !== "undecided" && (w.progress === "done" || w.progress === "pushed");
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

/** Unknown pinning, activity or conversation state always preserves the workspace. */
export function archiveCandidate(
  w: ArchiveFlow,
  inspection: ArchiveInspection,
  progress: "done" | "pushed",
  days: number,
  now = Date.now(),
): ArchiveCandidate | null {
  if (
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
    members.some(
      (m) => !conversations.some((a) => a.id === m.id && a.workspaceId === m.workspaceId),
    )
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
    const shared = workflows.some(
      (other) =>
        other.id !== w.id &&
        [other.plan, other.execute].some(
          (m) =>
            m?.workspaceId && [w.plan?.workspaceId, w.execute?.workspaceId].includes(m.workspaceId),
        ),
    );
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
      workspace.pinnedAt !== null ||
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
