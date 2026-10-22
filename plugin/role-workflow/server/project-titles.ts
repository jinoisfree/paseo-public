import type { PaseoApi } from "@getpaseo/client";
import { projectTitleLabel, replaceProjectTitleLabel } from "./protocol";

/** Called on project events and periodically, inside the engine's title mutation queue. */
export function createProjectTitleSync(getApi: () => PaseoApi) {
  const applied = new Map<string, string>();
  return async () => {
    const api = getApi();
    const { projects } = await api.projects.list();
    const labels = new Map(
      projects.map((project) => [
        project.projectId,
        projectTitleLabel(project.projectCustomName?.trim() || project.projectDisplayName),
      ]),
    );
    const changed = new Map([...labels].filter(([id, label]) => applied.get(id) !== label));
    for (const id of applied.keys()) if (!labels.has(id)) applied.delete(id);
    if (!changed.size) return;
    const failed = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await api.workspaces.list({ page: { limit: 200, cursor } });
      for (const row of page.entries) {
        if (!row.projectId || !changed.has(row.projectId)) continue;
        try {
          const workspace = api.workspaces.ref(row.id);
          const current = await workspace.refresh();
          if (!current || current.projectId !== row.projectId) continue;
          const title = replaceProjectTitleLabel(current.name, changed.get(row.projectId)!);
          if (title !== current.name) await workspace.setTitle(title);
        } catch {
          failed.add(row.projectId);
        }
      }
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    for (const [id, label] of changed) if (!failed.has(id)) applied.set(id, label);
    // A failed project remains pending so the next timer/event retries it.
    if (failed.size) throw new Error("일부 프로젝트 제목을 갱신하지 못해 다시 시도합니다.");
  };
}
