export async function x(port: any, w: any) {
  const { archiveCleaned: c } = WorkspaceLifecycle.prototype;
  return c.call(port.lifecycle({ port: () => port, db: async () => ({ workflows: [w] }), cleanupReadiness: async () => ({ stage: "ready", detail: "" }) }), w);
}
