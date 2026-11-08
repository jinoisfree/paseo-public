import { executorSelectionSchema } from "./executor-selection";
import { planConflictSchema } from "./plan-disposition";
import { generalAgentSchema } from "./general-agent";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  repositoryPathsSchema,
  pushTargetsSchema,
  verificationRecordSchema,
  verdictViewSchema,
} from "./artifacts";
import { managedPushSchema } from "./managed-push";

import { settingsValuesSchema } from "./settings-schema";
import { recommendedSettings } from "./recommended";

export const settingsSchema = z.object({
  folderRoots: settingsValuesSchema.shape.folderRoots.default(recommendedSettings.folderRoots),
  autoPinStarted: settingsValuesSchema.shape.autoPinStarted.default(recommendedSettings.autoPinStarted),
  autoPinPushed: settingsValuesSchema.shape.autoPinPushed.default(recommendedSettings.autoPinPushed),
  autoArchivePushed: settingsValuesSchema.shape.autoArchivePushed.default(recommendedSettings.autoArchivePushed),
  autoArchiveWorktree: settingsValuesSchema.shape.autoArchiveWorktree.default(recommendedSettings.autoArchiveWorktree),
  archiveAfterDays: settingsValuesSchema.shape.archiveAfterDays.default(recommendedSettings.archiveAfterDays),
  notifyPermission: settingsValuesSchema.shape.notifyPermission.default(recommendedSettings.notifyPermission),
  notifyStopped: settingsValuesSchema.shape.notifyStopped.default(recommendedSettings.notifyStopped),
  notifyCompleted: settingsValuesSchema.shape.notifyCompleted.default(recommendedSettings.notifyCompleted),
  titleMarker: settingsValuesSchema.shape.titleMarker.default(recommendedSettings.titleMarker),
  koreanTitle: settingsValuesSchema.shape.koreanTitle.default(recommendedSettings.koreanTitle),
  executorThinking: settingsValuesSchema.shape.executorThinking.default(recommendedSettings.executorThinking),
  askMode: settingsValuesSchema.shape.askMode.default(recommendedSettings.askMode),
  defaultMode: settingsValuesSchema.shape.defaultMode.default(recommendedSettings.defaultMode),
  askExecutorModel: settingsValuesSchema.shape.askExecutorModel.default(recommendedSettings.askExecutorModel),
  rememberProjectChoices: settingsValuesSchema.shape.rememberProjectChoices.default(recommendedSettings.rememberProjectChoices),
  autoStart: settingsValuesSchema.shape.autoStart.default(recommendedSettings.autoStart),
  autoResumeQuota: settingsValuesSchema.shape.autoResumeQuota.default(recommendedSettings.autoResumeQuota),
  autoResumeTransient: settingsValuesSchema.shape.autoResumeTransient.default(recommendedSettings.autoResumeTransient),
  shellPushGuard: settingsValuesSchema.shape.shellPushGuard.default(recommendedSettings.shellPushGuard),
  executorPlacement: settingsValuesSchema.shape.executorPlacement.catch(recommendedSettings.executorPlacement).default(recommendedSettings.executorPlacement),
  threshold: settingsValuesSchema.shape.threshold.default(recommendedSettings.threshold),
  claudeCompression: settingsValuesSchema.shape.claudeCompression.default(recommendedSettings.claudeCompression),
  codexCompression: settingsValuesSchema.shape.codexCompression.default(recommendedSettings.codexCompression),
  maxCycles: settingsValuesSchema.shape.maxCycles.default(recommendedSettings.maxCycles),
  maxTurns: settingsValuesSchema.shape.maxTurns.default(recommendedSettings.maxTurns),
  executorModel: settingsValuesSchema.shape.executorModel.default(recommendedSettings.executorModel),
  executorMode: settingsValuesSchema.shape.executorMode.default(recommendedSettings.executorMode),
  claudeExecutorModel: settingsValuesSchema.shape.claudeExecutorModel.default(recommendedSettings.claudeExecutorModel),
  claudeExecutorThinking: settingsValuesSchema.shape.claudeExecutorThinking.default(recommendedSettings.claudeExecutorThinking),
  claudeExecutorMode: settingsValuesSchema.shape.claudeExecutorMode.default(recommendedSettings.claudeExecutorMode),
  claudeStartMode: settingsValuesSchema.shape.claudeStartMode.default(recommendedSettings.claudeStartMode),
});
export type Settings = z.infer<typeof settingsSchema>;
const savedExecutorSchema = z.object({ model: z.string().max(120), thinking: z.string().max(40) });
export const projectDefaultsSchema = z.object({
  mode: z.enum(["general", "federated"]),
  general: generalAgentSchema.optional(),
  codex: savedExecutorSchema.optional(),
  claude: savedExecutorSchema.optional(),
});
export type ProjectDefaults = z.infer<typeof projectDefaultsSchema>;
export const archiveEntrySchema = z.object({
  id: z.string(),
  number: z.number().int().nonnegative(),
  title: z.string(),
  projectId: z.string(),
  folder: z.string(),
  progress: z.enum(["done", "pushed", "no_push"]),
  workspaceIds: z.array(z.string()),
  agentIds: z.array(z.string()),
  archivedAt: z.string(),
});
export type ArchiveEntry = z.infer<typeof archiveEntrySchema>;
export const archiveCandidateSchema = archiveEntrySchema.omit({ archivedAt: true }).extend({
  lastActivityAt: z.string(),
});
export type ArchiveCandidate = z.infer<typeof archiveCandidateSchema>;
export const archiveFinished = defineRpc({
  name: "workflow.archive-finished",
  input: z.object({
    apply: z.boolean().default(false),
    // Applying is restricted to the rows the user confirmed in the preview.
    ids: z.array(z.string()).max(500).default([]),
  }),
  output: z.object({
    rows: z.array(archiveCandidateSchema),
    blocked: z.array(z.object({ id: z.string(), number: z.number(), title: z.string(), reason: z.string() })).default([]),
    archivedIds: z.array(z.string()),
    errors: z.array(z.object({ id: z.string(), error: z.string() })),
  }),
});
export const workflowViewSchema = z.object({
  contract: z.number().int().default(1),
  selection: executorSelectionSchema.nullable().default(null),
  heldPlan: z.boolean().default(false),
  planConflict: planConflictSchema.nullable().default(null),
  planIssue: z.object({ key: z.string(), reason: z.string() }).nullable().default(null),
  id: z.string(),
  number: z.number(),
  title: z.string(),
  cwd: z.string(),
  mode: z.enum(["undecided", "general", "federated"]),
  status: z.enum(["active", "paused", "needs_input", "completed", "error"]),
  phase: z.enum(["plan", "execute", "review"]),
  cycles: z.number(),
  turns: z.number(),
  detail: z.string(),
  updatedAt: z.string(),
  progress: z.enum(["plan", "active", "done", "pushed", "no_push"]).default("active"),
  planAgentId: z.string().nullable(),
  executeAgentId: z.string().nullable(),
  planGeneration: z.number(),
  executeGeneration: z.number(),
  planCompactions: z.number(),
  executeCompactions: z.number(),
  planCompressionReason: z.string().default(""),
  executeCompressionReason: z.string().default(""),
  compactionRecovery: z.boolean().default(false),
  planUsage: z.number().nullable(),
  executeUsage: z.number().nullable(),
  repositories: repositoryPathsSchema.default([]),
  pushTargets: pushTargetsSchema.default([]),
  managedPush: managedPushSchema.nullable().default(null),
  pushHistory: z.array(managedPushSchema).default([]),
  verification: z.array(verificationRecordSchema).default([]),
  artifactNotice: z.string().default(""),
  conflict: z.string().default(""),
  waitingFor: z.number().optional(),
  generalAgent: generalAgentSchema.nullable().default(null),
  plannerAgent: generalAgentSchema.nullable().default(null),
  automatic: z.boolean().default(false),
  verdict: verdictViewSchema.nullable().default(null),
  generalTransition: z.boolean().default(false),
  deliveryUnconfirmed: z.boolean().default(false),
});
export const status = defineRpc({
  name: "workflow.status",
  input: z.object({}),
  output: z.object({
    settings: settingsSchema.nullable(),
    settingsRevision: z.number().int().nonnegative().nullable(),
    federation: z.object({ available: z.boolean(), reason: z.string().nullable() }),
    projects: z.record(z.string(), projectDefaultsSchema).default({}),
    workflows: z.array(workflowViewSchema),
    archives: z.array(archiveEntrySchema).default([]),
    error: z.string().nullable(),
    devices: z.number(),
  }),
});
export const configure = defineRpc({
  name: "workflow.configure",
  input: z.object({ settings: settingsValuesSchema.strict(), expectedRevision: z.number().int().nonnegative() }).strict(),
  output: z.object({ settings: settingsSchema, revision: z.number().int().nonnegative() }),
});
export const forgetProject = defineRpc({
  name: "workflow.forget-project",
  input: z.object({ cwd: z.string().min(1).max(4096) }),
  output: z.object({ ok: z.literal(true) }),
});
export const setRepositories = defineRpc({
  name: "workflow.repositories",
  input: z.object({ id: z.string(), paths: repositoryPathsSchema }),
  output: z.object({ repositories: repositoryPathsSchema }),
});
export const selectMode = defineRpc({
  name: "workflow.select-mode",
  input: z.object({ id: z.string(), mode: z.enum(["general", "federated"]) }),
  output: z.object({ ok: z.boolean(), detail: z.string() }),
});
export const selectPlacement = defineRpc({
  name: "workflow.select-placement",
  input: z.object({ id: z.string(), placement: z.enum(["worktree", "wait"]) }),
  output: z.object({ ok: z.boolean(), detail: z.string() }),
});
export const selectExecutor = defineRpc({
  name: "workflow.select-executor",
  input: z.object({
    id: z.string(),
    provider: z.enum(["codex", "claude"]),
    model: z.string().trim().min(1).max(120),
    // An empty value is only valid for a model without thinking options.
    thinking: z.string().trim().max(40).default(""),
  }),
  output: z.object({ ok: z.boolean(), detail: z.string() }),
});
export const control = defineRpc({
  name: "workflow.control",
  input: z.object({
    id: z.string(),
    action: z.enum(["pause", "resume", "general", "resend", "retry_compaction"]),
    message: z.string().max(30000).default(""),
  }),
  output: z.object({
    ok: z.literal(true),
    status: workflowViewSchema.shape.status,
    detail: z.string(),
  }),
});

export const testNotification = defineRpc({
  name: "workflow.test-notification",
  input: z.object({}),
  output: z.object({
    tokens: z.number(),
    status: z.number().nullable(),
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const executorModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
  thinkingOptions: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean() })),
});
export type ExecutorModel = z.infer<typeof executorModelSchema>;
export const models = defineRpc({
  name: "workflow.models",
  input: z.object({ provider: z.enum(["claude", "codex"]).default("codex") }),
  output: z.object({ models: z.array(executorModelSchema), error: z.string().nullable() }),
});

export const setProgress = defineRpc({
  name: "workflow.progress",
  input: z.object({
    number: z.number().int().positive(),
    progress: z.enum(["plan", "active", "done", "pushed", "no_push"]),
    // Numbers repeat across projects; a project id, folder path or folder name picks one.
    project: z.string().max(500).default(""),
    // Repair an existing task against its reported commit, not another task's current HEAD.
    targets: pushTargetsSchema.min(1).optional(),
    // An explicit historical response may be checked; this never searches old turns itself.
    source: z
      .object({
        agentId: z.string().trim().min(1).max(200),
        messageId: z.string().trim().min(1).max(500),
      })
      .optional(),
  }),
  output: z.object({ titles: z.array(z.string()) }),
});
// One-time adoption of pins recorded by the earlier plugin, guarded by their exact timestamps.
export const adoptReviewPins = defineRpc({
  name: "workflow.review-pins",
  input: z.object({
    id: z.string(),
    key: z.string(),
    pins: z
      .array(z.object({ workspaceId: z.string(), pinnedAt: z.string() }))
      .min(1)
      .max(2),
  }),
  output: z.object({ adopted: z.number().int().nonnegative() }),
});
export const retitle = defineRpc({
  name: "workflow.retitle",
  input: z.object({
    apply: z.boolean().default(false),
    // Numbers every project from 1 in the order its work was created.
    renumber: z.boolean().default(false),
    unmanaged: z
      .array(
        z.object({
          workspaceId: z.string(),
          projectId: z.string().default(""),
          cwd: z.string().default(""),
          provider: z.string(),
          role: z.enum(["plan", "execute"]).nullable().default(null),
          title: z.string().max(500),
        }),
      )
      .max(500)
      .default([]),
  }),
  output: z.object({
    rows: z.array(
      z.object({ workspaceId: z.string(), title: z.string(), error: z.string().nullable() }),
    ),
  }),
});
