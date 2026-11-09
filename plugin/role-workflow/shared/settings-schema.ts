import { z } from "zod";
import { folderRootsSchema } from "./folders";
import { claudeCompressionValueSchema } from "./compression";

export const settingsValuesSchema = z.object({
  folderRoots: folderRootsSchema.removeDefault(),
  autoPinStarted: z.boolean(),
  autoPinPushed: z.boolean(),
  autoArchivePushed: z.boolean(),
  autoArchiveWorktree: z.boolean(),
  archiveAfterDays: z.number().int().nonnegative(),
  notifyPermission: z.boolean(),
  notifyStopped: z.boolean(),
  notifyCompleted: z.boolean(),
  titleMarker: z.boolean(),
  koreanTitle: z.boolean(),
  executorThinking: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9_.-]*$/),
  askMode: z.boolean(),
  // Used for new conversations while the mode question is off.
  defaultMode: z.enum(["general", "federated"]),
  askExecutorModel: z.boolean(),
  rememberProjectChoices: z.boolean(),
  autoStart: z.boolean(),
  autoResumeQuota: z.boolean(),
  autoResumeTransient: z.boolean(),
  shellPushGuard: z.boolean(),
  executorPlacement: z.enum(["ask", "worktree", "wait"]),
  threshold: z.number().min(0.05).max(0.9),
  claudeCompression: claudeCompressionValueSchema,
  codexCompression: z.enum(["threshold", "native"]),
  maxCycles: z.number().int().min(1).max(50),
  maxTurns: z.number().int().min(2).max(200),
  executorModel: z
    .string()
    .trim()
    .regex(/^codex(?:\/[^\s]+)?$/, "codex 또는 codex/모델 ID를 입력하세요.")
    .max(120),
  reviewerMode: z.string().trim().min(1).max(80),
  claudeReviewerMode: z.string().trim().min(1).max(80),
  executorMode: z.string().trim().min(1).max(80),
  claudeExecutorModel: z
    .string()
    .trim()
    .max(120)
    .regex(/^claude(?:\/[^\s]+)?$/, "claude 또는 claude/모델 ID를 입력하세요."),
  claudeExecutorThinking: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9_.-]*$/),
  claudeExecutorMode: z.string().trim().min(1).max(80),
  // An empty value keeps the mode chosen for new Claude conversations.
  claudeStartMode: z.string().trim().max(80),
});
