import type { z } from "zod";
import type { workflowViewSchema } from "./contracts";

type ChatWorkflow = Pick<
  z.infer<typeof workflowViewSchema>,
  "id" | "status" | "planAgentId" | "executeAgentId"
>;

export function chatControl(
  workflows: readonly ChatWorkflow[],
  agentId: string,
  action: "pause" | "resume",
  args: string,
) {
  const matches = workflows.filter(
    (workflow) => workflow.planAgentId === agentId || workflow.executeAgentId === agentId,
  );
  const workflow = matches.find((match) => match.status !== "completed") ?? matches[0];
  if (!workflow) throw new Error("이 대화는 자동 작업에 연결되어 있지 않습니다.");
  if (action === "resume" && workflow.status === "active")
    throw new Error("이미 진행 중인 작업입니다.");
  if (action === "pause" && workflow.status !== "active")
    throw new Error("진행 중인 작업이 아닙니다.");
  return { id: workflow.id, action, message: action === "resume" ? args.trim() : "" };
}

type FederateWorkflow = ChatWorkflow & Pick<z.infer<typeof workflowViewSchema>, "mode">;
type FederateAction =
  | { kind: "control"; input: ReturnType<typeof chatControl> }
  | { kind: "message"; text: string };

export function chatFederate(
  workflows: readonly FederateWorkflow[],
  agentId: string,
  agentStatus: "initializing" | "idle" | "running" | "error" | "closed",
  args: string,
): FederateAction {
  const matches = workflows.filter(
    (workflow) => workflow.planAgentId === agentId || workflow.executeAgentId === agentId,
  );
  const workflow = matches.find((match) => match.status !== "completed") ?? matches[0];
  if (!workflow) throw new Error("이 대화는 자동 작업에 연결되어 있지 않습니다.");
  if (workflow.mode === "federated")
    return { kind: "control", input: chatControl([workflow], agentId, "resume", args) };
  if (workflow.planAgentId !== agentId)
    throw new Error("실행 대화에서는 전환할 수 없습니다. 계획 대화에서 입력하세요.");
  if (agentStatus === "running" || agentStatus === "initializing")
    throw new Error("응답 중입니다. 응답이 끝난 뒤 다시 입력하세요.");
  const instructions = args.trim();
  const prompt =
    "연합개발로 전환한다. 지금까지의 대화 맥락을 이어받아 연합개발 지침의 계획·검토 담당으로 진행하라.";
  const text = instructions ? `${prompt}\n\n추가 지시:\n${instructions}` : prompt;
  return { kind: "message", text };
}
