import { planReviewSchema, reviewSelectionSchema } from "../shared/plan-review";
import { PlanReviewGate, planDocumentFolder } from "./plan-review";
import { decisionHash } from "../shared/plan-approval";
import { OwnerPolicyStore } from "./owner-policy";
import { recommendedSettings } from "../shared/recommended";
import { unknownData } from "./data-records";
import { compressionDecision, type ContextUsage } from "../shared/compression";
import { executorSelectionSchema, selectionStageLabel, type SelectionStage } from "../shared/executor-selection";
import { applySelectionBatch, selectionAnswers, pendingFields, timelineSelections, explicitSelection } from "./executor-selection";
import type { ExecutorModel } from "./protocol";
import { capabilities } from "../shared/capabilities";
import { planConflictSchema } from "../shared/plan-disposition";
import { generalStateSchema, type GeneralAgent } from "../shared/general-agent";
import { verdictProblem, verdictView, VERDICT_REPAIR } from "./verdict";
import { generalAnswers, configChoice, type GeneralQuestion } from "./general-agent";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { WorkspaceLifecycle, bindWorkspaceLifecycle } from "./workspace-lifecycle";
import { z } from "zod";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { PaseoAgentConfig } from "@getpaseo/client";
import {
  settingsSchema,
  projectDefaultsSchema,
  archiveEntrySchema,
  type Settings,
} from "../shared/contracts";
import { isFinished, type ArchiveInspection } from "./archive";
import {
  parseDecision,
  DecisionError,
  parseTitle,
  parseProgress,
  stripTitleDecor,
  decorateTitle,
  titleProgress,
  type Decision,
  type TitleRole,
} from "./protocol";
import { executorDefaults, oppositeProvider } from "../shared/assignment";
import { requestsFederation, requestsBrainstorm, normalizeModeLabel, workflowRequestedMode } from "../shared/mode-request";
import { JsonStore } from "./store";
import { ManagedPushRunner } from "./managed-push";
import { managedPushSchema, type ManagedPush } from "../shared/managed-push";
import type { RepoProbe } from "./git";
import { pushPending, type TurnEvidence } from "./push-evidence";
import {
  pushReviewSchema,
  pushReviewKey,
  syncPushReview,
} from "./push-review";
import {
  repositoryPathsSchema,
  pushTargetsSchema,
  proseArtifacts,
  verdictRecordSchema,
  type PushTarget,
} from "../shared/artifacts";
import {
  repositoryPaths,
  resolvedPushTargets,
  pushCheckSchema,
  verificationRecordSchema,
  inspectVerification,
} from "./artifacts";
import { resolvedFolder, pathsOverlap } from "./workspaces";
import { WorktreeCleanup } from "./worktree-cleanup";
import { placeExecutor, workFolder, worktreeContext } from "./worktree";
import { quotaPauseSchema } from "./quota";
import { transientPauseSchema } from "./transient";
import { Recovery } from "./recovery";
import { Compaction } from "./compaction";
import { ExecutorChoice } from "./executor-choice";
import { ManagedPushes } from "./managed-pushes";
import { GeneralMode } from "./general-mode";
import { PushAudit } from "./push-audit";
import { Archives } from "./archives";

const memberSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  generation: z.number(),
  config: z.custom<PaseoAgentConfig>(
    (v) => !!v && typeof v === "object" && typeof unknownData(v, "provider") === "string",
  ),
  env: z.record(z.string(), z.string()).default({}),
  usage: z.number().nullable(),
  lastTurnKey: z.string().default(""),
  compactedForTurn: z.string().default(""),
  compaction: z.string().nullable().default(null),
  compactionTurnKey: z.string().default(""),
  compactionError: z.string().default(""),
  compactions: z.number().int().default(0),
  handoff: z.string().default(""),
  rememberedThrough: z.number().int().nonnegative().default(0),
});
export type Member = z.infer<typeof memberSchema>;
const inboxSchema = z.object({
  key: z.string(),
  agentId: z.string(),
  text: z.string(),
  failed: z.string().nullable(),
  compacted: z.boolean().default(false),
  canceled: z.boolean().default(false),
  reviewerViolation: z.string().default(""),
  // The turn arrived while the flow waited for an answer.
  resumed: z.boolean().default(false),
  // The turn replies to the instruction this engine delivered, not to something the user typed.
  answers: z.boolean().default(false),
});
type Inbox = z.infer<typeof inboxSchema>;
type Role = "plan" | "execute" | "reviewer";
function memberRole(w: { plan: Member | null; execute: Member | null; reviewer?: Member | null }, id: string): Role | null {
  for (const role of ["plan", "execute", "reviewer"] as const) if (w[role]?.id === id) return role;
  return null;
}
const pendingSchema = z.object({
  id: z.string(),
  role: z.enum(["plan", "execute", "reviewer"]),
  prompt: z.string(),
  phase: z.enum(["plan", "execute", "review"]),
  rememberedThrough: z.number().int().nonnegative().optional(),
  stage: z.enum(["queued", "sending", "sent"]),
  // The executor's instruction from a plan, as opposed to a follow-up message.
  instruction: z.boolean().default(false),
  // A resend after the turn failed; its addressee already has the message.
  retry: z.boolean().optional(),
});
const baselineSchema = z.object({
  head: z.string(),
  dirty: z.array(z.string()),
  repositories: z
    .array(z.object({ name: z.string(), head: z.string(), dirty: z.array(z.string()) }))
    .max(8)
    .default([]),
  incomplete: z.boolean().default(false),
});
const workflowSchema = z.object({
  id: z.string(),
  selection: executorSelectionSchema.nullable().default(null),
  planIssue: z.object({ response: inboxSchema, pendingId: z.string(), reason: z.string() }).nullable().default(null),
  planConflict: planConflictSchema.nullable().default(null),
  contract: z.number().int().positive().default(1),
  completeRepairs: z.number().int().nonnegative().default(0),
  verdict: verdictRecordSchema.nullable().default(null),
  verdictIssue: z.string().default(""),
  projectId: z.string(),
  cwd: z.string(),
  title: z.string(),
  goal: z.string(),
  titled: z.boolean().default(true),
  number: z.number().int().nonnegative().default(0),
  progress: z.enum(["plan", "active", "done", "pushed", "no_push"]).default("active"),
  mode: z.enum(["undecided", "general", "federated"]).default("federated"),
  notifiedStatus: z.string().nullable().default(null),
  status: z.enum(["active", "paused", "needs_input", "completed", "error"]),
  phase: z.enum(["plan", "execute", "review"]),
  plan: memberSchema.nullable(),
  execute: memberSchema.nullable(),
  reviewer: memberSchema.nullable().default(null),
  reviewPlan: inboxSchema.nullable().default(null),
  reviewSelection: reviewSelectionSchema.default(() => reviewSelectionSchema.parse({})),
  planReview: planReviewSchema.default(() => planReviewSchema.parse({})),
  implementationReserved: z.boolean().default(false),
  cycles: z.number(),
  turns: z.number(),
  detail: z.string(),
  repositories: repositoryPathsSchema.default([]),
  /** Decided once, when the first executor is created; a replacement never moves its work. */
  isolation: z.enum(["undecided", "worktree", "shared"]).default("undecided"),
  placement: z.object({
    stage: z.enum(["choice", "waiting"]), number: z.number(), title: z.string(), reason: z.string(), cardPosted: z.boolean().default(false),
  }).nullable().default(null),
  worktree: z
    .object({ path: z.string(), branch: z.string(), base: z.string(), baseBranch: z.string().optional(), workspaceId: z.string() })
    .nullable()
    .default(null),
  worktreeHistory: z.array(z.object({ path: z.string(), branch: z.string(), base: z.string(), baseBranch: z.string().optional(), workspaceId: z.string() })).default([]),
  worktreeCleanup: z.object({
    stage: z.enum(["pending", "done", "skipped", "failed"]), attempts: z.number().int().nonnegative(),
    detail: z.string(), at: z.string(), evidenceFiles: z.number().int().nonnegative().nullable().default(null),
    permanentSince: z.number().nonnegative().nullable().default(null), permanentError: z.string().default(""), permanentErrors: z.number().int().nonnegative().default(0),
  }).nullable().default(null),
  /** Commit sets already notified about a required base merge; survives restart and retargeting. */
  worktreeMergeNotices: z.array(z.string()).default([]),
  /** Result of moving the planner's checkout to the pushed, verified commit. */
  integration: z.object({ commit: z.string(), ok: z.boolean(), detail: z.string() }).nullable().default(null),
  pushTargets: pushTargetsSchema.default([]),
  pushEpoch: z.number().int().nonnegative().default(0),
  pushAuditGeneration: z.number().int().nonnegative().default(0),
  pushAudit: z
    .object({
      version: z.number().int().positive(),
      fingerprint: z.string(),
      attempts: z.number().int().nonnegative(),
      after: z.number(),
      outcome: z.enum(["checking", "none", "retry", "unverified", "pushed"]),
    })
    .nullable()
    .default(null),
  managedPush: managedPushSchema.nullable().default(null),
  managedRetry: z
    .object({ requestId: z.string(), attempts: z.number().int(), after: z.number() })
    .nullable()
    .default(null),
  pushCheck: pushCheckSchema.nullable().default(null),
  pushUnverified: z.boolean().default(false),
  pushApprovalPending: z.boolean().default(false),
  pushReceipt: z
    .object({
      key: z.string(),
      agentId: z.string(),
      turnKey: z.string(),
      calls: z.array(z.string()).min(1),
    })
    .nullable()
    .default(null),
  pushReview: pushReviewSchema.nullable().default(null),
  startPin: pushReviewSchema.nullable().default(null),
  pushRetry: z
    .object({ attempts: z.number().int().nonnegative(), after: z.number() })
    .nullable()
    .default(null),
  artifactNotice: z.string().default(""),
  invalidTargets: z.boolean().default(false),
  verification: z.array(verificationRecordSchema).max(30).default([]),
  constraints: z.record(z.string(), z.string()).default({}),
  conflict: z.string().default(""),
  writerWait: z
    .object({ key: z.string(), text: z.string(), blocker: z.number().default(0) })
    .nullable()
    .default(null),
  notifiedWriterWait: z.string().default(""),
  generalState: generalStateSchema.default(() => generalStateSchema.parse({})),
  generalTransition: z.boolean().default(false),
  transitionTurns: z.array(inboxSchema).default([]),
  // The plan held at the cycle limit, and a resume note that goes out with it.
  limitPlan: z.string().default(""),
  // The plan held until the executor is picked on the plugin screen (contract 5).
  selectionPlan: z.string().default(""),
  // The in-chat executor picker was posted once the flow became federated (contract 5).
  pickerPosted: z.boolean().default(false),
  brainstorm: z.boolean().default(false),
  brainstormBaseline: z.array(z.string()).default([]),
  holdSeq: z.number().int().nonnegative().default(0),
  heldApproval: z.object({ id: z.number().int().positive(), inboxKey: z.string(), decisionHash: z.string(), summary: z.string(), handoff: z.string(), at: z.string() }).nullable().default(null),
  approvedHold: z.number().int().nonnegative().default(0),
  selectionDraft: executorSelectionSchema.nullable().default(null),
  pickerPostedFor: z.number().int().nonnegative().default(0),
  /** The in-chat mode card was offered once, after a turn that ended with the mode undecided. */
  modePickerPosted: z.boolean().default(false),
  resumeNote: z.string().default(""),
  generalHandoff: z.string().default(""),
  generalDelivery: z
    .object({
      id: z.string(),
      prompt: z.string(),
      stage: z.enum(["queued", "sending", "sent", "uncertain"]),
    })
    .nullable()
    .default(null),
  updatedAt: z.string(),
  lastPlan: z.string(),
  lastResult: z.string(),
  // The executor's instruction, kept outside pending so a lost delivery can be read back.
  lastInstruction: z.string().default(""),
  planFingerprint: z.string().default(""),
  repeatedPlans: z.number().int().nonnegative().default(0),
  wantsFederation: z.boolean().default(false),
  // Who asked the user something. The answer goes there, and a resume without one is refused.
  asker: z.enum(["plan", "execute", "reviewer"]).nullable().default(null),
  // An executor instruction parked while the planner's question about it is open.
  held: pendingSchema.nullable().default(null),
  repairs: z.number().int().nonnegative().default(0),
  quotaPause: quotaPauseSchema.nullable().default(null),
  transientPause: transientPauseSchema.nullable().default(null),
  baseline: baselineSchema.nullable().default(null),
  repositoryBaselines: z
    .array(z.object({ cwd: z.string(), snapshot: baselineSchema.nullable() }))
    .max(8)
    .default([]),
  memories: z
    .array(z.object({ sequence: z.number().int(), text: z.string() }))
    .max(50)
    .default([]),
  memorySequence: z.number().int().nonnegative().default(0),
  history: z.array(z.string()),
  processed: z.array(z.string()),
  inbox: inboxSchema.nullable(),
  pending: pendingSchema.nullable(),
});
export type Workflow = z.infer<typeof workflowSchema>;

/** Contract 3 keeps the original planner and shares the automatic role engine. */
function splitGeneral(w: Workflow): boolean {
  return capabilities(w).splitGeneral;
}
function automates(w: Workflow): boolean {
  return capabilities(w).automatic;
}

function generalView(w: Workflow): GeneralAgent | null {
  if (w.mode !== "general" || !w.plan) return null;
  if (capabilities(w).standalone) return configChoice(w.plan.config);
  return w.generalState.selected ?? (splitGeneral(w) ? null : configChoice(w.plan.config));
}

function isReadOnlyReview(
  w: Workflow,
  agentId: string,
  decision: Decision | undefined,
  evidence: TurnEvidence | undefined,
) {
  return (
    automates(w) &&
    agentId === w.plan?.id &&
    decision?.status === "complete" &&
    !!evidence &&
    !evidence.changed &&
    !evidence.pushes.length &&
    !pushPending(evidence.report)
  );
}

function preservesReviewedPush(w: Workflow, roots: string[], targets: PushTarget[] | undefined) {
  if (!targets?.length || !w.pushReceipt || w.invalidTargets) return false;
  const key = pushReviewKey(targets);
  return (
    w.pushReceipt.key === key &&
    pushReviewKey(w.pushTargets) === key &&
    w.repositories.every((repository) => roots.includes(repository)) &&
    targets.every((target) => roots.includes(target.repository))
  );
}

type Pending = NonNullable<Workflow["pending"]>;
const databaseSchema = z.object({
  version: z.literal(1),
  // Counts one-time conversions of stored flows; see migrate().
  revision: z.number().int().nonnegative().default(0),
  // The last number given out before numbering went per project; kept for the earlier version.
  sequence: z.number().int().nonnegative().default(0),
  // The last number given out in each project.
  sequences: z.record(z.string(), z.number().int().nonnegative()).default({}),
  settings: settingsSchema,
  projects: z.record(z.string(), projectDefaultsSchema).default({}),
  workflows: z.array(z.preprocess((value) => {
    if (!value || typeof value !== "object") return value;
    const raw = value as Record<string, unknown>;
    // New runtime fields are parked outside legacy enums. Older builds load a safe wait.
    return raw.planReviewRuntime && typeof raw.planReviewRuntime === "object"
      ? { ...raw, ...raw.planReviewRuntime } : raw;
  }, workflowSchema)),
  archives: z.array(archiveEntrySchema).max(500).default([]),
});
export type Database = z.infer<typeof databaseSchema>;
export interface Snapshot {
  id: string;
  workspaceId: string;
  projectId: string;
  cwd: string;
  title: string;
  status: string;
  archived: boolean;
  archivedAt?: string | null;
  permission: boolean;
  questions?: { id: string; input: unknown }[];
  usage: number | null;
  contextUsage?: ContextUsage | null;
  config?: PaseoAgentConfig;
}
export interface History {
  evidence?: TurnEvidence;
  compacted?: boolean;
  maintenance?: boolean;
  maintenanceId?: string;
  request?: string;
  goal?: string;
  auditRevision?: string;
  generalAnswers?: Partial<Record<GeneralQuestion, string>>;
  selectionAnswers?: ReturnType<typeof timelineSelections>;
  modeAnswer?: "general" | "federated";
  brainstormAnswer?: boolean;
  normalizedModeAnswer?: "general" | "federated";
  text: string;
  key: string;
  messageIds: string[];
  /** Provider turn of each user message, by message ID, when the timeline records turns. */
  messageTurns?: Record<string, string>;
  /** Provider turn of the newest timeline entry. */
  turnId?: string;
  failed: string | null;
}
export interface WorkflowPort {
  reviewerModes?(provider: "codex" | "claude", cwd: string): Promise<{ enabled: boolean; modes: string[] }>;
  federationAvailability?(cwd?: string): Promise<{ available: boolean; reason: string | null }>;
  models?(provider: "codex" | "claude", cwd: string): Promise<readonly ExecutorModel[]>;
  syncProjectTitles?(): Promise<void>;
  quotaAccount(provider: string): Promise<string | null>;
  quotaAvailable(provider: string): Promise<boolean | null>;
  archiveInspection(workspaceIds: readonly string[]): Promise<ArchiveInspection>;

  workspaceName(workspaceId: string): Promise<string | null>;
  projectName(projectId: string, cwd?: string): Promise<string>;
  rename(workspaceId: string, title: string): Promise<void>;
  inspect(id: string): Promise<Snapshot | null>;
  create(
    workflow: Workflow,
    role: "plan" | "execute" | "reviewer",
    member: Member,
    marker?: boolean,
  ): Promise<string>;
  /** Creates (or returns, for the same workflow) the executor's worktree workspace. */
  createWorktree?(
    workflow: Workflow,
    baseBranch: string,
    marker?: boolean,
  ): Promise<{ workspaceId: string; path: string }>;
  createGeneral?(
    workflow: Workflow,
    transfer: NonNullable<Workflow["generalState"]["transfer"]>,
    mode: string,
  ): Promise<void>;
  generalNotice?(
    id: string,
    choice: GeneralAgent,
    message: string,
    noticeId: string,
    planner?: GeneralAgent,
  ): Promise<void>;
  /** Posts the executor picker card into the planner conversation. */
  executorPicker?(agentId: string, workflowId: string): Promise<void>;
  /** Unbudgeted underlying request: retain the in-flight entry until it actually settles. */
  ensurePickerCard?(agentId: string, workflowId: string, hold: { id: number; decisionHash: string }): Promise<boolean>;
  /** Posts the work-mode card into an undecided conversation. */
  modePicker?(agentId: string, workflowId: string): Promise<void>;
  placementPicker?(agentId: string, workflowId: string, blocker: { number: number; title: string }, generation?: number): Promise<void>;
  send(id: string, prompt: string, messageId: string): Promise<void>;
  /** Reads the latest turn. `through` is a message id the search must reach back to. */
  history(id: string, through?: string): Promise<History>;
  /** Resolves only the named response and rejects missing boundaries or later tool activity. */
  historicalPush?(agentId: string, messageId: string): Promise<{ turn: History; later: History[] }>;
  /** Strictly reads only the latest complete provider response for automatic verification. */
  pushAuditHistory?(agentId: string): Promise<History>;
  compact(id: string, messageId: string): Promise<void>;
}

export interface NotificationEvent {
  kind: "permission" | "stopped" | "completed" | "waiting";
  title: string;
  body: string;
  agentId: string;
  workspaceId: string;
}

const REVIEW =
  "구현 결과를 검토하세요. 규칙 30-verification 3.2–7절에 따라 handoff·impl-report와 실제 변경 파일·시험을 직접 확인하고, 설계 적합성(4.2)을 따로 판정한 뒤 작업 문서 폴더에 verdict.md를 쓰세요. 완료 조건 충족 시 complete, 부분 완료·미완료면 원인을 분류해 구체적 수정 계획과 함께 plan을 반환하세요.";
const REPAIR = "작업을 다시 하지 말고, 직전 응답의 결과를 그대로 반영한 상태 블록만 출력하세요.";
const CONTINUE = "중단된 지점부터 이어서 진행하세요. 이미 끝낸 작업은 반복하지 마세요.";
const HELD = " (전달 전인 실행 지시는 보류했습니다. 답변에 따라 계획 담당이 진행하거나 바꿉니다.)";

/** Messages this plugin delivers start with the flow id; anything else is the user's own text. */
function userText(request: string): string {
  return request.startsWith("작업 ID:") ? "" : request;
}
/** The planner's workspace is never recreated, so only what titles and pairing read is kept. */
function slimConfig(config: PaseoAgentConfig): PaseoAgentConfig {
  return {
    provider: config.provider,
    ...(config.modeId ? { modeId: config.modeId } : {}),
    ...(config.thinkingOptionId ? { thinkingOptionId: config.thinkingOptionId } : {}),
  };
}
function migrate(db: Database): Database {
  for (const w of db.workflows) {
    if (w.notifiedStatus === null) w.notifiedStatus = w.status;
    if (w.plan) w.plan.config = slimConfig(w.plan.config);
    if (w.processed.length > 200) w.processed.splice(0, w.processed.length - 200);
    if (db.revision < 3)
      for (const memory of w.memories)
        w.constraints[`remember:${createHash("sha256").update(memory.text).digest("hex")}`] = memory.text;
    if (db.revision < 1) adoptFlags(w);
    // Numbers were global before. Each project continues from its own highest until the
    // existing titles are renumbered.
    if (db.revision < 2)
      db.sequences[w.projectId] = Math.max(db.sequences[w.projectId] ?? 0, w.number);
  }
  db.revision = 3;
  return db;
}
/** Fills in, once, what flows stored before these fields existed must have meant. */
function adoptFlags(w: Workflow) {
  // A conversation without a planner was never a federation. Only the mode changes, so the
  // earlier version still treats these flows as it did if the plugin is rolled back.
  if (!w.plan && w.mode === "federated") w.mode = "general";
  // A wait without an unread turn came from a question, asked by the executor only if it
  // had already worked; and an unread turn from the agent holding the instruction is that
  // instruction's answer.
  if (w.status === "needs_input" && !w.inbox)
    w.asker = w.phase === "execute" && w.execute?.lastTurnKey ? "execute" : "plan";
  const holder = w.pending && w.pending.stage !== "queued" ? w[w.pending.role] : null;
  if (w.inbox && holder?.id === w.inbox.agentId) w.inbox.answers = true;
}

/** A workspace without a flow, as a script found it. */
interface Unmanaged {
  workspaceId: string;
  projectId: string;
  cwd?: string;
  provider: string;
  role: "plan" | "execute" | "reviewer" | null;
  title: string;
}
function nextNumber(sequences: Record<string, number>, projectId: string): number {
  sequences[projectId] = (sequences[projectId] ?? 0) + 1;
  return sequences[projectId];
}
/**
 * Gives every flow and flowless workspace its number within its project. Without `renumber`
 * a number already present stays. With it, each project counts from 1 in the order of the
 * old numbers, and whatever shared a number, or a legacy pair's title, still shares one.
 */
function numbering(db: Database, unmanaged: readonly Unmanaged[], renumber: boolean) {
  const entries = [
    ...db.workflows.map((w) => ({
      key: `flow:${w.id}`,
      projectId: w.projectId,
      old: w.number,
      pair: "",
    })),
    ...unmanaged.map((item) => ({
      key: `row:${item.workspaceId}`,
      projectId: item.projectId,
      old: Number(/^\S*\s*(?:CLAUDE|GPT|C|G)\[[^\]]*\]-(\d+)/iu.exec(item.title.trim())?.[1] ?? 0),
      pair: item.role ? stripTitleDecor(item.title) : "",
    })),
  ];
  const sequences: Record<string, number> = renumber ? {} : { ...db.sequences };
  const assigned = new Map<string, number>();
  const shared = new Map<string, number>();
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .toSorted((a, b) => (a.entry.old || Infinity) - (b.entry.old || Infinity) || a.index - b.index);
  for (const { entry } of ordered) {
    let slot = "";
    if (entry.old) slot = `${entry.projectId}\n#${entry.old}`;
    else if (entry.pair) slot = `${entry.projectId}\n${entry.pair}`;
    const number =
      (renumber ? 0 : entry.old) ||
      (slot && shared.get(slot)) ||
      nextNumber(sequences, entry.projectId);
    if (slot) shared.set(slot, number);
    assigned.set(entry.key, number);
  }
  return { sequences, of: (key: string) => assigned.get(key) ?? 0 };
}


/** Reported targets beyond the edit scope that this flow has not already receipted. */
function outsideScope(w: Workflow, next: PushTarget[]) {
  // Completion reports repeat their targets; an already-receipted identical
  // set was confirmed by its own turn's executions and needs no new ones.
  const key = pushReviewKey(next);
  if (w.pushReceipt?.key === key && key === pushReviewKey(w.pushTargets)) return false;
  return (
    !!w.repositories.length && next.some((target) => !w.repositories.includes(target.repository))
  );
}

export class WorkflowEngine {
  readonly store: JsonStore<Database>;
  private federation = { available: true, reason: null as string | null };
  private frozenSettings: unknown = structuredClone(recommendedSettings);
  private policyState: Awaited<ReturnType<OwnerPolicyStore["load"]>> | null = null;
  private database: Database | null = null;
  private loading: Promise<Database> | null = null;
  private readonly tickFailures = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private cleanupChecked = false;
  private pushTitlesChecked = false;
  private readonly pendingTitles = new Set<string>();
  // Display-only observations; compaction identity and deduplication remain durable.
  private readonly compressionReasons = new Map<string, string>();
  private readonly compacting = new Map<string, Promise<void>>();
  private readonly permissions = new Set<string>();
  // Flows showing a permission wait this tick; a second status line must not fight it.
  private readonly asking = new Set<string>();
  private readonly modeQuestions = new Map<string, { question: string; header?: string; review?: { question: string; header: string } }>();
  private readonly pickerInFlight = new Map<string, Promise<void>>();
  private savedDatabase: string | undefined;
  private readonly savedHandoffs = new Map<string, string>();
  private readonly scopeCache = new Map<string, Promise<string>>();
  private readonly managedRunner: ManagedPushRunner;
  private readonly managedExecutions = new Map<string, ManagedPush>();
  private readonly planReviewGate = new PlanReviewGate({
    port: () => this.port, settings: () => this.settings(),
    queue: (w, role, prompt, phase) => this.queue(w, role, prompt, phase),
    touch: (w, detail) => this.touch(w, detail),
    startReserved: w => this.startReservedImplementation(w),
  });
  private readonly archives = new Archives({
    lifecycle: () => this.lifecycle,
    port: () => this.port,
    db: () => this.db(),
    save: () => this.save(),
    serial: (work) => this.serial(work),
    settings: () => this.settings(),
    handoffPath: (w) => this.handoffPath(w),
    savedHandoffs: () => this.savedHandoffs,
  });
  private readonly pushAudit = new PushAudit({
    port: () => this.port,
    probe: () => this.probe,
    stopped: () => this.stopped,
    now: () => this.now(),
    save: () => this.save(),
    serial: (work) => this.serial(work),
    db: () => this.db(),
    setPushUnverified: (w, value) => this.setPushUnverified(w, value),
    queuePushReview: (w) => this.queuePushReview(w),
    pendingTitles: () => this.pendingTitles,
  });
  private readonly generalMode = new GeneralMode({
    port: () => this.port,
    db: () => this.db(),
    save: () => this.save(),
    touch: (w, detail) => this.touch(w, detail),
    settings: () => this.settings(),
    serial: (work) => this.serial(work),
    executorChoice: () => this.executorChoice,
    compacting: (agentId) => this.compacting.has(agentId),
    seen: (w, key) => this.seen(w, key),
    rememberProject: (w, executor) => this.rememberProject(w, executor),
    queue: (w, role, prompt, phase, instruction) => this.queue(w, role, prompt, phase, instruction),
    generalDefault: (cwd) => this.generalDefault(cwd),
    advance: (w) => this.advance(w),
    renameWorkspaces: (w, marker, keep) => this.renameWorkspaces(w, marker, keep),
    handoffPath: (w) => this.handoffPath(w),
    captureArtifacts: (w, text, evidence, agentId, turnKey) => this.captureArtifacts(w, text, evidence, agentId, turnKey),
    busyWriter: (w) => this.busyWriter(w),
    allowMode: (w, mode) => this.allowMode(w, mode),
    startBrainstorm: (w) => this.startBrainstorm(w),
  });
  private readonly worktreeCleanup = new WorktreeCleanup({
    lifecycle: () => this.lifecycle,
    port: () => this.port, probe: () => this.probe, db: () => this.db(), save: () => this.save(),
    settings: () => this.settings(), now: () => this.now(), stateFolder: () => path.dirname(this.store.file),
    touch: (w, detail) => this.touch(w, detail),
  });
  private readonly managedPushes = new ManagedPushes({
    // Read late: the runner is assigned in the constructor, after field initializers.
    runner: () => this.managedRunner,
    executions: () => this.managedExecutions,
    checking: () => this.managedChecking,
    port: () => this.port,
    probe: () => this.probe,
    stopped: () => this.stopped,
    serial: (work) => this.serial(work),
    db: () => this.db(),
    save: () => this.save(),
    now: () => this.now(),
    touch: (w, detail) => this.touch(w, detail),
    settings: () => this.settings(),
    invalidatePush: (w, progress) => this.invalidatePush(w, progress),
    setPushUnverified: (w, value) => this.setPushUnverified(w, value),
    renameWorkspaces: (w, marker) => this.renameWorkspaces(w, marker),
    cleanupWorktree: (w) => this.worktreeCleanup.run(w),
    queuePushReview: (w) => this.queuePushReview(w),
    quiet: (snapshot) => this.quiet(snapshot),
    busyWriter: (w) => this.busyWriter(w),
  });
  private readonly executorChoice = new ExecutorChoice({
    port: () => this.port,
    save: () => this.save(),
    touch: (w, detail) => this.touch(w, detail),
    settings: () => this.settings(),
  });
  private readonly compaction = new Compaction({
    port: () => this.port,
    save: () => this.save(),
    touch: (w, detail) => this.touch(w, detail),
    serial: (work) => this.serial(work),
    settings: () => this.settings(),
    compacting: this.compacting,
    compressionReasons: this.compressionReasons,
  });
  private readonly recovery = new Recovery({
    port: () => this.port,
    now: () => this.now(),
    settings: () => this.settings(),
    touch: (w, detail) => this.touch(w, detail),
    resume: (w, message, automatic) => this.resume(w, message, automatic),
    limitDetail: (w) => this.limitDetail(w),
    compacting: (agentId) => this.compacting.has(agentId),
  });
  private readonly managedChecking = new Set<string>();
  constructor(
    file: string,
    private readonly port: WorkflowPort,
    private readonly notify: (event: NotificationEvent) => Promise<unknown> = async () => {},
    private readonly probe: RepoProbe | null = null,
    private readonly now: () => number = Date.now,
    managedRunner?: ManagedPushRunner,
    private readonly lifecycle = new WorkspaceLifecycle(),
    readonly policy = new OwnerPolicyStore(path.join(path.dirname(file), "owner", "policy.json")),
  ) {
    bindWorkspaceLifecycle(this.lifecycle, { db: () => this.db(), cleanupReadiness: w => this.worktreeCleanup.verifyForArchive(w) });
    this.managedRunner =
      managedRunner ?? new ManagedPushRunner(path.join(path.dirname(file), "pushes"));
    this.store = new JsonStore(
      file,
      () => ({
        version: 1,
        revision: 2,
        sequence: 0,
        sequences: {},
        settings: settingsSchema.parse({}),
        projects: {},
        workflows: [],
        archives: [],
      }),
      (v) => {
        const raw = v as Record<string, unknown>;
        this.frozenSettings = raw.settings;
        // Preserve the rollback snapshot verbatim; it is never an effective-setting source after migration.
        return databaseSchema.parse({ ...raw, settings: recommendedSettings });
      },
    );
  }
  private async db(): Promise<Database> {
    // A failed load (transient I/O, a bad file being repaired) is retried on the next call.
    this.loading ??= this.store
      .read()
      .then(migrate)
      .catch((error: unknown) => {
        this.loading = null;
        throw error;
      });
    const db = (this.database ??= await this.loading);
    this.policyState = await this.policy.load(this.frozenSettings === undefined ? undefined
      : { settings: this.frozenSettings, source: this.store.file });
    db.settings = this.policyState.settings;
    return db;
  }
  private handoffPath(w: Workflow) {
    return path.join(path.dirname(this.store.file), "handoffs", `${w.id}.json`);
  }
  private markWriterWaits(db: Database, events: NotificationEvent[]) {
    const marked: [Workflow, string][] = [];
    for (const w of db.workflows) {
      if (
        automates(w) &&
        w.status === "active" &&
        w.pending?.stage === "queued" &&
        w.writerWait &&
        w.writerWait.key !== w.notifiedWriterWait
      ) {
        marked.push([w, w.notifiedWriterWait]);
        w.notifiedWriterWait = w.writerWait.key;
        const member = w.plan ?? w.execute;
        if (db.settings.notifyStopped && member)
          events.push({
            kind: "waiting",
            title: `진행 예정 · #${w.number} ${w.title}`,
            body: w.writerWait.text,
            agentId: member.id,
            workspaceId: member.workspaceId ?? "",
          });
      }
    }
    return marked;
  }
  private async save() {
    const db = await this.db();
    const events: NotificationEvent[] = [];
    const marked: [Workflow, Workflow["notifiedStatus"]][] = [];
    const markedWaits = this.markWriterWaits(db, events);
    for (const w of db.workflows) {
      if (w.notifiedStatus === w.status) continue;
      const previous = w.notifiedStatus;
      marked.push([w, previous]);
      w.notifiedStatus = w.status;
      let kind: NotificationEvent["kind"] | null = null;
      if (
        previous === "active" &&
        ["paused", "needs_input", "error"].includes(w.status) &&
        db.settings.notifyStopped
      )
        kind = "stopped";
      else if (w.status === "completed" && w.cycles >= 1 && db.settings.notifyCompleted)
        kind = "completed";
      const member = w.plan ?? w.execute;
      if (kind && member && automates(w))
        events.push({
          kind,
          title: `${kind === "stopped" ? "작업 중단" : "작업 완료"} · ${w.title}`,
          body: w.detail,
          agentId: member.id,
          workspaceId: member.workspaceId ?? "",
        });
    }
    // Contract 5 offers the picker as soon as the flow is federated, not after the plan.
    const pickers = db.workflows.filter(
      (w) => capabilities(w).screenSelection && !capabilities(w).firstPlanGate && !w.pickerPosted && w.plan && !w.execute &&
        w.status !== "completed" && !this.executorChoice.selectedExecutor(w),
    );
    for (const w of pickers) w.pickerPosted = true;
    const persisted = { ...db, settings: this.frozenSettings, workflows: db.workflows.map(w => {
      const reviewerRuntime = w.pending?.role === "reviewer" || w.asker === "reviewer" || w.quotaPause?.role === "reviewer" || w.transientPause?.role === "reviewer" || w.held?.role === "reviewer";
      if (!reviewerRuntime && (!capabilities(w).planReview || !this.firstPlan(w) || w.reviewSelection.enabled === false)) return w;
      // One authoritative runtime snapshot. Legacy fields are only a rollback-safe projection;
      // they cannot dispatch either a reviewer or an unapproved executor after rollback.
      return { ...w, status: "needs_input", pending: null, inbox: null, held: null,
        asker: "plan", quotaPause: null, transientPause: null, selectionPlan: "",
        planReviewRuntime: { status: w.status, pending: w.pending, inbox: w.inbox, held: w.held,
          asker: w.asker, quotaPause: w.quotaPause, transientPause: w.transientPause, selectionPlan: w.selectionPlan } };
    }) };
    const serialized = JSON.stringify(persisted);
    if (serialized !== this.savedDatabase) {
      try {
        await this.store.write(persisted as Database);
      } catch (error) {
        // Unsent notifications stay pending for the next successful save.
        for (const [w, previous] of marked) w.notifiedStatus = previous;
        for (const w of pickers) w.pickerPosted = false;
        markedWaits.forEach(([w, previous]) => {
          w.notifiedWriterWait = previous;
        });
        throw error;
      }
      this.savedDatabase = serialized;
    }
    for (const event of events) this.dispatch(event);
    // A failed post leaves the plan card and dashboard pickers as the fallback.
    for (const w of pickers) void this.port.executorPicker?.(w.plan!.id, w.id).catch(() => {});
    for (const w of db.workflows) {
      const earlyCard = capabilities(w).planReview && w.brainstorm && w.pickerPosted && w.pickerPostedFor === 0;
      if (this.firstPlan(w) && (this.earlyReviewPicker(w) || earlyCard)) {
        if (!w.pickerPosted) void this.ensurePickerCard(w.id, 0);
      } else if (this.firstPlan(w) && w.heldApproval && w.pickerPostedFor !== w.heldApproval.id)
        void this.ensurePickerCard(w.id, w.heldApproval.id);
      await this.saveHandoff(w);
    }
  }
  private earlyReviewPicker(w: Workflow) {
    return capabilities(w).planReview && w.brainstorm && w.reviewSelection.enabled === true;
  }
  private firstPlan(w: Workflow) {
    return capabilities(w).firstPlanGate && !w.execute && !w.lastInstruction;
  }
  private invalidateApproval(w: Workflow) {
    if (!this.firstPlan(w)) return;
    if (w.approvedHold && w.selection) w.selectionDraft = structuredClone(w.selection);
    w.selection = executorSelectionSchema.parse({});
    w.heldApproval = null;
    w.approvedHold = 0;
  }
  private ensurePickerCard(workflowId: string, holdId: number): Promise<void> {
    const key = `${workflowId}:${holdId}`;
    const running = this.pickerInFlight.get(key);
    if (running) return running;
    const request = (async () => {
      const w = (await this.db()).workflows.find(w => w.id === workflowId);
      if (!w?.plan || !this.port.ensurePickerCard) return;
      const early = holdId === 0 && this.earlyReviewPicker(w);
      if (!early && w.heldApproval?.id !== holdId) return;
      const posted = await this.port.ensurePickerCard(w.plan.id, w.id, early ? { id: 0, decisionHash: "" } : { ...w.heldApproval! });
      if (posted) await this.serial(async () => {
        if (early) {
          w.pickerPosted = true;
          w.pickerPostedFor = 0;
        } else {
          if (w.heldApproval?.id !== holdId) return;
          w.pickerPostedFor = holdId;
        }
        await this.save();
      });
    })().catch(() => {}).finally(() => { this.pickerInFlight.delete(key); });
    this.pickerInFlight.set(key, request);
    return request;
  }
  private async brainstormDirty(w: Workflow): Promise<string[]> {
    const snapshot = await this.probe?.snapshot(w.cwd).catch(() => null);
    if (!snapshot || snapshot.incomplete) return [];
    // Ignore file-size/mtime changes on paths that were already dirty at entry.
    return [...snapshot.dirty.map(row => row.split("\t")[0]),
      ...(snapshot.repositories ?? []).flatMap(repo => repo.dirty.map(row => `${repo.name}/${row.split("\t")[0]}`))];
  }
  private async startBrainstorm(w: Workflow) {
    if (!capabilities(w).brainstorm || w.brainstorm) return;
    w.brainstormBaseline = await this.brainstormDirty(w);
    w.brainstorm = true;
    w.modePickerPosted = true;
    this.touch(w, "브레인스토밍: 파일을 바꾸지 않고 논의·조사합니다. 규칙 15-design-guide 5절을 따르세요.");
    await this.save();
  }
  private async warnBrainstormChanges(w: Workflow) {
    if (!capabilities(w).brainstorm || !w.brainstorm) return;
    const dirty = await this.brainstormDirty(w);
    const added = dirty.filter(row => !w.brainstormBaseline.includes(row));
    if (!added.length) return;
    w.brainstormBaseline = [...new Set([...w.brainstormBaseline, ...dirty])];
    const detail = "브레인스토밍 중 저장소 변경이 늘었습니다. 파일을 바꾸지 않고 논의·조사하세요.";
    this.touch(w, detail);
    if (w.plan) this.dispatch({ kind: "stopped", title: `브레인스토밍 변경 확인 · ${w.title}`, body: detail, agentId: w.plan.id, workspaceId: w.plan.workspaceId ?? "" });
    await this.save();
  }
  private async saveHandoff(w: Workflow) {
    const artifact = new JsonStore<unknown>(
      this.handoffPath(w),
      () => null,
      (value) => value,
    );
    const handoff = {
      id: w.id,
      planConflict: w.planConflict,
      planIssue: w.planIssue,
      selection: w.selection,
      goal: w.goal,
      cwd: w.cwd,
      status: w.status,
      mode: w.mode,
      detail: w.detail,
      lastPlan: w.lastPlan,
      lastInstruction: w.lastInstruction,
      lastResult: w.lastResult,
      planHandoff: w.plan?.handoff,
      executeHandoff: w.execute?.handoff,
      reviewerHandoff: w.reviewer?.handoff, reviewSelection: w.reviewSelection, planReview: w.planReview,
      remember: w.memories.map((item) => item.text),
      constraints: w.constraints,
      repositories: w.repositories,
      pushTargets: w.pushTargets,
      pushCheck: w.pushCheck,
      verification: w.verification,
      generalHandoff: w.generalHandoff,
      generalTransition: w.generalTransition,
      transitionTurns: w.transitionTurns,
      previousAgentIds: w.history,
      planAgentId: w.plan?.id,
      executeAgentId: w.execute?.id,
      reviewerAgentId: w.reviewer?.id,
    };
    const serializedHandoff = JSON.stringify(handoff);
    if (serializedHandoff !== this.savedHandoffs.get(w.id)) {
      await artifact.write(handoff);
      this.savedHandoffs.set(w.id, serializedHandoff);
    }
  }
  private touch(w: Workflow, detail: string) {
    w.detail = detail;
    w.updatedAt = new Date().toISOString();
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.tail.then(work);
    this.tail = task.catch(() => {});
    return task;
  }
  async close() {
    this.stopped = true;
    this.pushAudit.stop();
    await Promise.allSettled(this.compacting.values());
    await this.tail;
  }
  async settings(): Promise<Settings> {
    return (await this.db()).settings;
  }
  async generalDefault(cwd: string): Promise<GeneralAgent | null> {
    const db = await this.db();
    return db.settings.rememberProjectChoices
      ? (db.projects[path.resolve(cwd)]?.general ?? null)
      : null;
  }
  async startSettings(cwd: string, planner: string): Promise<Settings> {
    const db = await this.db();
    const saved = db.settings.rememberProjectChoices ? db.projects[path.resolve(cwd)] : undefined;
    if (!saved) return db.settings;
    const provider = oppositeProvider(planner);
    const executor = saved[provider];
    return {
      ...db.settings,
      // Remembered choices must not disable an explicitly enabled mode or model question;
      // they only become the first offered option.
      defaultMode: saved.mode,
      ...(executor && provider === "codex"
        ? { executorModel: executor.model, executorThinking: executor.thinking }
        : {}),
      ...(executor && provider === "claude"
        ? { claudeExecutorModel: executor.model, claudeExecutorThinking: executor.thinking }
        : {}),
    };
  }
  private async rememberProject(w: Workflow, executor = false) {
    const db = await this.db();
    if (!db.settings.rememberProjectChoices || w.mode === "undecided") return;
    const key = path.resolve(w.cwd);
    const saved = { ...db.projects[key], mode: w.mode };
    if (executor && w.execute) {
      const provider = this.executorChoice.executorProvider(w);
      saved[provider] = {
        model: w.execute.config.provider,
        thinking: w.execute.config.thinkingOptionId ?? "",
      };
    }
    db.projects[key] = saved;
  }
  forgetProject(cwd: string) {
    return this.serial(async () => {
      delete (await this.db()).projects[path.resolve(cwd)];
      await this.save();
      return { ok: true as const };
    });
  }
  configure(settings: Settings) {
    return this.configureWithRevision(settings).then(result => result.settings);
  }
  configureWithRevision(settings: Settings, expectedRevision?: number) {
    return this.serial(async () => {
      const db = await this.db();
      if (this.policyState?.error || !this.policyState?.policy)
        throw new Error(this.policyState?.error ?? "지시서를 읽은 뒤 저장하세요.");
      const saved = await this.policy.save(settings, expectedRevision ?? this.policyState.policy.revision);
      db.settings = (await this.policy.load()).settings;
      if (!db.settings.autoResumeTransient) {
        for (const w of db.workflows)
          if (w.transientPause && ["paused", "error"].includes(w.status))
            this.recovery.stopTransient(w, w.transientPause.failure);
      }
      await this.save();
      return saved;
    });
  }
  setRepositories(id: string, paths: string[]) {
    return this.serial(async () => {
      const w = (await this.db()).workflows.find((entry) => entry.id === id);
      if (!w) throw new Error("작업을 찾을 수 없습니다.");
      const roots = await repositoryPaths(this.probe, w.cwd, repositoryPathsSchema.parse(paths));
      if (JSON.stringify(roots) !== JSON.stringify(w.repositories)) this.newPushPhase(w);
      this.assignRepositories(w, roots);
      await this.refreshConflicts();
      await this.save();
      await this.renameWorkspaces(w, (await this.settings()).titleMarker);
      return { repositories: w.repositories };
    });
  }
  reviewOptions(id: string) {
    return this.serial(async () => {
      const w = (await this.db()).workflows.find(w => w.id === id);
      if (!w || !capabilities(w).planReview) throw new Error("계획 검증 대상 작업이 아닙니다.");
      return { providers: await this.planReviewGate.options(w) };
    });
  }
  selectPlanReview(id: string, choice: { holdId?: number; enabled: boolean; provider?: "codex" | "claude"; model?: string; thinking?: string; extra?: boolean }) {
    return this.serial(async () => {
      const w = (await this.db()).workflows.find(w => w.id === id);
      if (!w || !capabilities(w).planReview || !this.firstPlan(w)) throw new Error("첫 계획에서만 검증을 선택할 수 있습니다.");
      const draft = this.earlyReviewPicker(w) && !w.heldApproval && choice.holdId === undefined && !choice.extra;
      if (!draft && (!choice.holdId || w.heldApproval?.id !== choice.holdId)) return { ok: false, detail: "계획이 바뀌었습니다. 현재 계획을 다시 확인하세요." };
      await this.planReviewGate.choose(w, choice);
      await this.save();
      if (!draft && w.status === "active") await this.advance(w);
      return { ok: true, detail: draft && choice.enabled ? "검증 담당 초안을 저장했습니다. 첫 계획이 나오면 검증합니다." : w.detail };
    });
  }
  /** The executor chosen on the plugin screen; a held plan goes out once it is valid. */
  selectExecutor(id: string, choice: { provider: "codex" | "claude"; model: string; thinking: string; holdId?: number; unverified?: boolean; reserve?: boolean }) {
    return this.serial(async () => {
      const w = (await this.db()).workflows.find((entry) => entry.id === id);
      if (!w) throw new Error("작업을 찾을 수 없습니다.");
      if (!capabilities(w).executorSelection) throw new Error("연합개발 작업에서만 구현 담당을 선택할 수 있습니다.");
      if (capabilities(w).firstPlanGate && choice.holdId && w.approvedHold === choice.holdId)
        return { ok: true, detail: "승인한 계획을 이미 처리했습니다." };
      if (this.firstPlan(w)) {
        const draft = structuredClone(w.selectionDraft ?? executorSelectionSchema.parse({}));
        try {
          await applySelectionBatch(draft, { provider: choice.provider, model: choice.model,
            thinking: choice.thinking || "추론 없음" }, provider => this.executorChoice.catalog(w, provider));
        } catch (error) { draft.error = error instanceof Error ? error.message : String(error); }
        w.selectionDraft = draft;
        if (capabilities(w).planReview && draft.stage !== "ready") w.implementationReserved = false;
        const hold = w.heldApproval;
        if (this.earlyReviewPicker(w) && !hold && choice.holdId === undefined) {
          w.implementationReserved = draft.stage === "ready";
          await this.save();
          return { ok: draft.stage === "ready", detail: draft.error || "검증을 통과하면 이 담당으로 바로 구현을 시작합니다." };
        }
        if (capabilities(w).planReview && choice.reserve && w.reviewSelection.enabled === true &&
            ["reviewing", "revising"].includes(w.planReview.stage) && hold && choice.holdId === hold.id) {
          w.implementationReserved = draft.stage === "ready";
          await this.save();
          return { ok: w.implementationReserved, detail: draft.error || "검증 통과 시 구현 시작을 예약했습니다." };
        }
        return this.approveExecutor(w, choice.holdId, !!choice.unverified);
      }
      // An executor whose selection fell out of ready (e.g. a failed catalog) may be re-picked within its product.
      if (w.execute && w.selection?.stage === "ready") throw new Error("구현 담당이 이미 생성되어 바꿀 수 없습니다.");
      if (w.execute && w.execute.config.provider.split("/")[0] !== choice.provider)
        throw new Error("이미 만든 구현 담당과 같은 제품의 모델만 고를 수 있습니다.");
      const state = w.selection!;
      // A still-open chat question is retired; its late answer cannot override this choice.
      if (state.pending) { state.answered.push(state.pending.id); state.pending = null; }
      try {
        await applySelectionBatch(state, { provider: choice.provider, model: choice.model,
          thinking: choice.thinking || "추론 없음" }, provider => this.executorChoice.catalog(w, provider));
      } catch (error) { state.error = error instanceof Error ? error.message : String(error); }
      const selected = this.executorChoice.selectedExecutor(w);
      if (!selected) {
        this.touch(w, state.error);
        await this.save();
        return { ok: false, detail: state.error };
      }
      w.asker = null;
      this.touch(w, `구현 담당 선택 확인: ${selected.provider}/${selected.model} · 추론 ${selected.thinking || "없음"}. 최초 담당 설정은 유지합니다.`);
      const held = !!w.selectionPlan && w.inbox?.key === w.selectionPlan;
      if (held && w.status === "needs_input") w.status = "active";
      await this.save();
      if (held) await this.advance(w);
      return { ok: true, detail: held ? "보관한 계획을 구현 담당에게 전달합니다." : "구현 담당을 확정했습니다. 계획이 나오면 바로 전달합니다." };
    });
  }
  /** Manual and reserved starts share the same held-plan approval and dispatch checks. */
  private async approveExecutor(w: Workflow, holdId?: number, unverified = false, automatic = false) {
    const hold = w.heldApproval, draft = w.selectionDraft;
    if (!draft) return { ok: false, detail: "구현 담당 선택을 확인하세요." };
    if (!holdId || hold?.id !== holdId || !w.selectionPlan ||
        w.inbox?.key !== w.selectionPlan || w.selectionPlan !== hold.inboxKey) {
      await this.save();
      return { ok: false, detail: "계획이 바뀌었습니다. 현재 계획을 확인하고 다시 고르세요." };
    }
    if (draft.stage !== "ready" || draft.pending || !draft.provider || draft.thinking === null) {
      await this.save();
      return { ok: false, detail: draft.error || "구현 담당 선택을 확인하세요." };
    }
    if (capabilities(w).planReview) {
      const review = w.planReview;
      if (w.reviewSelection.enabled === null) return { ok: false, detail: "계획 검증 켜기/끄기를 먼저 선택하세요." };
      if (w.pending) return { ok: false, detail: "진행 중인 검증·기록 응답을 기다리세요." };
      if (w.reviewSelection.enabled) {
        if (review.stage === "limit" && unverified) {
          review.stage = "unverified_approved"; review.hash = hold.decisionHash;
        }
        if (!["passed", "unverified_approved"].includes(review.stage) || review.hash !== hold.decisionHash)
          return { ok: false, detail: "현재 계획의 검증이 끝나지 않았습니다." };
      }
    }
    w.selection = structuredClone(draft);
    w.approvedHold = holdId;
    if (capabilities(w).planReview) w.implementationReserved = false;
    w.asker = null;
    if (w.status === "needs_input") w.status = "active";
    await this.save();
    await this.advance(w);
    if (automatic && w.status === "active" && w.execute?.workspaceId && !w.placement) {
      this.touch(w, "계획 검증 통과 — 예약한 구현 담당으로 구현을 시작합니다.");
      await this.save();
    }
    return { ok: true, detail: "승인한 계획을 구현 담당에게 전달합니다." };
  }
  private async startReservedImplementation(w: Workflow): Promise<boolean> {
    if (!capabilities(w).planReview || !this.firstPlan(w) || !w.implementationReserved ||
        w.reviewSelection.enabled !== true || w.planReview.stage !== "passed" ||
        !w.heldApproval || w.planReview.hash !== w.heldApproval.decisionHash ||
        w.selectionDraft?.stage !== "ready" || w.pending) return false;
    return (await this.approveExecutor(w, w.heldApproval.id, false, true)).ok;
  }
  cancelImplementationReservation(id: string) {
    return this.serial(async () => {
      const w = (await this.db()).workflows.find(w => w.id === id);
      if (!w || !capabilities(w).planReview || !this.firstPlan(w)) return { ok: false, detail: "구현 시작 예약을 취소할 수 없습니다." };
      w.implementationReserved = false;
      this.touch(w, "구현 시작 예약을 취소했습니다. 검증 뒤 직접 구현 담당을 확정하세요.");
      await this.save();
      return { ok: true, detail: w.detail };
    });
  }
  private assignRepositories(w: Workflow, roots: string[], preservePush = false) {
    if (JSON.stringify(roots) === JSON.stringify(w.repositories)) return;
    w.repositories = roots;
    if (!preservePush && w.managedPush?.state !== "pushed") {
      w.pushTargets = [];
      this.invalidatePush(w);
      w.invalidTargets = false;
      w.artifactNotice =
        "작업 저장소가 바뀌었습니다. 푸시할 원격·브랜치·커밋과 승인 범위를 다시 확인하세요.";
    }
    w.baseline = null;
    w.repositoryBaselines = [];
    w.planFingerprint = "";
    this.scopeCache.clear();
  }
  private invalidatePush(w: Workflow, progress: Workflow["progress"] = "done") {
    this.setPushUnverified(w, false);
    w.pushReceipt = null;
    w.pushCheck = null;
    w.pushRetry = null;
    if (w.progress === "pushed" || w.progress === "no_push") w.progress = progress;
  }
  private newPushPhase(w: Workflow) {
    w.pushApprovalPending = false;
    this.pushAudit.invalidatePushAudit(w);
    this.setPushUnverified(w, false);
    if (!w.managedPush) return;
    // The durable execution journal is never deleted when a new phase begins.
    w.pushEpoch++;
    w.managedPush = null;
    w.managedRetry = null;
  }
  private supersedeManagedTargets(w: Workflow, next: PushTarget[]) {
    if (w.managedPush && pushReviewKey(next) !== pushReviewKey(w.managedPush.targets))
      this.newPushPhase(w);
  }
  /** Records evidence, never executes reported commands or interprets a report as approval. */
  private async captureArtifacts(
    w: Workflow,
    text: string,
    evidence: TurnEvidence | undefined,
    agentId: string,
    turnKey: string,
  ) {
    const before = w.progress;
    const progress = parseProgress(text);
    if (progress === "active" || progress === "plan" || evidence?.changed) {
      this.newPushPhase(w);
      // A new phase cannot inherit another phase's successful push or deferred check.
      w.pushTargets = [];
      this.invalidatePush(w, progress === "plan" ? "plan" : "active");
      if (evidence?.changed) w.progress = "active";
      w.invalidTargets = false;
    }
    let decision: Decision | undefined;
    try {
      decision = parseDecision(text);
    } catch {
      /* General prose has no decision block. */
    }
    const prose = proseArtifacts(text);
    const readOnlyReview = isReadOnlyReview(w, agentId, decision, evidence);
    await this.captureTargets(w, prose, decision, evidence, readOnlyReview);
    await this.capturePushEvidence(
      w,
      evidence ?? { report: text, changed: false, pushes: [] },
      !!(decision?.pushTargets ?? prose.pushTargets),
      agentId,
      turnKey,
      progress,
    );
    if (decision?.verification)
      w.verification = await Promise.all(
        decision.verification.map((item) => inspectVerification(this.probe, w.cwd, item)),
      );
    for (const item of decision?.constraints ?? []) {
      // A stable id updates a rule without evicting an unrelated older constraint.
      if (item.text.trim()) w.constraints[`rule:${item.id}`] = item.text.trim();
      else delete w.constraints[`rule:${item.id}`];
    }
    if (decision) {
      this.remember(w, decision.remember);
      this.recordVerdict(w, decision.verdict);
    }
    await this.save();
    if (before !== w.progress) await this.renameWorkspaces(w, (await this.settings()).titleMarker);
  }
  private recordVerdict(w: Workflow, verdict: Decision["verdict"]) {
    if (!verdict) return;
    w.verdict = { ...verdict, recordedAt: new Date().toISOString() };
    w.verdictIssue = "";
  }
  private async observedPushes(
    w: Workflow,
    executions: TurnEvidence["pushes"],
    reportedTargets: PushTarget[] = [],
  ) {
    const observed = new Map<string, { target: PushTarget; callId: string }>();
    for (const execution of executions) {
      const repository = await this.probe?.repository?.(execution.cwd).catch(() => null);
      const commit = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(execution.commit)
        ? execution.commit
        : await this.probe?.commit?.(execution.cwd, execution.commit).catch(() => null);
      if (!repository || !commit) continue;
      const parsed = pushTargetsSchema.safeParse([
        { repository, remote: execution.remote, branch: execution.branch, commit },
      ]);
      if (!parsed.success) continue;
      const target = parsed.data[0];
      if (
        w.repositories.length &&
        !w.repositories.includes(repository) &&
        !reportedTargets.some((reported) => pushReviewKey([reported]) === pushReviewKey([target]))
      )
        continue;
      observed.set(JSON.stringify([repository, target.remote, target.branch]), {
        target,
        callId: execution.callId,
      });
    }
    return [...observed.values()];
  }
  private async capturePushEvidence(
    w: Workflow,
    evidence: TurnEvidence,
    reported: boolean,
    agentId: string,
    turnKey: string,
    progress: Workflow["progress"] | null,
  ) {
    if (pushPending(evidence.report)) {
      // Repeated approval wording for the existing preview must not discard it.
      if (w.managedPush?.state !== "prepared") this.newPushPhase(w);
      this.invalidatePush(w);
      w.progress = progress === "active" || progress === "plan" ? progress : "done";
      w.pushApprovalPending = true;
      w.artifactNotice =
        "푸시 승인 또는 실행을 기다립니다. 다른 작업의 원격 반영으로 완료 처리하지 않습니다.";
      return;
    }
    if (!evidence.pushes.length || w.invalidTargets) return;
    const rows = await this.observedPushes(w, evidence.pushes, reported ? w.pushTargets : []);
    const targets = rows.map((row) => row.target);
    if (!targets.length) return;
    // The stored state holds at most eight targets; more would make the file unreadable.
    if (targets.length > 8) {
      this.invalidatePush(w);
      w.artifactNotice =
        "한 번에 확인할 수 있는 푸시 대상(8개)을 넘었습니다. 푸시 완료로 표시하지 않습니다.";
      return;
    }
    const key = pushReviewKey(targets);
    // Metadata is a claim; only matching successful push commands in this flow establish a receipt.
    if (reported && key !== pushReviewKey(w.pushTargets)) {
      this.invalidatePush(w);
      return;
    }
    if (key !== pushReviewKey(w.pushTargets)) this.invalidatePush(w);
    w.pushTargets = targets;
    w.pushReceipt = { key, agentId, turnKey, calls: rows.map((row) => row.callId) };
  }
  private async captureTargets(
    w: Workflow,
    prose: ReturnType<typeof proseArtifacts>,
    decision?: Decision,
    evidence?: TurnEvidence,
    readOnlyReview = false,
  ) {
    const unverified = w.pushUnverified;
    try {
      const paths = decision?.repositories ?? prose.repositories;
      if (prose.invalidTargets) throw new Error("푸시대상 형식이 올바르지 않습니다.");
      const targets = decision?.pushTargets ?? prose.pushTargets;
      const next = targets ? await resolvedPushTargets(this.probe, w.cwd, targets) : undefined;
      if (paths) {
        const roots = await repositoryPaths(this.probe, w.cwd, paths);
        // Reviewers may include an extra checkout they inspected. That read-only scope
        // expansion must not discard the executor's receipt for the exact same targets.
        const preservePush = readOnlyReview && preservesReviewedPush(w, roots, next);
        this.assignRepositories(w, roots, preservePush);
      }
      if (next) {
        if (outsideScope(w, next)) {
          // A task can edit one checkout and publish its settings mirror in another.
          // Only matching executions in this turn may confirm explicitly reported targets
          // outside the earlier edit scope. Keep that scope for conflict/change detection.
          const observed = await this.observedPushes(w, evidence?.pushes ?? [], next);
          if (pushReviewKey(next) !== pushReviewKey(observed.map((row) => row.target)))
            throw new Error(
              "푸시 대상이 선택된 작업 저장소에 포함되지 않으며 같은 대화의 실행 증거도 일치하지 않습니다.",
            );
        }
        if (pushReviewKey(next) !== pushReviewKey(w.pushTargets)) {
          this.supersedeManagedTargets(w, next);
          this.invalidatePush(w);
          w.artifactNotice =
            "푸시 대상이 바뀌었습니다. 이 저장소·원격·브랜치·커밋에 대한 사용자 승인을 확인하세요.";
        }
        w.pushTargets = next;
        w.invalidTargets = false;
      }
    } catch (error) {
      w.invalidTargets = true;
      this.invalidatePush(w);
      this.setPushUnverified(w, unverified);
      w.artifactNotice = error instanceof Error ? error.message : String(error);
    }
  }
  prepareManagedPush(id: string) {
    return this.managedPushes.prepareManagedPush(id);
  }
  executeManagedPush(id: string, requestId: string, approved: boolean) {
    return this.managedPushes.executeManagedPush(id, requestId, approved);
  }
  recheckManagedPush(id: string, requestId: string) {
    return this.managedPushes.recheckManagedPush(id, requestId);
  }
  async list() {
    const db = await this.db();
    const histories = new Map(
      await Promise.all(
        db.workflows.map(
          async (w) =>
            [
              w.id,
              w.managedPush || w.pushEpoch ? await this.managedRunner.history(w.id) : [],
            ] as const,
        ),
      ),
    );
    return {
      settings: db.settings,
      settingsRevision: this.policyState?.policy?.revision ?? null,
      federation: this.federation,
      projects: db.projects,
      error: this.policyState?.error ?? null,
      archives: db.archives.toSorted((a, b) => b.archivedAt.localeCompare(a.archivedAt)),
      workflows: db.workflows.map((w) => ({
        id: w.id,
        contract: w.contract,
        selection: this.firstPlan(w) ? w.selectionDraft ?? w.selection : w.selection,
        brainstorm: w.brainstorm,
        firstPlan: this.firstPlan(w),
        heldApproval: w.heldApproval,
        implementationReserved: w.implementationReserved,
        reviewSelection: w.reviewSelection, planReview: w.planReview, reviewerAgentId: w.reviewer?.id ?? null,
        heldPlan: !!w.selectionPlan && w.inbox?.key === w.selectionPlan,
        planConflict: w.planConflict,
        planIssue: w.planIssue ? { key: w.planIssue.response.key, reason: w.planIssue.reason } : null,
        number: w.number,
        title: w.title,
        cwd: w.cwd,
        status: w.status,
        mode: w.mode,
        phase: w.phase,
        cycles: w.cycles,
        turns: w.turns,
        detail: w.detail,
        repositories: w.repositories,
        pushTargets: w.pushTargets,
        managedPush: w.managedPush,
        pushHistory: histories.get(w.id) ?? [],
        verification: w.verification,
        artifactNotice: w.artifactNotice,
        conflict: w.conflict,
        waitingFor: this.waitingFor(w),
        generalAgent: generalView(w),
        plannerAgent: automates(w) && w.contract >= 3 && w.plan ? configChoice(w.plan.config) : null,
        automatic: automates(w),
        verdict: verdictView(w),
        generalTransition: w.generalTransition,
        deliveryUnconfirmed: w.pending?.stage === "sending" && w.status !== "active",
        updatedAt: w.updatedAt,
        progress: w.progress,
        planAgentId: w.plan?.id ?? null,
        executeAgentId: w.execute?.id ?? null,
        planGeneration: w.plan?.generation ?? 0,
        executeGeneration: w.execute?.generation ?? 0,
        planCompactions: w.plan?.compactions ?? 0,
        executeCompactions: w.execute?.compactions ?? 0,
        planCompressionReason: this.compressionReasons.get(w.plan?.id ?? "") ?? "",
        compactionRecovery: capabilities(w).standalone && !!(w.plan?.compaction || w.plan?.compactionError),
        executeCompressionReason: this.compressionReasons.get(w.execute?.id ?? "") ?? "",
        planUsage: w.plan?.usage ?? null,
        executeUsage: w.execute?.usage ?? null,
      })),
    };
  }
  enroll(
    snapshot: Snapshot,
    config: PaseoAgentConfig,
    env: Record<string, string> = {},
    mode: Workflow["mode"] = "federated",
    titled = true,
    contract = 1,
  ) {
    return this.serial(async () => {
      const db = await this.db();
      const known = db.workflows.find(
        (w) =>
          w.plan?.id === snapshot.id ||
          w.execute?.id === snapshot.id ||
          w.reviewer?.id === snapshot.id ||
          w.history.includes(snapshot.id),
      );
      if (known) return known.id;
      if (snapshot.archived) throw new Error("보관된 대화는 자동 작업에 연결할 수 없습니다.");
      const availability = mode === "federated" ? await this.federationStatus(snapshot.cwd) : null;
      if (availability && !availability.available) mode = "undecided";
      // Only new root conversations enroll; persisted members retain their original roles.
      const member: Member = {
        id: snapshot.id,
        workspaceId: snapshot.workspaceId,
        generation: 1,
        config: slimConfig(contract >= 3 ? {
          ...config,
          provider: snapshot.config?.provider || config.provider,
          modeId: snapshot.config?.modeId ?? config.modeId,
          thinkingOptionId: snapshot.config?.thinkingOptionId ?? config.thinkingOptionId,
        } : config),
        env,
        usage: snapshot.usage,
        lastTurnKey: "",
        compactedForTurn: "",
        compaction: null,
        compactionTurnKey: "",
        compactionError: "",
        compactions: 0,
        handoff: "",
        rememberedThrough: 0,
      };
      const w: Workflow = {
        id: randomUUID(),
        selection: contract >= 4 ? executorSelectionSchema.parse({responses:{}}) : null,
        reviewer: null,
        reviewPlan: null,
        reviewSelection: reviewSelectionSchema.parse({}),
        planReview: planReviewSchema.parse({}),
        implementationReserved: false,
        planIssue: null,
        planConflict: null,
        contract: mode === "general" && contract < 3 ? 1 : contract,
        completeRepairs: 0,
        verdict: null,
        verdictIssue: "",
        projectId: snapshot.projectId,
        cwd: snapshot.cwd,
        title: stripTitleDecor(snapshot.title),
        goal: "",
        status: "active",
        notifiedStatus: "active",
        mode,
        titled,
        number: nextNumber(db.sequences, snapshot.projectId),
        progress: "active",
        phase: "plan",
        plan: member,
        execute: null,
        cycles: 0,
        turns: 0,
        detail: availability?.reason ?? "첫 작업을 기다리고 있습니다.",
        repositories: [],
        isolation: "undecided",
        placement: null,
        worktree: null,
        worktreeMergeNotices: [],
        worktreeHistory: [],
        worktreeCleanup: null,
        integration: null,
        pushTargets: [],
        pushEpoch: 0,
        pushAuditGeneration: 0,
        pushAudit: null,
        managedPush: null,
        managedRetry: null,
        pushReview: null,
        startPin:
          db.settings.autoPinStarted && this.lifecycle.supportsPins && snapshot.workspaceId
            ? {
                key: "start",
                workspaces: [{ id: snapshot.workspaceId, phase: "queued", ownedPinAt: null }],
              }
            : null,
        pushRetry: null,
        pushCheck: null,
        pushUnverified: false,
        pushApprovalPending: false,
        pushReceipt: null,
        artifactNotice: "",
        invalidTargets: false,
        verification: [],
        constraints: {},
        conflict: "",
        writerWait: null,
        notifiedWriterWait: "",
        generalState: generalStateSchema.parse({}),
        generalTransition: false,
        transitionTurns: [],
        limitPlan: "",
        selectionPlan: "",
        pickerPosted: false,
        brainstorm: false,
        brainstormBaseline: [],
        holdSeq: 0,
        heldApproval: null,
        approvedHold: 0,
        selectionDraft: null,
        pickerPostedFor: 0,
        modePickerPosted: false,
        resumeNote: "",
        generalHandoff: "",
        generalDelivery: null,
        updatedAt: new Date().toISOString(),
        lastPlan: "",
        lastResult: "",
        lastInstruction: "",
        planFingerprint: "",
        repeatedPlans: 0,
        wantsFederation: false,
        asker: null,
        held: null,
        repairs: 0,
        baseline: null,
        repositoryBaselines: [],
        quotaPause: null,
        transientPause: null,
        memories: [],
        memorySequence: 0,
        history: [],
        processed: [],
        inbox: null,
        pending: null,
      };
      db.workflows.push(w);
      await this.save();
      return w.id;
    });
  }
  ended(
    agentId: string,
    key: string,
    text: string,
    failed: string | null,
    goal = "",
    compacted = false,
    request = "",
    canceled = false,
    messageIds?: readonly string[],
    evidence?: TurnEvidence,
  ) {
    return this.serial(async () => {
      const w = (await this.db()).workflows.find(
        (candidate) => memberRole(candidate, agentId) !== null,
      );
      if (!w) return;
      if (memberRole(w, agentId) === "reviewer" && w.planReview.stage === "done") return;
      if (w.processed.includes(key) || w.inbox?.key === key || w.planIssue?.response.key === key) return;
      if (capabilities(w).brainstorm && requestsBrainstorm(userText(request || goal))) await this.startBrainstorm(w);
      if (canceled) w.transientPause = null;
      this.pushAudit.invalidatePushAudit(w);
      let foreignReview = false;
      try { foreignReview = memberRole(w, agentId) !== "reviewer" && !!parseDecision(text).planReview; } catch { /* read() owns malformed-block handling. */ }
      if (foreignReview && w.pending?.role !== memberRole(w, agentId)) {
        const error = this.assignmentError(w, memberRole(w, agentId)!, parseDecision(text))!;
        w.planReview.error = error; this.touch(w, error); this.seen(w, key);
        await this.save(); return;
      }
      if (memberRole(w, agentId) !== "reviewer" && !foreignReview) await this.recordTurnEvidence(w, text, failed, evidence, agentId, key);
      await this.refreshConflicts();
      const turn = {
        agentId,
        key,
        text,
        failed,
        compacted,
        canceled,
        reviewerViolation: evidence?.changed || evidence?.pushes.length ? "검증 턴에서 파일 변경 또는 푸시가 관측됐습니다." : "",
        resumed: false,
        answers: true,
      };
      // The prompt asks for the mode before the first reply. When a turn ends with the mode still
      // undecided (the model skipped the question), the conversation gets a one-click card instead.
      if (
        capabilities(w).current &&
        w.mode === "undecided" &&
        w.plan?.id === agentId &&
        !w.modePickerPosted &&
        !w.brainstorm &&
        !workflowRequestedMode(w, userText(request || goal))
      ) {
        w.modePickerPosted = true;
        void this.port.modePicker?.(agentId, w.id).catch(() => {});
      }
      if (w.contract >= 6 && w.mode === "undecided") {
        const requested = workflowRequestedMode(w, userText(request || goal));
        if (requested && await this.allowMode(w, requested)) { w.mode = requested; await this.rememberProject(w); }
      }
      await this.warnBrainstormChanges(w);
      if (this.firstPlan(w) && w.plan?.id === agentId && !w.selectionDraft?.explicitRead) {
        const draft = w.selectionDraft ?? executorSelectionSchema.parse({});
        draft.explicitRead = true;
        const explicit = explicitSelection(userText(goal || request));
        try {
          if (Object.keys(explicit).length) await applySelectionBatch(draft, explicit, provider => this.executorChoice.catalog(w, provider));
        } catch (error) { draft.error = error instanceof Error ? error.message : String(error); }
        w.selectionDraft = draft;
        await this.save();
      }
      // An informational turn with no outstanding work must not consume the initial
      // selection or trigger recovery/continuation. Live deliveries keep their existing
      // receipt and side-turn rules, including rejection of note as an instruction answer.
      const note = failed === null ? this.sideDecision(w, memberRole(w, agentId)!, text) : null;
      if (capabilities(w).current && !capabilities(w).standalone && !w.pending && !w.inbox && note?.status === "note") {
        this.seen(w, key);
        this.remember(w, note.remember);
        await this.renameFromResponse(w, agentId, text, false, request, evidence?.report ?? text, key);
        await this.save();
        return;
      }
      if (capabilities(w).current && w.mode === "undecided") {
        const requested = workflowRequestedMode(w, userText(request || goal));
        if (requested && await this.allowMode(w, requested)) w.mode = requested;
      }
      if (capabilities(w).executorSelection && !this.firstPlan(w) && w.plan?.id === agentId && !w.selection!.explicitRead) {
        w.selection!.explicitRead = true;
        const explicit = explicitSelection(userText(goal || request));
        if (Object.keys(explicit).length) {
          await this.executorChoice.acceptSelection(w, "explicit", explicit, undefined, true);
        }
      }
      if (capabilities(w).executorSelection && w.plan?.id === agentId &&
          w.selection!.stage !== "ready" && failed === null && !this.sideDecision(w, "plan", text)) {
        const snapshot = await this.port.inspect(agentId);
        if (w.status !== "paused") w.status = snapshot?.permission ? "active" : "needs_input";
        this.seen(w, key);
        this.touch(w, w.selection!.error || `구현 담당 ${selectionStageLabel[w.selection!.stage]} 선택의 실제 답변을 기다립니다.`);
        await this.save();
        return;
      }
      if (await this.generalMode.finishGeneralChoice(w, agentId, text, goal, request, failed, key)) return;
      if (await this.transitionTurn(w, turn, request, messageIds)) return;
      const chatResume = await this.chatResume(w, turn, request);
      const role: Role = memberRole(w, agentId)!;
      if (chatResume === "resumed" && !this.sideDecision(w, role, text)) {
        this.seen(w, key);
        // This turn may itself have ended the outstanding instruction. Settle it before
        // keepMoving, so a later tick does not mistake its seen answer for a new stop.
        await this.clearSettled(w);
        await this.save();
        await this.advance(w);
      } else {
        await this.admitTurn(
          w,
          turn,
          request,
          goal,
          evidence,
          chatResume === "blocked",
          messageIds,
        );
      }
      if (chatResume === "resumed") await this.keepMoving(w);
      if (capabilities(w).standalone && w.plan?.id === agentId) {
        if (failed === null && !canceled) w.plan.lastTurnKey = key;
        if (compacted) w.plan.compactedForTurn = key;
        await this.compaction.maintainStandalone(w);
        await this.save();
      }
    });
  }
  /** A /compact turn is maintenance, never a new product response or a role handoff. */
  maintenanceEnded(agentId: string, key: string, compacted: boolean, maintenanceId?: string) {
    return this.serial(async () => {
      const w = (await this.db()).workflows.find(w => memberRole(w, agentId) !== null);
      if (!w || !compacted || w.processed.includes(key)) return;
      const member = w[memberRole(w, agentId)!]!;
      this.seen(w, key);
      if (!this.compacting.has(member.id)) {
        if (member.compaction && maintenanceId === member.compaction) {
          const recovering = !!member.compactionError;
          this.compaction.finishCompaction(w, member, member.compactionTurnKey || member.lastTurnKey);
          if (recovering) member.compactionError = "압축 완료 확인됨. 압축 복구 버튼으로 유지보수를 재개하세요.";
        } else {
          member.compactedForTurn = member.lastTurnKey;
          // A confirmed explicit compaction also settles an older uncertain request.
          member.compaction = null;
          member.compactionTurnKey = "";
        }
      }
      await this.save();
    });
  }
  private async admitTurn(
    w: Workflow,
    turn: Inbox,
    request: string,
    goal: string,
    evidence: TurnEvidence | undefined,
    chatBlocked: boolean,
    messageIds?: readonly string[],
  ) {
    const { agentId, key, text, failed, compacted, canceled } = turn;
    const report = evidence?.report ?? text;
    const role: Role = memberRole(w, agentId)!;
    if (!(await this.admits(w, agentId, text, failed, request, key, report))) {
      await this.rememberSideTurn(w, key, evidence);
      return;
    }
    // An agent runs one turn at a time, so while an instruction is in flight to it, the turn
    // it ends is that instruction's, even when the user steered or interrupted it on the way.
    let mine =
      !!w.pending &&
      w.pending.stage !== "queued" &&
      w.pending.role === role &&
      this.carries(w, w.pending, request, messageIds);
    // A lifecycle event may omit the delivered message, as when the user steered a long turn
    // or a compaction cut it from view. Only this exact completed response, read from the same
    // member's history, can establish that it ends the delivered instruction's turn.
    if (!mine && w.pending?.role === role && w.pending.stage === "sent" && failed === null &&
        this.sideDecision(w, role, text))
      mine = await this.received(w, turn, w.pending.id);
    const answers = w.inbox ? this.supersedes(w, role, agentId, text, failed, mine) : mine;
    if (answers === null) {
      // A result nobody has read yet outranks what the user says on the side meanwhile.
      this.seen(w, key);
      await this.save();
      return;
    }
    if (w.inbox) {
      this.invalidateApproval(w);
      this.seen(w, w.inbox.key);
      w.selectionPlan = "";
    }
    const resumed = !chatBlocked && w.status === "needs_input";
    if (resumed) w.status = "active";
    // A failure pause ends when the user carries the failed instruction on to a decision.
    if (w.status === "paused" && w.pending?.retry && w.pending.stage === "queued" &&
        w.pending.role === role && failed === null && this.sideDecision(w, role, text))
      w.status = "active";
    if (!w.goal) w.goal = goal.slice(0, 32000);
    w.inbox = { agentId, key, text, failed, compacted, canceled, reviewerViolation: evidence?.changed || evidence?.pushes.length ? "검증 턴에서 파일 변경 또는 푸시가 관측됐습니다." : "", resumed, answers };
    await this.save();
    await this.advance(w);
  }
  private async chatResume(
    w: Workflow,
    turn: Inbox,
    request: string,
  ): Promise<"resumed" | "blocked" | null> {
    const said = userText(request);
    if (
      !automates(w) ||
      !["paused", "error", "needs_input"].includes(w.status) ||
      w.generalTransition ||
      turn.failed !== null ||
      turn.canceled ||
      !requestsFederation(said)
    )
      return null;
    try {
      // The user's message also answers an open question; its finished turn decides what follows.
      await this.checkResume(w, w.asker ? said : "");
    } catch (error) {
      this.touch(w, `채팅 재개 불가: ${error instanceof Error ? error.message : String(error)}`);
      await this.save();
      return "blocked";
    }
    await this.prepareResume(w, false);
    w.asker = null;
    this.touch(w, "채팅의 연합개발 요청으로 자동 작업을 재개합니다.");
    await this.save();
    return "resumed";
  }
  private async recordTurnEvidence(
    w: Workflow,
    text: string,
    failed: string | null,
    evidence: TurnEvidence | undefined,
    agentId: string,
    key: string,
  ) {
    if (failed === null) return this.captureArtifacts(w, text, evidence, agentId, key);
    w.pushRetry = null;
    if (!evidence?.changed) return;
    this.newPushPhase(w);
    this.invalidatePush(w, "active");
    w.progress = "active";
    await this.renameWorkspaces(w, (await this.settings()).titleMarker);
    await this.save();
  }
  private async rememberSideTurn(w: Workflow, key: string, evidence?: TurnEvidence) {
    if (
      (w.mode !== "undecided" || evidence?.changed || evidence?.pushes.length) &&
      !w.processed.includes(key)
    )
      this.seen(w, key);
    await this.save();
  }
  private async transitionTurn(
    w: Workflow,
    turn: Inbox,
    request: string,
    messageIds?: readonly string[],
  ) {
    if (capabilities(w).current) {
      const requested = workflowRequestedMode(w, userText(request));
      if (requested && requested !== w.mode) {
        if (w.mode === "undecided") {
          if (await this.allowMode(w, requested)) {
            w.mode = requested;
            await this.rememberProject(w);
          }
        } else this.touch(w, "진행 중인 작업의 방식은 바꿀 수 없습니다. 현재 방식을 유지합니다. 다른 방식은 새 작업으로 시작하세요.");
        await this.save();
      }
      return false;
    }
    const switching =
      automates(w) &&
      !!w.execute &&
      w.plan?.id === turn.agentId &&
      workflowRequestedMode(w, userText(request)) === "general";
    if (splitGeneral(w) && workflowRequestedMode(w, userText(request)) === "federated" && await this.allowMode(w, "federated")) {
      w.mode = "federated";
      await this.rememberProject(w);
      await this.save();
    }
    if (switching && w.contract >= 3) {
      w.mode = "general";
      await this.rememberProject(w);
      await this.save();
      return false;
    }
    if (switching || w.generalTransition) {
      if (w.inbox && !w.transitionTurns.some((entry) => entry.key === w.inbox!.key))
        w.transitionTurns.push(w.inbox);
      w.transitionTurns.push(turn);
      // Only the latest turns matter for the handoff; an endless wait must not grow the file.
      if (w.transitionTurns.length > 20) w.transitionTurns.splice(0, w.transitionTurns.length - 20);
      this.seen(w, turn.key);
      await this.generalMode.returnToGeneral(w);
      return true;
    }
    // A real response establishes receipt even if a send acknowledgement was lost.
    if (
      w.mode === "general" &&
      w.generalDelivery &&
      (messageIds?.includes(w.generalDelivery.id) || request === w.generalDelivery.prompt)
    ) {
      w.generalDelivery.stage = "sent";
      w.status = "active";
      await this.save();
    }
    return false;
  }
  /**
   * Settles what a turn means before the flow itself sees it: the title, the mode, and
   * whether a finished flow starts again. False means the turn goes no further.
   */
  private async admits(
    w: Workflow,
    agentId: string,
    text: string,
    failed: string | null,
    request: string,
    key: string,
    report = text,
  ): Promise<boolean> {
    let transitioned = false;
    if (!capabilities(w).current && automates(w) && !w.execute && workflowRequestedMode(w, userText(request)) === "general") {
      this.generalMode.generalize(w);
      await this.rememberProject(w);
      await this.save();
    }
    if (capabilities(w).standalone) {
      if (failed === null) await this.renameFromResponse(w, agentId, text, false, request, report, key);
      return false;
    }
    if (capabilities(w).current && w.mode === "undecided") {
      if (failed === null) await this.renameFromResponse(w, agentId, text, false, request, report, key);
      return false;
    }
    if (!automates(w)) {
      // The request counts even when the turn that carried it failed.
      await this.noteModeRequest(w, userText(request));
      if (failed !== null) return false;
      if (!this.federates(w, text)) {
        await this.renameFromResponse(w, agentId, text, false, request, report, key);
        return false;
      }
      w.mode = "federated";
      w.wantsFederation = false;
      transitioned = true;
    }
    if (failed === null)
      await this.renameFromResponse(w, agentId, text, transitioned, request, report, key);
    if (w.status !== "completed") return true;
    if (w.plan?.id !== agentId || failed !== null) return false;
    try {
      const d = parseDecision(text);
      if (d.status === "note") {
        this.seen(w, key);
        this.remember(w, d.remember);
        await this.save();
        return false;
      }
    } catch {
      return false;
    }
    w.cycles = 0;
    w.turns = 0;
    w.planFingerprint = "";
    w.repeatedPlans = 0;
    w.status = "active";
    if (w.execute && w.execute.workspaceId === null) await this.executorChoice.restoreExecutor(w);
    return true;
  }
  /**
   * Whether the delivered message is part of the turn that just ended. A turn that finished
   * a moment before the delivery, or one that never received it, does not carry it. With no
   * record of the turn's messages there is nothing to judge by, and the turn counts.
   */
  private carries(
    w: Workflow,
    pending: Pending,
    request: string,
    messageIds?: readonly string[],
  ): boolean {
    if (!messageIds || (!messageIds.length && !request)) return true;
    return messageIds.includes(pending.id) || request.startsWith(`작업 ID: ${w.id}`);
  }
  /**
   * Decides what a side turn does to an inbox that is still unread, as happens while paused.
   * True: it takes the answer's place. False: it is stored as an ordinary turn. Null: the
   * unread answer stays and this turn is dropped.
   */
  private supersedes(
    w: Workflow,
    role: Role,
    agentId: string,
    text: string,
    failed: string | null,
    mine: boolean,
  ): boolean | null {
    const unread = w.inbox!;
    const d = failed === null ? this.sideDecision(w, role, text) : null;
    if (d?.status === "note") {
      this.remember(w, d.remember);
      return null;
    }
    if (!unread.answers) return mine;
    if (unread.failed !== null) {
      // That instruction ended in failure, so the user is driving from here.
      w.pending = null;
      return false;
    }
    // The addressee's newer decision replaces its answer and ends the instruction in its place.
    if (d && unread.agentId === agentId) return true;
    if (d?.status !== "complete" || role !== "plan") return null;
    // A planner may call the work done over a result it has not read. The answer did arrive,
    // so the instruction is over even if this turn is itself replaced before a resume.
    w.pending = null;
    return false;
  }
  /** A general conversation federates only after the user names that mode. */
  private async noteModeRequest(w: Workflow, said: string) {
    if (w.mode === "federated") return;
    const mode = workflowRequestedMode(w, said);
    if (!mode) return;
    if (mode === "general") {
      if (w.mode === "undecided") this.generalMode.generalize(w);
      await this.rememberProject(w);
    }
    const wants = mode === "federated";
    if (wants === w.wantsFederation && mode !== "general") return;
    w.wantsFederation = wants;
    await this.save();
  }
  /** Only a plan starts a federation; other blocks leave an unconnected conversation alone. */
  private federates(w: Workflow, text: string): boolean {
    if (!w.plan || (w.mode === "general" && !w.wantsFederation)) return false;
    try {
      return parseDecision(text).status === "plan";
    } catch {
      return false;
    }
  }
  private seen(w: Workflow, key: string) {
    w.processed.push(key);
    if (w.processed.length > 200) w.processed.splice(0, w.processed.length - 200);
  }
  private async renameFromResponse(
    w: Workflow,
    agentId: string,
    text: string,
    transitioned: boolean,
    request: string,
    report: string,
    key: string,
  ) {
    const settings = await this.settings();
    const requested = this.declared(w, agentId, text, request, report, key);
    const declared = await this.verified(w, requested);
    const progressed = declared !== null && declared !== w.progress;
    if (progressed) w.progress = declared;
    const member = w.plan ?? w.execute;
    const first = member?.id === agentId && !w.titled;
    if (![first, transitioned, progressed, this.pendingTitles.has(w.id)].some(Boolean)) return;
    const parsed = first && settings.koreanTitle ? parseTitle(text) : null;
    w.titled = true;
    if (!parsed && !settings.titleMarker && !transitioned) {
      await this.save();
      return;
    }
    let title = parsed ?? w.title;
    if (first && !parsed && member.workspaceId) {
      try {
        title = (await this.port.workspaceName(member.workspaceId)) ?? w.title;
      } catch {
        /* Keep the stored title when the workspace cannot be read. */
      }
    }
    w.title = stripTitleDecor(title);
    await this.save();
    await this.renameWorkspaces(w, settings.titleMarker, !parsed);
  }
  private async managedProgress(
    w: Workflow,
    declared: Workflow["progress"] | null,
  ): Promise<Workflow["progress"] | undefined> {
    if (
      w.managedPush &&
      w.managedPush.epoch === w.pushEpoch &&
      declared !== "active" &&
      declared !== "plan"
    ) {
      if (w.managedPush.state === "pushed") {
        await this.managedPushes.managedCompleted(w, w.managedPush);
        return "pushed";
      }
      return "done";
    }
    return undefined;
  }
  private setPushUnverified(w: Workflow, value: boolean) {
    if (w.pushUnverified === value) return;
    w.pushUnverified = value;
    this.pendingTitles.add(w.id);
  }
  private hasPushObligation(w: Workflow) {
    return !!(
      w.pushTargets.length ||
      w.invalidTargets ||
      w.managedPush ||
      w.pushReceipt ||
      w.pushUnverified ||
      w.pushApprovalPending
    );
  }
  private noPushProgress(w: Workflow): Workflow["progress"] {
    if (this.hasPushObligation(w)) {
      w.artifactNotice = "푸시 대상 또는 미확인 실행이 남아 있어 푸시 불필요로 완료할 수 없습니다.";
      return "done";
    }
    w.pushRetry = null;
    w.artifactNotice = "";
    return "no_push";
  }
  private async assertNoPushCompletion(w: Workflow) {
    if (w.progress !== "done" && w.progress !== "no_push")
      throw new Error("완료한 작업만 푸시 불필요로 정리할 수 있습니다.");
    if (this.hasPushObligation(w)) throw new Error("푸시 대상 또는 미확인 실행이 남아 있습니다.");
    if (
      w.pending ||
      w.inbox ||
      w.held ||
      w.asker ||
      w.generalTransition ||
      ["needs_input", "error"].includes(w.status)
    )
      throw new Error("대기 중인 작업이나 확인 요청을 먼저 마쳐 주세요.");
    await this.assertQuietProgressChange(w);
  }
  private async assertQuietProgressChange(w: Workflow) {
    for (const member of [w.plan, w.execute, w.reviewer]) {
      if (!member) continue;
      const snapshot = await this.port.inspect(member.id);
      if (!snapshot || !this.quiet(snapshot))
        throw new Error("진행 중인 대화가 끝난 뒤 완료 또는 푸시 상태를 변경하세요.");
    }
  }
  /** A same-flow execution receipt and remote confirmation are both required. */
  private async verified(
    w: Workflow,
    declared: Workflow["progress"] | null,
  ): Promise<Workflow["progress"] | null> {
    if (declared === "no_push") return this.noPushProgress(w);
    const managed = await this.managedProgress(w, declared);
    if (managed) return managed;
    if (declared !== "pushed") {
      if (declared === "active" || declared === "plan") this.setPushUnverified(w, false);
      if (declared !== null) w.pushRetry = null;
      return declared;
    }
    // Keep an unchanged legacy display during read-only follow-ups. This cannot promote
    // green work, create a receipt or pin it; new edits/targets/pending approval clear it first.
    if (w.progress === "pushed" && !w.pushReceipt && !w.invalidTargets) return "pushed";
    let pushed: boolean | null = null;
    w.pushRetry = null;
    if (
      !w.invalidTargets &&
      this.probe &&
      w.pushTargets.length &&
      w.pushReceipt?.key === pushReviewKey(w.pushTargets)
    ) {
      const targets = await Promise.all(
        w.pushTargets.map(async (target) => {
          const result = await this.probe?.pushedTarget?.(target).catch(() => null);
          if (result === true) return { ...target, result: "pushed" as const };
          if (result === false) return { ...target, result: "missing" as const };
          return { ...target, result: "unknown" as const };
        }),
      );
      w.pushCheck = { checkedAt: new Date().toISOString(), targets };
      pushed = targets.every((target) => target.result === "pushed");
      if (!pushed) w.pushRetry = { attempts: 0, after: this.now() + 30_000 };
      w.artifactNotice = "";
      if (!pushed)
        w.artifactNotice = w.pushRetry
          ? "원격 반영 확인을 재시도합니다. 기록한 저장소·원격·브랜치·커밋만 조회합니다."
          : "원격 반영을 확인하지 못했습니다. 작업 저장소와 푸시 대상 커밋을 확인하세요.";
    } else
      w.artifactNotice =
        "이 작업의 성공한 푸시 실행 기록과 대상 커밋이 일치하지 않습니다. 원격에 있다는 이유만으로 푸시 완료 처리하지 않습니다.";
    if (pushed === true) await this.queuePushReview(w);
    this.setPushUnverified(w, pushed !== true);
    // A failed confirmation can stay green; its pinned retry still needs durable storage.
    await this.save();
    if (pushed === true) return declared;
    return "done";
  }
  private async queuePushReview(w: Workflow) {
    if (!(await this.settings()).autoPinPushed || !this.lifecycle.supportsPins || !w.pushTargets.length)
      return;
    const key = pushReviewKey(w.pushTargets);
    if (w.pushReview?.key === key) {
      for (const row of w.pushReview.workspaces)
        if (row.phase === "withdrawn") row.phase = "queued";
      return;
    }
    const ids = [w.plan?.workspaceId, w.isolation === "worktree" ? null : w.execute?.workspaceId].filter((id): id is string => !!id);
    w.pushReview = {
      key,
      workspaces: [...new Set(ids)].map((id) => ({ id, phase: "queued", ownedPinAt: null })),
    };
  }
  private async syncStartPin(w: Workflow) {
    if (!w.startPin || !this.lifecycle.supportsPins) return;
    try {
      // Always active: starting a new phase never withdraws a workflow's start pin.
      await syncPushReview(w.startPin, this.lifecycle, () => this.save(), true, w.isolation === "worktree" ? w.execute?.workspaceId ?? null : null);
    } catch {
      w.artifactNotice =
        "새 작업 상단 고정 응답을 확인하지 못했습니다. 목록의 고정 상태를 다시 확인합니다.";
      await this.save();
    }
  }
  private async syncPushReview(w: Workflow) {
    if (!w.pushReview || !this.lifecycle.supportsPins) return false;
    const active =
      w.progress === "pushed" &&
      w.pushReview.key === pushReviewKey(w.pushTargets) &&
      !!w.pushCheck?.targets.length &&
      w.pushCheck.targets.every((target) => target.result === "pushed");
    try {
      return await syncPushReview(w.pushReview, this.lifecycle, () => this.save(), active, w.isolation === "worktree" ? w.execute?.workspaceId ?? null : null);
    } catch {
      w.artifactNotice =
        "상단 고정 변경 응답을 확인하지 못했습니다. 목록의 고정 상태를 다시 확인합니다.";
      await this.save();
      return false;
    }
  }
  adoptReviewPins(id: string, key: string, pins: { workspaceId: string; pinnedAt: string }[]) {
    return this.serial(async () => {
      const w = (await this.db()).workflows.find((entry) => entry.id === id);
      const review = w?.pushReview;
      if (!w || !review || review.key !== key || w.progress !== "pushed" || !this.lifecycle.supportsPins)
        throw new Error("이전 자동 고정 기록과 현재 푸시 상태가 다릅니다.");
      const rows = [];
      for (const pin of pins) {
        const row = review.workspaces.find((entry) => entry.id === pin.workspaceId);
        const current = await this.lifecycle.get(pin.workspaceId);
        if (!row || row.phase !== "pinned" || row.ownedPinAt || current?.pinnedAt !== pin.pinnedAt)
          throw new Error("고정이 변경됐거나 이미 확인됐습니다. 기존 고정을 보존합니다.");
        rows.push({ row, expectedPin: pin });
      }
      for (const { row, expectedPin } of rows) row.ownedPinAt = expectedPin.pinnedAt;
      await this.save();
      return { adopted: rows.length };
    });
  }
  /** Retry only a reported push, with its pinned targets, while both conversations are idle. */
  private async retryPush(w: Workflow) {
    // The strict history port moves this verification outside the shared workflow queue.
    if ([this.port.pushAuditHistory, w.managedPush].some(Boolean)) return;
    const retry = w.pushRetry;
    if (!retry || retry.after > this.now()) return;
    if (w.progress !== "done" || w.invalidTargets || !w.pushTargets.length) {
      w.pushRetry = null;
      return;
    }
    if (w.generalTransition || w.inbox || w.pending || w.status === "needs_input") return;
    for (const member of [w.plan, w.execute, w.reviewer]) {
      if (!member) continue;
      const snapshot = await this.port.inspect(member.id).catch(() => null);
      if (!snapshot || snapshot.archived || !this.quiet(snapshot)) return;
    }
    const progress = await this.verified(w, "pushed");
    if (progress === "pushed") {
      w.progress = "pushed";
      await this.renameWorkspaces(w, (await this.settings()).titleMarker);
    } else if (w.pushRetry) {
      const attempts = retry.attempts + 1;
      w.pushRetry =
        attempts < 5
          ? { attempts, after: this.now() + Math.min(30_000 * 2 ** attempts, 300_000) }
          : null;
      if (!w.pushRetry)
        w.artifactNotice =
          "원격 반영 재확인이 끝났습니다. 작업 저장소와 푸시 대상 커밋을 확인하세요.";
    }
  }
  auditPushes() {
    return this.pushAudit.auditPushes();
  }
  private declared(
    w: Workflow,
    agentId: string,
    text: string,
    request = "",
    report = text,
    key = "",
  ): Workflow["progress"] | null {
    if (pushPending(report)) return w.contract >= 3 && automates(w) && w.status !== "completed" ? null : "done";
    // The user's own line wins and works in conversations created before the progress prompt.
    // Messages delivered by this plugin start with the flow id and are never read as one.
    const user = parseProgress(userText(request));
    if (user) return user;
    const stated = parseProgress(report) ?? parseProgress(text);
    if (
      stated !== "active" &&
      stated !== "plan" &&
      w.pushReceipt?.agentId === agentId &&
      w.pushReceipt.turnKey === key
    )
      return "pushed";
    // Contract 3 promotes completion only after the planner verdict gate in complete().
    if (w.contract >= 3 && automates(w) && ["done", "no_push"].includes(stated ?? "")) return null;
    if (stated) return stated;
    // A block completes the work only from a federation's planner or a lone legacy executor.
    const finishes = w.plan ? automates(w) && w.plan.id === agentId : true;
    if (!finishes || w.progress === "pushed" || w.progress === "no_push" || w.contract >= 3) return null;
    try {
      return parseDecision(text).status === "complete" ? "done" : null;
    } catch {
      return null;
    }
  }
  /** Flows from before progress tracking are green when finished or awaiting a read complete. */
  private legacyProgress(w: Workflow): Workflow["progress"] {
    if (w.progress !== "active" || !automates(w)) return w.progress;
    const waiting = w.inbox?.failed === null && this.declared(w, w.inbox.agentId, w.inbox.text);
    return w.status === "completed" || waiting === "done" ? "done" : w.progress;
  }
  private async ensureNumber(w: Workflow) {
    if (w.number) return;
    w.number = nextNumber((await this.db()).sequences, w.projectId);
    await this.save();
  }
  private pushTitleState(w: Workflow) {
    return w.managedPush?.state ?? (w.pushUnverified ? "unknown" : undefined);
  }
  private waitingFor(w: Workflow) {
    return automates(w) && w.status === "active" && w.pending?.stage === "queued"
      ? w.writerWait?.blocker || undefined
      : undefined;
  }
  /** Each workspace keeps its current name unless a new title was just chosen. */
  private async titles(
    w: Workflow,
    marker: boolean,
    detail: { number: number; progress: Workflow["progress"] },
    keep: boolean,
  ) {
    const paired = automates(w) && !!w.plan;
    // The executor is a tab in the planner's workspace. Only flows from before that keep
    // two workspaces, each naming its role.
    const apart = !!w.execute?.workspaceId && w.execute.workspaceId !== w.plan?.workspaceId;
    const projectName = await this.port.projectName(w.projectId, w.cwd);
    const rows: {
      workspaceId: string;
      title: string;
      base: string;
      found: boolean;
    }[] = [];
    for (const member of [w.plan, w.execute, w.reviewer]) {
      if (!member?.workspaceId || rows.some((row) => row.workspaceId === member.workspaceId))
        continue;
      const name = keep
        ? await this.port.workspaceName(member.workspaceId).catch(() => null)
        : null;
      const base = (name && stripTitleDecor(name)) || w.title;
      const review = w.pushReview?.workspaces.find((row) => row.id === member.workspaceId);
      const pushReview =
        detail.progress === "pushed" &&
        !!review &&
        ["queued", "sent", "pinned"].includes(review.phase);
      let role: TitleRole = "pair";
      if (apart) role = member === w.plan ? "plan" : "execute";
      rows.push({
        workspaceId: member.workspaceId,
        base,
        found: name !== null,
        title: decorateTitle(member.config.provider, paired ? role : null, base, marker, {
          ...detail,
          projectName,
          generation: member.generation,
          pushReview,
          pushState: this.pushTitleState(w),
          waitingFor: this.waitingFor(w),
        }).slice(0, 120),
      });
    }
    return rows;
  }
  private async renameWorkspaces(w: Workflow, marker: boolean, keep = true) {
    await this.syncStartPin(w);
    await this.syncPushReview(w);
    await this.ensureNumber(w);
    let failed = false;
    for (const row of await this.titles(w, marker, w, keep)) {
      try {
        await this.port.rename(row.workspaceId, row.title);
      } catch {
        failed = true;
        console.error("role-workflow: workspace rename failed");
      }
    }
    if (failed) this.pendingTitles.add(w.id);
    else this.pendingTitles.delete(w.id);
  }
  /** Re-read same-task execution evidence without replaying agent actions or messages. */
  private async recoverPushReceipt(w: Workflow, reported: boolean) {
    if (w.pushReceipt?.key === pushReviewKey(w.pushTargets)) return;
    const members = [w.execute, w.plan].filter((member) => !!member);
    const histories = [];
    for (const member of members) {
      const snapshot = await this.port.inspect(member.id);
      if (!snapshot || !this.quiet(snapshot))
        throw new Error("진행 중인 대화가 끝난 뒤 푸시 상태를 확인하세요.");
      const turn = await this.port.history(member.id);
      const report = turn.evidence?.report ?? turn.text;
      if (
        turn.failed ||
        pushPending(report) ||
        ["active", "plan"].includes(parseProgress(report) ?? "")
      )
        return;
      histories.push({ member, turn, report });
    }
    for (const { member, turn, report } of histories) {
      if (parseProgress(report) !== "pushed" || !turn.evidence?.pushes.length) continue;
      if (reported)
        await this.capturePushEvidence(w, turn.evidence, true, member.id, turn.key, "pushed");
      else {
        // Re-read rejected targets, without replaying old edit scopes, memories or checks.
        const prose = proseArtifacts(turn.text);
        let targets = prose.pushTargets;
        try {
          targets = parseDecision(turn.text)?.pushTargets ?? targets;
        } catch {
          /* General prose has no decision block. */
        }
        await this.captureTargets(
          w,
          { repositories: undefined, pushTargets: targets, invalidTargets: prose.invalidTargets },
          undefined,
          turn.evidence,
        );
        await this.capturePushEvidence(w, turn.evidence, !!targets, member.id, turn.key, "pushed");
      }
    }
  }
  private async historicalPushReady(w: Workflow, agentId: string) {
    if (
      w.mode !== "general" ||
      w.progress !== "done" ||
      !["active", "completed"].includes(w.status) ||
      w.generalTransition ||
      w.pending ||
      w.inbox ||
      w.managedPush ||
      w.pushReceipt
    )
      throw new Error("새 작업이나 기존 푸시 기록이 있는 작업은 과거 응답으로 복구할 수 없습니다.");
    const members = [w.plan, w.execute, w.reviewer].filter((member) => !!member);
    if (!members.some((member) => member.id === agentId))
      throw new Error("현재 작업의 대화에서만 과거 푸시를 확인할 수 있습니다.");
    for (const member of members) {
      const snapshot = await this.port.inspect(member.id);
      if (
        !snapshot ||
        snapshot.archived ||
        member.compaction ||
        snapshot.status !== "idle" ||
        snapshot.permission
      )
        throw new Error("현재 대화가 모두 대기 상태일 때만 과거 푸시를 확인할 수 있습니다.");
    }
  }
  private historicalDecision(text: string) {
    try {
      return parseDecision(text);
    } catch {
      if (text.includes("<paseo-workflow>"))
        throw new Error("과거 응답 이후의 구조화된 작업 상태를 확인할 수 없습니다.");
      return undefined;
    }
  }
  private async validateHistoricalFollowup(w: Workflow, turn: History, targetKey: string) {
    const report = turn.evidence?.report ?? turn.text;
    if (
      turn.failed !== null ||
      turn.compacted ||
      turn.evidence?.changed ||
      turn.evidence?.pushes.length ||
      pushPending(report) ||
      ["active", "plan"].includes(parseProgress(report) ?? "") ||
      this.historicalFollowupStartsWork(turn.text)
    )
      throw new Error("선택한 푸시 뒤에 새 작업이나 미확인 실행이 있어 복구하지 않습니다.");
    await this.validateHistoricalFollowupArtifacts(w, turn.text, targetKey);
  }
  private historicalFollowupStartsWork(text: string) {
    // Check each declaration with the normal fence/block rules, not only the final one.
    return [...text.matchAll(/^작업상태:[ \t]*(계획|진행)[ \t]*$/gm)].some((match) =>
      ["active", "plan"].includes(
        parseProgress(text.slice(0, match.index + match[0].length)) ?? "",
      ),
    );
  }
  private async validateHistoricalFollowupArtifacts(w: Workflow, text: string, targetKey: string) {
    if (text.split("<paseo-workflow>").length > 2)
      throw new Error("선택한 푸시 뒤에 여러 작업 상태 블록이 있어 복구하지 않습니다.");
    const prose = proseArtifacts(text);
    const decision = this.historicalDecision(text);
    // Completion replies are told to repeat their exact targets; only a different set is new.
    const repeated =
      prose.pushTargets !== undefined &&
      pushReviewKey(await resolvedPushTargets(this.probe, w.cwd, prose.pushTargets)) === targetKey;
    if (
      prose.invalidTargets ||
      (prose.pushTargets !== undefined && !repeated) ||
      prose.repositories !== undefined ||
      decision?.pushTargets !== undefined ||
      decision?.repositories !== undefined ||
      (decision && !["note", "complete"].includes(decision.status))
    )
      throw new Error("선택한 푸시 뒤에 작업 계획 또는 저장소·푸시 대상이 다시 보고되었습니다.");
  }
  private async validateHistoricalSourceTargets(w: Workflow, turn: History, targetKey: string) {
    const prose = proseArtifacts(turn.text);
    const decision = this.historicalDecision(turn.text);
    const reported = decision?.pushTargets ?? prose.pushTargets;
    if (prose.invalidTargets) throw new Error("선택한 응답의 푸시 대상 보고를 읽을 수 없습니다.");
    if (reported) {
      const targets = await resolvedPushTargets(this.probe, w.cwd, reported);
      if (pushReviewKey(targets) !== targetKey)
        throw new Error("선택한 응답의 푸시 대상 보고가 현재 작업 대상과 다릅니다.");
    }
  }
  private async recoverHistoricalPush(w: Workflow, source: { agentId: string; messageId: string }) {
    await this.historicalPushReady(w, source.agentId);
    if (!this.port.historicalPush || !w.pushTargets.length || w.invalidTargets)
      throw new Error("현재 푸시 대상과 과거 응답을 함께 확인할 수 없습니다.");
    const targetKey = pushReviewKey(w.pushTargets);
    const { turn, later } = await this.port.historicalPush(source.agentId, source.messageId);
    const report = turn.evidence?.report ?? turn.text;
    if (
      turn.failed !== null ||
      !turn.key ||
      !turn.evidence?.pushes.length ||
      parseProgress(report) !== "pushed" ||
      pushPending(report)
    )
      throw new Error("선택한 응답에서 성공한 푸시 실행과 완료 보고를 확인할 수 없습니다.");
    await this.validateHistoricalSourceTargets(w, turn, targetKey);
    for (const followup of later) await this.validateHistoricalFollowup(w, followup, targetKey);
    const executions = await Promise.all(
      turn.evidence.pushes.map((push) => this.observedPushes(w, [push], w.pushTargets)),
    );
    if (
      executions.some((rows) => rows.length !== 1) ||
      pushReviewKey(executions.flat().map((row) => row.target)) !== targetKey
    )
      throw new Error("선택한 응답의 실제 푸시 대상이 현재 작업 대상과 다릅니다.");
    const latest = await this.port.history(source.agentId);
    if (
      !latest.key ||
      latest.key !== (later.at(-1) ?? turn).key ||
      pushReviewKey(w.pushTargets) !== targetKey
    )
      throw new Error("확인 중 대화 또는 푸시 대상이 바뀌었습니다. 최신 기록을 다시 확인하세요.");
    await this.historicalPushReady(w, source.agentId);
    await this.capturePushEvidence(w, turn.evidence, true, source.agentId, turn.key, "pushed");
  }
  /** Sets the colour of one numbered flow, verifying a requested push from its own evidence. */
  setProgress(
    number: number,
    progress: Workflow["progress"],
    project = "",
    targets?: PushTarget[],
    source?: { agentId: string; messageId: string },
  ) {
    return this.serial(async () => {
      const db = await this.db();
      const matches = db.workflows.filter(
        (candidate) =>
          candidate.number === number &&
          (!project ||
            [candidate.projectId, candidate.cwd, path.basename(candidate.cwd)].includes(project)),
      );
      if (!matches.length) throw new Error(`${number}번 작업을 찾을 수 없습니다.`);
      if (matches.length > 1)
        throw new Error(
          `${number}번 작업이 여러 프로젝트에 있습니다(${matches
            .map((match) => path.basename(match.cwd))
            .join(", ")}). 프로젝트 폴더 이름을 함께 지정하세요.`,
        );
      const w = matches[0];
      if (progress === "no_push") await this.assertNoPushCompletion(w);
      if (source) {
        if (progress !== "pushed" || targets !== undefined)
          throw new Error(
            "과거 푸시 복구는 현재 대상을 유지한 푸시 상태 확인에만 사용할 수 있습니다.",
          );
        await this.recoverHistoricalPush(w, source);
      }
      if (targets && progress !== "pushed")
        throw new Error("푸시 상태를 확인할 때만 푸시 대상을 지정하세요.");
      if (progress === "active" || progress === "plan") {
        this.newPushPhase(w);
        w.pushTargets = [];
        this.invalidatePush(w, progress);
      }
      if (targets) {
        await this.assertQuietProgressChange(w);
        const next = await resolvedPushTargets(
          this.probe,
          w.cwd,
          pushTargetsSchema.min(1).parse(targets),
        );
        if (
          w.repositories.length &&
          next.some((target) => !w.repositories.includes(target.repository))
        )
          throw new Error("푸시 대상이 선택된 작업 저장소에 포함되지 않습니다.");
        if (pushReviewKey(next) !== pushReviewKey(w.pushTargets)) {
          this.newPushPhase(w);
          this.invalidatePush(w);
        }
        w.pushTargets = next;
        w.pushCheck = null;
        w.invalidTargets = false;
      }
      if (progress !== "pushed") {
        this.newPushPhase(w);
        this.invalidatePush(w, progress);
      } else if (!source) await this.recoverPushReceipt(w, !!targets);
      w.progress = (await this.verified(w, progress))!;
      await this.save();
      await this.renameWorkspaces(w, db.settings.titleMarker);
      return (await this.titles(w, db.settings.titleMarker, w, true)).map((row) => row.title);
    });
  }
  /** Converts existing titles to the current format. Unmanaged rows have no workflow. */
  retitle(apply: boolean, unmanaged: Unmanaged[], renumber = false) {
    return this.serial(async () => {
      const db = await this.db();
      const marker = db.settings.titleMarker;
      const managed = new Set(
        db.workflows.flatMap((w) => [w.plan?.workspaceId, w.execute?.workspaceId]),
      );
      const flowless = unmanaged.filter((item) => !managed.has(item.workspaceId));
      const numbers = numbering(db, flowless, renumber);
      const rows: {
        workspaceId: string;
        title: string;
        error: string | null;
      }[] = [];
      for (const w of db.workflows) {
        const number = numbers.of(`flow:${w.id}`);
        const progress = this.legacyProgress(w);
        const titles = await this.titles(w, marker, { number, progress }, true);
        if (apply) Object.assign(w, { number, progress, title: titles[0]?.base ?? w.title });
        // Archived or unreadable workspaces keep their titles.
        for (const row of titles)
          if (row.found) rows.push({ workspaceId: row.workspaceId, title: row.title, error: null });
      }
      for (const item of flowless)
        rows.push({
          workspaceId: item.workspaceId,
          title: decorateTitle(item.provider, item.role, stripTitleDecor(item.title), marker, {
            projectName: await this.port.projectName(item.projectId, item.cwd),
            number: numbers.of(`row:${item.workspaceId}`),
            // Without a flow the colour lives only in the title, so it is carried over.
            progress: titleProgress(item.title) ?? "active",
          }).slice(0, 120),
          error: null,
        });
      if (!apply) return rows;
      db.sequences = numbers.sequences;
      await this.save();
      for (const row of rows) {
        try {
          await this.port.rename(row.workspaceId, row.title);
        } catch (error) {
          row.error = error instanceof Error ? error.message : String(error);
        }
      }
      return rows;
    });
  }
  private dispatch(event: NotificationEvent) {
    void Promise.resolve()
      .then(() => this.notify(event))
      .catch(() => console.error("role-workflow: notification failed"));
  }
  permission(
    agentId: string,
    request: {
      id: string;
      title?: string;
      description?: string;
      name?: string;
      kind: string;
      input?: unknown;
    },
  ) {
    return this.serial(async () => {
      const db = await this.db();
      const w = db.workflows.find(
        (candidate) => memberRole(candidate, agentId) !== null,
      );
      const key = `${agentId}:${request.id}`;
      if (w && capabilities(w).current && w.mode === "undecided" && w.plan?.id === agentId) {
        const history = await this.port.history(agentId).catch(() => null);
        const requested = workflowRequestedMode(w, history?.goal ?? "");
        if (requested && await this.allowMode(w, requested)) { w.mode = requested; await this.rememberProject(w); }
      }
      const questionId = request.id.replace(/^permission-/, "");
      if (w && capabilities(w).executorSelection && !this.firstPlan(w) && w.plan?.id === agentId && request.kind === "question") {
        this.executorChoice.rememberSelectionQuestion(w, questionId, request.input);
        await this.save();
      } else await this.generalMode.rememberGeneralQuestion(w, agentId, request, db.settings);
      if (w?.plan?.id === agentId && request.kind === "question") {
        const parsed = z
          .object({
            questions: z.array(
              z.object({
                question: z.string(),
                header: z.string().optional(),
                options: z.array(z.object({ label: z.string() })),
              }),
            ),
          })
          .safeParse(request.input);
        const question = parsed.success
          ? parsed.data.questions.find(
              (item) =>
                (w.contract < 6 || item.question === "진행 방식을 선택하세요") &&
                item.options.some((option) => (w.contract >= 6 ? normalizeModeLabel(option.label) : option.label) === "일반개발") &&
                item.options.some((option) => (w.contract >= 6 ? normalizeModeLabel(option.label) : option.label) === "연합개발"),
            )
          : undefined;
        if (question) {
          const review = w.contract >= 7 && w.brainstorm && w.mode === "undecided" && parsed.success
            ? parsed.data.questions.find(item => item.question === "계획 검증을 켤까요?" && item.header === "계획검증" &&
              item.options.length === 2 && item.options.some(o => o.label === "켜기") && item.options.some(o => o.label === "끄기")) : undefined;
          this.modeQuestions.set(key, { question: question.question, header: question.header,
            ...(review ? { review: { question: review.question, header: review.header! } } : {}) });
          if (this.modeQuestions.size > 200)
            this.modeQuestions.delete(this.modeQuestions.keys().next().value!);
        }
      }
      if (
        !w ||
        !automates(w) ||
        !db.settings.notifyPermission ||
        this.permissions.has(key)
      )
        return;
      this.permissions.add(key);
      if (this.permissions.size > 200)
        this.permissions.delete(this.permissions.values().next().value!);
      const member = w[memberRole(w, agentId)!];
      this.dispatch({
        kind: "permission",
        title: `권한 요청 · ${w.title}`,
        body: request.title || request.description || request.name || request.kind,
        agentId,
        workspaceId: member?.workspaceId ?? "",
      });
    });
  }
  permissionResolved(agentId: string, requestId: string, resolution: AgentPermissionResponse) {
    return this.serial(async () => {
      const key = `${agentId}:${requestId}`;
      const workflow = (await this.db()).workflows.find(w => w.plan?.id === agentId);
      if (workflow && capabilities(workflow).executorSelection && !this.firstPlan(workflow)) {
        const pending = workflow.selection?.pending;
        if (pending?.id === requestId.replace(/^permission-/, "") && resolution.behavior === "allow") {
          const values = selectionAnswers(resolution.updatedInput, pendingFields(pending));
          await this.executorChoice.acceptSelection(workflow, requestId, values);
        }
      } else await this.generalMode.resolveGeneralQuestion(agentId, requestId, resolution);
      const question = this.modeQuestions.get(key);
      this.modeQuestions.delete(key);
      if (!question || resolution.behavior !== "allow") return;
      const parsed = z
        .object({ answers: z.record(z.string(), z.unknown()) })
        .safeParse(resolution.updatedInput);
      if (!parsed.success) return;
      const answers = parsed.data.answers;
      const answer =
        answers[question.question] ?? (question.header ? answers[question.header] : undefined);
      const label = typeof answer === "string" ? ((workflow?.contract ?? 1) >= 6 ? normalizeModeLabel(answer) : answer) : "";
      if (label !== "브레인스토밍" && label !== "일반개발" && label !== "연합개발") return;
      const w = (await this.db()).workflows.find(
        (candidate) => memberRole(candidate, agentId) !== null,
      );
      if (label === "브레인스토밍") {
        if (w) await this.startBrainstorm(w);
        return;
      }
      const mode = label === "일반개발" ? "general" : "federated";
      if (!w || !w.plan) return;
      if (w.mode !== mode) await this.applyModeChoice(w, agentId, mode);
      if (w.contract >= 7 && question.review && label === "연합개발" && w.mode === "federated" && this.firstPlan(w)) {
        const values = [question.review.question, question.review.header].filter(key => Object.hasOwn(answers, key)).map(key => answers[key]);
        if (values.length && values.every(value => value === values[0]) && (values[0] === "켜기" || values[0] === "끄기")) {
          w.reviewSelection.enabled = values[0] === "켜기";
          await this.save();
        }
      }
    });
  }
  async federationStatus(cwd?: string) {
    return (this.federation = await (this.port.federationAvailability?.(cwd) ?? { available: true, reason: null }));
  }
  private async allowMode(w: Workflow, mode: "general" | "federated") {
    if (mode === "general") return true;
    const availability = await this.federationStatus(w.cwd);
    if (availability.available) {
      if (availability.reason) this.touch(w, availability.reason);
      return true;
    }
    this.touch(w, availability.reason ?? "실행 가능한 제품이 없어 연합개발을 선택할 수 없습니다.");
    return false;
  }
  /** Records a work-mode choice from the question tool or the in-chat card. */
  private async applyModeChoice(w: Workflow, agentId: string, mode: "general" | "federated") {
    if (capabilities(w).current && w.mode !== "undecided") {
      this.touch(w, "진행 중인 작업의 방식은 바꿀 수 없습니다. 다른 방식은 새 작업으로 시작하세요.");
      await this.save();
      return;
    }
    if (!await this.allowMode(w, mode)) { await this.save(); return; }
    // Clear stale questions before queuing a transition as well as before an immediate choice.
    for (const pending of this.modeQuestions.keys())
      if (pending.startsWith(`${agentId}:`)) this.modeQuestions.delete(pending);
    if (mode === "general" && w.execute && w.contract < 3) {
      await this.generalMode.returnToGeneral(w);
      return;
    }
    const established = w.mode !== "undecided";
    if (mode === "general" && !(w.contract >= 3 && automates(w))) this.generalMode.generalize(w);
    else w.mode = mode;
    w.wantsFederation = false;
    await this.rememberProject(w);
    await this.save();
    if ((mode === "federated" || established) && w.titled)
      await this.renameWorkspaces(w, (await this.settings()).titleMarker);
  }
  /** The mode card: chooses the mode, then tells the planner so the request continues. */
  selectMode(id: string, mode: "brainstorm" | "general" | "federated") {
    return this.serial(async () => {
      const w = (await this.db()).workflows.find((candidate) => candidate.id === id);
      if (!w?.plan) return { ok: false, detail: "작업을 찾을 수 없습니다." };
      if (w.mode !== "undecided")
        return { ok: w.mode === mode, detail: `진행 방식은 이미 ${w.mode === "general" ? "일반개발" : "연합개발"}입니다.` };
      if (mode === "brainstorm") {
        if (!capabilities(w).brainstorm) return { ok: false, detail: "이 작업은 브레인스토밍을 지원하지 않습니다." };
        await this.startBrainstorm(w);
        const snapshot = await this.port.inspect(w.plan.id).catch(() => null);
        if (snapshot && this.quiet(snapshot)) await this.port.send(w.plan.id,
          `작업 ID: ${w.id}\n진행 방식: 브레인스토밍 (사용자가 화면에서 선택). 진행 방식을 다시 묻지 않고 규칙 15-design-guide 5절에 따라 파일을 바꾸지 않고 논의·조사한다.`, `role-workflow-mode:${w.id}:brainstorm`).catch(() => {});
        return { ok: true, detail: "브레인스토밍으로 논의·조사합니다." };
      }
      await this.applyModeChoice(w, w.plan.id, mode);
      // applyModeChoice may refuse; read the mode again after it.
      if ((w.mode as Workflow["mode"]) !== mode) return { ok: false, detail: w.detail };
      const label = mode === "general" ? "일반개발" : "연합개발";
      const snapshot = await this.port.inspect(w.plan.id).catch(() => null);
      if (snapshot && this.quiet(snapshot))
        await this.port
          .send(
            w.plan.id,
            `작업 ID: ${w.id}\n진행 방식: ${label} (사용자가 화면에서 선택). 진행 방식을 다시 묻지 않고, 직전 요청을 이 방식으로 이어서 진행한다.`,
            `role-workflow-mode:${w.id}`,
          )
          .catch(() => {});
      return { ok: true, detail: `${label}로 진행합니다.${mode === "federated" && this.federation.reason ? " " + this.federation.reason : ""}` };
    });
  }
  /** A placement choice is valid only while this task is awaiting its first placement. */
  selectPlacement(id: string, placement: "worktree" | "wait") {
    return this.serial(async () => {
      const w = (await this.db()).workflows.find((candidate) => candidate.id === id);
      if (!w?.plan) return { ok: false, detail: "작업을 찾을 수 없습니다." };
      if (!capabilities(w).executorSelection) return { ok: false, detail: "연합개발 작업이 아닙니다." };
      if (w.isolation !== "undecided") return { ok: false, detail: "구현 시작 방법이 이미 정해졌습니다." };
      if (w.placement?.stage !== "choice" || w.status !== "active" || !w.execute || w.execute.workspaceId)
        return { ok: false, detail: "구현 시작 방법 선택을 기다리는 상태가 아닙니다." };
      try {
        await placeExecutor(w, this.probe, this.port, await this.settings(), await this.placementBlocker(w), placement);
      } catch (error) {
        w.status = "error";
        this.touch(w, String(error));
        await this.save();
        return { ok: false, detail: w.detail };
      }
      await this.save();
      const detail = (w.isolation as Workflow["isolation"]) === "worktree" ? "따로 작업 공간에서 시작합니다." : "앞 작업이 끝나면 자동으로 시작합니다.";
      const snapshot = await this.port.inspect(w.plan.id).catch(() => null);
      if (snapshot && this.quiet(snapshot))
        await this.port.send(w.plan.id, `작업 ID: ${w.id}\n${detail}`, `role-workflow-placement:${w.id}`).catch(() => {});
      await this.advance(w);
      return { ok: true, detail };
    });
  }
  generalTimeline(...args: Parameters<GeneralMode["generalTimeline"]>) {
    return this.generalMode.generalTimeline(...args);
  }
  control(id: string, action: "pause" | "resume" | "general" | "resend" | "retry_compaction", message = "") {
    return this.serial(async () => {
      const w = (await this.db()).workflows.find((candidate) => candidate.id === id);
      if (!w) throw new Error("자동 작업을 찾을 수 없습니다.");
      if (capabilities(w).standalone) {
        if (isFinished(w) || w.status === "completed") throw new Error("완료된 작업은 압축 유지보수를 시작하지 않습니다.");
        if (action === "pause") await this.pause(w);
        else if (action === "retry_compaction") await this.compaction.retryCompaction(w);
        else if (action === "resume" && !message.trim()) {
          if (w.plan?.compactionError) {
            if (w.status !== "paused") throw new Error("압축 복구·재시도 버튼으로 완료 상태를 먼저 확인하세요.");
            w.status = "error";
            this.touch(w, "압축 오류가 남아 있습니다. 압축 복구·재시도로 완료 상태를 확인하세요.");
          } else {
            w.status = "active";
            await this.compaction.maintainStandalone(w);
          }
          await this.save();
        } else throw new Error("단일 대화에서는 압축 유지보수 일시정지·재개·복구만 지원합니다.");
        return { ok: true as const, status: w.status, detail: w.detail };
      }
      if (action === "retry_compaction") throw new Error("이 작업은 기존 재개 기능으로 복구하세요.");
      if (!automates(w)) throw new Error("연합개발이 시작되지 않은 대화입니다.");
      if (action === "general") {
      if (capabilities(w).current) throw new Error("진행 중 방식 전환은 지원하지 않습니다. 일반개발은 새 작업으로 시작하세요.");
        if (w.contract >= 3) {
          w.mode = "general";
          await this.rememberProject(w);
          await this.save();
          return { ok: true as const, status: w.status, detail: w.detail };
        }
        await this.generalMode.returnToGeneral(w);
        return { ok: true as const, status: w.status, detail: w.detail };
      }
      if (w.generalTransition)
        throw new Error("일반개발 전환을 기다리고 있습니다. 현재 응답이 끝나면 이어집니다.");
      if (w.status === "completed")
        throw new Error("완료된 작업입니다. 계획 대화에 새 지시를 보내면 다시 시작합니다.");
      if (action === "resend") await this.resend(w);
      else if (action === "pause") await this.pause(w);
      else await this.resume(w, message.trim());
      return { ok: true as const, status: w.status, detail: w.detail };
    });
  }
  private async pause(w: Workflow) {
    w.quotaPause = null;
    w.transientPause = null;
    w.status = "paused";
    w.notifiedStatus = "paused";
    this.touch(w, "일시정지: 현재 응답은 마무리하고 다음 자동 작업은 시작하지 않습니다.");
    await this.save();
  }
  private async resume(
    w: Workflow,
    message: string,
    automatic = false,
  ): Promise<Workflow["status"]> {
    // Refusals come before any change, so a rejected resume leaves the flow as it was.
    await this.checkResume(w, message);
    await this.prepareResume(w, automatic);
    if (w.status !== "active") { await this.save(); return w.status; }
    if (automatic && w.quotaPause && !w.pending && !w.inbox && !w.asker && !w.held)
      this.queue(w, w.quotaPause.role, w.quotaPause.prompt ?? CONTINUE, w.quotaPause.phase);
    if (automatic && w.transientPause && !w.pending && !w.inbox && !w.asker && !w.held)
      this.queue(w, w.transientPause.role, CONTINUE, w.transientPause.phase);
    if (message && !w.planIssue) this.redirect(w, message);
    this.touch(w, "자동 작업을 재개합니다.");
    await this.save();
    await this.advance(w);
    await this.keepMoving(w);
    return w.status;
  }
  private async prepareResume(w: Workflow, automatic: boolean) {
    if (!automatic) {
      w.quotaPause = null;
      w.transientPause = null;
      w.planFingerprint = "";
      w.repeatedPlans = 0;
    }
    const settings = await this.settings();
    // Only the user may grant a fresh budget; automatic retries stop at the limit instead.
    if (!automatic && (w.cycles >= settings.maxCycles || w.turns >= settings.maxTurns)) {
      w.cycles = 0;
      w.turns = 0;
    }
    for (const member of [w.plan, w.execute, w.reviewer]) {
      if (member?.compaction && !this.compacting.has(member.id)) member.compaction = null;
    }
    w.status = "active";
    if (w.execute && w.execute.workspaceId === null) await this.executorChoice.restoreExecutor(w);
    if (w.planIssue) {
      const issue = w.planIssue;
      if (w.pending?.id === issue.pendingId &&
          await this.received(w, issue.response, issue.pendingId)) {
        w.inbox = { ...issue.response, answers: true };
        w.planIssue = null;
      } else {
        w.status = "needs_input";
        this.touch(w, issue.reason);
      }
    }
    await this.clearSettled(w);
  }
  private async received(w: Workflow, response: Inbox, pendingId: string): Promise<boolean> {
    const member = [w.plan, w.execute, w.reviewer].find((m) => m?.id === response.agentId);
    if (!member) return false;
    const history = await this.port.history(member.id, pendingId).catch(() => null);
    if (!history || history.failed !== null || history.key !== response.key ||
        history.text !== response.text || !history.messageIds.includes(pendingId)) return false;
    // A later turn also lists the delivery, so only the turn the delivery opened answers it.
    // Histories without turns keep the planner's earlier exact-response rule.
    return history.turnId
      ? history.messageTurns?.[pendingId] === history.turnId
      : member === w.plan || member === w.reviewer;
  }
  private async checkResume(w: Workflow, message: string) {
    for (const member of [w.plan, w.execute, w.reviewer]) {
      // An executor whose creation failed is restored by resume below.
      if (!member || (member === w.execute && member.workspaceId === null)) continue;
      const snapshot = await this.port.inspect(member.id);
      if (!snapshot || snapshot.archived)
        throw new Error("연결된 대화가 보관되어 재개할 수 없습니다. 새 대화에서 다시 시작하세요.");
    }
    if (message && w.pending?.stage === "sending")
      throw new Error("전달 중인 요청이 있습니다. 답변 없이 재개하여 전달 상태를 먼저 확인하세요.");
    if (!message && w.asker && !w.pending && !w.inbox)
      throw new Error(
        "답변을 기다리는 질문이 있습니다. 답변을 입력해 재개하거나 그 대화에 직접 답하세요.",
      );
  }
  /** Clears what a resume must not trip over again. */
  private async clearSettled(w: Workflow) {
    // A failure the user has now seen must not pause the flow a second time.
    const failure = w.inbox?.failed === null ? null : w.inbox;
    if (failure) {
      this.seen(w, failure.key);
      w.inbox = null;
      if (failure.answers) w.pending = null;
    }
    if (await this.over(w)) w.pending = null;
  }
  private redirect(w: Workflow, message: string) {
    const note = `사용자의 추가 지시/답변:\n${message}\n기존 목표와 검증 기준을 지켜 계속 진행하세요.`;
    // An instruction that has not gone out yet carries the note with it.
    if (w.pending?.stage === "queued") {
      w.pending.prompt += `\n\n${note}`;
      return;
    }
    // The plan held at the cycle limit is still dispatched; the note travels with it.
    if (w.inbox && [w.limitPlan, w.selectionPlan].includes(w.inbox.key)) {
      w.resumeNote = w.resumeNote ? `${w.resumeNote}\n\n${note}` : note;
      return;
    }
    if (w.inbox) {
      this.seen(w, w.inbox.key);
      w.inbox = null;
    }
    // An answer goes to whoever asked. A parked instruction waits for what they then decide.
    const to = w.asker ?? this.floor(w);
    w.asker = null;
    this.queue(w, to, note, w.phase);
  }
  /** The role expected to act when no instruction is outstanding. */
  private floor(w: Workflow): Role {
    if (w.planReview.stage === "reviewing" && w.reviewSelection.enabled) return "reviewer";
    return !w.held && w.phase === "execute" && w.execute ? "execute" : "plan";
  }
  /** A resume must leave something queued, running or asked, or the flow looks alive and idles. */
  private async keepMoving(w: Workflow) {
    if (w.status !== "active" || w.pending || w.inbox || !w.processed.length) return;
    if (w.asker) this.keepWaiting(w);
    else this.queue(w, this.floor(w), CONTINUE, w.phase);
    await this.save();
    await this.advance(w);
  }
  archived(agentId: string) {
    return this.archives.archived(agentId);
  }
  archiveFinished(apply = false, ids: readonly string[] = []) {
    return this.archives.archiveFinished(apply, ids);
  }
  syncProjectTitles() {
    return this.serial(async () => {
      if (!this.stopped) await this.port.syncProjectTitles?.();
    });
  }
  tick() {
    return this.serial(async () => {
      if (this.stopped) return;
      if (!this.cleanupChecked) {
        await this.db();
        this.cleanupChecked = true;
        await this.archives.cleanupArchived();
        if ((await this.db()).workflows.some((w) => w.conflict)) await this.refreshConflicts();
      }
      if (!this.pushTitlesChecked) {
        this.pushTitlesChecked = true;
        for (const w of (await this.db()).workflows)
          if (
            w.progress === "pushed" ||
            w.progress === "no_push" ||
            w.managedPush ||
            w.pushUnverified
          )
            await this.renameWorkspaces(w, (await this.settings()).titleMarker);
      }
      // One workflow's failed read must not skip the others or the final save.
      for (const w of (await this.db()).workflows)
        await this.syncWorkflow(w).catch((error) =>
          console.error(`role-workflow: #${w.number} sync failed; will retry:`, error),
        );
      await this.archives.checkArchives().catch((error) =>
        console.error("role-workflow: archive check failed; will retry:", error),
      );
      for (const w of (await this.db()).workflows) {
        const ready = await this.tidyWorkflow(w).catch((error) => {
          console.error(`role-workflow: #${w.number} housekeeping failed; will retry:`, error);
          return false;
        });
        if (ready) await this.stepWorkflow(w);
        else if (capabilities(w).standalone) await this.compaction.maintainStandalone(w).catch(error => {
          w.status = "error";
          this.touch(w, `압축 유지보수 확인 실패: ${String(error)}. 압축 복구·재시도를 사용하세요.`);
        });
      }
      await this.save();
    });
  }
  private async syncWorkflow(w: Workflow) {
    await this.syncStartPin(w);
    await this.managedPushes.syncManagedPush(w);
    await this.worktreeCleanup.run(w);
    if (this.pendingTitles.has(w.id))
      await this.renameWorkspaces(w, (await this.settings()).titleMarker);
    if (await this.syncPushReview(w))
      await this.renameWorkspaces(w, (await this.settings()).titleMarker);
  }
  /** Retries and mode transitions; true when the federated flow may take its next step. */
  private async tidyWorkflow(w: Workflow) {
    await this.retryPush(w);
    if (w.generalTransition) {
      await this.generalMode.finishGeneralTransition(w);
      return false;
    }
    if (w.mode === "general" && !splitGeneral(w) && !capabilities(w).current) {
      if (w.generalState.transfer?.stage === "queued") await this.generalMode.applyGeneralChoice(w);
      await this.generalMode.deliverGeneral(w);
    }
    await this.recovery.retryQuota(w);
    await this.recovery.retryTransient(w);
    return automates(w) && w.status === "active";
  }
  private async stepWorkflow(w: Workflow) {
    try {
      if ((await this.observe(w)) === false) return;
      await this.recover(w);
      await this.advance(w);
      this.tickFailures.delete(w.id);
    } catch (error) {
      // A single failed daemon read is retried; a failure that persists stops the flow.
      const failures = (this.tickFailures.get(w.id) ?? 0) + 1;
      this.tickFailures.set(w.id, failures);
      if (failures < 3) return;
      this.tickFailures.delete(w.id);
      await this.recovery.recordTransient(w, w.pending?.role ?? this.floor(w), String(error), "error");
      w.status = "error";
      this.touch(w, String(error));
      this.recovery.describeTransient(w, String(error));
    }
  }
  private async observe(w: Workflow) {
    this.asking.delete(w.id);
    let responding = false;
    for (const member of [w.plan, w.execute, w.reviewer]) {
      if (!member?.workspaceId) continue;
      const snapshot = await this.port.inspect(member.id);
      // Finished work is being collected, possibly with only one legacy half archived.
      // It must neither resume nor produce a stopped notification because of that archive.
      if (member === w.execute && w.worktreeCleanup?.stage === "done") continue;
      if (snapshot?.archived && isFinished(w)) {
        if (member === w.execute) await this.worktreeCleanup.manuallyArchived(w);
        return false;
      }
      if (!snapshot || snapshot.archived) {
        member.usage = null;
        this.compressionReasons.set(member.id, compressionDecision(member.config.provider, await this.settings(), null).reason);
        w.status = "paused";
        this.touch(w, "연결된 대화가 보관되었거나 없어 자동 진행을 멈췄습니다.");
        return;
      }
      member.usage = snapshot.usage;
      responding ||= snapshot.status === "running" || snapshot.status === "initializing";

      const waiting = "권한 또는 질문에 대한 사용자 응답을 기다리고 있습니다.";
      if (!snapshot.permission) continue;
      this.asking.add(w.id);
      if (w.detail !== waiting) this.touch(w, waiting);
    }
    // Permission text is transient, not a durable workflow decision. A resolved
    // question (including a note-only turn) must not leave a false wait forever.
    if (
      !this.asking.has(w.id) &&
      w.detail === "권한 또는 질문에 대한 사용자 응답을 기다리고 있습니다."
    ) {
      let detail = "자동 전달할 지시가 없습니다. 다음 사용자 요청을 기다립니다.";
      if (responding) detail = "담당 대화가 응답을 처리하고 있습니다.";
      else if (w.pending) detail = "다음 담당자에게 전달할 지시를 확인하고 있습니다.";
      this.touch(w, detail);
    }
  }
  private async recover(w: Workflow) {
    if (w.inbox || w.pending?.stage !== "sent") return;
    const turn = await this.lastTurn(w, w.pending);
    if (!turn) return;
    if (w.processed.includes(turn.history.key)) {
      // The turn ended and was already seen, so no answer is coming. Stop where it shows.
      w.pending = null;
      w.status = "needs_input";
      this.touch(
        w,
        "전달한 지시의 응답이 이미 끝나 다음 단계가 정해지지 않았습니다. 대화를 확인하고 재개하세요.",
      );
    } else if (turn.history.text) {
      // The turn-ended event for this turn will now find it taken and skip its evidence,
      // so push receipts and reported artifacts are recorded here, as in a transition.
      if (turn.failed === null && w.pending!.role !== "reviewer")
        await this.captureArtifacts(
          w,
          turn.history.text,
          turn.history.evidence,
          turn.agentId,
          turn.history.key,
        );
      w.inbox = {
        agentId: turn.agentId,
        key: turn.history.key,
        text: turn.history.text,
        failed: turn.failed,
        compacted: turn.history.compacted ?? false,
        canceled: false,
        reviewerViolation: turn.history.evidence?.changed || turn.history.evidence?.pushes.length ? "검증 턴에서 파일 변경 또는 푸시가 관측됐습니다." : "",
        resumed: false,
        // The last turn after a confirmed delivery stands for the instruction's answer.
        answers: true,
      };
    } else return;
    await this.save();
  }
  /** The addressee's latest turn, once it is idle and the instruction is known to have arrived. */
  private async lastTurn(w: Workflow, pending: Pending) {
    const member = w[pending.role];
    if (!member) return null;
    const snapshot = await this.port.inspect(member.id);
    if (!snapshot || !this.quiet(snapshot)) return null;
    const history = await this.port.history(member.id, pending.id);
    if (!history.messageIds.includes(pending.id)) return null;
    return {
      agentId: member.id,
      history,
      failed: snapshot.status === "error" ? "담당 대화 오류" : history.failed,
    };
  }
  private quiet(snapshot: Snapshot): boolean {
    return (
      snapshot.status !== "running" && snapshot.status !== "initializing" && !snapshot.permission
    );
  }
  /**
   * True when the instruction in flight has in fact ended: its addressee is idle and the turn
   * it produced was already seen. Flows stored by earlier versions can be left this way.
   */
  private async over(w: Workflow): Promise<boolean> {
    if (w.pending?.stage !== "sent" || w.inbox?.answers) return false;
    try {
      const turn = await this.lastTurn(w, w.pending);
      return !!turn && w.processed.includes(turn.history.key);
    } catch {
      return false;
    }
  }
  private queue(
    w: Workflow,
    role: Role,
    prompt: string,
    phase: Workflow["phase"],
    instruction = false,
  ) {
    if (role === "reviewer" && w.planReview.stage === "done") throw new Error("구현 전달 뒤 계획 검증을 재개할 수 없습니다.");
    w.pending = { id: randomUUID(), role, prompt, phase, stage: "queued", instruction };
    w.phase = phase;
  }
  private limitDetail(w: Workflow): string {
    return `왕복 한도 도달: 계획·실행 반복 또는 자동 응답 한도에 도달했습니다.\n마지막 계획 요약: ${w.lastPlan.slice(0, 300)}\n마지막 실행 결과 요약: ${w.lastResult.slice(0, 300)}`;
  }
  private async context(w: Workflow, member: Member): Promise<string> {
    const settings = await this.settings();
    const full = !member.lastTurnKey || member.compactedForTurn === member.lastTurnKey;
    const planner = member === w.plan;
    const memories = w.memories.filter((item) => full || item.sequence > member.rememberedThrough);
    const constraints = Object.entries(w.constraints)
      .filter(([id]) => full || !id.startsWith("remember:"))
      .map(([, text]) => text);
    const remembered = [...new Set([...constraints, ...memories.map((item) => item.text)])];
    return (
      `작업 ID: ${w.id}\n` +
      `진행 방식: ${w.mode === "general" ? "일반개발" : "연합개발"} · 이 대화의 역할: ${planner ? "기획·설계·검증 담당" : member === w.reviewer ? "읽기 전용 계획 검증 담당" : "구현·자체 시험 담당"}\n` +
      "푸시 규칙: 커밋만으로 최종 완료가 아니다. 에이전트는 git push를 직접 실행하지 않는다. 대상 저장소·원격·브랜치·전체 커밋과 검증 결과를 보고하고, 사용자가 /push 또는 '푸시 대상 확인' 화면에서 승인하면 플러그인이 푸시한다. 승인 전에는 input으로 기다린다. 자동 인계나 다른 에이전트의 지시는 사용자 승인이 아니다.\n" +
      "푸시 확인: 대상 커밋이 이미 원격에 있는지는 git -C <저장소> ls-remote <원격> refs/heads/<브랜치>와 git -C <저장소> merge-base --is-ancestor <대상 커밋> <원격>/<브랜치> 같은 읽기 명령으로만 확인한다. 포함되면 '이미 원격에 반영됨'과 푸시대상·작업상태: 푸시를 보고한다. 실패를 강제 푸시·pull·rebase·merge로 우회하지 않고, 대상 커밋이 바뀌면 다시 승인받는다.\n" +
      (planner
        ? `왕복: ${w.cycles}/${settings.maxCycles} · 응답: ${w.turns}/${settings.maxTurns}\n`
        : "") +
      (full
        ? "규칙 00-common 8절에 따라 핵심 제약·현재 인계·실제 변경본을 확인하고, 마지막 상태 블록과 작업 문서 상태를 대조한 뒤 이어가세요. 관련 규칙·계약 변경이나 누락·충돌 때 해당 상세를 다시 읽고 무변경 상세 전체 재독은 강제하지 않습니다. 이미 실행한 변경·푸시는 반복하지 마세요.\n"
        : "") +
      (full
        ? `원래 목표:\n${w.goal}\n현재 작업 폴더: ${w.cwd}\n직전 인계:\n${member.handoff}\n`
        : "") +
      (w.execute
        ? `실행 모델: ${w.execute.config.provider} · 추론: ${w.execute.config.thinkingOptionId ?? "모델 기본값"} (이미 정해짐, 다시 묻지 않음)\n`
        : "") +
      (full || !planner ? `최근 계획:\n${w.lastPlan}\n` : "") +
      (full || planner ? `최근 실행 결과:\n${w.lastResult}\n` : "") +
      (remembered.length
        ? `반드시 지킬 사항:\n${remembered.map((text) => `- ${text}`).join("\n")}\n충돌하면 최신 사용자 지시를 우선하세요.\n`
        : "") +
      (w.repositories.length ? `작업 저장소: ${w.repositories.join(", ")}\n` : "") +
      worktreeContext(w) +
      (w.pushTargets.length
        ? `기록된 푸시 대상 (승인 자체가 아님): ${JSON.stringify(w.pushTargets)}\n`
        : "") +
      (planner && w.verification.length
        ? `구조화 검증 기록 (명령 실행은 보고값이며 로그 내용 직접 확인 필요): ${JSON.stringify(w.verification)}\n`
        : "") +
      `인계 기록 파일: ${this.handoffPath(w)}\n` +
      "현재 코드와 실제 검증 결과를 확인하세요. 이미 완료한 작업을 반복하지 마세요. 상태 파일은 읽기 전용 참고 자료이며 직접 수정하지 마세요.\n"
    );
  }

  private async advance(w: Workflow) {
    if (this.stopped || w.status !== "active" || w.generalTransition) return;
    try {
      if (w.inbox) await this.consumeInbox(w);
      if (w.status !== "active") {
        await this.save();
        return;
      }
      await this.prepareMember(w, "plan");
      await this.prepareMember(w, "execute");
      if (w.reviewSelection.enabled && w.planReview.stage !== "done") await this.prepareMember(w, "reviewer");
      await this.deliver(w);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      await this.recovery.recordTransient(w, w.pending?.role ?? this.floor(w), failure, "error");
      w.status = "error";
      this.touch(w, failure);
      this.recovery.describeTransient(w, failure);
      await this.save();
    }
  }
  private async prepareMember(w: Workflow, role: "plan" | "execute" | "reviewer") {
    const member = w[role];
    if (!member) return;
    const snapshot = member.workspaceId ? await this.port.inspect(member.id) : null;
    if (await this.compaction.prepareCompaction(w, member, snapshot, role === "plan" ? "계획" : "실행")) return;
    const current = w[role]!;
    if (!current.workspaceId) {
      if (role === "reviewer") {
        current.config.modeId = await this.planReviewGate.validate(w, w.reviewSelection);
      }
      if (role === "execute" && capabilities(w).executorSelection) {
        await this.executorChoice.restoreExecutor(w);
        if (w.status !== "active") return;
      }
      await this.ensureNumber(w);
      if (role === "execute") {
        const blocker = w.placement || (w.isolation === "undecided" && capabilities(w).executorSelection && (current.generation === 1 || w.worktreeHistory.length > 0))
          ? await this.placementBlocker(w) : null;
        if (await placeExecutor(w, this.probe, this.port, await this.settings(), blocker)) await this.save();
        if (w.placement) {
          if (blocker) {
            w.placement.number = blocker.number;
            w.placement.title = blocker.title;
            const detail = w.placement.stage === "choice"
              ? `구현 시작 방법 선택을 기다립니다: 같은 폴더에서 #${blocker.number} 작업이 진행 중입니다.`
              : `같은 폴더의 #${blocker.number} ${blocker.title} 작업이 끝나면 #${w.number} 구현을 자동으로 시작합니다.`;
            const explained = detail + (w.placement.reason ? ` ${w.placement.reason}` : "") +
              " 그 작업을 완료 표시하거나 보관하면 바로 시작합니다.";
            if (w.detail !== explained) this.touch(w, explained);
            await this.save();
            if (w.placement.stage === "choice" && w.plan && !w.placement.cardPosted && this.port.placementPicker) {
              try {
                await this.port.placementPicker(w.plan.id, w.id, { number: blocker.number, title: blocker.title }, w.worktreeHistory.length ? current.generation : undefined);
                w.placement.cardPosted = true;
                await this.save();
              } catch {
                // A timeline failure leaves the choice pending and retries on the next tick.
              }
            }
            return;
          }
          w.placement = null;
          await this.save();
        }
      }
      current.workspaceId = await this.port.create(
        w,
        role,
        current,
        (await this.settings()).titleMarker,
      );
      if (!(role === "execute" && w.isolation === "worktree") && w.startPin && !w.startPin.workspaces.some((row) => row.id === current.workspaceId))
        w.startPin.workspaces.push({
          id: current.workspaceId,
          phase: "queued",
          ownedPinAt: null,
        });
      await this.save();
    }
  }
  private async deliver(w: Workflow) {
    if ([w.plan, w.execute, w.reviewer].some(m => m?.compaction)) return;
    const pending = w.pending;
    if (!pending || pending.stage === "sent" || w.status !== "active") return;
    if (pending.role === "reviewer") {
      if (w.planReview.stage === "done" || !w.reviewSelection.enabled) return;
      const mode = await this.planReviewGate.validate(w, w.reviewSelection);
      if (w.reviewer?.config.modeId !== mode) throw new Error("검증 대화의 읽기 전용 모드가 바뀌었습니다.");
    }
    const member = w[pending.role];
    if (!member) throw new Error("다음 담당 대화가 없습니다.");
    if (!member.workspaceId) return;
    const snapshot = await this.port.inspect(member.id);
    if (!snapshot || snapshot.archived) throw new Error("다음 담당 대화를 사용할 수 없습니다.");
    if (pending.role === "reviewer" && snapshot.config?.modeId && snapshot.config.modeId !== member.config.modeId)
      throw new Error("검증 대화의 실제 읽기 전용 모드가 바뀌었습니다.");
    if (pending.stage === "sending") return this.confirmDelivery(pending, member);
    if (!this.receptive(snapshot)) return;
    if (w.turns >= (await this.settings()).maxTurns) {
      w.status = "paused";
      this.touch(w, this.limitDetail(w));
      await this.save();
      return;
    }
    if (pending.role === "execute" && !(await this.clearToExecute(w, pending))) return;
    pending.rememberedThrough = w.memorySequence;
    pending.stage = "sending";
    w.turns++;
    await this.save();
    await this.port.send(
      member.id,
      (await this.context(w, member)) + "\n이번 지시:\n" + pending.prompt,
      pending.id,
    );
    pending.stage = "sent";
    member.rememberedThrough = pending.rememberedThrough;
    const descriptions = {
      plan: "계획 담당이 계획을 작성하고 있습니다.",
      execute: "실행 담당이 계획을 실행하고 있습니다.",
      review: "계획 담당이 구현 결과를 검토하고 있습니다.",
    };
    // A note to the planner during the executor's phase is not the executor working.
    const answering = pending.role === "plan" && pending.phase === "execute";
    this.touch(
      w,
      pending.role === "reviewer" ? `${w.planReview.error ? w.planReview.error + "\n" : ""}계획 검증 중 (${w.planReview.round}/${w.planReview.maxRounds})` : answering ? "계획 담당이 답변을 처리하고 있습니다." : descriptions[pending.phase],
    );
    await this.save();
  }
  /**
   * The user's explicit retry after a failed send. Only a quiet conversation whose history
   * lacks the message is sent again, under the same message ID; a delivered one just resumes.
   */
  private async resend(w: Workflow) {
    const pending = w.pending;
    if (!pending || pending.stage !== "sending" || w.status === "active")
      throw new Error("다시 보낼 미확인 전달이 없습니다.");
    const member = w[pending.role];
    if (!member) throw new Error("다음 담당 대화가 없습니다.");
    const snapshot = await this.port.inspect(member.id);
    if (!snapshot || snapshot.archived) throw new Error("다음 담당 대화를 사용할 수 없습니다.");
    if (!this.receptive(snapshot))
      throw new Error("담당 대화가 아직 응답 중입니다. 응답이 끝난 뒤 다시 확인하세요.");
    const history = await this.port.history(member.id, pending.id);
    if (!history.messageIds.includes(pending.id)) {
      pending.stage = "queued";
      w.turns = Math.max(0, w.turns - 1);
    }
    await this.resume(w, "");
  }
  /** A send that may or may not have arrived is settled from the conversation, never resent. */
  private async confirmDelivery(pending: Pending, member: Member) {
    const history = await this.port.history(member.id, pending.id);
    if (!history.messageIds.includes(pending.id))
      throw new Error(
        "이전 메시지의 전달 여부를 확인할 수 없습니다. 중복 실행을 막기 위해 정지했습니다. 대화에서 전달 내역을 확인하세요.",
      );
    pending.stage = "sent";
    member.rememberedThrough = pending.rememberedThrough ?? member.rememberedThrough;
    await this.save();
  }
  /** Whether the conversation can take a message now; throws when it needs the user first. */
  private receptive(snapshot: Snapshot): boolean {
    if (!this.quiet(snapshot)) return false;
    // Sending with a message ID lets the daemon reload a closed conversation.
    if (snapshot.status !== "idle" && snapshot.status !== "closed")
      throw new Error("담당 대화에 오류가 있습니다. 대화를 확인한 뒤 재개하세요.");
    return true;
  }
  /** False while another flow writes in the folder; otherwise marks where this run starts. */
  private async clearToExecute(w: Workflow, pending: Pending): Promise<boolean> {
    const busy = await this.busyWriter(w);
    if (busy) {
      // Unchanged text must not move updatedAt, or every tick would rewrite the state file.
      const waiting = `같은 저장소의 다른 작업 #${busy.number} ${busy.title} 진행 후 #${w.number} ${w.title} 진행 예정입니다. 해당 대화의 응답이 끝나면 자동 전달합니다.`;
      w.conflict = waiting;
      if (w.writerWait?.blocker !== busy.number) this.pendingTitles.add(w.id);
      w.writerWait = { key: `${pending.id}:${busy.id}`, text: waiting, blocker: busy.number };
      if (w.detail !== waiting && !this.asking.has(w.id)) this.touch(w, waiting);
      return false;
    }
    w.conflict = "";
    if (w.writerWait) {
      w.writerWait = null;
      this.pendingTitles.add(w.id);
    }
    // The baseline belongs to the plan; follow-up messages to the executor keep it.
    if (pending.instruction) {
      w.repositoryBaselines = await Promise.all(
        w.repositories.map(async (cwd) => ({
          cwd,
          snapshot: baselineSchema
            .nullable()
            .parse((await this.probe?.snapshot(cwd).catch(() => null)) ?? null),
        })),
      );
      w.baseline = w.repositories.length
        ? null
        : baselineSchema
            .nullable()
            .parse((await this.probe?.snapshot(workFolder(w)).catch(() => null)) ?? null);
    }
    return true;
  }
  /** Unlike busyWriter, an unfinished writer between turns still owns this folder. */
  private async placementBlocker(w: Workflow): Promise<Workflow | null> {
    const scopes = await this.scopes(w);
    for (const other of (await this.db()).workflows) {
      const writer = this.writer(other);
      if (other.id === w.id || !writer?.workspaceId || other.status === "completed" || isFinished(other)) continue;
      const snapshot = await this.port.inspect(writer.id);
      if (!snapshot || snapshot.archived) continue;
      const others = await this.scopes(other);
      if (scopes.some(left => others.some(right => pathsOverlap(left, right)))) return other;
    }
    return null;
  }
  private async busyWriter(w: Workflow): Promise<Workflow | null> {
    const scopes = await this.scopes(w);
    for (const other of (await this.db()).workflows) {
      const writer = this.writer(other);
      if (other.id === w.id || !writer?.workspaceId) continue;
      const active = await this.port.inspect(writer.id);
      if (
        !active ||
        active.archived ||
        (!active.permission && active.status !== "running" && active.status !== "initializing")
      )
        continue;
      const others = await this.scopes(other);
      if (scopes.some((left) => others.some((right) => pathsOverlap(left, right)))) return other;
    }
    return null;
  }
  private writer(w: Workflow) {
    const member = automates(w) ? w.execute : w.plan;
    return member?.config.modeId === "plan" || member?.config.modeId === "read-only"
      ? null
      : member;
  }
  private scopes(w: Workflow) {
    const folders =
      w.isolation === "worktree" && w.worktree && this.writer(w) === w.execute
        ? [w.worktree.path]
        : w.repositories.length
          ? w.repositories
          : [w.cwd];
    return Promise.all(
      folders.map((folder) => {
        let resolved = this.scopeCache.get(folder);
        if (!resolved) {
          resolved = (async () =>
            (await this.probe?.repository?.(folder).catch(() => null)) ??
            (await resolvedFolder(folder)))();
          this.scopeCache.set(folder, resolved);
        }
        return resolved;
      }),
    );
  }
  started(agentId: string) {
    return this.serial(async () => {
      const w = (await this.db()).workflows.find(
        (entry) => memberRole(entry, agentId) !== null,
      );
      if (!w) return;
      this.pushAudit.invalidatePushAudit(w);
      // A later user turn supersedes the deferred colour change, even before it replies.
      w.pushRetry = null;
      const automatic =
        w.status === "active" &&
        w.pending &&
        w.pending.stage !== "queued" &&
        w[w.pending.role]?.id === agentId;
      if (!automatic) w.transientPause = null;
      if (w?.mode === "general" && w.generalDelivery?.stage === "uncertain") {
        w.generalDelivery = null;
        w.status = "active";
        this.touch(w, "일반개발 대화에서 직접 이어가고 있습니다.");
      }
      this.scopeCache.clear();
      await this.refreshConflicts(agentId);
      await this.save();
    });
  }
  /** Ordinary turns cannot be blocked by this API; show their overlap and delay automated writes. */
  private async refreshConflicts(starting = "") {
    const active: Workflow[] = [];
    for (const w of (await this.db()).workflows) {
      w.conflict = "";
      const member = this.writer(w);
      if (!member) continue;
      const snapshot = await this.port.inspect(member.id).catch(() => null);
      if (
        snapshot &&
        !snapshot.archived &&
        (member.id === starting ||
          snapshot.permission ||
          snapshot.status === "running" ||
          snapshot.status === "initializing")
      )
        active.push(w);
    }
    for (let i = 0; i < active.length; i++) {
      const left = active[i];
      const scopes = await this.scopes(left);
      for (const right of active.slice(i + 1)) {
        const others = await this.scopes(right);
        if (!scopes.some((a) => others.some((b) => pathsOverlap(a, b)))) continue;
        left.conflict = `같은 저장소에서 #${right.number} ${right.title} 작업이 실행 중입니다. 동시 수정을 피하거나 별도 worktree를 사용하세요.`;
        right.conflict = `같은 저장소에서 #${left.number} ${left.title} 작업이 실행 중입니다. 동시 수정을 피하거나 별도 worktree를 사용하세요.`;
      }
    }
  }
  private async evidence(w: Workflow): Promise<string> {
    if (!this.probe) return "";
    if (w.repositoryBaselines.length) {
      const sections = await Promise.all(
        w.repositoryBaselines.map(async (item) => {
          const text = item.snapshot
            ? await this.probe!.changes(item.cwd, item.snapshot).catch(() => "")
            : "";
          return `저장소: ${item.cwd}\n${text || "변경 증거 수집 실패. 이 저장소는 직접 확인하세요."}`;
        }),
      );
      return `\n\n${sections.join("\n\n")}`;
    }
    if (!w.baseline) return "";
    try {
      const text = await this.probe.changes(workFolder(w), w.baseline);
      return text ? `\n\n${text}` : "";
    } catch {
      return "";
    }
  }
  /** Drops a turn that changes nothing, such as the user chatting beside queued work. */
  private setAside(w: Workflow, inbox: Inbox) {
    this.seen(w, inbox.key);
    w.inbox = null;
    if (inbox.resumed) this.keepWaiting(w);
  }
  /** Puts back a wait that a turn briefly lifted, without announcing the stop a second time. */
  private keepWaiting(w: Workflow) {
    w.status = "needs_input";
    w.notifiedStatus = "needs_input";
  }
  private recordCompaction(member: Member, inbox: Inbox) {
    if (inbox.compacted) member.compactedForTurn = inbox.key;
  }
  private remember(w: Workflow, items: string[]) {
    for (const item of items) {
      const text = item.replace(/\s+/g, " ").trim();
      if (!text || w.memories.some((memory) => memory.text === text)) continue;
      w.constraints[`remember:${createHash("sha256").update(text).digest("hex")}`] = text;
      w.memories.push({ sequence: ++w.memorySequence, text });
      if (w.memories.length > 50) w.memories.shift();
    }
    // Every full context repeats these; keep the newest 100 so a long flow stays bounded.
    const remembered = Object.keys(w.constraints).filter((key) => key.startsWith("remember:"));
    for (const key of remembered.slice(0, Math.max(0, remembered.length - 100)))
      delete w.constraints[key];
  }
  private assignmentError(w: Workflow, role: Role, d: Decision): string | null {
    if (role === "reviewer") {
      if (!["result", "input"].includes(d.status) || (d.status === "result" && !d.planReview))
        return "assignmentError: 계획 검증 담당은 result(planReview 필수) 또는 input만 반환할 수 있습니다.";
      if (w.planReview.stage === "done" || (!w.reviewSelection.enabled && w.planReview.stage !== "off"))
        return "assignmentError: 이 계획 검증은 종료됐습니다.";
      return null;
    }
    if (d.planReview) return "assignmentError: planReview는 계획 검증 담당만 사용할 수 있습니다.";
    if (
      (d.status === "plan" && role !== "plan") ||
      (d.status === "result" && role !== "execute") ||
      (d.status === "complete" && role === "execute" && w.plan)
    )
      return "담당 역할과 완료 상태가 맞지 않습니다. 대화 내용을 확인하세요.";
    if (
      d.status === "plan" &&
      !w.execute &&
      d.executorModel &&
      d.executorModel.split("/")[0] !== this.executorChoice.executorProvider(w)
    )
      return `실행 모델은 ${this.executorChoice.executorProvider(w)} 제공자여야 합니다.`;
    return null;
  }
  private async consume(w: Workflow) {
    const inbox = w.inbox!;
    const role = memberRole(w, inbox.agentId);
    if (!role) { w.inbox = null; return; }
    if (role === "reviewer" && w.reviewSelection.enabled === false) {
      if (w.pending?.role === "reviewer") w.pending = null;
      this.seen(w, inbox.key); w.inbox = null; w.planReview.stage = "off";
      this.planReviewGate.restore(w); await this.save(); return;
    }
    const side =
      !inbox.answers && inbox.failed === null ? this.sideDecision(w, role, inbox.text) : null;
    if (side?.status === "note" && !(role === "plan" && w.planReview.stage === "revising")) {
      this.remember(w, side.remember);
      this.setAside(w, inbox);
    } else if (inbox.answers) await this.answered(w, role, inbox);
    else if (w.pending) await this.beside(w, role, inbox, w.pending);
    else await this.driven(w, role, inbox);
    await this.save();
  }
  /** The reply to a delivered instruction. Whatever it says, that instruction is over. */
  private async answered(w: Workflow, role: Role, inbox: Inbox) {
    if (inbox.failed !== null) await this.recovery.quotaFailure(w, role, inbox);
    const pending = w.pending;
    w.pending = null;
    w.planIssue = null;
    w.asker = null;
    if (inbox.failed !== null) {
      this.seen(w, inbox.key);
      w.inbox = null;
      if (!inbox.canceled) await this.recovery.recordTransient(w, role, inbox.failed, "turn");
      if (w.transientPause && w.transientPause.attempts < 5) {
        this.queue(
          w,
          role,
          pending?.prompt ?? CONTINUE,
          pending?.phase ?? w.phase,
          pending?.instruction,
        );
        w.pending!.retry = true;
      }
      // A turn the user stopped is picked up by their next message; a failure waits for a resume.
      w.status = inbox.canceled ? "needs_input" : "paused";
      this.touch(
        w,
        inbox.canceled
          ? "응답이 중단되었습니다. 대화에서 직접 이어가거나 재개하세요."
          : `응답 중단: ${inbox.failed}. 대화를 확인하고 재개하세요.`,
      );
      this.recovery.describeTransient(w);
      return;
    }
    const d = this.read(w, role, inbox, true);
    if (d) await this.act(w, role, d, this.record(w, role, d, inbox), inbox);
  }
  /** Nothing is outstanding, so the conversation the user is in moves the flow. */
  private async driven(w: Workflow, role: Role, inbox: Inbox) {
    if (inbox.canceled) w.quotaPause = null;
    // A stopped turn decides nothing, and the executor has the floor only in its own phase.
    if (inbox.canceled || (role === "execute" && this.floor(w) !== "execute"))
      return this.setAside(w, inbox);
    if (inbox.failed !== null) {
      await this.recovery.quotaFailure(w, role, inbox);
      this.seen(w, inbox.key);
      w.inbox = null;
      await this.recovery.recordTransient(w, role, inbox.failed, "turn");
      if (w.transientPause && w.transientPause.attempts < 5) this.queue(w, role, CONTINUE, w.phase);
      w.status = "paused";
      this.touch(w, `응답 중단: ${inbox.failed}. 대화를 확인하고 재개하세요.`);
      this.recovery.describeTransient(w);
      return;
    }
    // While the flow waits for the user, a turn that decides nothing leaves that wait as it is.
    if (inbox.resumed && !this.sideDecision(w, role, inbox.text)) return this.setAside(w, inbox);
    const d = this.read(w, role, inbox, false);
    if (d) await this.act(w, role, d, this.record(w, role, d, inbox), inbox);
  }
  /**
   * The user spoke to a conversation while an instruction was queued or running. That
   * instruction stands; only the planner can change work addressed to the executor.
   */
  private async beside(w: Workflow, role: Role, inbox: Inbox, pending: Pending) {
    const d = inbox.failed === null ? this.sideDecision(w, role, inbox.text) : null;
    // The user carried a failed instruction on in its own conversation. That turn answers it,
    // and the queued resend would only repeat the work.
    if (d && pending.retry && pending.stage === "queued" && pending.role === role) {
      w.pending = null;
      w.transientPause = null;
      w.status = "active";
      await this.act(w, role, d, this.record(w, role, d, inbox), inbox);
      return;
    }
    if (d?.status === "plan" && role === "plan" && pending.role === "plan" &&
        pending.stage !== "queued") {
      const reason = "계획 응답의 전달 연관성을 확인하지 못했습니다. 응답을 보존했습니다. 원 대화의 수신 내역을 확인한 뒤 재개하면 같은 응답의 이력을 다시 조회합니다.";
      if (!w.planIssue) w.planIssue = { response: inbox, pendingId: pending.id, reason };
      w.inbox = null;
      w.status = "needs_input";
      this.touch(w, reason);
      return;
    }
    if (d?.status === "plan" && role === "plan" && pending.role === "execute" &&
        (pending.stage !== "queued" || (w.planConflict && w.planConflict.stage !== "resolved")) && d.next !== w.lastInstruction) {
      const reason = "실행 중인 지시와 새 계획이 충돌합니다. 새 계획은 적용하지 않았습니다. 기존 실행의 결과를 먼저 검토한 뒤 계획 담당이 재확정해야 합니다.";
      if (!w.planConflict || w.planConflict.stage === "resolved") {
        w.planConflict = { pendingId: pending.id, agentId: inbox.agentId, key: inbox.key,
          text: inbox.text, next: d.next, reason, stage: "executing" };
      } else if (w.planConflict.key !== inbox.key) {
        w.planConflict.rejected = { key: inbox.key, next: d.next,
          reason: "미처리 계획 충돌이 있어 추가 계획을 거부했습니다. 최초 보존 계획은 유지합니다." };
      }
      this.seen(w, inbox.key);
      w.inbox = null;
      this.touch(w, w.planConflict.rejected?.reason ?? reason);
      return;
    }
    const report = d ? this.absorb(w, d, inbox) : "";
    if (!d) {
      this.seen(w, inbox.key);
      w.inbox = null;
    }
    const moved =
      d && role === "plan" && pending.role === "execute"
        ? await this.overrule(w, d, report, inbox, pending)
        : false;
    if (!moved && inbox.resumed) this.keepWaiting(w);
  }
  /** What a planner's side decision does to work addressed to the executor; false if nothing. */
  private async overrule(
    w: Workflow,
    d: Decision,
    report: string,
    inbox: Inbox,
    pending: Pending,
  ): Promise<boolean> {
    const queued = pending.stage === "queued";
    // Repeating the plan that is already out is not a new plan.
    const revised = d.status === "plan" && d.next !== w.lastInstruction;
    if (d.status === "complete") {
      w.pending = null;
      await this.complete(w, d, "plan");
    } else if (revised && queued) {
      w.pending = null;
      await this.plan(w, d, report, inbox, pending.instruction);
    } else if (d.status === "input" && queued) {
      // The instruction is parked rather than left queued, so an answer can reach the planner.
      w.held = pending;
      w.pending = null;
      w.status = "needs_input";
      w.asker = "plan";
      this.touch(w, (d.next || d.summary) + HELD);
    } else if (d.status === "continue" || (d.status === "plan" && !revised)) {
      // The planner said to go on, so what is queued goes out.
      w.asker = null;
    } else return false;
    return true;
  }
  private sideDecision(w: Workflow, role: Role, text: string): Decision | null {
    try {
      const d = parseDecision(text);
      return this.assignmentError(w, role, d) ? null : d;
    } catch {
      return null;
    }
  }
  /** Returns the turn's decision, or settles why there is none and returns null. */
  private read(w: Workflow, role: Role, inbox: Inbox, repairable: boolean): Decision | null {
    let problem: string;
    // A malformed block cannot erase a read-only violation via the formatting repair turn.
    if (role === "reviewer" && w.reviewSelection.enabled && inbox.reviewerViolation) {
      w.status = "needs_input"; w.asker = "reviewer";
      w.planReview.error = inbox.reviewerViolation; this.touch(w, inbox.reviewerViolation);
      this.seen(w, inbox.key); w.inbox = null; return null;
    }
    try {
      const d = parseDecision(inbox.text);
      const invalid = this.assignmentError(w, role, d) ?? (
        inbox.answers && d.status === "note" && !(role === "plan" && w.planReview.stage === "revising")
          ? "전달한 지시에는 note로 답할 수 없습니다. 담당 역할의 작업 결과를 확인하세요." : null);
      if (!invalid) {
        if (role === "reviewer" && d.planReview && w.reviewSelection.enabled &&
            (d.planReview.planHash !== w.heldApproval?.decisionHash || inbox.reviewerViolation)) {
          w.status = "needs_input"; w.asker = "reviewer";
          w.planReview.error = inbox.reviewerViolation || "검증 planHash가 현재 보관 계획과 다릅니다.";
          this.touch(w, w.planReview.error); this.seen(w, inbox.key); w.inbox = null;
          return null;
        }
        return d;
      }
      problem = invalid;
      if (repairable && w.repairs === 0 && (role === "reviewer" || d.planReview)) {
        if (role === "reviewer" || d.planReview) w.planReview.error = invalid;
        w.repairs++; this.seen(w, inbox.key); w.inbox = null;
        this.queue(w, role, `${invalid} ${REPAIR}`, w.phase);
        this.touch(w, invalid + " 상태 블록을 한 번 보정 요청합니다.");
        return null;
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
      if (repairable && w.repairs === 0) {
        // Ask once for the block, naming what was wrong with it, before stopping for the user.
        w.repairs++;
        this.seen(w, inbox.key);
        w.inbox = null;
        const reason = error instanceof DecisionError ? error.reason : "형식 오류";
        this.queue(
          w,
          role,
          `직전 응답 끝에서 작업 상태 블록을 읽지 못했습니다(${reason}). ${REPAIR}`,
          w.phase,
        );
        this.touch(w, "응답 끝의 작업 상태가 없어 한 번 다시 요청합니다.");
        return null;
      }
    }
    this.seen(w, inbox.key);
    w.inbox = null;
    w.repairs = 0;
    w.status = "needs_input";
    if (role === "reviewer") w.asker = "reviewer";
    this.touch(w, problem);
    return null;
  }
  /** Keeps what a side turn established without moving the flow, and returns its report. */
  private absorb(w: Workflow, d: Decision, inbox: Inbox): string {
    this.remember(w, d.remember);
    const role = memberRole(w, inbox.agentId);
    const member = role ? w[role] : null;
    // A compaction during the side turn means the next delivery owes the full context again.
    if (inbox.compacted && member) member.compactedForTurn = member.lastTurnKey;
    const report = `${d.summary}\n${d.handoff}\n검증:\n${d.checks.join("\n")}`;
    if (d.status === "result" && !d.planReview) w.lastResult = report;
    this.seen(w, inbox.key);
    w.inbox = null;
    return report;
  }
  /** Stores what a turn on the main line reported and returns it as the other role reads it. */
  private record(w: Workflow, role: Role, d: Decision, inbox: Inbox): string {
    if (w.quotaPause?.role === role) w.quotaPause = null;
    w.transientPause = null;
    this.remember(w, d.remember);
    this.recordCompaction(w[role]!, inbox);
    w[role]!.handoff = d.handoff;
    w[role]!.lastTurnKey = inbox.key;
    const report = `${d.summary}\n${d.handoff}\n검증:\n${d.checks.join("\n")}`;
    this.seen(w, inbox.key);
    w.inbox = null;
    w.repairs = 0;
    if (role === "plan" && d.status !== "complete") w.completeRepairs = 0;
    w.asker = null;
    this.touch(w, d.summary);
    if (d.status === "result" && !d.planReview) w.lastResult = report;
    return report;
  }
  private async act(w: Workflow, role: Role, d: Decision, report: string, inbox: Inbox) {
    if (await this.planReviewGate.receive(w, role, d)) return;
    if (role === "plan" && d.status === "plan" && w.planConflict &&
        w.planConflict.stage !== "resolved") {
      // The instruction the conflict waited on is over without its result reaching review,
      // so nothing else would deliver one. Send the review now instead of waiting for good.
      if (w.planConflict.stage === "executing" && w.pending?.role !== "execute") {
        await this.reviewConflict(w);
        return;
      }
      if (w.planConflict.stage !== "review" || !inbox.answers) {
        w.status = "needs_input";
        this.touch(w, "기존 실행 결과와 보존된 충돌 계획을 먼저 검토해야 새 계획을 실행할 수 있습니다.");
        return;
      }
      w.planConflict.stage = "resolved";
      w.planConflict.confirmedKey = inbox.key;
    }
    if (d.status === "input") {
      w.status = "needs_input";
      w.asker = role;
      this.touch(w, (d.next || d.summary) + (w.held ? HELD : ""));
      return;
    }
    // Only the planner settles what happens to an instruction it parked.
    const held = role === "plan" ? w.held : null;
    if (held) w.held = null;
    const proceeds =
      d.status === "continue" || (d.status === "plan" && d.next === w.lastInstruction);
    if (d.status === "complete") await this.complete(w, d, role);
    else if (held && proceeds) w.pending = held;
    else if (d.status === "continue") this.queue(w, role, d.next, w.phase);
    else if (d.status === "plan") await this.plan(w, d, report, inbox, !!held?.instruction);
    else if (w.plan) await this.reviewConflict(w);
    else w.status = "completed";
  }
  /** Queues the planner's review, carrying any plan held back while the result was pending. */
  private async reviewConflict(w: Workflow) {
    let conflict = "";
    if (w.planConflict && w.planConflict.stage !== "resolved") {
      w.planConflict.stage = "review";
      conflict = `\n\n적용하지 않은 새 계획(응답 ${w.planConflict.key}):\n${w.planConflict.next}\n${w.planConflict.reason}\n기존 결과와 함께 검토하고 실행할 지시를 plan으로 재확정하세요.`;
    }
    const folder = w.planReview.path ? path.dirname(w.planReview.path)
      : planDocumentFolder(w.id, { next: w.lastInstruction, handoff: w.plan?.handoff ?? "" });
    const instruction = w.contract >= 7 ? REVIEW.replace("작업 문서 폴더에 verdict.md", path.join(folder, "verdict.md")) : REVIEW;
    this.queue(w, "plan", instruction + (await this.evidence(w)) + conflict, "review");
  }
  private async complete(w: Workflow, d: Decision, role: Role) {
    if (automates(w) && w.contract >= 2 && role === "plan") {
      let problem = await verdictProblem(w.cwd, d.verdict);
      if (
        !problem && w.contract >= 3 && w.plan && w.execute &&
        w.plan.config.provider === w.execute.config.provider &&
        d.verdict?.condition !== "단일 모델"
      ) problem = "같은 모델의 별도 대화 검증은 단일 모델로 보고해야 합니다.";
      w.verdict = d.verdict ? { ...d.verdict, recordedAt: new Date().toISOString() } : null;
      w.verdictIssue = problem;
      if (problem && w.completeRepairs === 0) {
        w.completeRepairs++;
        this.queue(w, "plan", VERDICT_REPAIR.replace("<사유>", problem), w.phase);
        this.touch(w, `완료 판정 정보를 한 번 다시 요청합니다: ${problem}`);
        return;
      }
      if (problem) {
        this.touch(w, problem === "판정 없음" ? problem : `판정 불일치: ${problem}`);
        if (w.contract >= 3) {
          w.status = "needs_input";
          w.asker = "plan";
          return;
        }
      }
    }
    w.completeRepairs = 0;
    w.quotaPause = null;
    w.transientPause = null;
    w.status = "completed";
    w.asker = null;
    w.held = null;
    if (w.progress !== "pushed" && w.progress !== "no_push") {
      w.progress = w.contract >= 3 && parseProgress(`${d.summary}\n${d.handoff}`) === "no_push"
        ? this.noPushProgress(w) : "done";
    }
  }
  private async consumeInbox(w: Workflow) {
    const progress = w.progress;
    await this.consume(w);
    if (w.progress !== progress && (await this.settings()).titleMarker)
      await this.renameWorkspaces(w, true);
  }
  private async reassessRepeatedPlan(w: Workflow, d: Decision): Promise<boolean> {
    if (this.probe && w.lastResult) {
      const snapshots = await Promise.all(
        (w.repositories.length ? w.repositories : [w.cwd]).map((cwd) =>
          this.probe!.snapshot(cwd).catch(() => null),
        ),
      );
      const fingerprint =
        snapshots.every((snapshot) => snapshot && !snapshot.incomplete) && w.lastResult
          ? createHash("sha256")
              .update(JSON.stringify([snapshots, d.next, w.lastResult]))
              .digest("hex")
          : "";
      w.repeatedPlans = fingerprint && fingerprint === w.planFingerprint ? w.repeatedPlans + 1 : 0;
      w.planFingerprint = fingerprint;
      if (w.repeatedPlans === 2) {
        this.queue(
          w,
          "plan",
          "같은 실행 지시와 결과가 반복되며 저장소 상태도 바뀌지 않았습니다. 동일 지시를 다시 보내기 전에 원인과 기존 검증 증거를 재검토하세요. 새 근거가 있는 수정 계획은 plan, 완료 조건 충족은 complete, 외부 변화나 사용자 답변이 꼭 필요하면 input으로 보고하세요.",
          "review",
        );
        this.touch(w, "변경 없이 같은 지시·결과가 반복되어 계획 담당이 원인을 다시 검토합니다.");
        return true;
      }
      if (w.repeatedPlans > 2) {
        w.status = "needs_input";
        w.asker = "plan";
        this.touch(
          w,
          "원인 재검토 후에도 같은 지시와 결과가 반복됩니다. 새 근거나 추가 지시와 함께 재개하세요.",
        );
        return true;
      }
    }
    return false;
  }
  private async plan(
    w: Workflow,
    d: Decision,
    report: string,
    inbox: NonNullable<Workflow["inbox"]>,
    replaces: boolean,
  ) {
    const settings = await this.startSettings(w.cwd, w.plan?.config.provider ?? "claude");
    if (this.firstPlan(w) && w.heldApproval?.inboxKey !== inbox.key) {
      this.invalidateApproval(w);
      w.heldApproval = { id: ++w.holdSeq, inboxKey: inbox.key, decisionHash: decisionHash(d), summary: d.summary, handoff: d.handoff, at: new Date().toISOString() };
    }
    if (await this.planReviewGate.hold(w, inbox, d)) return;
    if (capabilities(w).executorSelection && !(await this.executorChoice.selectionReady(w))) {
      if (capabilities(w).screenSelection) {
        // Like the cycle limit, keep the plan unread so the screen choice dispatches it once.
        if (w.processed.at(-1) === inbox.key) w.processed.pop();
        w.inbox = inbox;
        w.selectionPlan = inbox.key;
        await this.save();
      }
      return;
    }
    if (splitGeneral(w) && (!w.generalState.settled || !w.generalState.selected)) {
      w.status = "needs_input";
      w.asker = "plan";
      this.touch(w, "구현 담당이 정해지지 않았습니다. 구현 에이전트·모델·추론을 선택한 뒤 인계하세요.");
      return;
    }
    if (!replaces && (await this.reassessRepeatedPlan(w, d))) return;
    if (!replaces && w.cycles >= settings.maxCycles) {
      // Keep the plan as inbox so raising the limit and resuming dispatches it.
      w.processed.pop();
      w.inbox = inbox;
      w.limitPlan = inbox.key;
      w.status = "paused";
      this.touch(w, this.limitDetail(w));
    } else {
      if (!replaces) w.cycles++;
      const hadManagedPush = !!w.managedPush;
      this.newPushPhase(w);
      this.invalidatePush(w, "active");
      w.progress = "active";
      if (hadManagedPush) await this.renameWorkspaces(w, settings.titleMarker);
      if (w.contract >= 3) {
        w.verdict = null;
        w.verdictIssue = "";
        w.completeRepairs = 0;
      }
      w.lastPlan = report;
      w.lastInstruction = d.next;
      let generation = 1;
      // A user may have archived the executor directly; only a confirmed missing path
      // permits replacing that worktree. Unknown filesystem/API state preserves it.
      const manuallyCleaned = await this.worktreeCleanup.manuallyArchived(w);
      if ((w.worktreeCleanup?.stage === "done" || manuallyCleaned) && w.worktree) {
        generation = (w.execute?.generation ?? 0) + 1;
        w.worktreeHistory.push(w.worktree);
        if (w.execute) w.history.push(w.execute.id);
        w.execute = null;
        w.worktree = null;
        w.isolation = "undecided";
        w.placement = null;
        w.integration = null;
      }
      // Every new implementation cycle gets a fresh cleanup budget/checkpoint.
      w.worktreeCleanup = null;
      if (!w.execute) {
        const defaults = executorDefaults(settings, this.executorChoice.executorProvider(w));
        const selected = this.executorChoice.selectedExecutor(w);
        const model = selected
          ? (selected.model ? `${selected.provider}/${selected.model}` : selected.provider)
          : d.executorModel ?? defaults.model;
        const thinking = selected
          ? selected.thinking
          : d.executorThinking ?? (model === defaults.model ? defaults.thinking : "");
        w.execute = {
          id: randomUUID(),
          workspaceId: null,
          generation,
          config: {
            provider: model,
            ...(thinking ? { thinkingOptionId: thinking } : {}),
            modeId: defaults.mode,
          },
          env: {},
          usage: null,
          lastTurnKey: "",
          compactedForTurn: "",
          compaction: null,
          compactionTurnKey: "",
          compactionError: "",
          compactions: 0,
          handoff: "",
          rememberedThrough: 0,
        };
        await this.rememberProject(w, true);
      }
      const note = w.resumeNote;
      w.limitPlan = "";
      w.selectionPlan = "";
      w.heldApproval = null;
      if (capabilities(w).planReview && w.planReview.stage !== "done") {
        w.planReview.outcome = w.reviewSelection.enabled ? (w.planReview.stage === "passed" ? "passed" : "unverified_approved") : "off";
        w.planReview.stage = "done"; w.reviewPlan = null;
      }
      w.resumeNote = "";
      this.queue(w, "execute", note ? `${d.next}\n\n${note}` : d.next, "execute", true);
    }
  }
}
