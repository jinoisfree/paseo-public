import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pushTargetSchema } from "./artifacts";

export const managedPushStateSchema = z.enum([
  "prepared",
  "running",
  "checking",
  "pushed",
  "failed",
  "unknown",
]);
export const managedPushTargetSchema = pushTargetSchema.extend({
  remoteUrl: z.string(),
  snapshotTree: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional(),
  exitCode: z.number().int().nullable().default(null),
  verified: z.boolean().nullable().default(null),
  alreadyIncluded: z.boolean().default(false),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  error: z.string().default(""),
}).superRefine((target, ctx) => {
  if (!!target.snapshot !== !!target.snapshotTree)
    ctx.addIssue({ code: "custom", message: "스냅샷 검증 기록이 불완전합니다. 새 요청을 준비하세요." });
});
export const managedPushSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string(),
  epoch: z.number().int().nonnegative(),
  state: managedPushStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  approvedAt: z.string().nullable().default(null),
  targets: z.array(managedPushTargetSchema).min(1).max(8),
  error: z.string().default(""),
});
export type ManagedPush = z.infer<typeof managedPushSchema>;
export const preparePush = defineRpc({
  name: "workflow.push-prepare",
  input: z.object({ id: z.string() }),
  output: managedPushSchema,
});
export const executePush = defineRpc({
  name: "workflow.push-execute",
  input: z.object({ id: z.string(), requestId: z.string().uuid(), approved: z.literal(true) }),
  output: managedPushSchema,
});
export const recheckPush = defineRpc({
  name: "workflow.push-recheck",
  input: z.object({ id: z.string(), requestId: z.string().uuid() }),
  output: managedPushSchema,
});
