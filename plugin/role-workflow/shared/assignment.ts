import type { Settings } from "./contracts";
import { recommendedSettings } from "./recommended";

export type WorkflowProvider = "claude" | "codex";
export type WorkflowRole = "plan" | "execute";

export function oppositeProvider(provider: string): WorkflowProvider {
  const base = provider.split("/")[0];
  if (base === "claude") return "codex";
  if (base === "codex") return "claude";
  throw new Error(`지원하지 않는 작업 제공자: ${base}`);
}

export function executorDefaults(settings: Settings | null, provider: WorkflowProvider) {
  settings ??= recommendedSettings;
  return provider === "claude"
    ? {
        model: settings.claudeExecutorModel,
        thinking: settings.claudeExecutorThinking,
        mode: settings.claudeExecutorMode,
      }
    : {
        model: settings.executorModel,
        thinking: settings.executorThinking,
        mode: settings.executorMode,
      };
}

export function creationRole(
  newAutomated: boolean,
  declared: string | undefined,
): WorkflowRole | undefined {
  if (newAutomated) return "plan";
  if (declared === "plan" || declared === "execute") return declared;
  return undefined;
}
