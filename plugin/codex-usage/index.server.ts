import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { discover, fetchUsage } from "./server/usage.js";

// 본체 제공자가 사용하는 Codex 홈의 사용량을 별도로 표시한다.
export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "codex-paseo",
    label: "Codex · Paseo 계정",
    icon: "icon.svg",
    input: inputSchema,
    discover: (scope) => discover(scope),
    fetch: fetchUsage,
  });
  return () => {};
}
