import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useRpc, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { control, status } from "../shared/contracts";
import { resumePill, resumeResult } from "../shared/resume";
import { reportControl } from "./control-feedback";

export function ResumePopover(props: PluginButtonContentProps) {
  const read = useRpc(status),
    act = useRpc(control);
  const [target, setTarget] = useState<ReturnType<typeof resumePill>>(null);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const agentId = props.context === "agent" ? props.agentId : "";
  const s = useMemo(
    () => ({
      panel: { padding: 16, gap: 12, maxWidth: 360, backgroundColor: props.theme.colors.surface0 },
      text: { color: props.theme.colors.foreground },
      error: { color: props.theme.colors.statusDanger },
      input: {
        color: props.theme.colors.foreground,
        borderWidth: 1,
        borderColor: props.theme.colors.foregroundMuted,
        padding: 8,
        minHeight: 70,
      },
      button: { padding: 10, backgroundColor: props.theme.colors.accent, borderRadius: 8 },
      buttonText: { color: props.theme.colors.accentForeground },
    }),
    [props.theme],
  );
  useEffect(() => {
    let disposed = false;
    async function load() {
      try {
        const data = await read({});
        if (disposed) return;
        if (data.error) throw new Error(data.error);
        const next = resumePill(data.workflows, agentId);
        setTarget(next);
        if (!next) setResult("현재 재개할 멈춘 작업이 없습니다.");
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    }
    void load();
    return () => {
      disposed = true;
    };
  }, [read, agentId]);
  const resume = useCallback(async () => {
    if (!target || busy) return;
    setBusy(true);
    setError("");
    setResult("");
    try {
      const detail = resumeResult(
        await act({ id: target.id, action: "resume", message: message.trim() }),
      );
      setResult(detail);
      // The host closes the popover when the active workflow hides its pill.
      reportControl(detail);
      setTarget(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [target, busy, act, message]);
  return (
    <View style={s.panel}>
      <Text style={s.text}>{target?.detail ?? (result || "상태를 확인하고 있습니다…")}</Text>
      <TextInput
        accessibilityLabel="답변·추가 지시"
        placeholder="답변·추가 지시 (선택)"
        value={message}
        onChangeText={setMessage}
        multiline
        maxLength={30000}
        style={s.input}
      />
      <Pressable
        accessibilityRole="button"
        disabled={busy || !target}
        onPress={resume}
        style={s.button}
      >
        <Text style={s.buttonText}>{busy ? "재개 중…" : "재개"}</Text>
      </Pressable>
      {!!error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}
