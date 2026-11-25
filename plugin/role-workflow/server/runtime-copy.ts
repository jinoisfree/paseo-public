import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeCopyStatus } from "../shared/contracts";
import { createRepoProbe, git } from "./git";

const CACHE_MS = 60_000;
const cache = new Map<string, { expires: number; status: Promise<RuntimeCopyStatus> }>();

export async function installedRuntimeRoot(home: string): Promise<string | null> {
  try {
    // Paseo evaluates a CJS bundle in memory. Its registered directory supplies the source location.
    const config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    const directory = config?.plugins?.["role-workflow"]?.path;
    if (typeof directory !== "string" || !path.isAbsolute(directory)) return null;
    return await createRepoProbe().repository!(directory);
  } catch {
    return null;
  }
}

function unknown(root: string | null): RuntimeCopyStatus {
  return { state: "unknown", root, branch: null, dirty: 0, ahead: 0, worktrees: 0, reasons: [] };
}

async function inspect(root: string): Promise<RuntimeCopyStatus> {
  try {
    const [ref, status, count, trees] = await Promise.all([
      git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch((error: unknown) => {
        if (typeof error === "object" && error && "code" in error && error.code === 1) return "";
        throw error;
      }),
      git(root, ["status", "--porcelain=v1", "--untracked-files=no"]),
      git(root, ["rev-list", "--count", "refs/remotes/origin/main..HEAD"]),
      git(root, ["worktree", "list", "--porcelain", "-z"]),
    ]);
    const branch = ref.trim() || null;
    const dirty = status.split("\n").filter(Boolean).length;
    const ahead = Number(count.trim());
    const worktrees = trees.split("\0").filter((row) => row.startsWith("worktree ")).length - 1;
    if (!Number.isSafeInteger(ahead) || ahead < 0 || worktrees < 0) return unknown(root);
    const reasons: RuntimeCopyStatus["reasons"] = [];
    if (branch !== "main") reasons.push("branch");
    if (dirty) reasons.push("dirty");
    if (ahead) reasons.push("ahead");
    if (worktrees) reasons.push("worktrees");
    return { state: reasons.length ? "drift" : "ok", root, branch, dirty, ahead, worktrees, reasons };
  } catch {
    return unknown(root);
  }
}

export function runtimeCopyStatus(root: string | null): Promise<RuntimeCopyStatus> {
  if (!root) return Promise.resolve(unknown(root));
  const now = Date.now();
  const existing = cache.get(root);
  if (existing && existing.expires > now) return existing.status;
  const status = inspect(root);
  cache.set(root, { expires: now + CACHE_MS, status });
  return status;
}
