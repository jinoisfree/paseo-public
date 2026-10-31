import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("general agent timeline card renders the durable agent, model and thinking without a state block", async () => {
  const result = await build({
    entryPoints: [new URL("../client/general-agent-card.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    alias: { "react-native": "react-native-web" },
    external: ["react", "react/jsx-runtime", "react-native-web"],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  const html = renderToStaticMarkup(
    createElement(module.exports.GeneralAgentCard, {
      item: {
        data: {
          choice: { provider: "codex", model: "chosen", thinking: "high" },
          message: "선택한 담당 대화로 넘겼습니다",
        },
      },
      theme: { colors: { foreground: "black", foregroundMuted: "gray" } },
    }),
  );
  assert.ok(html.includes("Codex · chosen · high"));
  assert.ok(html.includes("선택한 담당 대화로 넘겼습니다"));
  assert.ok(!html.includes("paseo-workflow"));
});
