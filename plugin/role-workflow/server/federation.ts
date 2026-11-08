import { readFile } from "node:fs/promises";
import path from "node:path";
import type { OperationalApi } from "./timeline-cards";
import { withBudget } from "./call-budget";
import { paseoHome } from "./paths";

export type FederationAvailability = { available: boolean; reason: string | null };
export async function federationAvailability(api: OperationalApi, cwd = "", home = paseoHome()): Promise<FederationAvailability> {
  try {
    let enabled: Record<string, { enabled?: boolean }> = {};
    try { enabled = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"))?.agents?.providers ?? {}; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const catalog = await withBudget("제품 목록", 5000, api.providers.listAvailable());
    if (catalog.error) throw new Error("제공자 조회 실패");
    const usable = await Promise.all((["claude", "codex"] as const).map(async provider => {
      if (enabled[provider]?.enabled === false || !catalog.providers.some(row => row.provider === provider && row.available)) return false;
      try {
        const result = await withBudget("제품 모델", 5000, api.providers.listModels(provider, cwd ? { cwd } : undefined));
        if (result.error) return null;
        return (result.models ?? []).some(model => model.isSelectable !== false);
      } catch { return null; }
    }));
    return usable.some(Boolean) ? { available: true, reason: null } : usable.includes(null) ? unknownAvailability() : {
      available: false, reason: "실행 가능한 Claude Code·Codex 제품이 없어 연합개발을 선택할 수 없습니다. 본체 제공자 설정과 모델 카탈로그를 확인하세요.",
    };
  } catch {
    return unknownAvailability();
  }
}

function unknownAvailability(): FederationAvailability {
  return { available: true, reason: "경고: 제품 상태를 확인하지 못했습니다. 연합개발은 허용하며 본체 카탈로그를 다시 확인하세요." };
}
