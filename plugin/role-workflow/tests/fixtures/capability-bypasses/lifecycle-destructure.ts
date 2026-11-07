export async function x(port: any, id: string) {
  const gate = port.lifecycle({ port: () => ({ archiveInspection: async () => ({ workspaces: [{ id, pinnedAt: null, cwd: "/tmp" }], conversations: [{ id: "a", workspaceId: id, status: "idle", activeTurn: false, permission: false }] }) }), db: async () => ({ workflows: [] }) });
  const { archive: go } = gate; return go.call(gate, id);
}
