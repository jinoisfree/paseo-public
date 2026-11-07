import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { z } from "zod";
import { selectMode } from "../shared/contracts";

export const modePickerCardSchema = z.object({ workflowId: z.string() });

/** Posted when a request names a mode without choosing it; one press records the choice. */
export function ModePickerCard({ item, theme }: PluginTimelineItemProps<z.infer<typeof modePickerCardSchema>>) {
  const choose = useRpc(selectMode);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const c = theme.colors;
  const styles = useMemo(
    () => ({
      box: { gap: 8 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      text: { color: c.foreground },
      muted: { color: c.foregroundMuted },
      choice: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border },
    }),
    [c],
  );
  const pick = useCallback(
    async (mode: "general" | "federated") => {
      setBusy(true);
      try {
        const result = await choose({ id: item.data.workflowId, mode });
        setMessage(result.detail);
        setDone(result.ok);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "진행 방식을 정하지 못했습니다.");
      } finally {
        setBusy(false);
      }
    },
    [choose, item.data.workflowId],
  );
  return (
    <View style={styles.box}>
      <Text style={styles.text}>진행 방식을 선택하세요</Text>
      {!done && (
        <View style={styles.row}>
          {(
            [
              ["federated", "연합개발"],
              ["general", "일반개발"],
            ] as const
          ).map(([mode, label]) => (
            <Pressable key={mode} accessibilityRole="button" disabled={busy} onPress={() => void pick(mode)} style={styles.choice}>
              <Text style={styles.text}>{label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {!!message && <Text style={styles.muted}>{message}</Text>}
    </View>
  );
}
