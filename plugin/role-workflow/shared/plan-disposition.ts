import { z } from "zod";

export const planConflictSchema = z.object({
  pendingId: z.string(),
  agentId: z.string(),
  key: z.string(),
  text: z.string(),
  next: z.string(),
  reason: z.string(),
  stage: z.enum(["executing", "review", "resolved"]),
  confirmedKey: z.string().optional(),
  rejected: z.object({ key: z.string(), next: z.string(), reason: z.string() }).optional(),
});
