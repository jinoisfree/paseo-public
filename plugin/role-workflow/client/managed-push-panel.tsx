import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { status } from "../shared/contracts";
import { executePush, preparePush, recheckPush, type ManagedPush } from "../shared/managed-push";

let focus = { id: "", revision: 0 };
const listeners = new Set<() => void>();
const submitted = new Set<string>();
export function focusManagedPush(id: string) {
  focus = { id, revision: focus.revision + 1 };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useManagedPushFocus() {
  return useSyncExternalStore(subscribe, () => focus);
}

const labels: Record<ManagedPush["state"], string> = {
  prepared: "푸시 승인 대기",
  running: "푸시 실행 중",
  checking: "원격 반영 확인 중",
  pushed: "[PUSH] 원격 반영 확인",
  failed: "푸시 실패",
  unknown: "푸시 결과 확인 필요",
};
type Workflow = RpcOutput<typeof status>["workflows"][number];
interface Props {
  workflow: Workflow;
  refresh: () => Promise<void>;
  styles: {
    text: StyleProp<TextStyle>;
    muted: StyleProp<TextStyle>;
    error: StyleProp<TextStyle>;
    title: StyleProp<TextStyle>;
    card: StyleProp<ViewStyle>;
    row: StyleProp<ViewStyle>;
    spacing: StyleProp<ViewStyle>;
    button: StyleProp<ViewStyle>;
  };
}

function PushTargets({
  push,
  styles: s,
}: {
  push: NonNullable<Workflow["managedPush"]>;
  styles: Props["styles"];
}) {
  const remoteResult = (verified: boolean | null | undefined) => {
    if (verified === true) return "확인됨";
    return verified === false ? "확인되지 않음" : "확인 중";
  };
  return (
    <>
      {push.targets.map((target) => (
        <View key={`${target.repository}:${target.remote}:${target.branch}`} style={s.spacing}>
          <Text selectable style={s.text}>
            저장소: {target.repository}
          </Text>
          <Text selectable style={s.text}>
            원격: {target.remote} · {target.remoteUrl}
          </Text>
          <Text selectable style={s.text}>
            브랜치: {target.branch}
          </Text>
          <Text selectable style={s.text}>
            커밋: {target.commit}
          </Text>
          {push.state !== "prepared" && (
            <Text style={s.muted}>
              실행 종료: {target.exitCode ?? "확인 중"} · 원격 반영:{" "}
              {target.alreadyIncluded ? "이미 원격에 포함됨" : remoteResult(target.verified)}
            </Text>
          )}
        </View>
      ))}
    </>
  );
}

function VerificationRecords({ workflow: w, styles: s }: Pick<Props, "workflow" | "styles">) {
  const names = {
    matched: "대상 일치",
    failed: "검사 실패",
    changed: "대상 변경",
    unavailable: "확인 불가",
  };
  return (
    <>
      <Text style={s.text}>기록된 검증</Text>
      {(w.verification ?? []).map((check) => (
        <View
          key={`${check.command}:${check.cwd}:${check.commit}:${check.logPath}`}
          style={s.spacing}
        >
          <Text selectable style={s.muted}>
            {check.command}
          </Text>
          <Text selectable style={s.muted}>
            {check.cwd} · {check.commit}
          </Text>
          <Text style={s.muted}>
            종료 코드: {check.exitCode ?? "미기록"} · 기록 상태: {names[check.state]}
            {check.criterion ? ` · ${check.criterion}` : ""}
          </Text>
        </View>
      ))}
      {!w.verification?.length && (
        <Text style={s.muted}>
          이 작업에 연결된 검증 기록이 없습니다. 대화의 검증 결과를 확인하세요.
        </Text>
      )}
    </>
  );
}

function requestState(push: Workflow["managedPush"], uncertain: string) {
  return {
    waiting: !!push && ["running", "checking", "unknown"].includes(push.state),
    unresolved:
      !!push && push.state === "prepared" && (uncertain === push.id || submitted.has(push.id)),
  };
}

export function ManagedPushPanel({ workflow: w, refresh, styles: s }: Props) {
  const prepare = useRpc(preparePush),
    execute = useRpc(executePush),
    recheck = useRpc(recheckPush);
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState("");
  const push = w.managedPush;
  const history = w.pushHistory?.filter((record) => record.id !== push?.id) ?? [];
  const { waiting, unresolved } = requestState(push, uncertain);

  const run = useCallback(
    async (action: "prepare" | "execute" | "recheck") => {
      if (locked.current) return;
      if (action !== "prepare" && !push) return;
      if (action === "execute" && (push?.state !== "prepared" || submitted.has(push.id))) return;
      locked.current = true;
      setPending(true);
      setNotice("");
      if (action === "execute" && push) {
        submitted.add(push.id);
        setUncertain(push.id);
      }
      try {
        if (action === "prepare") {
          await prepare({ id: w.id });
          setNotice("아래 저장소·원격·커밋을 확인한 뒤 승인하세요.");
        } else if (action === "execute" && push) {
          await execute({ id: w.id, requestId: push.id, approved: true });
          setNotice("푸시 요청의 현재 상태를 확인했습니다.");
        } else if (push) {
          await recheck({ id: w.id, requestId: push.id });
          setNotice("현재 상태와 원격 반영을 다시 확인했습니다.");
        }
      } catch {
        setNotice(
          action === "execute"
            ? "요청 결과를 확인하지 못했습니다. 다시 실행하지 말고 ‘현재 상태 확인’으로 확인하세요."
            : "상태를 확인하지 못했습니다. 연결과 작업 상태를 확인한 뒤 다시 조회하세요.",
        );
      } finally {
        try {
          await refresh();
        } catch {
          setNotice("상태를 불러오지 못했습니다. 실행을 반복하지 말고 다시 조회하세요.");
        } finally {
          locked.current = false;
          setPending(false);
        }
      }
    },
    [prepare, execute, recheck, w.id, push, refresh],
  );
  const actions = useMemo(
    () => ({
      prepare: () => void run("prepare"),
      execute: () => void run("execute"),
      recheck: () => void run("recheck"),
    }),
    [run],
  );
  function button(label: string, action: "prepare" | "execute" | "recheck") {
    return (
      <Pressable
        accessibilityRole="button"
        testID={`managed-push-${action}-${w.id}`}
        disabled={pending || (action === "execute" && unresolved)}
        onPress={actions[action]}
        style={s.button}
      >
        <Text style={s.text}>{label}</Text>
      </Pressable>
    );
  }
  return (
    <View style={s.spacing} testID={`managed-push-${w.id}`}>
      <Text style={s.title}>{push ? labels[push.state] : "푸시"}</Text>
      {!!notice && (
        <Text accessibilityRole="alert" style={s.muted}>
          {notice}
        </Text>
      )}
      {pending && <Text style={s.muted}>요청 처리 중…</Text>}
      {!push && (
        <Text style={s.muted}>푸시할 대상을 확인하고 승인하면 앱이 실행 결과를 기록합니다.</Text>
      )}
      {push && (
        <>
          <PushTargets push={push} styles={s} />
          {push.state === "prepared" && (
            <>
              <Text style={s.muted}>
                표시된 커밋과 원격에만 적용됩니다. 대상이 바뀌면 다시 확인하고 승인해야 합니다.
              </Text>
              <VerificationRecords workflow={w} styles={s} />
              {unresolved ? (
                <Text style={s.muted}>
                  이 요청은 이미 전송했습니다. 실행을 반복하지 않고 현재 상태를 조회합니다.
                </Text>
              ) : (
                button("이 대상으로 푸시 승인·실행", "execute")
              )}
            </>
          )}
          {push.state === "failed" && (
            <Text style={s.error}>
              {push.error || "푸시를 완료하지 못했습니다. 원인을 확인한 뒤 대상을 다시 준비하세요."}
            </Text>
          )}
          {(waiting || unresolved) && (
            <Text style={s.muted}>결과가 확인될 때까지 새 푸시를 실행하지 않습니다.</Text>
          )}
          {button("현재 상태 확인", "recheck")}
        </>
      )}
      {!waiting &&
        !unresolved &&
        button(push ? "푸시 대상 다시 확인" : "푸시 대상 확인", "prepare")}
      {!!history.length && (
        <View style={s.spacing}>
          <Text style={s.text}>이전 푸시 기록</Text>
          {history.map((previous) => (
            <Text key={previous.id} style={s.muted}>
              {labels[previous.state]} ·{" "}
              {previous.targets
                .map((target) => `${target.remote}/${target.branch} ${target.commit.slice(0, 8)}`)
                .join(" · ")}{" "}
              · {new Date(previous.updatedAt).toLocaleString()}
            </Text>
          ))}
        </View>
      )}
      {!push && !!w.artifactNotice && (
        <Text style={s.muted}>
          대화만으로 푸시 결과를 확인하지 못한 경우에도 여기서 승인 대상과 실행 상태를 확인할 수
          있습니다.
        </Text>
      )}
    </View>
  );
}
