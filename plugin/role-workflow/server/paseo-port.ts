import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { usageAvailable } from "./quota";
import { createHash } from "node:crypto";
import type { PaseoApi, PaseoAgentConfig, PaseoAgent } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { contextRatio, decorateTitle } from "./protocol";
import type { WorkflowPort, History } from "./engine";
import type { ArchiveInspection, ArchiveConversation } from "./archive";
import type { PushReviewPort } from "./push-review";
import { turnEvidence } from "./push-evidence";
import { createProjectTitleSync } from "./project-titles";

const ASYNC_ANSWER_PREFIX = "Answers to your questions:\n\n";

function isAsyncAnswerCandidate(item: AgentTimelineItem): boolean {
  return item.type === "user_message" && item.text.startsWith(ASYNC_ANSWER_PREFIX);
}

/** Only a completed question's exact provider-generated answer can extend evidence. */
function evidenceBoundary(
  items: readonly AgentTimelineItem[],
  turnIds?: readonly (string | undefined)[],
): number {
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  let boundary = -1;
  let lastUser = -1;
  for (const [index, item] of items.entries()) {
    if (
      item.type === "tool_call" &&
      item.name === "request_user_input_async" &&
      item.status === "completed" &&
      item.error === null &&
      item.callId &&
      item.detail.type === "plain_text" &&
      item.detail.text
    ) {
      // A question can identify only one matching answer, even if its call is repeated.
      if (seen.has(item.callId)) pending.delete(item.callId);
      else pending.set(item.callId, ASYNC_ANSWER_PREFIX + item.detail.text);
      seen.add(item.callId);
    }
    if (item.type !== "user_message") continue;
    lastUser = index;
    const matches = [...pending].filter(([, answer]) => answer === item.text);
    const sameTurn =
      new Set(turnIds?.slice(boundary, index + 1).filter((id) => id !== undefined)).size <= 1;
    if (boundary >= 0 && matches.length === 1 && sameTurn) {
      pending.delete(matches[0][0]);
      continue;
    }
    // Ordinary steering remains a new boundary, even within the same provider turn.
    // Earlier questions cannot carry old push evidence across that request.
    boundary = index;
    pending.clear();
  }
  // A response that starts a new provider turn cannot inherit the question's earlier push.
  if (
    boundary < lastUser &&
    new Set(turnIds?.slice(boundary).filter((id) => id !== undefined)).size > 1
  )
    return lastUser;
  return boundary;
}

export function readTurn(
  items: readonly AgentTimelineItem[],
  cwd?: string,
  turnIds?: readonly (string | undefined)[],
): History & { goal: string; request: string; maintenance: boolean } {
  const lastUser = items.findLastIndex((item) => item.type === "user_message");
  const turn = items.slice(lastUser + 1);
  const user = items[lastUser];
  const messages = turn
    .filter((item) => item.type === "assistant_message")
    .map((item) => item.text);
  // Timeline entries are separate messages. Joining without a boundary swallows a
  // standalone status/target line next to the following commentary or final answer.
  const text = messages.join("\n");
  const messageIds = items.flatMap((item) =>
    item.type === "user_message"
      ? [item.clientMessageId, item.messageId].filter((id): id is string => !!id)
      : [],
  );
  const identity =
    user?.type === "user_message" ? (user.clientMessageId ?? user.messageId ?? user.text) : "";
  const first = items.find((item) => item.type === "user_message");
  return {
    text,
    // Keep persisted text/key/request semantics; only the tool evidence spans an async answer.
    evidence: turnEvidence(items.slice(evidenceBoundary(items, turnIds) + 1), cwd),
    compacted: turn.some((item) => item.type === "compaction" && item.status === "completed"),
    maintenance:
      user?.type === "user_message" &&
      (/^\/compact(?:\s|$)/.test(user.text.trim()) ||
        user.clientMessageId?.startsWith("role-workflow-compact:") === true),
    messageIds,
    key: createHash("sha256")
      // Preserve persisted turn identities across the message-boundary fix.
      .update(identity + "\n" + messages.join(""))
      .digest("hex"),
    failed: null,
    goal: first?.type === "user_message" ? first.text : "",
    request: user?.type === "user_message" ? user.text : "",
  };
}

/** Lifecycle events omit entry metadata; use the matching history snapshot for async answers. */
export async function readCompletedTurn(
  items: readonly AgentTimelineItem[],
  cwd: string | undefined,
  history: () => Promise<History>,
): Promise<ReturnType<typeof readTurn>> {
  const turn = readTurn(items, cwd);
  const lastUser = items.findLastIndex((item) => item.type === "user_message");
  if (lastUser < 0 || !isAsyncAnswerCandidate(items[lastUser])) return turn;
  // A stale/failed history query must not fall back to borrowing earlier push evidence.
  turn.evidence = turnEvidence(items.slice(lastUser + 1), cwd);
  try {
    const saved = await history();
    if (saved.key === turn.key && saved.text === turn.text && saved.evidence)
      turn.evidence = saved.evidence;
  } catch {
    // The current event still provides its own unambiguous post-message evidence.
  }
  return turn;
}

const TAB_NAMES: Record<string, string> = { claude: "Claude", codex: "GPT" };
const HISTORY_PAGE = 200;
const HISTORY_PAGES = 25;

type TimelinePage = Awaited<
  ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>
>;
type HistoricalPage = TimelinePage & {
  agent: NonNullable<TimelinePage["agent"]>;
  startCursor: NonNullable<TimelinePage["startCursor"]>;
  endCursor: NonNullable<TimelinePage["endCursor"]>;
};

function historicalCheck(condition: unknown): asserts condition {
  if (!condition) throw new Error("지정한 과거 푸시의 연속된 기록을 확인할 수 없습니다.");
}

function checkHistoricalPage(page: TimelinePage, agentId: string): asserts page is HistoricalPage {
  historicalCheck(
    !page.error &&
      !page.reset &&
      !page.staleCursor &&
      !page.gap &&
      page.epoch.trim() &&
      page.projection === "projected" &&
      page.agentId === agentId &&
      page.agent?.id === agentId &&
      page.agent.cwd &&
      path.isAbsolute(page.agent.cwd) &&
      page.entries.length > 0 &&
      page.startCursor?.epoch === page.epoch &&
      page.endCursor?.epoch === page.epoch,
  );
}

function checkHistoricalWindow(
  page: HistoricalPage,
  newest: HistoricalPage | undefined,
  before: TimelinePage["startCursor"],
): void {
  if (newest) {
    // A before-page legitimately has newer entries: they are the pages already read.
    // A fixed canonical window and adjacent cursor bounds exclude skipped/replaced pages.
    historicalCheck(
      before &&
        page.direction === "before" &&
        page.hasNewer &&
        page.epoch === newest.epoch &&
        page.agent.cwd === newest.agent.cwd &&
        page.window.minSeq === newest.window.minSeq &&
        page.window.maxSeq === newest.window.maxSeq &&
        page.window.nextSeq === newest.window.nextSeq &&
        page.endCursor.seq === before.seq - 1,
    );
  } else {
    historicalCheck(
      page.direction === "tail" && !page.hasNewer && page.endCursor.seq === page.window.maxSeq,
    );
  }
}

function checkHistoricalEntries(
  page: HistoricalPage,
  newest: HistoricalPage,
  requireTurnIds = true,
): void {
  historicalCheck(
    page.startCursor.seq === page.entries[0].seqStart && page.startCursor.seq <= page.endCursor.seq,
  );
  let previous = page.startCursor.seq - 1;
  for (const entry of page.entries) {
    historicalCheck(
      (!requireTurnIds || entry.turnId?.trim()) &&
        entry.provider === newest.entries[0].provider &&
        Number.isSafeInteger(entry.seqStart) &&
        Number.isSafeInteger(entry.seqEnd) &&
        entry.seqStart > previous &&
        entry.seqStart <= page.endCursor.seq &&
        entry.seqEnd >= entry.seqStart &&
        entry.seqEnd <= page.window.maxSeq,
    );
    previous = entry.seqStart;
  }
}

/** An explicit source request only: later turns must contain complete text-only replies. */
async function readHistoricalPush(
  api: PaseoApi,
  agentId: string,
  messageId: string,
): Promise<{ turn: History; later: History[] }> {
  historicalCheck(messageId.trim());
  const timeline = api.agents.ref(agentId).timeline;
  const pages: TimelinePage["entries"][] = [];
  let newest: HistoricalPage | undefined;
  let before: TimelinePage["startCursor"] = null;
  let source = -1;
  let bounded = false;
  for (let count = 0; count < HISTORY_PAGES; count++) {
    const page = await timeline.refetch(
      before
        ? { direction: "before", cursor: before, limit: HISTORY_PAGE }
        : { limit: HISTORY_PAGE },
    );
    checkHistoricalPage(page, agentId);
    checkHistoricalWindow(page, newest, before);
    newest ??= page;
    checkHistoricalEntries(page, newest);
    pages.unshift(page.entries);
    const entries = pages.flat();
    historicalCheck(entries.length <= HISTORY_PAGE * HISTORY_PAGES);
    const matches = entries.flatMap((entry, index) =>
      entry.item.type === "user_message" &&
      (entry.item.messageId === messageId || entry.item.clientMessageId === messageId)
        ? [index]
        : [],
    );
    historicalCheck(matches.length <= 1);
    source = matches[0] ?? -1;
    if (source > 0) {
      historicalCheck(entries[source - 1].turnId !== entries[source].turnId);
      bounded = true;
      break;
    }
    if (!page.hasOlder) {
      bounded = source === 0;
      break;
    }
    before = page.startCursor;
  }
  historicalCheck(newest?.agent && bounded && source >= 0);
  return historicalTurns(pages.flat(), source, newest.agent.cwd);
}

function checkHistoricalTurnOrder(entries: TimelinePage["entries"]): void {
  const seen = new Set<string>();
  let previousTurn: string | undefined;
  for (const entry of entries) {
    // Discontinuous reuse can join unrelated runs after a provider session replacement.
    if (entry.turnId !== previousTurn) {
      historicalCheck(entry.turnId && !seen.has(entry.turnId));
      seen.add(entry.turnId);
      previousTurn = entry.turnId;
    }
  }
}

function historicalTurns(
  entries: TimelinePage["entries"],
  source: number,
  cwd: string,
): { turn: History; later: History[] } {
  checkHistoricalTurnOrder(entries);
  const groups: TimelinePage["entries"][] = [];
  for (const entry of entries.slice(source)) {
    const group = groups.at(-1);
    if (group && group[0].turnId === entry.turnId) group.push(entry);
    else groups.push([entry]);
  }
  historicalCheck(groups.length >= 2);
  const turns = groups.map((group, index) => {
    const items = group.map((entry) => entry.item);
    const turnIds = group.map((entry) => entry.turnId);
    historicalCheck(
      group[0].item.type === "user_message" && group.at(-1)?.item.type === "assistant_message",
    );
    if (index === 0) {
      // An ordinary later request in this provider turn cannot supply a different push.
      historicalCheck(evidenceBoundary(items, turnIds) === 0);
    } else {
      // One user only: readTurn must not hide earlier activity behind a later steering message.
      // Model reasoning is not activity; Claude records it before most replies.
      historicalCheck(
        group
          .slice(1)
          .every((entry) => ["assistant_message", "reasoning"].includes(entry.item.type)),
      );
    }
    return readTurn(items, cwd, turnIds);
  });
  return { turn: turns[0], later: turns.slice(1) };
}

function latestAuditTurn(
  entries: TimelinePage["entries"],
  cwd: string,
  hasOlder: boolean,
): History | null {
  const latest = entries.at(-1)!;
  historicalCheck(latest.turnId?.trim());
  historicalCheck(latest.item.type === "assistant_message" && latest.item.text.trim());
  const start = entries.findLastIndex((entry) => entry.turnId !== latest.turnId) + 1;
  const prefix = entries.slice(0, start);
  // Old provider imports can lack turn ids. They are excluded from evidence; a missing id
  // inside this turn (or reuse of this turn id) still makes its boundary ambiguous.
  historicalCheck(!prefix.some((entry) => entry.turnId === latest.turnId));
  const previousTurn = prefix.some((entry) => entry.turnId?.trim());
  // A page can start halfway through a provider turn, including at a steering user message.
  if (!previousTurn && hasOlder) return null;
  historicalCheck(start === 0 || previousTurn);
  const group = entries.slice(start);
  historicalCheck(group[0].item.type === "user_message");
  historicalCheck(auditTurnFinished(group));
  return readTurn(
    group.map((entry) => entry.item),
    cwd,
    group.map((entry) => entry.turnId),
  );
}

function auditTurnFinished(entries: TimelinePage["entries"]): boolean {
  let compactions = 0;
  for (const { item } of entries) {
    if (
      item.type === "error" ||
      (item.type === "notification" && item.level === "error") ||
      (item.type === "tool_call" && item.status === "running")
    )
      return false;
    if (item.type === "compaction") {
      if (item.status === "loading") compactions++;
      else compactions = Math.max(0, compactions - 1);
    }
  }
  return compactions === 0;
}

/** Automatic audits never search across a later provider turn, even a text-only follow-up. */
async function readPushAuditHistory(api: PaseoApi, agentId: string): Promise<History> {
  const timeline = api.agents.ref(agentId).timeline;
  const pages: TimelinePage["entries"][] = [];
  let newest: HistoricalPage | undefined;
  let before: TimelinePage["startCursor"] = null;
  for (let count = 0; count < HISTORY_PAGES; count++) {
    const page = await timeline.refetch(
      before
        ? { direction: "before", cursor: before, limit: HISTORY_PAGE }
        : { limit: HISTORY_PAGE },
    );
    checkHistoricalPage(page, agentId);
    checkHistoricalWindow(page, newest, before);
    historicalCheck(
      page.agent.status === "idle" &&
        page.agent.activeTurn === null &&
        page.agent.pendingPermissions?.length === 0 &&
        !page.agent.archivedAt,
    );
    newest ??= page;
    checkHistoricalEntries(page, newest, false);
    pages.unshift(page.entries);
    const entries = pages.flat();
    historicalCheck(entries.length <= HISTORY_PAGE * HISTORY_PAGES);
    const turn = latestAuditTurn(entries, newest.agent.cwd, page.hasOlder);
    if (turn)
      return {
        ...turn,
        auditRevision: JSON.stringify([
          newest.epoch,
          newest.window.maxSeq,
          newest.window.nextSeq,
          entries.at(-1)!.turnId,
        ]),
      };
    before = page.startCursor;
  }
  throw new Error("최신 푸시 응답의 시작 경계를 확인할 수 없습니다.");
}

async function readProjectName(api: PaseoApi, projectId: string, cwd = ""): Promise<string> {
  try {
    const project = (await api.projects.list()).projects.find((row) => row.projectId === projectId);
    const name = project?.projectCustomName?.trim() || project?.projectDisplayName.trim();
    if (name) return name;
  } catch {
    // Titles can still be updated while the project directory is unavailable.
  }
  return path.basename(cwd) || "프로젝트";
}

export function createPort(
  getApi: () => PaseoApi,
  pins?: { pin: PushReviewPort["pin"]; unpin(id: string): Promise<void> },
): WorkflowPort {
  const usageRecoveryEnabled = false;
  let usageCheckedAt = -Infinity;
  let usage: ReturnType<PaseoApi["providers"]["listUsage"]> | undefined;
  return {
    syncProjectTitles: createProjectTitleSync(getApi),
    ...(pins
      ? {
          pushReview: {
            pin: pins.pin,
            async get(workspaceId: string) {
              const workspace = await getApi().workspaces.ref(workspaceId).refresh();
              return workspace ? { pinnedAt: workspace.pinnedAt ?? null } : null;
            },
            async unpin(workspaceId: string, expectedPinAt: string) {
              const workspace = await getApi().workspaces.ref(workspaceId).refresh();
              if (!workspace || workspace.pinnedAt !== expectedPinAt) return false;
              await pins.unpin(workspaceId);
              return true;
            },
          },
        }
      : {}),
    async quotaAccount(provider) {
      return quotaAccount(provider);
    },
    async quotaAvailable(provider) {
      // Disable usage recovery until quota decisions identify the executing account.
      if (!usageRecoveryEnabled) return null;
      try {
        if (!usage || Date.now() - usageCheckedAt >= 60_000) {
          usageCheckedAt = Date.now();
          usage = limitedUsage(getApi());
        }
        const result = await usage;
        const age = Date.now() - Date.parse(result.fetchedAt);
        if (!Number.isFinite(age) || age < -60_000 || age > 120_000) return null;
        const found = result.providers.find((entry) => entry.providerId === provider);
        return found ? usageAvailable(found) : null;
      } catch {
        return null;
      }
    },
    async archiveInspection(workspaceIds) {
      return readArchiveInspection(getApi(), workspaceIds);
    },
    async archiveWorkspace(workspaceId) {
      const result = await getApi().workspaces.ref(workspaceId).archive();
      if (result.error || !result.archivedAt || result.workspaceId !== workspaceId)
        throw new Error(result.error || "워크스페이스 보관을 확인하지 못했습니다.");
    },
    async workspaceName(workspaceId) {
      return (await getApi().workspaces.ref(workspaceId).refresh())?.name ?? null;
    },
    async projectName(projectId, cwd) {
      return readProjectName(getApi(), projectId, cwd);
    },
    async rename(workspaceId, title) {
      await getApi().workspaces.ref(workspaceId).setTitle(title);
    },
    async inspect(id) {
      const api = getApi();
      const snapshot = await api.agents.ref(id).refresh();
      if (!snapshot?.agent.workspaceId) return null;
      const agent = snapshot.agent;
      const workspace = await api.workspaces.ref(agent.workspaceId!).refresh();
      if (!workspace && !agent.archivedAt) return null;
      return {
        id: agent.id,
        workspaceId: agent.workspaceId!,
        projectId: workspace?.projectId ?? "",
        cwd: agent.cwd,
        title: agent.title || workspace?.name || "작업",
        status: agent.status,
        archived: !!agent.archivedAt,
        archivedAt: agent.archivedAt ?? null,
        permission: agent.pendingPermissions.length > 0,
        usage: contextRatio(agent.lastUsage),
      };
    },
    async create(w, role, member, marker = false) {
      const api = getApi();
      const base = member.config.provider.split("/")[0];
      const model = await resolveModel(api, w.cwd, member.config);
      await validateMode(api, base, w.cwd, member.config);
      member.config = { ...member.config, provider: `${base}/${model}` };
      const title = decorateTitle(base, role, w.title, marker, {
        projectName: await readProjectName(api, w.projectId, w.cwd),
        number: w.number,
        progress: w.progress,
        generation: member.generation,
      }).slice(0, 120);
      // The executor opens as a tab beside its planner, so the pair is one row in every
      // client's sidebar. A workspace of its own is only for a conversation without one.
      const beside = role === "execute" ? (w.plan?.workspaceId ?? null) : null;
      const workspace = beside
        ? api.workspaces.ref(beside)
        : await api.workspaces.create({
            idempotencyKey: `role-workflow:${w.id}:${role}:${member.generation}`,
            source: { kind: "directory", path: w.cwd, projectId: w.projectId },
            title,
          });
      const agent = await workspace.agents.create({
        agentId: member.id,
        idempotencyKey: `role-workflow-agent:${member.id}`,
        title: beside ? `${TAB_NAMES[base] ?? base} 실행` : title,
        config: member.config,
        env: { ...member.env, PASEO_ROLE_WORKFLOW_MANAGED: "1", PASEO_ROLE_WORKFLOW_ROLE: role },
        labels: {
          "role-workflow.id": w.id,
          "role-workflow.role": role,
          "role-workflow.generation": String(member.generation),
        },
      });
      if (agent.id !== member.id) throw new Error("생성된 대화 ID가 인계 대상과 다릅니다.");
      return workspace.id;
    },
    async compact(id, messageId) {
      const agent = getApi().agents.ref(id);
      let finish!: (error: Error | null) => void;
      const completed = new Promise<Error | null>((resolve) => {
        finish = resolve;
      });
      const timer = setTimeout(
        () => finish(new Error("압축 완료 확인 시간이 초과되었습니다.")),
        180000,
      );
      let assistantText = "";
      const subscription = agent.timeline.subscribe(({ event }) => {
        if (event.type === "error" || event.type === "turn_failed") finish(new Error(event.error));
        if (event.type === "turn_canceled") finish(new Error(event.reason));
        if (event.type !== "timeline") return;
        if (event.item.type === "compaction" && event.item.status === "completed") finish(null);
        if (event.item.type === "assistant_message") {
          assistantText += event.item.text;
          if (assistantText.includes("Failed to compact context:"))
            finish(new Error(assistantText));
        }
      });
      try {
        await subscription.ready;
        await agent.send("/compact", { messageId });
        const error = await completed;
        if (error) throw error;
      } finally {
        clearTimeout(timer);
        subscription();
      }
    },
    async send(id, prompt, messageId) {
      await getApi().agents.ref(id).send(prompt, { messageId });
    },
    async historicalPush(agentId, messageId) {
      return readHistoricalPush(getApi(), agentId, messageId);
    },
    async pushAuditHistory(agentId) {
      return readPushAuditHistory(getApi(), agentId);
    },
    async history(id, through) {
      const timeline = getApi().agents.ref(id).timeline;
      let page = await timeline.refetch({ limit: HISTORY_PAGE });
      const pages = [page.entries];
      // One page holds 200 entries and a long turn has more. Walk back until the message
      // that started the turn is in view. A caller confirming a delivery names that message,
      // because a later one from the user may sit between it and the end of the turn.
      const reached = () => {
        const items = pages.flatMap((entries) => entries.map((entry) => entry.item));
        // The answer prefix only requests more history. It never proves an answer:
        // evidenceBoundary also requires the exact preceding question tool and turn metadata.
        const boundary = items.some(
          (item) => item.type === "user_message" && !isAsyncAnswerCandidate(item),
        );
        return (
          boundary &&
          items.some(
            (item) =>
              item.type === "user_message" &&
              (!through || item.clientMessageId === through || item.messageId === through),
          )
        );
      };
      while (pages.length < HISTORY_PAGES && page.hasOlder && page.startCursor && !reached()) {
        page = await timeline.refetch({
          direction: "before",
          cursor: page.startCursor,
          limit: HISTORY_PAGE,
        });
        // A cursor from a replaced timeline returns the newest page again.
        if (page.reset) break;
        pages.unshift(page.entries);
      }
      const entries = pages.flat();
      return readTurn(
        entries.map((entry) => entry.item),
        page.agent?.cwd,
        entries.map((entry) => entry.turnId),
      );
    },
  };
}

/** Read-only safety snapshot, including every tab in the requested workspaces. */
/**
 * The daemon can leave a timeline read unanswered (seen for closed Codex conversations
 * whose history it cannot load). The engine runs this inside its serial queue, where
 * three 60-second client timeouts blocked every lifecycle hook for three minutes, so
 * each read is bounded and reads run a few at a time.
 */
const ARCHIVE_ACTIVITY_TIMEOUT_MS = 5000;
const ARCHIVE_ACTIVITY_CONCURRENCY = 8;

export async function readArchiveInspection(
  api: PaseoApi,
  workspaceIds: readonly string[],
  options: { activityTimeoutMs?: number } = {},
): Promise<ArchiveInspection> {
  const activityTimeoutMs = options.activityTimeoutMs ?? ARCHIVE_ACTIVITY_TIMEOUT_MS;
  const workspaces: ArchiveInspection["workspaces"] = [];
  let cursor: string | undefined;
  do {
    const page = await api.workspaces.list({ page: { limit: 200, cursor } });
    workspaces.push(
      ...page.entries
        .filter((w) => workspaceIds.includes(w.id))
        .map((w) => ({
          id: w.id,
          pinnedAt: w.pinnedAt,
          archiving: !!w.archivingAt,
          status: w.status,
        })),
    );
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  const agents: PaseoAgent[] = [];
  do {
    const page = await api.agents.list({
      filter: { includeArchived: true },
      page: { limit: 200, cursor },
    });
    for (const { agent: a } of page.entries) {
      if (!a.workspaceId || !workspaceIds.includes(a.workspaceId)) continue;
      agents.push(a);
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  const conversations: ArchiveConversation[] = [];
  let next = 0;
  const worker = async () => {
    while (next < agents.length) {
      const index = next++;
      conversations[index] = await archiveConversation(api, agents[index], activityTimeoutMs);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(ARCHIVE_ACTIVITY_CONCURRENCY, agents.length) }, worker),
  );
  return { workspaces, conversations };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("대화 활동 조회 시간 초과")), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function archiveConversation(
  api: PaseoApi,
  a: PaseoAgent,
  timeoutMs: number,
): Promise<ArchiveConversation> {
  let lastActivityAt: string | null = null;
  try {
    // Daemons may project this request; merged rows retain their latest update timestamp.
    const tail = await withTimeout(
      api.agents.ref(a.id).timeline.refetch({ limit: 1, projection: "canonical" }),
      timeoutMs,
    );
    if (tail.error || tail.hasNewer || tail.gap || !tail.agent || tail.agent.id !== a.id)
      throw new Error("대화 활동 조회 실패");
    const times = [tail.entries.at(-1)?.timestamp, tail.agent.lastUserMessageAt].filter(
      (value): value is string => value !== null && value !== undefined,
    );
    if (times.length && times.every((time) => Number.isFinite(Date.parse(time))))
      lastActivityAt = new Date(Math.max(...times.map(Date.parse))).toISOString();
    // Use the snapshot from the same timeline query for current permissions and runs.
    const archivedAt = a.archivedAt;
    Object.assign(a, tail.agent);
    if (archivedAt) a.archivedAt = archivedAt;
  } catch {
    // A failed or empty timeline keeps this whole flow out of the candidate list.
  }
  return {
    id: a.id,
    workspaceId: a.workspaceId!,
    archived: !!a.archivedAt,
    status: a.status,
    permission: Array.isArray(a.pendingPermissions) ? a.pendingPermissions.length > 0 : null,
    activeTurn: a.activeTurn === undefined ? null : a.activeTurn !== null,
    lastActivityAt,
  };
}

/** The model the conversation will run: the one asked for, or the provider's default. */
async function resolveModel(api: PaseoApi, cwd: string, config: PaseoAgentConfig): Promise<string> {
  const slash = config.provider.indexOf("/");
  const base = slash === -1 ? config.provider : config.provider.slice(0, slash);
  const requested = slash === -1 ? null : config.provider.slice(slash + 1);
  const catalog = await api.providers.listModels(base, { cwd });
  if (catalog.error) throw new Error(catalog.error);
  const available = catalog.models?.filter((entry) => entry.isSelectable !== false);
  const model =
    requested === null
      ? (available?.find((entry) => entry.isDefault) ?? available?.[0])
      : available?.find((entry) => entry.id === requested);
  if (!model)
    throw new Error(
      requested === null
        ? `${base}의 실행 모델을 찾을 수 없습니다.`
        : `${base}에 ${requested} 모델이 없습니다. 사용 가능: ${
            catalog.models
              ?.slice(0, 4)
              .map((entry) => entry.id)
              .join(", ") ?? "없음"
          }`,
    );
  const thinking = config.thinkingOptionId;
  const thinkingOptions = model.thinkingOptions ?? [];
  if (thinking && !thinkingOptions.some((option) => option.id === thinking))
    throw new Error(
      `${model.id}에 ${thinking} 추론 정도가 없습니다. 사용 가능: ${thinkingOptions.map((option) => option.id).join(", ") || "없음"}`,
    );
  return model.id;
}

async function validateMode(
  api: PaseoApi,
  provider: string,
  cwd: string,
  config: PaseoAgentConfig,
) {
  if (!config.modeId) return;
  const modes = await api.providers.listModes(provider, { cwd });
  if (modes.error) throw new Error(modes.error);
  if (!modes.modes?.some((mode) => mode.id === config.modeId))
    throw new Error(`${provider}에 ${config.modeId} 권한 모드가 없습니다.`);
}

/** A refreshed auth file may replace the symlink. Unknown is never an account change. */
export async function quotaAccount(
  provider: string,
  home = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo"),
): Promise<string | null> {
  if (provider !== "codex") return null;
  const file = path.join(home, "codex-home", "auth.json");
  try {
    return (await lstat(file)).isSymbolicLink() ? await realpath(file) : null;
  } catch {
    return null;
  }
}
async function limitedUsage(api: PaseoApi) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      api.providers.listUsage(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("usage timeout")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
