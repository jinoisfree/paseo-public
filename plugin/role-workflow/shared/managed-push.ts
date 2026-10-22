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
  exitCode: z.number().int().nullable().default(null),
  verified: z.boolean().nullable().default(null),
  alreadyIncluded: z.boolean().default(false),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  error: z.string().default(""),
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
