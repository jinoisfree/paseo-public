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
규칙 원본: ${JSON.stringify(readme)}. 질문·설명·읽기 전용 조사는 답변에 필요한 규칙·자료만 읽는다.
실제 변경 시작: README.md와 00-common.md 핵심(1·3·4·5·8절), 프로젝트 지침, 현재 단계 상세를 읽는다. 나머지 공통 상세는 관련 판단 때 참조한다.
기획·설계: 10-planning.md. 구현: 20-implementation.md. 최종 검토: 30-verification.md와 관련 구현 기준. 역할 분리 인계·상태 처리: 40-paseo-role-workflow.md 관련 절.
일반개발: 00-common.md 3.4절과 현재 단계만 읽고 세 역할 문서 전체를 일괄 읽지 않는다.
압축 복구·모델 교대: 핵심 제약, 현재 인계·마지막 상태, 실제 변경본을 확인한다. 무변경 상세 문서 전체 재독은 강제하지 않으며 관련 규칙·계약 변경, 누락·충돌 때 해당 상세를 다시 읽는다.
프로젝트 작업 폴더의 AGENTS.md·CLAUDE.md가 있으면 그것도 따르며, 충돌 시 00-common 1절 우선순위를 따른다.
</paseo-agent-rules-v1>`;
}
