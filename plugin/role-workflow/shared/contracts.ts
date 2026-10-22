import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { repositoryPathsSchema, pushTargetsSchema, verificationRecordSchema } from "./artifacts";
import { managedPushSchema } from "./managed-push";
import { folderRootsSchema } from "./folders";

export const settingsSchema = z.object({
  folderRoots: folderRootsSchema,
  autoPinStarted: z.boolean().default(true),
  autoPinPushed: z.boolean().default(true),
  autoArchivePushed: z.boolean().default(true),
  archiveAfterDays: z.number().int().nonnegative().default(3),
  notifyPermission: z.boolean().default(true),
  notifyStopped: z.boolean().default(true),
  notifyCompleted: z.boolean().default(true),
  titleMarker: z.boolean().default(true),
  koreanTitle: z.boolean().default(true),
  executorThinking: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9_.-]*$/)
    .default(""),
  askMode: z.boolean().default(true),
  // Used for new conversations while the mode question is off.
  defaultMode: z.enum(["general", "federated"]).default("federated"),
  askExecutorModel: z.boolean().default(true),
  rememberProjectChoices: z.boolean().default(true),
  autoStart: z.boolean().default(true),
  autoResumeQuota: z.boolean().default(true),
  threshold: z.number().min(0.05).max(0.9).default(0.8),
  maxCycles: z.number().int().min(1).max(50).default(5),
  maxTurns: z.number().int().min(2).max(200).default(30),
  executorModel: z
    .string()
    .trim()
    .regex(/^codex(?:\/[^\s]+)?$/, "codex 또는 codex/모델 ID를 입력하세요.")
    .max(120)
    .default("codex"),
  executorMode: z.string().trim().min(1).max(80).default("auto"),
  claudeExecutorModel: z
    .string()
    .trim()
    .max(120)
    .regex(/^claude(?:\/[^\s]+)?$/, "claude 또는 claude/모델 ID를 입력하세요.")
    .default("claude"),
  claudeExecutorThinking: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9_.-]*$/)
    .default(""),
  claudeExecutorMode: z.string().trim().min(1).max(80).default("acceptEdits"),
  // An empty value keeps the mode chosen for new Claude conversations.
  claudeStartMode: z.string().trim().max(80).default("bypassPermissions"),
});
export type Settings = z.infer<typeof settingsSchema>;
const savedExecutorSchema = z.object({ model: z.string().max(120), thinking: z.string().max(40) });
export const projectDefaultsSchema = z.object({
  mode: z.enum(["general", "federated"]),
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
  progress: z.enum(["done", "pushed"]),
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
    archivedIds: z.array(z.string()),
    errors: z.array(z.object({ id: z.string(), error: z.string() })),
  }),
});
export const workflowViewSchema = z.object({
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
  progress: z.enum(["plan", "active", "done", "pushed"]).default("active"),
  planAgentId: z.string().nullable(),
  executeAgentId: z.string().nullable(),
  planGeneration: z.number(),
  executeGeneration: z.number(),
  planCompactions: z.number(),
  executeCompactions: z.number(),
  planUsage: z.number().nullable(),
  executeUsage: z.number().nullable(),
  repositories: repositoryPathsSchema.default([]),
  pushTargets: pushTargetsSchema.default([]),
  managedPush: managedPushSchema.nullable().default(null),
  pushHistory: z.array(managedPushSchema).default([]),
  verification: z.array(verificationRecordSchema).default([]),
  artifactNotice: z.string().default(""),
  conflict: z.string().default(""),
  generalTransition: z.boolean().default(false),
});
export const status = defineRpc({
  name: "workflow.status",
  input: z.object({}),
  output: z.object({
    settings: settingsSchema,
    projects: z.record(z.string(), projectDefaultsSchema).default({}),
    workflows: z.array(workflowViewSchema),
    archives: z.array(archiveEntrySchema).default([]),
    error: z.string().nullable(),
    devices: z.number(),
  }),
});
export const configure = defineRpc({
  name: "workflow.configure",
  input: settingsSchema,
  output: settingsSchema,
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
export const control = defineRpc({
  name: "workflow.control",
  input: z.object({
    id: z.string(),
    action: z.enum(["pause", "resume", "general"]),
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
    progress: z.enum(["plan", "active", "done", "pushed"]),
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
