import { readData } from "./data-records";
import { agentRulesBlock } from "./rules";
import type { WorkflowRole } from "../shared/assignment";
import { FEDERATED_ONLY, automationBlock, stripManagedBlocks } from "./protocol";

const START = "<paseo-role-workflow-v1>";
const END = "</paseo-role-workflow-v1>";
const BLOCK = /<paseo-role-workflow-v1>[\s\S]*?<\/paseo-role-workflow-v1>/gu;
const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

// Connected conversations hand work over through the state block. The copy-and-paste wording
// is only for conversations the plugin does not connect, where the user carries each message.
export function plannerInstructions(executor: string, automated: boolean): string {
  if (automated)
    return `당신은 이 사용자의 기획설계·검증 역할이다. 구현 실행은 별도의 ${executor} 대화에서 진행한다.
README의 단계별 읽기를 따른다. 기획·설계는 10-planning.md, 최종 검토는 30-verification.md, 인계는 40-paseo-role-workflow.md를 필요한 단계에 읽는다. 제품 코드는 고치지 않는다. git push는 직접 실행하지 않고 사용자의 화면 승인으로 플러그인이 실행한다. 실행 지시는 상태 블록 next에만 쓴다.
사용자가 명시적으로 역할 변경을 요청하면 그 요청을 따른다.
본문에는 사용자를 위한 분석과 계획 요약을 쓰고, next의 지시문을 본문에 다시 옮겨 적지 않는다.
완료 조건을 충족했다면 근거와 함께 완료라고 판단하고 불필요한 후속 작업을 만들지 않는다.

한국어로 설명한다. 전달은 호스트의 자동 작업 흐름이 담당한다.`;
  const handover = `4. 답변 마지막에 '${executor}에게 전달할 명령'을 작성한다. 사용자가 그대로 복사할 수 있도록 하나의 코드 블록에 목표, 관련 파일, 단계별 작업, 제약, 검증 명령과 기대 결과, 보고 항목을 담는다. 아직 확인하지 못한 경로나 명령은 확정된 사실처럼 쓰지 않는다. 앞선 대화를 보지 못한 ${executor}도 이해할 수 있어야 한다.
5. 사용자가 ${executor}의 작업 결과를 붙여넣으면 계획 충족 여부, 변경 내용, 테스트 결과, 누락과 회귀 가능성을 검토한다. 필요하면 실제 코드를 읽어 결과를 확인한다.
6. 추가 작업이 필요하면 다음 계획과 새로운 ${executor}용 실행 명령을 작성한다. 완료 조건을 충족했다면 근거와 함께 완료라고 판단하고 불필요한 후속 작업을 만들지 않는다.

한국어로 설명한다. ${executor}를 자동 실행하거나 메시지를 자동 전달하지 않는다. 사용자가 지시문과 결과를 복사하여 전달한다.`;
  return `당신은 이 사용자의 문제 분석·계획·검토 담당이다. 구현 실행은 별도의 ${executor} 대화에서 진행한다.

기본 작업 흐름:
1. 사용자의 요청과 관련 코드·환경·증거를 조사하여 문제점과 원인을 파악한다. 확인된 사실과 추정을 구분한다.
2. 목표, 수정 범위, 구현 순서, 완료 조건과 검증 방법을 포함한 구체적인 계획을 세운다.
3. 기본적으로 코드를 수정하거나 구현·배포를 실행하지 않는다. 분석에 필요한 읽기 전용 조사와 점검은 직접 수행한다. 사용자가 명시적으로 역할 변경을 요청하면 그 요청을 따른다.
${handover}`;
}

export function executorInstructions(planner: string, automated: boolean): string {
  if (automated)
    return `당신은 이 사용자의 구현 역할이다. 문제 분석과 구현 계획은 별도의 ${planner} 대화에서 준비한다.
README의 단계별 읽기에 따라 구현은 20-implementation.md, 인계는 40-paseo-role-workflow.md를 따른다. 인계 보고와 멈춤 보고는 result로 낸다.
전달받은 계획이나 실행 지시는 ${planner}가 세운 계획으로 간주한다. 사용자가 직접 요청한 작업도 그 요청의 범위에서 수행한다.
기존 사용자의 변경 사항을 보존한다. 사소한 구현 세부 사항은 판단하여 처리하되, 목표나 구조의 중대한 변경이 필요하면 ${planner}가 판단할 쟁점을 정리한다.
summary에 완료한 작업과 계획에서 달라진 점을, handoff에 원래 목표·변경 파일과 이유·미완료와 차단 사항·추가 검토가 필요한 내용을, checks에 실행한 검증 명령과 실제 결과를 쓴다. 본문에는 사용자를 위한 요약을 쓰고 같은 보고문을 다시 옮겨 적지 않는다.

한국어로 설명한다. 전달은 호스트의 자동 작업 흐름이 담당한다.`;
  const source = `1. 사용자가 전달한 계획이나 실행 지시문은 ${planner}가 세운 계획으로 간주한다. 사용자가 직접 요청한 작업도 그 요청의 범위에서 수행한다.`;
  const report = `5. 작업 후 답변 마지막에 '${planner}에게 전달할 결과'를 작성한다. 그대로 복사할 수 있도록 하나의 코드 블록에 원래 목표, 완료한 작업, 변경 파일과 이유, 실행한 검증 명령과 실제 결과, 미완료·차단 사항, 계획에서 달라진 점, 추가 검토가 필요한 내용을 담는다.
6. 실행하지 않은 테스트와 확인하지 못한 결과는 명확히 구분한다. 실제로 완료하지 않은 일을 완료했다고 보고하지 않는다.

한국어로 설명한다. ${planner}에게 자동으로 메시지를 보내지 않는다. 사용자가 결과 보고문을 복사하여 전달한다.`;
  return `당신은 이 사용자의 구현·검증 담당이다. 문제 분석과 구현 계획은 별도의 ${planner} 대화에서 준비한다.

기본 작업 흐름:
${source}
2. 관련 코드, 작업 디렉터리, 저장소 지침, 현재 변경 사항과 실행 환경을 확인한 뒤 계획대로 구현하고 필요한 검증을 수행한다.
3. 기존 사용자의 변경 사항을 보존하고, 요청 범위에 없는 리팩터링이나 기능 추가를 피한다.
4. 계획의 오류·충돌은 증거와 함께 설명한다. 사소한 구현 세부 사항은 판단하여 처리하되, 목표나 구조의 중대한 변경이 필요하면 임의로 확대하지 말고 ${planner}가 판단할 쟁점을 정리한다.
${report}`;
}

export const CLAUDE_INSTRUCTIONS = plannerInstructions("Codex", false);
export const CODEX_INSTRUCTIONS = executorInstructions("Claude", false);

export function appendRoleInstructions(
  provider: string,
  existing?: string,
  role?: WorkflowRole,
  options: { automated?: boolean; gated?: boolean; sharedRoles?: boolean } = {},
): string | undefined {
  if (provider !== "claude" && provider !== "codex") return existing;
  const counterpart = options.sharedRoles
    ? "선택된 담당 모델"
    : readData(NAMES, provider === "claude" ? "codex" : "claude");
  const automated = options.automated ?? false;
  // Without an explicit role each provider keeps its original one.
  const instructions =
    (role ?? (provider === "claude" ? "plan" : "execute")) === "plan"
      ? plannerInstructions(counterpart, automated)
      : executorInstructions(counterpart, automated);

  // Reapplying the plugin replaces its own block, preserving the caller's instructions.
  const original = (existing ?? "").replace(BLOCK, "").trim();
  const block = `${START}\n${options.gated ? `${FEDERATED_ONLY}\n` : ""}${instructions}\n${END}`;
  return original ? `${original}\n\n${block}` : block;
}

/**
 * Builds the whole system prompt in reading order: the caller's rules, the mode choice,
 * then the blocks that choice governs. A mode block makes those blocks federated-only.
 */
export function composePrompt(
  provider: string,
  existing: string | undefined,
  parts: {
    role?: WorkflowRole;
    automated: boolean;
    mode?: string;
    trailing?: string;
    rulesReadme?: string | null;
    sharedRoles?: boolean;
  },
): string | undefined {
  if (provider !== "claude" && provider !== "codex") return existing;
  const gated = !!parts.mode && !parts.sharedRoles;
  const original = stripManagedBlocks((existing ?? "").replace(BLOCK, ""));
  const lead = [original, agentRulesBlock(parts.rulesReadme), parts.mode?.trim()]
    .filter(Boolean)
    .join("\n\n");
  const role = appendRoleInstructions(provider, lead, parts.role, {
    automated: parts.automated,
    gated,
    sharedRoles: parts.sharedRoles,
  })!;
  return (parts.automated ? role + "\n" + automationBlock(gated) : role) + (parts.trailing ?? "");
}

/** Contract 4 keeps the initial configuration; only federation activates role instructions. */
export function composeCurrentPrompt(
  provider: string, existing: string | undefined, mode: "general" | "federated" | "undecided",
  rulesReadme: string | null, selection: string, trailing: string,
) {
  const original = stripManagedBlocks((existing ?? "").replace(BLOCK, ""));
  const choice = mode === "undecided"
    ? "첫 응답 전에 질문 도구로 진행 방식을 단독 질문한다. 질문·설명·읽기 전용 조사 요청이어도 생략하지 않는다. 질문/header: 진행 방식을 선택하세요/방식. 제목은 그대로 쓰고 설명은 제목 밖에 둔다. 선택지는 정확히 일반개발, 연합개발이다. 실제 답변 전에는 답변·조사·구현하지 않는다. 비동기 도구 반환은 답변이 아니다. 첫 사용자 요청의 첫 문장이 '연합개발', '연합개발로 진행해줘', '일반개발로 해줘'처럼 방식만 지정한 경우만 이미 답한 것으로 인정한다. '연합개발 테스트'처럼 방식 이름이 들어간 그 밖의 요청도 질문 도구로 묻는다. 도구가 없으면 채팅으로 묻고 기다린다."
    : `진행 방식은 ${mode === "general" ? "일반개발" : "연합개발"}이다. 진행 방식을 다시 묻지 않는다.`;
  const modeBlock = `<paseo-work-mode-v4>
${choice}
일반개발: 최초 대화와 처음 설정한 모델·추론으로 직접 조사·구현·자체 검증한다. 아래 연합개발 전용 블록, 구현 담당 선택, 상태 블록·인계 문서는 적용하지 않는다. 검증은 자체 점검으로 표시한다.
연합개발: 최초 대화는 기획·설계·검증 담당이고 구현은 사용자가 화면에서 고른 별도 대화가 맡는다. 최초 담당의 모델·추론을 바꾸지 않는다. 질문·설명 요청에는 note로 답하며 설명 요청만으로 구현 승인으로 보지 않는다.
정한 진행 방식은 이 작업 도중 바꾸지 않고(다른 방식은 새 작업) 압축 뒤에도 유지한다.
</paseo-work-mode-v4>`;
  if (mode === "general")
    return [original, agentRulesBlock(rulesReadme), modeBlock, trailing].filter(Boolean).join("\n\n");
  return composePrompt(provider, original, {
    role: "plan", automated: true, mode: modeBlock, rulesReadme,
    trailing: selection + trailing,
  })!;
}
