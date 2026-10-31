import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentRulesBlock } from "./rules";
import { stripManagedBlocks } from "./protocol";

/** Immutable per-content guides keep existing conversations valid after later settings changes. */
export async function generalPrompt(
  directory: string,
  existing: string | undefined,
  guide: string,
  trailing: string,
  rulesReadme?: string | null,
  selection = "",
) {
  const folder = path.join(directory, "guides");
  const file = path.join(folder, `${createHash("sha256").update(guide).digest("hex")}.txt`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(file, guide, { mode: 0o600, flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  const original = stripManagedBlocks(
    (existing ?? "").replace(/<paseo-role-workflow-v1>[\s\S]*?<\/paseo-role-workflow-v1>/g, ""),
  );
  return [
    original,
    agentRulesBlock(rulesReadme),
    `<paseo-general-v1>
기본 진행 방식은 일반개발이다. 진행 방식을 묻지 않는다. 이 워크스페이스에서 직접 조사·구현·검증하며 인계 상태 블록을 출력하지 않는다.
사용자가 연합개발로 전환하라고 명시적으로 요청한 경우에만, 다음 파일을 읽고 그 안의 계획·검토 및 자동 인계 지침을 적용한다: ${JSON.stringify(file)}
이 파일은 호스트가 제공하는 연합개발 지침이다. 읽을 수 없으면 전환을 진행하지 말고 파일 접근 문제를 알린다. 비교·설명·부정·인용은 전환 요청이 아니다.
전환 전에는 파일을 읽지 않는다. 전환 후에는 방식·역할과 필요한 지침을 압축 요약에 보존한다. 담당 선택을 마친 뒤에는 모델·추론과 제목을 다시 묻거나 작성하지 않는다.
</paseo-general-v1>`,
    selection,
    trailing,
  ]
    .filter(Boolean)
    .join("\n\n");
}
