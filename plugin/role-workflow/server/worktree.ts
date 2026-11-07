import type { ManagedPush } from "../shared/managed-push";
import type { Settings } from "../shared/contracts";
import { capabilities } from "../shared/capabilities";
import type { Workflow, WorkflowPort } from "./engine";
import type { RepoProbe } from "./git";
import { resolvedFolder } from "./workspaces";

/** Where the executor changes files: its own worktree, or the shared task folder. */
export function workFolder(w: Workflow) {
  return w.isolation === "worktree" && w.worktree ? w.worktree.path : w.cwd;
}

/** Decide once at the first executor; the engine supplies its existing scope/writer overlap. */
export async function placeExecutor(
  w: Workflow,
  probe: RepoProbe | null,
  port: WorkflowPort,
  settings: Settings,
  blocker: { number: number; title: string } | null = null,
  choice?: "worktree" | "wait",
): Promise<boolean> {
  if (w.isolation === "worktree") {
    await checkWorktree(w, probe);
    return false;
  }
  if (w.isolation === "shared") return false;
  if (!capabilities(w).executorSelection || w.execute?.generation !== 1 || (!blocker && !choice)) {
    w.isolation = "shared";
    w.placement = null;
    return true;
  }
  let reason = "";
  const origin = !w.repositories.length && port.createWorktree && probe?.identity
    ? await probe.identity(w.cwd) : null;
  if (w.repositories.length) reason = "여러 저장소를 지정한 작업은 따로 작업 공간을 만들 수 없어 기다립니다.";
  else if (!port.createWorktree) reason = "현재 연결은 따로 작업 공간 만들기를 지원하지 않아 기다립니다.";
  else if (!origin) reason = "Git 저장소를 확인할 수 없어 기다립니다.";
  else if (!origin.branch) reason = "현재 Git 브랜치가 없어 기다립니다.";
  else if (origin.root !== await resolvedFolder(w.cwd)) reason = "저장소 안의 하위 폴더에서는 따로 작업 공간을 만들 수 없어 기다립니다.";
  const decision = reason ? "wait" : choice ?? settings.executorPlacement;
  if (decision === "ask") {
    w.placement = { stage: "choice", number: blocker!.number, title: blocker!.title, reason: "" };
    return true;
  }
  if (decision === "wait") {
    w.isolation = "shared";
    w.placement = { stage: "waiting", number: blocker?.number ?? 0, title: blocker?.title ?? "", reason };
    return true;
  }
  const made = await port.createWorktree!(w, origin!.branch, settings.titleMarker);
  const placed = await probe!.identity!(made.path);
  if (!placed || placed.common !== origin!.common)
    throw new Error(
      `구현 worktree(${made.path})가 작업 저장소와 다른 Git 저장소입니다. worktree를 확인한 뒤 재개하세요.`,
    );
  w.worktree = { path: placed.root, branch: placed.branch, base: placed.head, workspaceId: made.workspaceId };
  w.isolation = "worktree";
  w.placement = null;
  return true;
}

async function checkWorktree(w: Workflow, probe: RepoProbe | null) {
  const tree = w.worktree;
  const [placed, origin] = tree
    ? await Promise.all([probe?.identity?.(tree.path), probe?.identity?.(w.cwd)])
    : [null, null];
  if (!tree || !placed || !origin || placed.common !== origin.common)
    throw new Error(
      `구현 worktree(${tree?.path ?? "기록 없음"})를 찾을 수 없거나 작업 저장소와 다릅니다. worktree를 복구한 뒤 재개하세요.`,
    );
}

/** Both conversations learn where the executor works and how the result comes back. */
export function worktreeContext(w: Workflow) {
  if (w.isolation !== "worktree" || !w.worktree) return "";
  return (
    `구현 worktree: ${w.worktree.path} (브랜치 ${w.worktree.branch}, 기준 커밋 ${w.worktree.base}). ` +
    "구현 담당은 이 폴더에서만 변경하고 이 브랜치에 커밋한다. " +
    `작업 문서(handoff·impl-report·verdict)는 계획 담당 폴더 ${w.cwd}의 절대 경로를 쓴다. ` +
    "계획·검증 담당은 이 worktree에서 변경·커밋·시험을 확인하고, 푸시대상 commit에는 이 브랜치의 검증된 전체 커밋을 쓴다. " +
    "푸시가 끝나면 플러그인이 계획 담당 checkout을 그 커밋으로 빨리 감기(ff-only)한다.\n"
  );
}

/** After a verified push, the planner's checkout follows only as a fast-forward. */
export async function integrateWorktree(w: Workflow, probe: RepoProbe | null, record: Pick<ManagedPush, "targets">) {
  if (w.isolation !== "worktree" || !w.worktree || !probe?.identity || !probe.fastForward) return;
  const origin = await probe.identity(w.cwd);
  const target = record.targets.find((t) => origin && t.branch.replace(/^refs\/heads\//, "") === origin.branch);
  if (!origin || !target) {
    w.integration = {
      commit: record.targets[0]?.commit ?? "",
      ok: false,
      detail: "작업 폴더의 현재 브랜치와 푸시한 브랜치가 달라 로컬 반영을 건너뛰었습니다.",
    };
    return;
  }
  if (w.integration?.commit === target.commit && w.integration.ok) return;
  const result =
    origin.head === target.commit ? { ok: true, detail: "" } : await probe.fastForward(w.cwd, target.commit);
  w.integration = {
    commit: target.commit,
    ok: result.ok,
    detail: result.ok
      ? `작업 폴더의 ${origin.branch}를 푸시한 커밋 ${target.commit.slice(0, 12)}로 빨리 감기했습니다.`
      : `작업 폴더 반영 실패(직접 반영 필요): ${result.detail}`,
  };
}
