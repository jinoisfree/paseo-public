import { WorkspaceLifecycle } from "../server/workspace-lifecycle.ts";
import { WorkflowEngine } from "../server/engine.ts";
/** Only transport observations are faked. Policy always comes from the actual engine. */
export class TestWorkflowEngine extends WorkflowEngine {
  constructor(file, port, notify, probe, now, runner) {
    const lifecycle = new WorkspaceLifecycle({
      get archiveWorkspace() { return port.archiveWorkspace; },
      get pushReview() { return port.pushReview; },
    }, ids => port.archiveInspection(ids));
    super(file, port, notify, probe, now, runner, lifecycle);
  }
}
export function archiveSdk(id, archive) {
  const agent = { id: "agent", workspaceId: id, status: "idle", pendingPermissions: [], activeTurn: null };
  return {
    workspaces: {
      list: async () => ({ entries: [{ id, pinnedAt: null, workspaceDirectory: "/tmp" }], pageInfo: {} }),
      ref: () => ({ archive }),
    },
    agents: {
      list: async () => ({ entries: [{ agent }], pageInfo: {} }),
      ref: () => ({ timeline: { refetch: async () => ({ agent, entries: [], hasNewer: false }) } }),
    },
  };
}
