import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ownerPolicySchema, effectiveSettings, type OwnerPolicy } from "../shared/owner-policy";
import { recommendedSettings } from "../shared/recommended";
import { settingsValuesSchema } from "../shared/settings-schema";
import { settingsSchema, type Settings } from "../shared/contracts";

const queues = new Map<string, Promise<unknown>>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function settingDifferences(settings: Settings): Partial<Settings> {
  return Object.fromEntries(Object.entries(settings).filter(([key, value]) =>
    !same(value, recommendedSettings[key as keyof Settings])));
}
export async function legacyNotifications(files: readonly string[]) {
  for (const file of files) {
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      return {
        ...(typeof data.phoneNotifications === "boolean" ? { phoneNotifications: data.phoneNotifications } : {}),
        ...(typeof data.phoneNotificationEndpoint === "string" && data.phoneNotificationEndpoint
          ? { phoneNotificationEndpoint: data.phoneNotificationEndpoint } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
  }
  return {};
}
export class OwnerPolicyStore {
  constructor(readonly file: string, private readonly legacyFiles: readonly string[] = []) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.file), previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(operation);
    const settled = next.catch(() => {});
    queues.set(key, settled);
    void settled.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
    return next;
  }
  private blank(): OwnerPolicy {
    const date = new Date().toISOString().slice(0, 10);
    return { version: 1, revision: 0, roleWorkflow: {}, notifications: {},
      decisions: { roleWorkflow: { date }, notifications: { date } } };
  }
  private async read(): Promise<OwnerPolicy> {
    try { return ownerPolicySchema.parse(JSON.parse(await readFile(this.file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.blank();
      throw new Error(`지시서를 읽을 수 없습니다: ${this.file}. 파일을 복구한 뒤 다시 시도하세요.`);
    }
  }
  private async write(policy: OwnerPolicy) {
    ownerPolicySchema.parse(policy);
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(this.file), `.policy-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(policy, null, 2) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.file);
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  async load(legacy?: { settings: unknown; source: string }) {
    try {
      return await this.serial(async () => {
        let policy = await this.read();
        if (!policy.migratedFrom && legacy) {
          const old = settingsSchema.parse(legacy.settings);
          const settings = settingsValuesSchema.parse({ ...recommendedSettings, ...old, ...policy.roleWorkflow });
          policy = { ...policy, revision: policy.revision + 1, roleWorkflow: settingDifferences(settings),
            notifications: { ...await legacyNotifications(this.legacyFiles), ...policy.notifications },
            migratedFrom: { source: legacy.source, at: new Date().toISOString(), stateSettingsSha256: hash(legacy.settings) } };
          await this.write(policy);
        }
        return { settings: effectiveSettings(policy), policy, error: null as string | null };
      });
    } catch (error) {
      return { settings: structuredClone(recommendedSettings), policy: null,
        error: `지시서 오류: ${this.file}. ${error instanceof Error && error.message.includes(this.file) ? error.message : "내용과 설정 형식을 확인한 뒤 다시 시도하세요."}` };
    }
  }
  save(settings: Settings, expectedRevision: number) {
    return this.serial(async () => {
      const policy = await this.read();
      if (policy.revision !== expectedRevision)
        throw new Error(`지시서 revision 충돌: ${this.file}. 설정을 다시 읽고 저장하세요.`);
      const validated = settingsValuesSchema.strict().parse(settings);
      const next = { ...policy, revision: policy.revision + 1, roleWorkflow: settingDifferences(validated),
        decisions: { ...policy.decisions, roleWorkflow: { date: new Date().toISOString().slice(0, 10) } } };
      await this.write(next);
      return { settings: effectiveSettings(next), revision: next.revision };
    });
  }
}
