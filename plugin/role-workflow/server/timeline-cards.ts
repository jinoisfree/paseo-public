import type { PaseoApi } from "@getpaseo/client";
import { timelineCardSchemas, type TimelineCardKind } from "../shared/timeline-cards";

/** Validate the actual boundary object, including unknown keys, before append can mutate. */
export async function appendTimelineCard(api: PaseoApi, agentId: string, id: string, kind: TimelineCardKind, data: unknown) {
  const checked = timelineCardSchemas[kind].parse(data);
  await api.agents.ref(agentId).timeline.append({ id, type: "plugin", kind, version: 1, data: checked });
}
