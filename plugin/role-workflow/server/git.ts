import { execFile } from "node:child_process";
import { readdir, lstat, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PushTarget } from "../shared/artifacts";
import { resolvedFolder } from "./workspaces";

export interface Baseline {
  head: string;
  /** One row per changed path: its status line, a tab, then the file's size and write time. */
  dirty: string[];
  /** Present only when the working folder contains separate repositories. */
  repositories?: { name: string; head: string; dirty: string[] }[];
  incomplete?: boolean;
}
export interface RepoProbe {
  /** Also probes up to eight direct child directories outside a repository. */
  snapshot(cwd: string): Promise<Baseline | null>;
  /** What git shows changed since the baseline, as text for a reviewer. */
  changes(cwd: string, baseline: Baseline): Promise<string>;
  /** False when commits are missing from the upstream branch; null when git cannot tell. */
  pushed(cwd: string): Promise<boolean | null>;
  /** Pins HEAD and its upstream before checking, so a retry never follows a later commit. */
  pushTarget?(cwd: string): Promise<PushTarget | null>;
  /** Explicit targets never fall back to another repository or its current HEAD. */
  pushedTarget?(target: PushTarget): Promise<boolean | null>;
  repository?(cwd: string): Promise<string | null>;
  /** Resolve only a hash observed in a successful push; never substitute HEAD. */
  commit?(cwd: string, hash: string): Promise<string | null>;
}

const execute = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute("git", args, {
    cwd,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    // Agents run git in the same folder; a status refresh must not take the index lock.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}
const lines = (text: string, limit: number) => text.split("\n").filter(Boolean).slice(0, limit);

const ROWS = 400;
/**
 * The status line alone cannot show a second edit to a file that was already modified, so
 * each row also carries the file's size and write time. Untracked files are listed one by
 * one for the same reason: a folder's single row would hide what changes inside it.
 */
async function dirty(run: typeof git, cwd: string) {
  // Status paths are relative to the repository root, which need not be the flow's folder.
  const [top, status] = await Promise.all([
    run(cwd, ["rev-parse", "--show-toplevel"]),
    run(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]),
  ]);
  const entries = status.split("\0");
  const rows: { code: string; file: string }[] = [];
  let incomplete = false;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    if (rows.length === ROWS) {
      incomplete = true;
      break;
    }
    const code = entry.slice(0, 2);
    // A rename or copy is followed by the path it came from.
    if (code.includes("R") || code.includes("C")) index++;
    rows.push({ code, file: entry.slice(3) });
  }
  const values = await Promise.all(
    rows.map(async ({ code, file }) => {
      const info = await stat(path.join(top.trim(), file)).catch(() => null);
      return `${code} ${file}\t${info ? `${info.size}:${Math.round(info.mtimeMs)}` : "-"}`;
    }),
  );
  return { values, incomplete };
}

export function createRepoProbe(run: typeof git = git): RepoProbe {
  async function repository(cwd: string) {
    try {
      return resolvedFolder((await run(cwd, ["rev-parse", "--show-toplevel"])).trim());
    } catch {
      return null;
    }
  }
  async function pushedTarget(target: PushTarget): Promise<boolean | null> {
    try {
      const ref = target.branch.startsWith("refs/heads/")
        ? target.branch
        : `refs/heads/${target.branch}`;
      await run(target.repository, ["check-ref-format", ref]);
      await run(target.repository, ["cat-file", "-e", `${target.commit}^{commit}`]);
      const advertised = (
        await run(target.repository, ["ls-remote", "--exit-code", "--", target.remote, ref])
      )
        .trim()
        .split(/\s+/)[0];
      if (advertised === target.commit) return true;
      if (!advertised) return null;
      await run(target.repository, ["cat-file", "-e", `${advertised}^{commit}`]);
      try {
        await run(target.repository, ["merge-base", "--is-ancestor", target.commit, advertised]);
        return true;
      } catch {
        return false;
      }
    } catch {
      return null;
    }
  }
  async function pushTarget(cwd: string): Promise<PushTarget | null> {
    try {
      const root = await repository(cwd);
      if (!root) return null;
      const commit = (await run(root, ["rev-parse", "HEAD"])).trim();
      const branch = (await run(root, ["symbolic-ref", "--quiet", "HEAD"])).trim();
      const [remote, ref] = (
        await run(root, [
          "for-each-ref",
          "--format=%(upstream:remotename)%00%(upstream:remoteref)",
          branch,
        ])
      )
        .trim()
        .split("\0");
      if (!remote || remote === "." || !ref?.startsWith("refs/heads/")) return null;
      return { repository: root, remote, branch: ref.slice("refs/heads/".length), commit };
    } catch {
      return null;
    }
  }
  async function singleSnapshot(cwd: string): Promise<Baseline | null> {
    try {
      const head = (await run(cwd, ["rev-parse", "HEAD"])).trim();
      const status = await dirty(run, cwd);
      return { head, dirty: status.values, ...(status.incomplete ? { incomplete: true } : {}) };
    } catch {
      return null;
    }
  }
  async function evidence(cwd: string, baseline: Baseline) {
    const base = baseline.head;
    const [commits, summary, collected] = await Promise.all([
      run(cwd, ["log", "--oneline", "-n", "20", `${base}..HEAD`]),
      run(cwd, ["diff", "--stat=120", "--stat-count=40", base]),
      dirty(run, cwd),
    ]);
    const status = collected.values;
    const before = new Set(baseline.dirty);
    const tree = status
      .slice(0, 60)
      .map((row) => `${before.has(row) ? "  " : "★ "}${row.split("\t")[0]}`);
    const sections = [
      `플러그인이 git에서 직접 수집한 변경 증거 (실행 전 커밋 ${base.slice(0, 8)} 기준, 실행 보고와 대조할 것):`,
    ];
    const log = lines(commits, 20);
    if (log.length) sections.push(`새 커밋:\n${log.join("\n")}`);
    if (summary.trim()) sections.push(`실행 전 커밋 대비 변경 통계:\n${summary.trimEnd()}`);
    if (tree.length)
      sections.push(`작업 트리 상태 (★ = 실행 전과 달라진 항목):\n${tree.join("\n")}`);
    // A list cut off at the limit cannot vouch that nothing else changed.
    const complete = !collected.incomplete && !baseline.incomplete && baseline.dirty.length < ROWS;
    const unchanged =
      !log.length && status.length === before.size && status.every((row) => before.has(row));
    return { text: sections.join("\n"), complete, unchanged };
  }
  const noChanges =
    "실행 전과 비교해 달라진 파일이 감지되지 않았다. 보고된 변경이 실제로 있는지 확인할 것.";
  return {
    async commit(cwd, hash) {
      if (!/^[a-f0-9]{7,64}$/.test(hash)) return null;
      try {
        return (await run(cwd, ["rev-parse", "--verify", `${hash}^{commit}`])).trim();
      } catch {
        return null;
      }
    },
    repository,
    pushTarget,
    pushedTarget,
    async snapshot(cwd) {
      const single = await singleSnapshot(cwd);
      if (single) return single;
      // An unborn or unreadable repository is not a folder of independent repositories.
      try {
        await run(cwd, ["rev-parse", "--show-toplevel"]);
        return null;
      } catch {
        // Only direct, ordinary directories are candidates; never follow links.
      }
      const entries = await readdir(cwd, { withFileTypes: true }).catch(() => []);
      const candidates = entries
        .filter(
          (entry) =>
            entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      const repositories: NonNullable<Baseline["repositories"]> = [];
      let incomplete = candidates.length > 8;
      for (const entry of candidates.slice(0, 8)) {
        const child = path.join(cwd, entry.name);
        try {
          await run(child, ["rev-parse", "--show-toplevel"]);
        } catch {
          continue;
        }
        const baseline = await singleSnapshot(child);
        if (baseline) {
          repositories.push({ name: entry.name, head: baseline.head, dirty: baseline.dirty });
          incomplete ||= !!baseline.incomplete;
        } else incomplete = true;
      }
      return repositories.length ? { head: "", dirty: [], repositories, incomplete } : null;
    },
    async changes(cwd, baseline) {
      if (!baseline.repositories?.length) {
        const result = await evidence(cwd, baseline);
        if (!result.complete)
          return result.text + "\n조사 범위 제한으로 전체 변경 여부를 확정할 수 없다.";
        return result.text + (result.unchanged ? `\n${noChanges}` : "");
      }
      const sections = [
        `하위 저장소 조사 범위 (깊이 1, 최대 8개 디렉터리): ${baseline.repositories.map((repo) => repo.name).join(", ")}`,
      ];
      let complete = !baseline.incomplete;
      let unchanged = true;
      for (const repo of baseline.repositories) {
        sections.push(`저장소: ${repo.name}`);
        try {
          // A saved name must still designate a direct directory, even after a rename.
          if (
            path.basename(repo.name) !== repo.name ||
            repo.name.startsWith(".") ||
            repo.name === "node_modules"
          )
            throw new Error("invalid repository");
          const child = path.join(cwd, repo.name);
          if (!(await lstat(child)).isDirectory()) throw new Error("missing repository");
          const result = await evidence(child, repo);
          sections.push(result.text);
          complete &&= result.complete;
          unchanged &&= result.unchanged;
        } catch {
          complete = false;
          sections.push("변경 증거를 수집하지 못했다. 이 저장소는 직접 확인할 것.");
        }
      }
      if (!complete)
        sections.push("조사 범위 제한 또는 수집 실패로 전체 변경 여부를 확정할 수 없다.");
      if (complete && unchanged) sections.push(noChanges);
      return sections.join("\n");
    },
    async pushed(cwd) {
      const target = await pushTarget(cwd);
      return target ? pushedTarget(target) : null;
    },
  };
}
