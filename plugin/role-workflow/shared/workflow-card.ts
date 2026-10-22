import { z } from "zod";
import { decisionSchema } from "./decision";

export const workflowCardSchema = z.object({
  decision: decisionSchema,
  raw: z.string(),
  prose: z.string(),
});
