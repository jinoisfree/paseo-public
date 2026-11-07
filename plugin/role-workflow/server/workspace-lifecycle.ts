import { operationalApi } from "./timeline-cards";
import { createRepoProbe } from "./git";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitEnvironment } from "./git-environment";
import { readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

import type { PaseoApi } from "@getpaseo/client";
import type { Workflow, WorkflowPort } from "./engine";
import type { PushReviewPort } from "./push-review";

export type CleanupReadiness = { stage: "ready" | "pending" | "skipped" | "done" | "failed"; detail: string; ownedPinAt?: string };
export interface LifecycleHost {
  port(): WorkflowPort;
  db(): Promise<{ workflows: Workflow[] }>;
  cleanupReadiness?(w: Workflow): Promise<CleanupReadiness>;
}

/** The only mutation boundary for workspace archive and automatic pins. */
export class WorkspaceLifecycle {
  constructor(private readonly host: LifecycleHost, private readonly transport: LifecycleTransport = {}) {}
  get supportsArchive() { return typeof this.transport.archiveWorkspace === "function"; }
  get supportsPins() { return !!this.transport.pushReview; }
  get supportsUnpin() { return typeof this.transport.pushReview?.unpin === "function"; }
  get(id: string) { return this.transport.pushReview?.get(id) ?? Promise.resolve(null); }
  private async executor(id: string) {
    return (await this.host.db()).workflows.find(w => w.isolation === "worktree" &&
      (w.execute?.workspaceId === id || w.worktree?.workspaceId === id));
  }
  async pinWorkspace(id: string): Promise<string> {
    if (await this.executor(id)) throw new Error("따로 작업 공간은 자동 고정하지 않습니다.");
    const port = this.transport.pushReview;
    if (!port) throw new Error("작업 공간 고정을 지원하지 않습니다.");
    // Do not take ownership of a pin placed since the caller's last inspection.
    const current = await port.get(id);
    if (!current || current.pinnedAt !== null) throw new Error("고정 상태가 바뀌어 보존합니다.");
    return port.pin(id);
  }
  async unpinOwned(id: string, expected: string): Promise<boolean> {
    const port = this.transport.pushReview;
    if (!port?.unpin || !expected) return false;
    const rows = (await this.host.db()).workflows.flatMap(w =>
      [...w.startPin?.workspaces ?? [], ...w.pushReview?.workspaces ?? []]);
    if (!rows.some(row => row.id === id && row.ownedPinAt === expected)) return false;
    const current = await port.get(id);
    if (!current || current.pinnedAt !== expected) return false;
    if (!await port.unpin(id, expected)) return false;
    return (await port.get(id))?.pinnedAt === null;
  }
  private async idleWorkspace(id: string) {
    const inspection = await this.host.port().archiveInspection([id]);
    const workspace = inspection.workspaces.find(ws => ws.id === id);
    const agents = inspection.conversations.filter(a => a.workspaceId === id);
    if (!workspace || workspace.pinnedAt !== null || workspace.archiving || !agents.length || agents.some(a =>
      a.archived !== true && (a.activeTurn !== false || a.permission !== false || !["idle", "closed"].includes(a.status)))) return null;
    return agents;
  }
  async archive(id: string): Promise<void> {
    if (await this.executor(id)) throw new Error("따로 작업 공간은 안전 정리 확인을 거쳐야 보관할 수 있습니다.");
    const inspection = await this.host.port().archiveInspection([id]);
    const cwd = inspection.workspaces.find(ws => ws.id === id)?.cwd;
    if (cwd) await verifyOrdinaryWorktree(cwd);
    if (!await this.idleWorkspace(id)) throw new Error("보관 직전 실행·권한·고정 상태가 바뀌어 보존합니다.");
    if (!cwd) throw new Error("작업 공간 디렉터리를 확인하지 못해 보존합니다.");
    await this.transport.archiveWorkspace!(id);
  }
  /** Only the engine-wired cleanup verifier can provide this call's single-use ready proof. */
  async archiveCleaned(w: Workflow): Promise<CleanupReadiness> {
    const id = w.worktree?.workspaceId;
    let proof: CleanupReadiness;
    try {
      if (!id || await this.executor(id) !== w) return { stage: "pending", detail: "따로 작업 공간 소속이 바뀌어 보존합니다." };
      if (!this.host.cleanupReadiness) return { stage: "pending", detail: "안전 정리 확인 증표가 없어 보존합니다." };
      proof = await this.host.cleanupReadiness(w);
      if (proof.stage !== "ready") return proof;
      // Last activity query is after every copy/unpin/Git check, immediately before mutation.
      const agents = await this.idleWorkspace(id);
      if (!agents || agents.length !== 1 || agents[0].id !== w.execute?.id)
        return { stage: "pending", detail: "보관 직전 실행·권한 상태가 바뀌어 따로 작업 공간을 보존합니다." };
      if (await this.executor(id) !== w) return { stage: "pending", detail: "보관 직전 소속이 바뀌어 보존합니다." };
    } catch {
      return { stage: "pending", detail: "보관 직전 상태를 조회하지 못해 보존합니다. 다음 점검 때 다시 확인합니다." };
    }
    await this.transport.archiveWorkspace!(id);
    return proof;
  }
}

interface LifecycleTransport {
  archiveWorkspace?(id: string): Promise<void>;
  pushReview?: PushReviewPort;
}

/** Raw capabilities stay in this closure; only policy-checked operations leave it. */
function createLifecycleFactory(getApi: () => PaseoApi, home: string) {
  const pins = createWorkspacePins(home);
  const transport: LifecycleTransport = {
    async archiveWorkspace(id) {
      // Preserve the former port budget at the capability boundary, including lost replies.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        getApi().workspaces.ref(id).archive(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("작업 공간 보관 응답이 30초 안에 도착하지 않았습니다.")), 30_000); }),
      ]).finally(() => clearTimeout(timer));
      if (result.error || !result.archivedAt || result.workspaceId !== id)
        throw new Error(result.error || "워크스페이스 보관을 확인하지 못했습니다.");
    },
    pushReview: {
      pin: pins.pin,
      async get(id) {
        const ws = await getApi().workspaces.ref(id).refresh();
        return ws ? { pinnedAt: ws.pinnedAt ?? null } : null;
      },
      async unpin(id, expected) {
        const ws = await getApi().workspaces.ref(id).refresh();
        if (!ws || ws.pinnedAt !== expected) return false;
        await pins.unpin(id);
        return true;
      },
    },
  };
  return { lifecycle: (host: LifecycleHost) => new WorkspaceLifecycle(host, transport), closeLifecycle: () => pins.close() };
}
/** The public workspace handle lacks pin(), so use the daemon's existing local pin RPC. */
export function pinDaemonUrl(listen: string) {
  const port = /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)$/.exec(listen)?.[1];
  if (!port || Number(port) < 1 || Number(port) > 65535)
    throw new Error("로컬 데몬 주소를 확인할 수 없습니다.");
  return `ws://127.0.0.1:${port}/ws`;
}

function createWorkspacePins(home: string) {
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

/** Protect native/external linked worktrees too; no Git mutation is used. */
async function verifyOrdinaryWorktree(cwd: string) {
  const run = async (args: string[]) => (await promisify(execFile)("git", ["-c", "core.fsmonitor=false", ...args],
    { cwd, env: gitEnvironment(), timeout: 5000, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
  // Locate an enclosing Git directory too: a workspace may start in a worktree subfolder.
  let folder: string;
  try { folder = await realpath(cwd); } catch { throw new Error("디렉터리를 확인하지 못해 작업 공간을 보존합니다."); }
  for (;;) {
    try { await lstat(path.join(folder, ".git")); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Git 디렉터리를 확인하지 못해 작업 공간을 보존합니다.");
      const parent = path.dirname(folder);
      if (parent === folder) return;
      folder = parent;
    }
  }
  try {
    const dir = await run(["rev-parse", "--path-format=absolute", "--git-dir"]);
    const common = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (dir === common) return;
    if (await run(["status", "--porcelain", "--untracked-files=all"]))
      throw new Error("커밋하지 않은 변경이 있어 연결된 worktree를 보존합니다.");
    const head = await run(["rev-parse", "--verify", "HEAD^{commit}"]);
    const probe = createRepoProbe();
    const hazards = await probe.cleanupHazards!(cwd, head);
    if (!hazards || hazards.length) throw new Error(hazards?.join("; ") || "숨겨진 Git 변경을 확인하지 못했습니다.");
    let included = false;
    for (const remote of (await run(["remote"])).split("\n").filter(Boolean)) {
      const prefix = `refs/remotes/${remote}/`;
      const refs = await run(["for-each-ref", "--contains=HEAD", "--format=%(refname)", prefix]);
      for (const ref of refs.split("\n").filter(ref => ref.startsWith(prefix) && ref !== prefix + "HEAD")) {
        if (await probe.pushedTarget!({ repository: cwd, remote, branch: ref.slice(prefix.length), commit: head }) === true) {
          included = true;
          break;
        }
      }
      if (included) break;
    }
    if (!included) throw new Error("HEAD의 원격 포함을 확인하지 못해 연결된 worktree를 보존합니다.");
  } catch (error) {
    throw new Error(`연결된 worktree 안전 검사를 통과하지 못해 보존합니다: ${error instanceof Error ? error.message : error}`);
  }
}

/** Entry point receives only the reduced API and policy-bound lifecycle factory. */
export function createWorkspaceAccess(home: string) {
  let source: PaseoApi | null = null;
  const getApi = () => {
    if (!source) throw new Error("Paseo 연결을 기다리고 있습니다.");
    return source;
  };
  return {
    attach(api: PaseoApi) { source = api; return operationalApi(api); },
    api: () => operationalApi(getApi()),
    ...createLifecycleFactory(getApi, home),
  };
}
