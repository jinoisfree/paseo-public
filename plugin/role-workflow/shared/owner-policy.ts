import { z } from "zod";
import raw from "./presets/schemas/policy.schema.json";
import { settingsValuesSchema } from "./settings-schema";
import { recommendedSettings } from "./recommended";

export interface OwnerPolicy {
  version: 1;
  revision: number;
  roleWorkflow: Partial<z.infer<typeof settingsValuesSchema>>;
  notifications: { phoneNotifications?: boolean; phoneNotificationEndpoint?: string };
  decisions: Record<string, { date: string; value?: unknown }>;
  migratedFrom?: { source: string; at: string; stateSettingsSha256: string };
}
// JSON Schema is shared with the Python installer; settings values retain their existing Zod constraints.
export const ownerPolicySchema = z.fromJSONSchema(raw as Parameters<typeof z.fromJSONSchema>[0])
  .superRefine((value, ctx) => {
    const parsed = settingsValuesSchema.partial().strict().safeParse((value as OwnerPolicy).roleWorkflow);
    if (!parsed.success) ctx.addIssue({ code: "custom", message: "roleWorkflow 설정이 올바르지 않습니다." });
  }).transform(value => value as OwnerPolicy);
export function effectiveSettings(policy: OwnerPolicy) {
  return settingsValuesSchema.parse({ ...recommendedSettings, ...policy.roleWorkflow });
}
