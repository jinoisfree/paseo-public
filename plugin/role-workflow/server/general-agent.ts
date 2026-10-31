import { GENERAL_QUESTIONS, LEGACY_GENERAL_QUESTIONS, type GeneralAgent } from "../shared/general-agent";
import type { PaseoAgentConfig } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export type GeneralQuestion = keyof typeof GENERAL_QUESTIONS;
export function generalQuestionNames(input: unknown): GeneralQuestion[] {
  const questions = input && typeof input === "object" ? Reflect.get(input, "questions") : null;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((q) =>
    Object.entries(GENERAL_QUESTIONS).flatMap(([name, value]) =>
      q &&
      [value, LEGACY_GENERAL_QUESTIONS[name as GeneralQuestion]].some((v) =>
        q.question === v.question || q.title === v.question || q.header === v.header)
        ? [name as GeneralQuestion]
        : [],
    ),
  );
}
export function generalAnswers(
  input: unknown,
  names: readonly GeneralQuestion[],
): Partial<Record<GeneralQuestion, string>> {
  const answers = input && typeof input === "object" ? Reflect.get(input, "answers") : null;
  if (!answers || typeof answers !== "object") return {};
  return Object.fromEntries(
    names.flatMap((name, index) => {
      const q = GENERAL_QUESTIONS[name];
      const legacy = LEGACY_GENERAL_QUESTIONS[name];
      const value =
        Reflect.get(answers, legacy.question) ?? Reflect.get(answers, legacy.header) ??
        Reflect.get(answers, q.question) ??
        Reflect.get(answers, q.header) ??
        Reflect.get(answers, `Question ${index + 1}`);
      return typeof value === "string" ? [[name, value]] : [];
    }),
  );
}

/** Only an exact completed native question/answer pair is accepted as a Codex choice. */
export function asyncGeneralAnswers(
  items: readonly AgentTimelineItem[],
): Partial<Record<GeneralQuestion, string>> {
  const result: Partial<Record<GeneralQuestion, string>> = {};
  for (const [i, item] of items.entries()) {
    if (
      item.type !== "tool_call" ||
      item.name !== "request_user_input_async" ||
      item.status !== "completed" ||
      item.error !== null ||
      item.detail.type !== "plain_text" ||
      !item.detail.text
    )
      continue;
    const detail = item.detail.text;
    const next = items.slice(i + 1).find((row) => row.type === "user_message");
    if (next?.type !== "user_message" || next.text !== "Answers to your questions:\n\n" + detail)
      continue;
    for (const [name, q] of Object.entries(GENERAL_QUESTIONS)) {
      for (const variant of [q, LEGACY_GENERAL_QUESTIONS[name as GeneralQuestion]]) {
        const entry = detail.split("\n\n").find((part) => part.startsWith(variant.question + "\n"));
        if (entry) result[name as GeneralQuestion] = entry.slice(variant.question.length + 1).trim();
      }
    }
  }
  return result;
}
export function configChoice(config: PaseoAgentConfig): GeneralAgent {
  const [provider, ...model] = config.provider.split("/");
  return {
    provider: provider === "codex" ? "codex" : "claude",
    model: model.join("/"),
    thinking: config.thinkingOptionId ?? "",
  };
}
export function choiceFromAnswers(
  provider: GeneralAgent["provider"],
  answers: Partial<Record<GeneralQuestion, string>>,
): GeneralAgent | null {
  if (!answers.model) return null;
  const model =
    new RegExp(`${provider}/([^\\s()]+)`).exec(answers.model)?.[1] ?? answers.model.trim();
  const thinking = /^(?:기본값|모델 기본값)$/.test(answers.thinking ?? "")
    ? ""
    : (answers.thinking?.trim() ?? "");
  if (!/^[A-Za-z0-9_.:-]+$/.test(model) || !/^[A-Za-z0-9_.-]*$/.test(thinking)) return null;
  return { provider, model, thinking };
}
export function explicitGeneralChoice(request: string): GeneralAgent | null {
  const lines = request.trim().split("\n");
  const first = /^(?:일반개발|일반개발로)$/.test(lines[0])
    ? (lines[1] ?? "")
    : lines[0].replace(/^일반개발\s*[:：]\s*/, "");
  if (/[?？"'`]|비교|예시|가정|하지|말고|아니/.test(first)) return null;
  const combined = /^(claude|codex)\/([A-Za-z0-9_.:-]+)(?=\s|$)/i.exec(first);
  const named = /^(Claude(?: Code)?|Codex)\s+모델\s*[:=]?\s*([A-Za-z0-9_.:-]+)(?=\s|$)/i.exec(
    first,
  );
  const provider = (combined?.[1] ?? named?.[1])?.toLowerCase();
  const model = combined?.[2] ?? named?.[2];
  if (!provider || !model) return null;
  return choiceFromAnswers(provider === "codex" ? "codex" : "claude", {
    model,
    thinking: /추론\s*[:=]?\s*([A-Za-z0-9_.-]+)/.exec(first)?.[1],
  });
}
