import { z } from "zod";
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

/** Offered until an executor exists, and again while that executor's selection is not ready. */
export function picksExecutor(w: {
  contract?: number;
  mode: string;
  status: string;
  executeAgentId: string | null;
  selection?: { stage?: string } | null;
}) {
  const stranded = !!w.executeAgentId && !!w.selection && w.selection.stage !== "ready";
  return capabilities(w).executorSelection && (!w.executeAgentId || stranded) && w.status !== "completed";
}

/** The in-chat picker card posted when a contract 5 flow becomes federated. */
export const executorPickerCardSchema = z.object({ workflowId: z.string() }).strict();
