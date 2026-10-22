import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { parseDecision } from "../shared/decision";
import { marked } from "marked";

/** Presentation only: the server continues to receive the unchanged original message. */
export const transformWorkflowReport: PluginTimelineTransformerContribution<"assistant_message">["transform"] =
  ({ item, phase }) => {
    if (phase !== "complete" || !item.text.includes("<paseo-workflow>")) return;
    try {
      const decision = parseDecision(item.text);
      const closing = item.text.lastIndexOf("</paseo-workflow>");
      let start = item.text.lastIndexOf("<paseo-workflow>", closing);
      while (start >= 0) {
        try {
          JSON.parse(item.text.slice(start + "<paseo-workflow>".length, closing));
          break;
        } catch {
          start = item.text.lastIndexOf("<paseo-workflow>", start - 1);
        }
      }
      if (start < 0) return;
      const prose = item.text.slice(0, start).trimEnd();
      // An example inside a fenced block must keep its original presentation.
      if ((prose.match(/^\s*```/gm)?.length ?? 0) % 2) return;
      // These features need Paseo's native file navigation or interactive fence renderer.
      if (/!\[|```\s*mermaid|\]\(<?(?:\/|\.\.?\/|file:|sandbox:)/i.test(prose)) return;
      let specialized = false;
      marked.walkTokens(marked.lexer(prose), (token) => {
        if (
          token.type === "image" ||
          token.type === "html" ||
          (token.type === "link" && !/^(?:https?:|mailto:)/i.test(token.href)) ||
          (token.type === "code" && /^(?:mermaid|diff)(?:\s|$)/i.test(token.lang ?? ""))
        )
          specialized = true;
      });
      if (specialized) return;
      return {
        items: [
          {
            type: "plugin" as const,
            kind: "workflow-report",
            version: 1,
            data: { decision, raw: item.text.slice(start), prose },
          },
        ],
      };
    } catch {
      // Invalid output remains visible for diagnosis and the engine's existing repair path.
      return;
    }
  };
