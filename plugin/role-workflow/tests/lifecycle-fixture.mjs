import { WorkspaceLifecycle } from "../server/workspace-lifecycle.ts";
export function installLifecycle(port) {
  port.lifecycle = host => new WorkspaceLifecycle(host, {
    get archiveWorkspace() { return port.archiveWorkspace; },
    get pushReview() { return port.pushReview; },
  });
  return port;
}
