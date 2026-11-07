import type { PaseoApi } from "@getpaseo/client";
import { timelineCardSchemas, type TimelineCardKind } from "../shared/timeline-cards";

/** Validate the actual boundary object, including unknown keys, before append can mutate. */
export async function appendTimelineCard(api: PaseoApi | OperationalApi, agentId: string, id: string, kind: TimelineCardKind, data: unknown) {
  const checked = timelineCardSchemas[kind].parse(data);
  await sourceFor(api).agents.ref(agentId).timeline.append({ id, type: "plugin", kind, version: 1, data: checked });
}

export type TimelinePage = Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>;
export function readTimelinePage(api: PaseoApi | OperationalApi, id: string, options: Parameters<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>[0]) {
  return sourceFor(api).agents.ref(id).timeline.refetch(options);
}
export function subscribeAgentEvents(api: PaseoApi | OperationalApi, id: string, listener: Parameters<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["subscribe"]>[0]) {
  return sourceFor(api).agents.ref(id).timeline.subscribe(listener);
}

// Readers and ordinary workspace/agent operations receive handles without mutation capabilities.
const sources = new WeakMap<object, PaseoApi>();
export function operationalApi(source: PaseoApi) {
  const agent = (handle: ReturnType<PaseoApi["agents"]["ref"]>) => ({
    id: handle.id,
    refresh: (...args: Parameters<typeof handle.refresh>) => handle.refresh(...args),
    respondToPermission: (...args: Parameters<typeof handle.respondToPermission>) => handle.respondToPermission(...args),
    send: (...args: Parameters<typeof handle.send>) => handle.send(...args),
  });
  const workspace = (handle: ReturnType<PaseoApi["workspaces"]["ref"]>) => ({
    id: handle.id,
    refresh: (...args: Parameters<typeof handle.refresh>) => handle.refresh(...args),
    setTitle: (...args: Parameters<typeof handle.setTitle>) => handle.setTitle(...args),
    agents: { create: async (...args: Parameters<typeof handle.agents.create>) => agent(await handle.agents.create(...args)) },
  });
  const safe = {
    providers: source.providers,
    projects: source.projects,
    workspaces: {
      list: (...args: Parameters<PaseoApi["workspaces"]["list"]>) => source.workspaces.list(...args),
      ref: (id: string) => workspace(source.workspaces.ref(id)),
      create: async (...args: Parameters<PaseoApi["workspaces"]["create"]>) => workspace(await source.workspaces.create(...args)),
    },
    agents: {
      list: (...args: Parameters<PaseoApi["agents"]["list"]>) => source.agents.list(...args),
      ref: (id: string) => agent(source.agents.ref(id)),
    },
  };
  sources.set(safe, source);
  return safe;
}

export function eventItems<T>(event: { timeline?: readonly T[] }) { return event.timeline ?? []; }

export type OperationalApi = ReturnType<typeof operationalApi>;
function sourceFor(api: PaseoApi | OperationalApi): PaseoApi {
  const source = sources.get(api);
  if (source) return source;
  // Public read helpers also accept an SDK API directly; no raw handle escapes them.
  return api as PaseoApi;
}
