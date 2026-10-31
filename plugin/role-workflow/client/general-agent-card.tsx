import { useMemo } from "react";
import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { z } from "zod";
import { generalAgentLabel, type generalCardSchema } from "../shared/general-agent";

export function GeneralAgentCard({
  item,
  theme,
}: PluginTimelineItemProps<z.infer<typeof generalCardSchema>>) {
  const styles = useMemo(
    () => ({
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
    }),
    [theme.colors.foreground, theme.colors.foregroundMuted],
  );
  return (
    <View>
      {item.data.planner && (
        <Text style={styles.text}>기획·설계·검증 · {generalAgentLabel(item.data.planner)}</Text>
      )}
      <Text style={styles.text}>{item.data.planner ? "구현" : "일반개발"} · {generalAgentLabel(item.data.choice)}</Text>
      <Text style={styles.muted}>{item.data.message}</Text>
    </View>
  );
}
