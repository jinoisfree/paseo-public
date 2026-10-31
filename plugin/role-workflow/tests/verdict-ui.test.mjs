import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { decisionSchema } from "../shared/decision.ts";

test("workflow timeline card shows a compact verdict line and missing complete verdict", async () => {
  const result = await build({
    entryPoints: [new URL("../client/workflow-card.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    alias: { "react-native": "react-native-web" },
    external: ["react", "react/jsx-runtime", "react-native-web"],
    plugins: [
      {
        name: "sdk-scroll-view",
        setup(builder) {
          builder.onResolve({ filter: /^@getpaseo\/plugin\/client\/react-native$/ }, () => ({
            path: "sdk",
            namespace: "sdk",
          }));
          builder.onLoad({ filter: /.*/, namespace: "sdk" }, () => ({
            contents: 'export { ScrollView } from "react-native-web";',
            resolveDir: new URL("../", import.meta.url).pathname,
          }));
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  const render = (verdict, status = "complete") =>
    renderToStaticMarkup(
      createElement(module.exports.WorkflowCard, {
        item: {
          data: {
            decision: decisionSchema.parse({
              status,
              summary: "검토 결과",
              handoff: "검증 보고",
              ...(verdict ? { verdict } : {}),
            }),
            prose: "",
            raw: "",
          },
        },
        theme: {
          colors: {
            foreground: "black",
            foregroundMuted: "gray",
            border: "gray",
            surface1: "white",
          },
        },
      }),
    );
  assert.ok(
    render({ path: "docs/task/verdict.md", judgement: "완료", condition: "교차 모델" }).includes(
      "판정: 완료 · 교차 모델 · docs/task/verdict.md",
    ),
  );
  assert.ok(
    render(
      { path: "verdict.md", judgement: "부분 완료", condition: "단일 모델" },
      "input",
    ).includes("판정: 부분 완료 · 단일 모델 · verdict.md"),
  );
  assert.ok(render(null).includes("판정: 판정 없음"));
  assert.ok(!render(null, "result").includes("판정:"), "unrelated cards keep their layout");
});
