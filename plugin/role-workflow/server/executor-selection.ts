import { EXECUTOR_QUESTIONS, type ExecutorSelection, type SelectionStage } from "../shared/executor-selection";
import type { ExecutorModel } from "./protocol";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export function selectionQuestion(input: unknown): SelectionStage | null {
  const questions = input && typeof input === "object" ? Reflect.get(input, "questions") : null;
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  return (Object.keys(EXECUTOR_QUESTIONS) as SelectionStage[]).find(stage => {
    const q = EXECUTOR_QUESTIONS[stage];
    return questions[0]?.question === q.question || questions[0]?.title === q.question || questions[0]?.header === q.header;
  }) ?? null;
}
export function selectionAnswer(input: unknown, stage: SelectionStage): string | null {
  const answers = input && typeof input === "object" ? Reflect.get(input, "answers") : null;
  if (!answers || typeof answers !== "object") return null;
  const q = EXECUTOR_QUESTIONS[stage];
  const value = Reflect.get(answers, q.question) ?? Reflect.get(answers, q.header) ?? Reflect.get(answers, "Question 1");
  return typeof value === "string" ? value : null;
}
/** Only exact completed question/answer pairs count; a returned tool call is not an answer. */
export function timelineSelections(items: readonly AgentTimelineItem[]) {
  return items.flatMap((item, index) => {
    if (item.type !== "tool_call" || !["request_user_input_async", "request_user_input"].includes(item.name) ||
        item.status !== "completed" || item.error !== null || item.detail.type !== "plain_text") return [];
    const detail = item.detail.text ?? "";
    const answer = items.slice(index + 1).find(row => row.type === "user_message");
    if (answer?.type !== "user_message" || answer.text !== "Answers to your questions:\n\n" + detail) return [];
    return (Object.keys(EXECUTOR_QUESTIONS) as SelectionStage[]).flatMap(stage => {
      const prefix = EXECUTOR_QUESTIONS[stage].question + "\n";
      return detail.startsWith(prefix) ? [{ id: item.callId, stage, value: detail.slice(prefix.length).trim() }] : [];
    });
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
export async function applySelection(
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

export function sequentialSelectionPrompt(catalogs: Record<string, readonly ExecutorModel[]>) {
  const rows = Object.entries(catalogs).map(([provider, models]) => `${provider}:\n` + models
    .filter(x => x.isSelectable !== false)
    .map(x => `${provider}/${x.id}: 추론 ${(x.thinkingOptions ?? []).map(o => o.id).join(", ") || "없음"}`).join("\n")).join("\n");
  return `\n<paseo-executor-selection-v4>
연합개발에서만 적용한다. 조사·설계 전에 다음 세 단계를 질문 도구로 순서대로 진행한다. 일반개발에서는 이 질문을 하지 않는다.
각 단계는 단독 호출이며 실제 사용자 답변을 받은 뒤 다음 단계로 간다. 비동기 도구 호출의 반환은 답변이 아니다.
1. 질문/header: ${EXECUTOR_QUESTIONS.provider.question}/${EXECUTOR_QUESTIONS.provider.header}. 선택지 Codex, Claude Code. 최초와 같은 제품도 허용한다.
2. 질문/header: ${EXECUTOR_QUESTIONS.model.question}/${EXECUTOR_QUESTIONS.model.header}. 답변받은 제품의 실행 가능한 모델만 제시한다. 선택지 이름은 provider/모델ID 그대로 쓰며 설명·추천 접미사를 붙이지 않는다.
3. 질문/header: ${EXECUTOR_QUESTIONS.thinking.question}/${EXECUTOR_QUESTIONS.thinking.header}. 선택한 모델의 추론 ID만 선택지 이름으로 쓰며 접미사를 붙이지 않는다. 0개면 추론 없음, 1개면 해당 ID를 명시하고 확정한다. 여러 개면 답변을 실제로 받을 때까지 기다린다.
저장 선호는 추천일 뿐이다. 최초 요청에 명시한 제품/모델/추론만 이미 답한 항목으로 인정한다. 호스트 검증이 끝나기 전 실행 담당 생성·구현은 금지한다.
질문 도구나 카탈로그 실패는 사용자에게 알리고 대기한다. 확인 안 된 모델·추론을 기본값으로 대체하지 않는다. 모델 목록에 없는 입력은 확인 가능한 모델로 재선택한다.
${rows || "카탈로그를 읽지 못했습니다. 사용자에게 문제를 알리고 재조회 후 선택하세요."}
</paseo-executor-selection-v4>`;
}
