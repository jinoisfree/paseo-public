import { useState, useMemo, useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { z } from "zod";
import type { workflowCardSchema } from "../shared/workflow-card";
import { ReportMarkdown } from "./report-markdown";

const labels = {
  plan: "실행 계획",
  result: "실행 결과 · 검토 대기",
  continue: "계속 진행",
  complete: "완료",
  input: "답변 필요",
  note: "안내",
};
export function WorkflowCard({
  item,
  theme,
}: PluginTimelineItemProps<z.infer<typeof workflowCardSchema>>) {
  const [details, setDetails] = useState(false);
  const [raw, setRaw] = useState(false);
  const d = item.data.decision;
  const c = theme.colors;
  const styles = useMemo(
    () => ({
      text: { color: c.foreground },
      muted: { color: c.foregroundMuted },
      title: { color: c.foreground, fontWeight: "600" as const },
      outer: { gap: 12 },
      inner: { gap: 10 },
      card: {
        gap: 10,
        padding: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
      },
    }),
    [c],
  );
  const detailState = useMemo(() => ({ expanded: details }), [details]);
  const rawState = useMemo(() => ({ expanded: raw }), [raw]);
  const toggleDetails = useCallback(() => setDetails((value) => !value), []);
  const toggleRaw = useCallback(() => setRaw((value) => !value), []);
  return (
    <View style={styles.outer}>
      {!!item.data.prose && <ReportMarkdown text={item.data.prose} theme={theme} />}
      <View style={styles.card}>
        <Text style={styles.title}>{labels[d.status]}</Text>
        <Text selectable style={styles.text}>
          {d.summary}
        </Text>
        {(d.verdict || d.status === "complete") && (
          <Text selectable style={styles.muted}>
            {d.verdict
              ? `판정: ${d.verdict.judgement} · ${d.verdict.condition} · ${d.verdict.path}`
              : "판정: 판정 없음"}
          </Text>
        )}
        {!!d.checks.length && (
          <Text
            selectable
            style={styles.muted}
          >{`검증 ${d.checks.length}건\n${d.checks.slice(0, 3).join("\n")}${d.checks.length > 3 ? "\n나머지 검증은 상세에서 확인" : ""}`}</Text>
        )}
        {d.status === "input" && !!d.next && (
          <Text selectable style={styles.text}>
            {d.next}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityState={detailState}
          onPress={toggleDetails}
        >
          <Text style={styles.text}>{details ? "상세 접기" : "인계·검증·다음 단계 보기"}</Text>
        </Pressable>
        {details && (
          <View style={styles.inner}>
            {!!d.next && d.status !== "input" && (
              <Text selectable style={styles.text}>{`다음 단계\n${d.next}`}</Text>
            )}
            <Text selectable style={styles.text}>{`인계\n${d.handoff}`}</Text>
            {!!d.checks.length && (
              <Text selectable style={styles.text}>{`검증\n${d.checks.join("\n")}`}</Text>
            )}
            {!!d.remember.length && (
              <Text selectable style={styles.text}>{`유지할 결정\n${d.remember.join("\n")}`}</Text>
            )}
            <Pressable accessibilityRole="button" accessibilityState={rawState} onPress={toggleRaw}>
              <Text style={styles.text}>{raw ? "원문 접기" : "상태 원문 보기"}</Text>
            </Pressable>
            {raw && (
              <Text selectable style={styles.text}>
                {item.data.raw}
              </Text>
            )}
          </View>
        )}
      </View>
    </View>
  );
}
