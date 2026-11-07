import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { z } from "zod";
import { selectPlacement } from "../shared/contracts";

export const placementPickerCardSchema = z.object({ workflowId: z.string(), number: z.number(), title: z.string() });

export function PlacementPickerCard({ item, theme }: PluginTimelineItemProps<z.infer<typeof placementPickerCardSchema>>) {
  const choose = useRpc(selectPlacement);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const { number, title, workflowId } = item.data;
  const c = theme.colors;
  const pick = useCallback(async (placement: "worktree" | "wait") => {
    setBusy(true);
    try {
      const result = await choose({ id: workflowId, placement });
      setMessage(result.detail);
      setDone(result.ok);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "구현 시작 방법을 정하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [choose, workflowId]);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: c.foreground }}>같은 폴더에서 다른 작업이 아직 진행 중이에요</Text>
      <Text style={{ color: c.foregroundMuted }}>#{number} {title} 작업이 이 폴더의 파일을 고치고 있어요. 두 작업이 같은 파일을 동시에 고치면 서로의 변경이 섞일 수 있어서, 어떻게 진행할지 골라 주세요.</Text>
      {!done && <>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void pick("worktree")} style={{ padding: 10, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}>
          <Text style={{ color: c.foreground }}>따로 작업 공간 만들어 바로 시작</Text>
        </Pressable>
        <Text style={{ color: c.foregroundMuted }}>이 폴더의 복사본(Git worktree)을 따로 만들어 지금 바로 구현을 시작해요. 서로 섞이지 않지만, 사이드바에 줄이 하나 더 생기고, 푸시한 뒤 원래 폴더로 합치는 단계가 있어요. 두 작업이 같은 곳을 고쳤다면 합칠 때 직접 정리해야 할 수 있어요.</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void pick("wait")} style={{ padding: 10, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}>
          <Text style={{ color: c.foreground }}>앞 작업이 끝나면 시작</Text>
        </Pressable>
        <Text style={{ color: c.foregroundMuted }}>지금 화면(같은 작업 공간)에서 그대로 진행해요. #{number} 작업이 끝나면 자동으로 시작해요. 섞일 걱정은 없지만 그동안 기다려야 해요.</Text>
      </>}
      {!!message && <Text style={{ color: c.foregroundMuted }}>{message}</Text>}
    </View>
  );
}
