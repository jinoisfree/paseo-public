import { readFile } from "node:fs/promises";
import path from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/** The public workspace handle lacks pin(), so use the daemon's existing local pin RPC. */
export function pinDaemonUrl(listen: string) {
  const port = /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)$/.exec(listen)?.[1];
  if (!port || Number(port) < 1 || Number(port) > 65535)
    throw new Error("로컬 데몬 주소를 확인할 수 없습니다.");
  return `ws://127.0.0.1:${port}/ws`;
}

export function createWorkspacePins(home: string) {
  let client: DaemonClient | null = null;
  async function connected() {
    if (!client) {
      const pid = JSON.parse(await readFile(path.join(home, "paseo.pid"), "utf8"));
      client = new DaemonClient({
        clientId: "role-workflow-push-review",
        url: pinDaemonUrl(pid.listen),
        connectTimeoutMs: 5000,
        localCredential: async () =>
          (await readFile(path.join(home, "local-credential"), "utf8")).trim(),
      });
    }
    await client.connect();
    return client;
  }
  return {
    async pin(workspaceId: string) {
      const result = await (await connected()).setWorkspacePinned(workspaceId, true);
      if (!result.pinnedAt) throw new Error("상단 고정을 확인하지 못했습니다.");
      return result.pinnedAt;
    },
    async unpin(workspaceId: string) {
      const result = await (await connected()).setWorkspacePinned(workspaceId, false);
      if (result.pinnedAt) throw new Error("상단 고정 해제를 확인하지 못했습니다.");
    },
    async close() {
      await client?.close();
      client = null;
    },
  };
}
