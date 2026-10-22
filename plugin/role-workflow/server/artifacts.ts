import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  pushTargetSchema,
  verificationRecordSchema,
  type PushTarget,
  type Verification,
} from "../shared/artifacts";
import type { RepoProbe } from "./git";

export const pushCheckSchema = z.object({
  checkedAt: z.string(),
  targets: z
    .array(pushTargetSchema.extend({ result: z.enum(["pushed", "missing", "unknown"]) }))
    .max(8),
});
export { verificationRecordSchema };

export async function repositoryPaths(
  probe: RepoProbe | null,
  cwd: string,
  paths: readonly string[],
) {
  if (!probe?.repository) throw new Error("저장소 경로를 확인할 수 없습니다.");
  const roots: string[] = [];
  for (const value of paths) {
    const root = await probe.repository(path.resolve(cwd, value));
    if (!root) throw new Error(`Git 저장소를 확인할 수 없습니다: ${value}`);
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

export async function resolvedPushTargets(
  probe: RepoProbe | null,
  cwd: string,
  targets: readonly PushTarget[],
) {
  const result: PushTarget[] = [];
  for (const target of targets) {
    const [repository] = await repositoryPaths(probe, cwd, [target.repository]);
    const next = { ...target, repository, branch: target.branch.replace(/^refs\/heads\//, "") };
    if (
      result.some(
        (entry) =>
          entry.repository === repository &&
          entry.remote === next.remote &&
          entry.branch === next.branch,
      )
    )
      throw new Error("같은 원격 브랜치의 푸시 대상이 중복되었습니다.");
    result.push(next);
  }
  return result;
}

export async function inspectVerification(
  probe: RepoProbe | null,
  cwd: string,
  item: Verification,
) {
  const directory = path.resolve(cwd, item.cwd);
  const result = {
    ...item,
    cwd: directory,
    logPath: path.resolve(directory, item.logPath),
    checkedAt: new Date().toISOString(),
  };
  const log = await stat(result.logPath).catch(() => null);
  if (!log?.isFile())
    return {
      ...result,
      state: "unavailable" as const,
      detail: "검증 로그 파일을 확인할 수 없습니다.",
    };
  if (item.exitCode === null)
    return { ...result, state: "unavailable" as const, detail: "실제 종료 코드가 없습니다." };
  if (item.exitCode !== 0)
    return { ...result, state: "failed" as const, detail: `검증 실패: 종료 ${item.exitCode}` };
  const snapshot = await probe?.snapshot(result.cwd).catch(() => null);
  if (!snapshot || snapshot.repositories?.length || snapshot.incomplete)
    return {
      ...result,
      state: "unavailable" as const,
      detail: "검증 대상 변경본을 확정할 수 없습니다.",
    };
  if (snapshot.head !== item.commit || snapshot.dirty.length)
    return {
      ...result,
      state: "changed" as const,
      detail: "현재 커밋 또는 작업 트리가 검증 기록과 다릅니다. 변경 범위를 확인하세요.",
    };
  return {
    ...result,
    state: "matched" as const,
    detail:
      "커밋·깨끗한 작업 트리·로그 존재 확인. 검사 내용과 실행 환경은 검토자가 확인해야 합니다.",
  };
}
