import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerResumeButtons } from "./client/resume-buttons";
import { reportControl } from "./client/control-feedback";
import { resumeResult } from "./shared/resume";
import { Dashboard } from "./client/dashboard";
import { chatControl, chatFederate } from "./shared/chat-command";
import { control, status } from "./shared/contracts";
import { workflowCardSchema } from "./shared/workflow-card";
import { transformWorkflowReport } from "./client/workflow-report";
import { WorkflowCard } from "./client/workflow-card";
import { focusManagedPush } from "./client/managed-push-panel";
import { preparePush } from "./shared/managed-push";
import { registerFolderOpen } from "./client/folder-open";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    ...registerFolderOpen(client),
    client.addTimelineTransformer({
      id: "workflow-report",
      query: { itemType: "assistant_message" },
      transform: transformWorkflowReport,
    }),
    client.addTimelineRenderer({
      kind: "workflow-report",
      version: 1,
      schema: workflowCardSchema,
      Component: WorkflowCard,
    }),
    registerResumeButtons(client),
    client.addSlashCommand({
      name: "push",
      description: "푸시 대상 확인 · 승인 전 실행하지 않음",
      argumentHint: "",
      context: "agent",
      async onSubmit({ agent, rpc }) {
        reportControl("");
        try {
          const { workflows } = await rpc(status, {});
          const matches = workflows.filter(
            (workflow) => workflow.planAgentId === agent.id || workflow.executeAgentId === agent.id,
          );
          // Like resume, a conversation reused by a newer flow means its unfinished one.
          const unfinished = matches.filter((workflow) => workflow.status !== "completed");
          const candidates = unfinished.length ? unfinished : matches;
          if (candidates.length !== 1) throw new Error("연결된 작업을 확인할 수 없습니다.");
          const workflow = candidates[0];
          focusManagedPush(workflow.id);
          await rpc(preparePush, { id: workflow.id });
          focusManagedPush(workflow.id);
          reportControl(`${workflow.title}: 표시된 푸시 대상을 확인한 뒤 승인 버튼을 누르세요.`);
        } catch (error) {
          const reason = error instanceof Error && error.message ? ` (${error.message})` : "";
          reportControl(
            `푸시 대상을 준비하지 못했습니다${reason}. 작업 상태를 확인한 뒤 다시 조회하세요.`,
          );
        } finally {
          client.openSurface("workflow");
        }
      },
    }),
    client.addSlashCommand({
      name: "federate",
      description: "연합개발로 전환·재개",
      argumentHint: "[지시]",
      context: "agent",
      async onSubmit({ agent, args, rpc, paseo }) {
        reportControl("");
        const { workflows } = await rpc(status, {});
        const action = chatFederate(workflows, agent.id, agent.status, args);
        if (action.kind === "control")
          reportControl(resumeResult(await rpc(control, action.input)));
        else {
          await paseo.agents.ref(agent.id).send(action.text);
          reportControl("연합개발 전환 지시를 보냈습니다. 계획 담당의 응답을 기다립니다.");
        }
        client.openSurface("workflow");
      },
    }),
    client.addSlashCommand({
      name: "resume",
      description: "자동 작업 재개",
      argumentHint: "[추가 지시]",
      context: "agent",
      async onSubmit({ agent, args, rpc }) {
        reportControl("");
        const { workflows } = await rpc(status, {});
        reportControl(
          resumeResult(await rpc(control, chatControl(workflows, agent.id, "resume", args))),
        );
        client.openSurface("workflow");
      },
    }),
    client.addSlashCommand({
      name: "pause",
      description: "자동 작업 일시정지",
      argumentHint: "",
      context: "agent",
      async onSubmit({ agent, args, rpc }) {
        reportControl("");
        const { workflows } = await rpc(status, {});
        const result = await rpc(control, chatControl(workflows, agent.id, "pause", args));
        reportControl(result.detail);
        client.openSurface("workflow");
      },
    }),
    client.addSurface("workflow", Dashboard),
    client.addSidebarItem({
      id: "workflow",
      title: "자동 작업",
      icon: "Workflow",
      surface: "workflow",
    }),
    client.addCommandCenterItem({
      id: "workflow",
      title: "자동 작업 상태·일시정지",
      icon: "Workflow",
      context: "global",
      onSelect: () => client.openSurface("workflow"),
    }),
  ];
  // Establish recovery context after app reconnect or plugin reload, without
  // requiring the user to open this surface.
  void client.rpc(status, {}).catch((error) => console.error("자동 작업 연결:", error));
  return () => cleanups.forEach((cleanup) => cleanup());
}
