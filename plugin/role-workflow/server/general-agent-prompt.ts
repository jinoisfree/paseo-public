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
${gated ? "[일반개발 전용] 일반개발로 정해졌을 때만 적용한다. 연합개발에서는 이 블록을 무시한다.\n" : ""}일반개발이 정해진 직후, 조사 전에 구현 담당을 고른다. 최초 대화는 기획·설계·검증을 유지한다. 먼저 질문 도구를 단독 호출한다. 질문: ${agent.question}. header: ${agent.header}. 선택지: ${labels.join(", ")}. 추천: ${preferred.provider === "codex" ? "Codex" : "Claude Code"}${preferred.model ? ` / ${preferred.model} / ${preferred.thinking || "모델 기본값"}` : ""}.
그 답을 받은 뒤 고른 에이전트의 모델·추론을 한 번의 질문 도구 호출로 함께 묻는다. 아래 해당 에이전트 목록만 쓴다. 질문/header를 정확히 유지한다.
${questions || "모델 카탈로그를 읽지 못했다. 저장된 구현 담당을 명시하거나 사용자에게 구현 모델을 직접 입력받는다. 최초 모델이 구현을 대신하지 않는다."}
선택한 에이전트의 목록이나 질문 도구가 없으면 저장된 구현 담당을 명시하거나 사용자에게 선택을 요청한다. 질문 미응답·생성 실패 때 최초 대화가 구현을 대신하지 않는다. 비동기 답변 대기 중은 답 없음이 아니다.
사용자의 처음 요청에 에이전트·모델이 명시돼 있으면 묻지 않는다. 선택은 구현 담당 설정만 저장한다. 최초 대화의 모델·추론·역할은 바꾸지 않는다. 선택 후 기획·설계를 계속하고 handoff.md를 작성한 뒤 plan 상태로 인계한다. 호스트가 같은 워크스페이스에 별도 구현 대화를 만들고 결과를 최초 대화로 돌려보낸다.
제품 코드는 구현 담당만 수정한다. 구현 담당의 result 뒤 최초 대화가 실제 코드와 시험을 검증하고 verdict.md로 판정한다. plan/result/complete/input 상태 블록을 사용한다. 위험도별 독립 검토 조건은 00-common과 30-verification을 따른다.
</paseo-general-agent-v1>`;
}
