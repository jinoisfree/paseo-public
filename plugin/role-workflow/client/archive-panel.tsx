import { useState, type ReactNode } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { archiveFinished, type ArchiveEntry } from "../shared/contracts";

interface Props {
  archives?: ArchiveEntry[];
  styles: {
    text: StyleProp<TextStyle>;
    muted: StyleProp<TextStyle>;
    title: StyleProp<TextStyle>;
    card: StyleProp<ViewStyle>;
    row: StyleProp<ViewStyle>;
    spacing: StyleProp<ViewStyle>;
  };
  button: (title: string, onPress: () => void, id?: string) => ReactNode;
  run: (work: () => Promise<unknown>, success: string) => Promise<void>;
  notice: (message: string) => void;
  error: (message: string) => void;
}
export function ArchivePanel({ archives = [], styles: s, button, run, notice, error }: Props) {
  const tidy = useRpc(archiveFinished);
  const [preview, setPreview] = useState<RpcOutput<typeof archiveFinished> | null>(null);
  async function readPreview() {
    setPreview(null);
    const result = await tidy({ apply: false, ids: [] });
    setPreview(result);
    if (!result.rows.length) notice("보관할 완료 작업이 없습니다.");
  }
  async function applyPreview() {
    if (!preview) return;
    const result = await tidy({ apply: true, ids: preview.rows.map((row) => row.id) });
    setPreview(null);
    notice(
      `${result.archivedIds.length}개 보관했습니다.${result.archivedIds.length < preview.rows.length ? " 조건이 바뀐 작업은 보존했습니다." : ""}`,
    );
    if (result.errors.length) error(result.errors.map((item) => item.error).join("\n"));
  }
  return (
    <>
      <View style={s.card}>
        <Text style={s.title}>끝난 작업 정리</Text>
        <Text style={s.muted}>저장된 유예 설정을 만족한 🟢 완료 작업을 확인한 뒤 보관합니다.</Text>
        {button("완료 정리", () => void run(readPreview, ""), "workflow-archive-preview")}
        {!!preview?.rows.length && (
          <View style={s.spacing}>
            <Text style={s.text}>완료 작업 {preview.rows.length}개를 보관합니다.</Text>
            {preview.rows.map((row) => (
              <Text key={row.id} style={s.text}>
                {row.folder} #{String(row.number).padStart(2, "0")} {row.title}
              </Text>
            ))}
            <View style={s.row}>
              {button("확인 · 보관", () => void run(applyPreview, ""), "workflow-archive-apply")}
              {button("취소", () => setPreview(null))}
            </View>
          </View>
        )}
      </View>
      <View style={s.card} testID="workflow-archives">
        <Text style={s.title}>보관함 · {archives.length}개</Text>
        <Text style={s.muted}>최근 500개 작업을 보관한 순서로 표시합니다.</Text>
        {archives.map((item) => (
          <View key={item.id}>
            <Text style={s.text}>
              {item.progress !== "done" ? "🔵" : "🟢"} {item.folder} #
              {String(item.number).padStart(2, "0")} {item.title}
            </Text>
            <Text style={s.muted}>{new Date(item.archivedAt).toLocaleString()}</Text>
          </View>
        ))}
        {!archives.length && <Text style={s.muted}>보관한 끝난 작업이 없습니다.</Text>}
      </View>
    </>
  );
}
