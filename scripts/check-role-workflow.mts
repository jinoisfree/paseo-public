// Adapted for the portable paseo-public distribution.
/** Read-only probe for the updater. Never reloads plugins or restarts the daemon. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const configFile = process.env.PASEO_PUBLIC_CONFIG ?? path.join(homedir(), ".config/paseo-public/config.json");
let config: { pluginPath?: string; profiles?: Record<string, { pluginPath?: string }> } = {};
try { config = JSON.parse(await readFile(configFile, "utf8")); } catch { /* Default layout. */ }
const pluginPath = config.profiles?.[root]?.pluginPath ?? config.pluginPath ?? path.join(root, "plugin/role-workflow");
const { folderList } = await import(pathToFileURL(path.join(pluginPath, "shared/folders.ts")).href);

const expectedVersion = process.argv[2];
if (!expectedVersion) throw new Error("Expected app version argument is required");
const home = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
let client: DaemonClient | undefined;
let connected = false;
let daemonVersion: string | null = null;
const result = async () => {
  let pid;
  try {
    pid = JSON.parse(await readFile(path.join(home, "paseo.pid"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "deferred", summary: "소유 계정의 Paseo 데몬이 실행 중이 아닙니다." };
    }
    throw error;
  }
  if (!Number.isSafeInteger(pid.pid) || pid.pid <= 0) {
    return { status: "failed", summary: "데몬 프로세스 정보를 확인하지 못했습니다." };
  }
  try {
    process.kill(pid.pid, 0); // Existence check only; never starts or stops a daemon.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return { status: "deferred", summary: "소유 계정의 Paseo 데몬이 실행 중이 아닙니다." };
    }
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
  const port = /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)$/.exec(pid.listen)?.[1];
  if (!port) return { status: "failed", summary: "로컬 데몬 주소를 확인하지 못했습니다." };
  client = new DaemonClient({
    clientId: "fold-reapply-plugin-check",
    url: `ws://127.0.0.1:${port}/ws`,
    appVersion: expectedVersion,
    localCredential: async () => (await readFile(path.join(home, "local-credential"), "utf8")).trim(),
  });
  await client.connect();
  connected = true;
  daemonVersion = client.getLastServerInfoMessage()?.version ?? null;
  if (daemonVersion !== expectedVersion) {
    return { status: "waiting", summary: "새 버전 데몬 연결을 기다리고 있습니다." };
  }
  const plugin = (await client.listPlugins()).find((entry) => entry.id === "role-workflow");
  if (!plugin?.enabled || plugin.status !== "running" || plugin.error) {
    return { status: "failed", summary: `플러그인이 정상 로드되지 않았습니다 (${plugin?.status ?? "없음"}).` };
  }
  const folders = folderList.output.parse(await client.invokePluginRpc("role-workflow", "workflow.folders", {}));
  return { status: "passed", summary: "role-workflow 플러그인 점검 정상", foldersCount: folders.folders.length };
};
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  const output = await Promise.race([
    result(),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("probe timeout")), 10000);
    }),
  ]);
  console.log(JSON.stringify({ ...output, daemonVersion }));
} catch {
  // Connection loss during an update is retried by the bounded Python wait loop.
  // Do not expose credentials, daemon paths or raw RPC errors in notifications.
  console.log(JSON.stringify({
    status: connected && daemonVersion === expectedVersion ? "failed" : "waiting",
    daemonVersion,
    summary: connected && daemonVersion === expectedVersion
      ? "플러그인 상태 또는 workflow.folders RPC를 확인하지 못했습니다."
      : "새 버전 데몬에 아직 연결하지 못했습니다.",
  }));
} finally {
  clearTimeout(timeout);
  await client?.close();
}
