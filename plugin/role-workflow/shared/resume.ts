import type { RpcOutput } from "@getpaseo/plugin";
import type { control, status } from "./contracts";

type Workflow = RpcOutput<typeof status>["workflows"][number];
export function resumePill(workflows: readonly Workflow[], agentId: string) {
  const matches = workflows.filter(
    (w) => w.planAgentId === agentId || w.executeAgentId === agentId,
  );
  const w = matches.find((candidate) => candidate.status !== "completed") ?? matches[0];
  if (!w || w.mode !== "federated" || !["paused", "needs_input", "error"].includes(w.status))
    return null;
  return { id: w.id, label: w.status === "needs_input" ? "답변 필요" : "재개", detail: w.detail };
}

export function resumeResult(result: RpcOutput<typeof control>) {
  if (result.status !== "active") throw new Error(result.detail || "작업을 재개하지 못했습니다.");
  return `재개했습니다. ${result.detail}`;
}
