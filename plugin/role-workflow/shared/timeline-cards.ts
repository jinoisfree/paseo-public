import { z } from "zod";
import { generalCardSchema } from "./general-agent";
import { executorPickerCardSchema } from "./executor-picker";
export const modePickerCardSchema = z.object({ workflowId: z.string() }).strict();
export const placementPickerCardSchema = z.object({ workflowId: z.string(), number: z.number(), title: z.string() }).strict();
export const timelineCardSchemas = {
  "mode-picker": modePickerCardSchema,
  "executor-picker": executorPickerCardSchema,
  "placement-picker": placementPickerCardSchema,
  "general-agent": generalCardSchema,
} as const;
export type TimelineCardKind = keyof typeof timelineCardSchemas;
