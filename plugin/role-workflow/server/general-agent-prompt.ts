import { GENERAL_QUESTIONS, type GeneralAgent } from "../shared/general-agent";

export function generalAgentPrompt(
  catalogs: Record<"claude" | "codex", string>,
  preferred: GeneralAgent,
  gated: boolean,
): string {
  const agent = GENERAL_QUESTIONS.agent;
  const labels =
    preferred.provider === "codex" ? ["Codex", "Claude Code"] : ["Claude Code", "Codex"];
  const questions = [catalogs.claude, catalogs.codex].filter(Boolean).join("\n");
  return `<paseo-general-agent-v1>
${gated ? "[일반개발 전용] 일반개발로 정해졌을 때만 적용한다. 연합개발에서는 이 블록을 무시한다.\n" : ""}일반개발이 정해진 직후, 조사 전에 담당을 고른다. 먼저 질문 도구를 단독 호출한다. 질문: ${agent.question}. header: ${agent.header}. 선택지: ${labels.join(", ")}. 추천: ${preferred.provider === "codex" ? "Codex" : "Claude Code"}${preferred.model ? ` / ${preferred.model} / ${preferred.thinking || "모델 기본값"}` : ""}.
그 답을 받은 뒤 고른 에이전트의 모델·추론을 한 번의 질문 도구 호출로 함께 묻는다. 아래 해당 에이전트 목록만 쓴다. 질문/header를 정확히 유지한다.
${questions || "모델 카탈로그를 읽지 못했다. 담당 질문을 생략하고 현재 대화 설정을 사용한다."}
선택한 에이전트의 목록이 없거나 질문 도구가 없거나 질문이 종료돼 답이 없으면 현재 대화 설정을 유지하고 첫 응답에 '기본값(현재 대화 설정) 사용'을 적는다. 비동기 답변 대기 중은 답 없음이 아니다.
사용자의 처음 요청에 에이전트·모델이 명시돼 있으면 묻지 않는다. 지정이 현재 설정과 다르면 작업을 시작하지 않고 호스트가 담당 대화를 준비하도록 응답을 마친다. 넘김 후 원래 대화에서 자동 전달하거나 작업하지 않는다.
고위험이면 규칙 00-common 3.4에 따라 본문으로 연합개발 전환을 요청한다. 일반개발에서는 input을 포함한 상태 블록을 출력하지 않는다.
</paseo-general-agent-v1>`;
}
