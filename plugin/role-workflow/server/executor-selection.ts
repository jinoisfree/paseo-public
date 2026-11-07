import { unknownData } from "./data-records";
import { EXECUTOR_QUESTIONS, type ExecutorSelection, type SelectionField, type SelectionStage } from "../shared/executor-selection";
import type { ExecutorModel } from "./protocol";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

const stages = Object.keys(EXECUTOR_QUESTIONS) as SelectionStage[];
export function selectionQuestions(input: unknown): SelectionField[] {
  const questions = input && typeof input === "object" ? unknownData(input, "questions") : null;
  if (!Array.isArray(questions) || !questions.length || questions.length > 3) return [];
  const fields: SelectionField[] = [];
  for (const [index, question] of questions.entries()) {
    const stage = stages.find(stage => {
      const q = EXECUTOR_QUESTIONS[stage];
      return question?.question === q.question || question?.title === q.question;
    });
    if (!stage || fields.some(x => x.stage === stage)) return [];
    const q = EXECUTOR_QUESTIONS[stage];
    fields.push({ stage, keys: [...new Set([q.question, q.header, `Question ${index + 1}`,
      ...(typeof question.id === "string" ? [question.id] : [])])] });
  }
  // Ambiguous native IDs must not assign one answer to multiple fields.
  if (fields.some((f, i) => fields.some((g, j) => i !== j && f.keys.some(k => g.keys.includes(k))))) return [];
  return fields;
}
export function pendingFields(pending: ExecutorSelection["pending"]): SelectionField[] {
  return pending?.fields ?? (pending?.stage ? [{stage: pending.stage,
    keys: [EXECUTOR_QUESTIONS[pending.stage].question, EXECUTOR_QUESTIONS[pending.stage].header, "Question 1"]}] : []);
}
export function selectionAnswers(input: unknown, fields: SelectionField[]): Partial<Record<SelectionStage, string>> {
  const answers = input && typeof input === "object" ? unknownData(input, "answers") : null;
  if (!answers || typeof answers !== "object") return {};
  return Object.fromEntries(fields.flatMap(field => {
    const values = field.keys.filter(key => Object.hasOwn(answers, key)).map(key => unknownData(answers, key));
    return values.length && values.every(x => typeof x === "string" && x === values[0]) ? [[field.stage, values[0]]] : [];
  }));
}
/** Only exact completed question/answer pairs count; a returned tool call is not an answer. */
export function timelineSelections(items: readonly AgentTimelineItem[]) {
  return items.flatMap((item, index) => {
    if (item.type !== "tool_call" || !["request_user_input_async", "request_user_input"].includes(item.name) ||
        item.status !== "completed" || item.error !== null || item.detail.type !== "plain_text") return [];
    const detail = item.detail.text ?? "";
    const answer = items.slice(index + 1).find(row => row.type === "user_message");
    if (answer?.type !== "user_message" || answer.text !== "Answers to your questions:\n\n" + detail) return [];
    const blocks = detail.split("\n\n");
    const fields: SelectionField[] = [];
    const values: Partial<Record<SelectionStage, string>> = {};
    for (const block of blocks) {
      const stage = stages.find(stage => block.startsWith(EXECUTOR_QUESTIONS[stage].question + "\n"));
      if (!stage || fields.some(x => x.stage === stage)) return [];
      fields.push({stage, keys:[EXECUTOR_QUESTIONS[stage].question]});
      values[stage] = block.slice(EXECUTOR_QUESTIONS[stage].question.length + 1).trim();
    }
    return fields.length ? [{id:item.callId, fields, values}] : [];
  });
}
export function timelineMode(items: readonly AgentTimelineItem[]): "general" | "federated" | null {
  for (const [index, item] of items.entries()) {
    if (item.type !== "tool_call" || !["request_user_input_async", "request_user_input"].includes(item.name) ||
        item.status !== "completed" || item.error !== null || item.detail.type !== "plain_text") continue;
    const detail = item.detail.text ?? "";
    if (!detail.startsWith("진행 방식을 선택하세요\n")) continue;
    const next = items.slice(index + 1).find(row => row.type === "user_message");
    if (next?.type !== "user_message" || next.text !== "Answers to your questions:\n\n" + detail) continue;
    const value = detail.slice("진행 방식을 선택하세요\n".length).trim();
    if (value === "일반개발") return "general";
    if (value === "연합개발") return "federated";
  }
  return null;
}
export function selectableModel(models: readonly ExecutorModel[], id: string) {
  return models.find(model => model.id === id && model.isSelectable !== false);
}
export function explicitSelection(request: string): Partial<Record<SelectionStage, string>> {
  const lines = request.trim().split("\n");
  const first = (lines[0] === "연합개발" ? lines[1] ?? "" : lines[0]).trim().replace(/^구현 담당\s*[:：]\s*/, "");
  if (/[?？"'`]|예시|가정|비교|말고|하지/.test(first)) return {};
  if (/^(Codex|Claude Code|codex|claude)$/.test(first)) return { provider: first };
  const match = /^(codex|claude)\/([^\s]+)(?:\s+추론\s*[:=]?\s*([A-Za-z0-9_.-]+))?\s*$/i.exec(first);
  return match ? { provider: match[1].toLowerCase(), model: match[2], ...(match[3] ? { thinking: match[3] } : {}) } : {};
}
export async function applyLegacySelection(
  state: ExecutorSelection, stage: SelectionStage, value: string,
  catalog: (provider: "codex" | "claude") => Promise<readonly ExecutorModel[]>,
): Promise<void> {
  state.error = "";
  if (stage === "provider") {
    const provider = value.trim().replace(/\s*\(Recommended\)$/, "");
    if (!["Codex", "Claude Code", "codex", "claude"].includes(provider))
      throw new Error("Codex 또는 Claude Code를 선택하세요.");
    state.provider = provider === "Codex" || provider === "codex" ? "codex" : "claude";
    state.model = ""; state.thinking = null; state.stage = "model";
    // A failed catalog keeps the provider and waits for a model. Never use saved defaults.
    await catalog(state.provider);
    return;
  }
  if (!state.provider) throw new Error("구현 제품의 실제 답변이 먼저 필요합니다.");
  const models = await catalog(state.provider);
  if (stage === "model") {
    const id = value.trim().replace(new RegExp(`^${state.provider}/`), "");
    const model = selectableModel(models, id);
    if (!model) throw new Error("실행 가능한 모델을 카탈로그에서 확인하지 못했습니다. 모델을 다시 선택하세요.");
    state.model = model.id; state.thinking = null; state.stage = "thinking";
    const options = model.thinkingOptions ?? [];
    if (options.length <= 1) {
      state.thinking = options[0]?.id ?? "";
      state.stage = "ready";
    }
    return;
  }
  const model = selectableModel(models, state.model);
  if (!model) { state.stage = "model"; state.model = ""; state.thinking = null;
    throw new Error("선택한 모델이 카탈로그에서 제거되었습니다. 모델부터 다시 선택하세요."); }
  const id = value.trim();
  if (!(model.thinkingOptions ?? []).some(option => option.id === id))
    throw new Error("이 모델이 지원하지 않는 추론 값입니다. 표시된 추론 ID를 다시 선택하세요.");
  state.thinking = id; state.stage = "ready";
}

export async function validateSelection(state: ExecutorSelection,
  catalog: (provider: "codex" | "claude") => Promise<readonly ExecutorModel[]>) {
  if (state.stage !== "ready" || !state.provider) return false;
  if (state.responses) {
    try { await applySelectionBatch(state, {}, catalog); return true; }
    catch (error) { state.error = error instanceof Error ? error.message : String(error); return false; }
  }
  const model = selectableModel(await catalog(state.provider), state.model);
  if (!model) { state.stage = "model"; state.model = ""; state.thinking = null;
    state.error = "선택한 모델이 없어 모델을 다시 선택해야 합니다."; return false; }
  const options = model.thinkingOptions ?? [];
  if (state.thinking === null || (options.length ? !options.some(x => x.id === state.thinking) : state.thinking !== "")) {
    state.stage = "thinking"; state.thinking = null;
    state.error = "지원 추론이 변경되었습니다. 추론 수준을 다시 선택하세요.";
    if (options.length <= 1) { state.thinking = options[0]?.id ?? ""; state.stage = "ready"; }
    return state.stage === "ready";
  }
  return true;
}

/** Apply one answer envelope atomically. Raw partial fields survive missing dependencies. */
export async function applySelectionBatch(state: ExecutorSelection, values: Partial<Record<SelectionStage, string>>,
  catalog: (provider: "codex" | "claude") => Promise<readonly ExecutorModel[]>) {
  const responses = state.responses ?? {
    ...(state.provider ? {provider:state.provider} : {}), ...(state.model ? {model:state.model} : {}),
    ...(state.thinking !== null ? {thinking:state.thinking || "추론 없음"} : {}),
  };
  const providerId = (value: string | undefined) => value?.trim().replace(/\s*\(Recommended\)$/, "")
    .replace(/^Codex$/, "codex").replace(/^Claude Code$/, "claude");
  if (values.provider !== undefined && ["codex", "claude"].includes(providerId(responses.provider) ?? "") && providerId(values.provider) !== providerId(responses.provider)) {
    delete responses.model; delete responses.thinking;
  } else if (values.model !== undefined && state.model && values.model.replace(new RegExp(`^${state.provider}/`), "") !== state.model) delete responses.thinking;
  Object.assign(responses, values);
  state.responses = responses;
  state.error = ""; state.provider = null; state.model = ""; state.thinking = null; state.stage = "provider";
  const provider = providerId(responses.provider);
  if (provider !== "codex" && provider !== "claude") throw new Error("구현 제품: Codex 또는 Claude Code 답변이 필요합니다.");
  state.provider = provider; state.stage = "model";
  const models = await catalog(provider);
  const rawModel = responses.model?.trim();
  // An explicit prefix naming a different product must never be stripped or guessed.
  const model = selectableModel(models, rawModel?.replace(new RegExp(`^${provider}/`), "") ?? "");
  if (!model) throw new Error("실행 모델: 선택한 제품의 실행 가능한 모델 ID로 답변하세요.");
  state.model = model.id; state.stage = "thinking";
  const value = responses.thinking?.trim();
  const options = model.thinkingOptions ?? [];
  let id = value;
  if (value === "추론 없음") id = options.length === 0 ? "" : undefined;
  if (value === "모델 기본값") {
    const confirmed = model.defaultThinkingOptionId ?? options.find(x => x.isDefault)?.id;
    id = confirmed !== undefined && options.some(x => x.id === confirmed) ? confirmed : undefined;
  }
  if (id === undefined || (options.length ? !options.some(x => x.id === id) : id !== "" || value !== "추론 없음"))
    throw new Error("실행 추론: 지원 ID 또는 확인 가능한 모델 기본값/추론 없음으로 답변하세요.");
  state.thinking = id; state.stage = "ready";
}

/** Contract 5: the executor is picked on the plugin screen, so no catalog or questions here. */
export const SCREEN_SELECTION_PROMPT = `\n<paseo-executor-selection-v5>
연합개발의 구현 담당(제품·모델·추론)은 사용자가 플러그인 화면에서 고른다. 질문 도구로 묻지 않고 모델 목록도 안내하지 않는다.
계획이 확정되면 그대로 plan을 낸다. 선택 전이면 호스트가 계획을 보관했다가 선택 직후 한 번 전달한다. 최초 담당의 모델·추론은 바꾸지 않는다.
</paseo-executor-selection-v5>`;
