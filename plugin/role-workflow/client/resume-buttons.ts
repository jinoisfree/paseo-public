import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { status } from "../shared/contracts";
import { resumePill } from "../shared/resume";
import { ResumePopover } from "./resume-popover";

interface Agent {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
}
export function registerResumeButtons(client: PluginClientContext) {
  const agents = new Map<string, Agent>();
  const pills = new Map<string, { workspaceId: string; button: PluginButtonRegistration }>();
  const lifetime = new AbortController();
  let stopped = false,
    reading = false,
    stale = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remove = (id: string) => {
    pills.get(id)?.button.remove();
    pills.delete(id);
  };
  async function refresh() {
    if (stopped) return;
    // An update during a read is applied by one more read right after it, not 15s later.
    if (reading) {
      stale = true;
      return;
    }
    reading = true;
    stale = false;
    try {
      const data = await client.rpc(status, {});
      if (stopped) return;
      if (data.error) throw new Error(data.error);
      for (const agent of agents.values()) {
        if (!agent.workspaceId || agent.archivedAt) {
          remove(agent.id);
          continue;
        }
        const target = resumePill(data.workflows, agent.id);
        let pill = pills.get(agent.id);
        if (pill && pill.workspaceId !== agent.workspaceId) {
          remove(agent.id);
          pill = undefined;
        }
        if (!pill && target) {
          pill = {
            workspaceId: agent.workspaceId,
            button: client.addComposerPill({
              id: "workflow-resume",
              workspaceId: agent.workspaceId,
              agentId: agent.id,
              button: {
                title: "자동 작업 재개",
                icon: "Play",
                label: target.label,
                behavior: { kind: "popover", Content: ResumePopover },
              },
            }),
          };
          pills.set(agent.id, pill);
        }
        pill?.button.update({ visible: !!target, label: target?.label ?? "재개" });
      }
    } catch (error) {
      if (!stopped) console.error("자동 작업 재개 버튼:", error);
    } finally {
      reading = false;
      if (stale) schedule(0);
    }
  }
  function schedule(delay = 1000) {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, delay);
  }
  // Agent events are coalesced; a slow poll also catches workflow-only changes.
  const interval = setInterval(() => schedule(0), 15000);
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      if (stopped) return;
      subscription.subscribe({
        snapshot: ({ entries }) => {
          agents.clear();
          for (const { agent } of entries) agents.set(agent.id, agent);
          for (const id of pills.keys()) if (!agents.has(id)) remove(id);
          schedule(0);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            agents.delete(update.agentId);
            remove(update.agentId);
          } else agents.set(update.agent.id, update.agent);
          schedule();
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!stopped) console.error("자동 작업 대화 구독:", error);
    });
  return () => {
    stopped = true;
    lifetime.abort();
    clearInterval(interval);
    clearTimeout(timer);
    for (const id of pills.keys()) remove(id);
    agents.clear();
  };
}
