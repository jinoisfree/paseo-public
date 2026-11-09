import type { PaseoAgentConfig } from "@getpaseo/client";
import type { ExecutorModel } from "./protocol";

/** Shared by creation and reviewer eligibility: the provider default, then first selectable. */
export function resolveModelFromCatalog(config: PaseoAgentConfig, models: readonly ExecutorModel[] | undefined): string {
  const slash = config.provider.indexOf("/");
  const base = slash === -1 ? config.provider : config.provider.slice(0, slash);
  const requested = slash === -1 ? null : config.provider.slice(slash + 1);
  const available = models?.filter((entry) => entry.isSelectable !== false);
  const model =
    requested === null
      ? (available?.find((entry) => entry.isDefault) ?? available?.[0])
      : available?.find((entry) => entry.id === requested);
  if (!model)
    throw new Error(
      requested === null
        ? `${base}의 실행 모델을 찾을 수 없습니다.`
        : `${base}에 ${requested} 모델이 없습니다. 사용 가능: ${
            models
              ?.slice(0, 4)
              .map((entry) => entry.id)
              .join(", ") ?? "없음"
          }`,
    );
  const thinking = config.thinkingOptionId;
  const thinkingOptions = model.thinkingOptions ?? [];
  if (thinking && !thinkingOptions.some((option) => option.id === thinking))
    throw new Error(
      `${model.id}에 ${thinking} 추론 정도가 없습니다. 사용 가능: ${thinkingOptions.map((option) => option.id).join(", ") || "없음"}`,
    );
  return model.id;
}
