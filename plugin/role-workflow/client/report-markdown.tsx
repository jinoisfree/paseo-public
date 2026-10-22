// The completed Markdown AST is immutable; positional keys and per-token styles/handlers
// belong to this memoized render tree and do not drive independently updating components.
/* eslint-disable react/no-array-index-key, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-function-as-prop */
import { useMemo, type ReactNode } from "react";
import { Text, View, Linking } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { marked, type Token, type Tokens } from "marked";

/** Small native renderer for the text surrounding a report; specialized content stays native. */
export function ReportMarkdown({
  text,
  theme,
}: {
  text: string;
  theme: PluginTimelineItemProps<unknown>["theme"];
}) {
  const tokens = useMemo(() => marked.lexer(text), [text]);
  return useMemo(() => {
    const c = theme.colors;
    const body = { color: c.foreground, fontSize: 14, lineHeight: 22 };
    function inline(items: Token[]): ReactNode {
      return items.map((token, i) => {
        const children =
          "tokens" in token && token.tokens
            ? inline(token.tokens)
            : String("text" in token ? token.text : token.raw);
        if (token.type === "br") return "\n";
        if (token.type === "strong")
          return (
            <Text key={i} style={{ fontWeight: "700" }}>
              {children}
            </Text>
          );
        if (token.type === "em")
          return (
            <Text key={i} style={{ fontStyle: "italic" }}>
              {children}
            </Text>
          );
        if (token.type === "del")
          return (
            <Text key={i} style={{ textDecorationLine: "line-through" }}>
              {children}
            </Text>
          );
        if (token.type === "codespan")
          return (
            <Text key={i} style={{ backgroundColor: c.surface2 }}>
              {children}
            </Text>
          );
        if (token.type === "link")
          return (
            <Text
              key={i}
              accessibilityRole="link"
              style={{ textDecorationLine: "underline" }}
              onPress={() => {
                void Linking.openURL(String(token.href)).catch(() => {});
              }}
            >
              {children}
            </Text>
          );
        return <Text key={i}>{children}</Text>;
      });
    }
    function tableBlock(table: Tokens.Table, key: number) {
      return (
        <ScrollView key={key} horizontal>
          <View style={{ borderWidth: 1, borderColor: c.border }}>
            {[table.header, ...table.rows].map((row, rowIndex) => (
              <View
                key={rowIndex}
                style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: c.border }}
              >
                {row.map((cell, cellIndex) => (
                  <Text
                    key={cellIndex}
                    selectable
                    style={{
                      ...body,
                      padding: 8,
                      width: 200,
                      fontWeight: rowIndex === 0 ? "600" : "400",
                      textAlign: table.align[cellIndex] ?? "left",
                    }}
                  >
                    {inline(cell.tokens)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    }
    function blocks(items: Token[]): ReactNode {
      return items.map((token, i) => {
        if (token.type === "space" || token.type === "def") return null;
        if (token.type === "hr")
          return <View key={i} style={{ borderBottomWidth: 1, borderColor: c.border }} />;
        if (token.type === "blockquote")
          return (
            <View
              key={i}
              style={{ borderLeftWidth: 3, borderColor: c.border, paddingLeft: 10, gap: 8 }}
            >
              {blocks(token.tokens ?? [])}
            </View>
          );
        if (token.type === "code")
          return (
            <ScrollView key={i} horizontal>
              <Text selectable style={{ ...body, backgroundColor: c.surface2, padding: 10 }}>
                {String(token.text)}
              </Text>
            </ScrollView>
          );
        if (token.type === "list") {
          const list = token as Tokens.List;
          return (
            <View key={i} style={{ gap: 6 }}>
              {list.items.map((item, index) => (
                <View key={index} style={{ flexDirection: "row", gap: 8 }}>
                  <Text style={body}>{listMarker(item, list, index)}</Text>
                  <View style={{ flex: 1, gap: 6 }}>{blocks(item.tokens)}</View>
                </View>
              ))}
            </View>
          );
        }
        if (token.type === "table") return tableBlock(token as Tokens.Table, i);
        return (
          <Text
            key={i}
            selectable
            style={{
              ...body,
              ...(token.type === "heading"
                ? {
                    fontSize: Math.max(16, 24 - Number(token.depth) * 2),
                    fontWeight: "600" as const,
                  }
                : {}),
            }}
          >
            {"tokens" in token && token.tokens
              ? inline(token.tokens)
              : String("text" in token ? token.text : token.raw)}
          </Text>
        );
      });
    }
    return <View style={{ gap: 10 }}>{blocks(tokens)}</View>;
  }, [tokens, theme.colors]);
}
function listMarker(item: Tokens.ListItem, list: Tokens.List, index: number) {
  if (item.task) return item.checked ? "☑" : "☐";
  return list.ordered ? `${Number(list.start) + index}.` : "•";
}
