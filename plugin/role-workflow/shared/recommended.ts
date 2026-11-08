import { z } from "zod";
import raw from "./presets/recommended.json";
import { settingsValuesSchema } from "./settings-schema";

const toggleSchema = z.object({ enabled: z.boolean() }).strict();
const profileSchema = z.object({
  desktopSettings: z.object({ daemon: z.object({ manageBuiltInDaemon: z.boolean() }).strict() }).strict(),
  modules: z.array(z.string().min(1)),
}).strict();
export const recommendedSchema = z.object({
  version: z.literal(1),
  roleWorkflow: settingsValuesSchema.strict(),
  core: z.object({
    pluginsEnabled: z.boolean(),
    agents: z.object({
      resumeOnStartup: z.boolean(),
      skills: z.object({ selection: z.object({ mode: z.literal("all") }).strict() }).strict(),
    }).strict(),
    daemon: z.object({
      mcp: z.object({ enabled: z.boolean(), injectIntoAgents: z.boolean() }).strict(),
      browserTools: toggleSchema, autoArchiveAfterMerge: z.boolean(), relay: toggleSchema,
    }).strict(),
    features: z.object({ dictation: toggleSchema, voiceMode: toggleSchema, webUi: toggleSchema }).strict(),
    log: z.object({ file: z.object({
      level: z.enum(["debug", "info", "warn", "error"]),
      rotate: z.object({ maxSize: z.string().regex(/^\d+[kmg]$/i), maxFiles: z.number().int().positive() }).strict(),
    }).strict() }).strict(),
  }).strict(),
  profiles: z.object({ server: profileSchema, desktop: profileSchema }).strict(),
}).strict();
// Validate JSON at the boundary before passing typed values to Zod defaults.
export const recommended = recommendedSchema.parse(raw);
export const recommendedSettings = recommended.roleWorkflow;
