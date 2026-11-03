import type { ExecutorModel } from "./contracts";
import { capabilities } from "./capabilities";

/** Every thinking option of the model; an empty id is offered only when the model has none. */
export function pickerThinking(model: ExecutorModel | undefined) {
  if (!model) return [];
  if (!model.thinkingOptions.length) return [{ id: "", label: "추론 없음", isDefault: true }];
  return model.thinkingOptions.map((option) => ({
    ...option,
    label: `${option.label}${option.isDefault ? " (기본)" : ""}`,
  }));
}

/** The default to preselect: the catalog default, or none when the catalog states none. */
export function pickerDefaultThinking(model: ExecutorModel | undefined) {
  const options = pickerThinking(model);
  return (options.find((option) => option.isDefault) ?? options[0])?.id ?? null;
}

/** The picker is offered until an executor conversation exists for the workflow. */
export function picksExecutor(w: {
  contract?: number;
  mode: string;
  status: string;
  executeAgentId: string | null;
}) {
  return capabilities(w).executorSelection && !w.executeAgentId && w.status !== "completed";
}
