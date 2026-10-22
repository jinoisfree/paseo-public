import type { ExecutorModel, Settings } from "./contracts";
import { executorDefaults, type WorkflowProvider } from "./assignment";

export function selectedModel(models: ExecutorModel[], value: string) {
  const provider = value.split("/")[0];
  return !value.includes("/")
    ? models.find((model) => model.isDefault)
    : models.find((model) => `${provider}/${model.id}` === value);
}
export function selectExecutorModel(
  settings: Settings,
  value: string,
  models: ExecutorModel[],
  provider: WorkflowProvider = "codex",
): Settings {
  const options = selectedModel(models, value)?.thinkingOptions ?? [];
  const current = executorDefaults(settings, provider);
  const thinking = options.some((option) => option.id === current.thinking) ? current.thinking : "";
  return provider === "claude"
    ? { ...settings, claudeExecutorModel: value, claudeExecutorThinking: thinking }
    : { ...settings, executorModel: value, executorThinking: thinking };
}
