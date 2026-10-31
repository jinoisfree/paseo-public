import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RULES, RULES_VERSION } from "./rules-content";

const pending = new Map<string, Promise<string | null>>();

async function matches(directory: string): Promise<boolean> {
  try {
    return (
      await Promise.all(
        Object.entries(RULES).map(
          async ([name, body]) => (await readFile(path.join(directory, name), "utf8")) === body,
        ),
      )
    ).every(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function publish(directory: string): Promise<string> {
  const target = path.join(directory, RULES_VERSION);
  const readme = path.join(target, "README.md");
  if (await matches(target)) return readme;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(directory, ".staging-"));
  let displaced: string | undefined;
  try {
    const writes = await Promise.allSettled(
      Object.entries(RULES).map(([name, body]) =>
        writeFile(path.join(temporary, name), body, { mode: 0o600 }),
      ),
    );
    const failure = writes.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    // Repair a corrupted version as a whole; other processes may have repaired it first.
    if (await matches(target)) return readme;
    try {
      const backup = path.join(directory, `.replaced-${randomUUID()}`);
      await rename(target, backup);
      displaced = backup;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!(await matches(target))) throw error;
    }
    return readme;
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (displaced) await rm(displaced, { recursive: true, force: true });
  }
}

/** Share concurrent work only; each plugin instance caches its startup promise. */
export function materializeRules(dataDir: string): Promise<string | null> {
  const directory = path.resolve(dataDir, "rules");
  const existing = pending.get(directory);
  if (existing) return existing;
  const job = publish(directory)
    .catch((error: unknown) => {
      console.error("role-workflow: 규칙 문서 비치 실패", error);
      return null;
    })
    .finally(() => pending.delete(directory));
  pending.set(directory, job);
  return job;
}

/** A path-only guide, independent of I/O and of the federated-only gate. */
export function agentRulesBlock(readme?: string | null): string {
  if (!readme) return "";
  return `<paseo-agent-rules-v1>
규칙 원본: ${JSON.stringify(readme)}. 작업 시작·압축 복구·모델 교대 때 README의 표에 따라 맡은 역할 문서를 직접 읽는다.
plan: 00-common.md, 10-planning.md, 30-verification.md, 40-paseo-role-workflow.md.
execute: 00-common.md, 20-implementation.md, 40-paseo-role-workflow.md.
일반개발: 00-common.md 3.4절을 읽고 단계별로 10-planning.md → 20-implementation.md → 30-verification.md를 읽는다.
프로젝트 작업 폴더의 AGENTS.md·CLAUDE.md가 있으면 그것도 따르며, 충돌 시 00-common 1절 우선순위를 따른다.
</paseo-agent-rules-v1>`;
}
