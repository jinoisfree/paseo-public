import path from "node:path";
import { proseArtifacts, pushTargetsSchema, type PushTarget } from "../shared/artifacts";
import { resolvedPushTargets } from "./artifacts";
import type { History, WorkflowPort } from "./engine";
import type { RepoProbe } from "./git";
import { parseDecision, parseProgress, type Decision } from "./protocol";
import { pushPending } from "./push-evidence";
import { pushReviewKey } from "./push-review";

export interface PushRecoveryInput {
  cwd: string;
  mode: "general" | "federated";
  repositories: string[];
  targets: PushTarget[];
  members: { id: string; role: "plan" | "execute" }[];
}

export type PushRecoveryResult =
  | { state: "none" | "retry" | "unverified"; reason: string }
  | {
      state: "pushed";
      targets: PushTarget[];
      receipt: { key: string; agentId: string; turnKey: string; calls: string[] };
      check: { checkedAt: string; targets: (PushTarget & { result: "pushed" })[] };
    };

interface Row {
  member: PushRecoveryInput["members"][number];
  turn: History;
}

function decision(text: string): Decision | undefined {
  const prose = text.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, "");
  if (!prose.includes("<paseo-workflow>")) return;
  if (prose.split("<paseo-workflow>").length > 2) throw new Error("ambiguous decision");
  return parseDecision(prose);
}

function blocked(turn: History): boolean {
  const report = turn.evidence?.report ?? turn.text;
  return (
    !turn.key ||
    turn.failed !== null ||
    !!turn.compacted ||
    pushPending(report) ||
    ["active", "plan"].includes(parseProgress(report) ?? "") ||
    ["active", "plan"].includes(parseProgress(turn.text) ?? "") ||
    ["active", "plan"].includes(parseProgress(turn.request ?? "") ?? "") ||
    ["plan", "continue", "input"].includes(decision(turn.text)?.status ?? "")
  );
}

function targetsIn(turn: History): PushTarget[] | undefined {
  const prose = proseArtifacts(turn.text);
  if (prose.invalidTargets) throw new Error("invalid push targets");
  return decision(turn.text)?.pushTargets ?? prose.pushTargets;
}

async function idle(input: PushRecoveryInput, port: WorkflowPort): Promise<boolean> {
  const snapshots = await Promise.all(input.members.map((member) => port.inspect(member.id)));
  return (
    snapshots.length > 0 &&
    snapshots.every((s) => s && s.status === "idle" && !s.permission && !s.archived)
  );
}

async function executions(row: Row, probe: RepoProbe): Promise<PushTarget[]> {
  const targets: PushTarget[] = [];
  for (const push of row.turn.evidence?.pushes ?? []) {
    if (!push.callId || !/^[a-f0-9]{7,64}$/.test(push.commit))
      throw new Error("push execution must contain an observed hash");
    const repository = await probe.repository?.(push.cwd);
    const commit = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(push.commit)
      ? push.commit
      : await probe.commit?.(push.cwd, push.commit);
    if (!repository || !commit?.startsWith(push.commit))
      throw new Error("unresolved push execution");
    const [target] = pushTargetsSchema.parse([
      {
        repository,
        remote: push.remote,
        branch: push.branch.replace(/^refs\/heads\//, ""),
        commit,
      },
    ]);
    // More than one write to a branch is deliberately ambiguous for unattended recovery.
    if (
      targets.some(
        (t) =>
          t.repository === repository && t.remote === target.remote && t.branch === target.branch,
      )
    )
      throw new Error("multiple push executions for one branch");
    targets.push(target);
  }
  return targets;
}

async function matchingTargets(
  input: PushRecoveryInput,
  rows: Row[],
  sources: Row[],
  probe: RepoProbe,
): Promise<PushTarget[] | null> {
  const actual = await Promise.all(sources.map((row) => executions(row, probe)));
  const expected = input.targets.length
    ? await resolvedPushTargets(probe, input.cwd, input.targets)
    : actual[0];
  const key = pushReviewKey(expected);
  if (!expected.length || actual.some((targets) => pushReviewKey(targets) !== key)) return null;
  for (const row of rows) {
    const reported = targetsIn(row.turn);
    if (reported && pushReviewKey(await resolvedPushTargets(probe, input.cwd, reported)) !== key)
      return null;
    if (sources.includes(row) && !reported) {
      const roots = await Promise.all(
        (input.repositories.length ? input.repositories : [input.cwd]).map((cwd) =>
          probe.repository?.(path.resolve(input.cwd, cwd)),
        ),
      );
      if (expected.some((target) => !roots.includes(target.repository))) return null;
    }
  }
  if (input.mode === "federated" && sources.some((row) => row.member.role === "execute")) {
    // An old executor result must not complete a newer planner task. Its latest final
    // review must explicitly attest these exact targets, without editing or new tools' pushes.
    const planner = rows.find((row) => row.member.role === "plan");
    if (
      !planner ||
      decision(planner.turn.text)?.status !== "complete" ||
      !targetsIn(planner.turn)?.length ||
      planner.turn.evidence?.changed
    )
      return null;
  }
  return expected;
}

async function inspectCurrentPush(
  input: PushRecoveryInput,
  port: WorkflowPort,
  probe: RepoProbe,
): Promise<PushRecoveryResult> {
  if (!port.pushAuditHistory || !probe.pushedTarget || !(await idle(input, port)))
    return {
      state: "retry",
      reason: "대화가 대기 상태가 되면 푸시 기록을 자동으로 다시 확인합니다.",
    };
  const rows = await Promise.all(
    input.members.map(async (member) => ({
      member,
      turn: await port.pushAuditHistory!(member.id),
    })),
  );
  if (rows.some((row) => blocked(row.turn)))
    return {
      state: "none",
      reason: "새 작업 또는 승인 대기 응답은 과거 푸시로 완료하지 않습니다.",
    };
  const sources = rows.filter((row) => row.turn.evidence?.pushes.length);
  if (!sources.length) {
    const claimed = rows.some(
      (row) => parseProgress(row.turn.evidence?.report ?? row.turn.text) === "pushed",
    );
    return claimed
      ? {
          state: "unverified",
          reason: "푸시 완료 보고는 있지만 성공한 실행 기록을 확인하지 못했습니다.",
        }
      : { state: "none", reason: "최신 응답에 확인할 푸시 실행이 없습니다." };
  }
  const targets = await matchingTargets(input, rows, sources, probe);
  if (!targets)
    return {
      state: "unverified",
      reason: "현재 작업 대상과 대화의 푸시 실행·최종 검토가 일치하지 않습니다.",
    };
  const remote = await Promise.all(targets.map((target) => probe.pushedTarget!(target)));
  if (remote.some((value) => value !== true))
    return {
      state: "retry",
      reason: "같은 푸시 대상 커밋의 원격 반영을 자동으로 다시 확인합니다.",
    };
  // Read again after slow Git checks. A new user message, response, or run cancels this result.
  const latest = await Promise.all(rows.map((row) => port.pushAuditHistory!(row.member.id)));
  if (
    latest.some((turn, index) => JSON.stringify(turn) !== JSON.stringify(rows[index].turn)) ||
    !(await idle(input, port))
  )
    return { state: "retry", reason: "조회 중 대화가 바뀌어 최신 기록을 다시 확인합니다." };
  const source = sources.find((row) => row.member.role === "plan") ?? sources[0];
  return {
    state: "pushed",
    targets,
    receipt: {
      key: pushReviewKey(targets),
      agentId: source.member.id,
      turnKey: source.turn.key,
      calls: source.turn.evidence!.pushes.map((push) => push.callId),
    },
    check: {
      checkedAt: new Date().toISOString(),
      targets: targets.map((target) => ({
        repository: target.repository,
        remote: target.remote,
        branch: target.branch,
        commit: target.commit,
        result: "pushed",
      })),
    },
  };
}

/** Read-only: never runs a push, replays a response, changes a workflow, or searches old turns. */
export async function inspectPushRecovery(
  input: PushRecoveryInput,
  port: WorkflowPort,
  probe: RepoProbe,
): Promise<PushRecoveryResult> {
  try {
    return await inspectCurrentPush(input, port, probe);
  } catch {
    return {
      state: "retry",
      reason: "대화 또는 원격 조회를 완료하지 못해 자동 재확인을 예약합니다.",
    };
  }
}
