import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { managedPushSchema, type ManagedPush } from "../shared/managed-push";
import { pushTargetSchema, type PushTarget } from "../shared/artifacts";

export interface ManagedGitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}
export type ManagedPushDriver = (cwd: string, args: string[]) => Promise<ManagedGitResult>;
type Target = ManagedPush["targets"][number];

const hashPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const now = () => new Date().toISOString();
const unavailable = "푸시 기록을 읽거나 저장하지 못했습니다. 다시 푸시하지 말고 기록을 확인하세요.";

function processEnvironment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) {
    if (
      /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG(?:_.*)?)$/.test(
        key,
      )
    )
      delete env[key as keyof typeof env];
  }
  return env;
}

const runGit: ManagedPushDriver = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: args.includes("push") ? 120_000 : 15_000,
        maxBuffer: 1024 * 1024,
        env: processEnvironment(),
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        let exitCode: number | null = 0;
        if (error) exitCode = typeof error.code === "number" && !error.killed ? error.code : null;
        resolve({ stdout, stderr, exitCode });
      },
    );
  });

class ManagedPushError extends Error {}
function safeError(message: string): Error {
  return new ManagedPushError(message);
}

async function fixedUrl(raw: string, cwd: string): Promise<string> {
  if (!raw || raw !== raw.trim() || /[\r\n]/.test(raw) || raw.includes("\0"))
    throw safeError("원격 URL이 올바르지 않습니다.");
  if (raw.includes("://")) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw safeError("원격 URL이 올바르지 않습니다.");
    }
    if (!new Set(["https:", "http:", "ssh:", "git:", "file:"]).has(url.protocol))
      throw safeError("지원하지 않는 원격 URL 형식입니다.");
    if (url.password || url.search || url.hash || (url.username && url.protocol !== "ssh:"))
      throw safeError(
        "인증 정보가 포함된 원격 URL은 사용할 수 없습니다. Git 자격 증명 저장소를 사용하세요.",
      );
    if (url.protocol === "file:") return pathToFileURL(await realpath(fileURLToPath(url))).href;
    return raw;
  }
  if (raw.includes("::")) throw safeError("외부 실행형 Git 전송 주소는 사용할 수 없습니다.");
  if (/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+:[^\s]+$/.test(raw)) return raw;
  return realpath(path.resolve(cwd, raw));
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicRecord(directory: string, record: ManagedPush) {
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path.join(directory, "record.json"));
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Executes only immutable, approved targets. Approval and workflow epoch checks belong to the engine. */
export class ManagedPushRunner {
  private readonly active = new Map<string, Promise<ManagedPush>>();
  private readonly owned = new Set<string>();

  constructor(
    private readonly directory: string,
    private readonly driver: ManagedPushDriver = runGit,
  ) {}

  private folder(id: string) {
    if (!managedPushSchema.shape.id.safeParse(id).success)
      throw safeError("푸시 요청 ID가 올바르지 않습니다.");
    return path.join(this.directory, id);
  }

  private async git(cwd: string, args: string[]) {
    try {
      const result = await this.driver(cwd, args);
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode,
      };
    } catch {
      return { stdout: "", stderr: "", exitCode: null };
    }
  }

  private async required(cwd: string, args: string[], message: string) {
    const result = await this.git(cwd, args);
    if (result.exitCode !== 0) throw safeError(message);
    return result.stdout.trim();
  }

  private async remoteUrl(repository: string, remote: string) {
    const output = await this.required(
      repository,
      ["remote", "get-url", "--push", "--all", remote],
      "원격 푸시 주소를 확인하지 못했습니다.",
    );
    const urls = output.split(/\r?\n/);
    if (urls.length !== 1) throw safeError("여러 푸시 URL이 설정된 원격은 사용할 수 없습니다.");
    try {
      return await fixedUrl(urls[0], repository);
    } catch (error) {
      if (error instanceof ManagedPushError) throw error;
      throw safeError("원격 푸시 주소를 확인하지 못했습니다.");
    }
  }

  private async literalUrl(repository: string, url: string, push: boolean) {
    // Literal URL arguments are still subject to Git's URL rewrite rules.
    // Refuse applicable nonidentity rewrites instead of letting them retarget approval.
    const result = await this.git(repository, [
      "config",
      "--null",
      "--get-regexp",
      "^url\\..*\\.(insteadof|pushinsteadof)$",
    ]);
    if (result.exitCode === 1) return true;
    if (result.exitCode !== 0) return false;
    return result.stdout
      .split("\0")
      .filter(Boolean)
      .every((row) => {
        const newline = row.indexOf("\n");
        if (newline === -1) return false;
        const key = row.slice(0, newline);
        const match = /^url\.(.+)\.(insteadof|pushinsteadof)$/i.exec(key);
        if (!match) return false;
        if (!push && match[2].toLowerCase() === "pushinsteadof") return true;
        const prefix = row.slice(newline + 1);
        return !url.startsWith(prefix) || match[1] + url.slice(prefix.length) === url;
      });
  }

  private async target(input: PushTarget): Promise<Target> {
    const parsed = pushTargetSchema.safeParse(input);
    if (!parsed.success) throw safeError("저장소, 원격, 브랜치와 전체 커밋 해시가 필요합니다.");
    const value = parsed.data;
    const top = await this.required(
      value.repository,
      ["rev-parse", "--show-toplevel"],
      "Git 저장소를 확인하지 못했습니다.",
    );
    const repository = await realpath(top).catch(() => {
      throw safeError("Git 저장소 경로를 확인하지 못했습니다.");
    });
    const branch = value.branch.replace(/^refs\/heads\//, "");
    if (branch.startsWith("refs/")) throw safeError("브랜치 이름이 올바르지 않습니다.");
    await this.required(
      repository,
      ["check-ref-format", `refs/heads/${branch}`],
      "브랜치 이름이 올바르지 않습니다.",
    );
    const type = await this.required(
      repository,
      ["cat-file", "-t", value.commit],
      "대상 커밋을 확인하지 못했습니다.",
    );
    if (type !== "commit") throw safeError("전체 커밋 객체 해시가 필요합니다.");
    const remoteUrl = await this.remoteUrl(repository, value.remote);
    if (
      !(await this.literalUrl(repository, remoteUrl, true)) ||
      !(await this.literalUrl(repository, remoteUrl, false))
    )
      throw safeError("Git URL 치환 설정 때문에 고정된 푸시 주소를 확인할 수 없습니다.");
    return {
      ...value,
      repository,
      branch,
      remoteUrl,
      exitCode: null,
      verified: null,
      alreadyIncluded: false,
      startedAt: null,
      finishedAt: null,
      error: "",
    };
  }

  async prepare(workflowId: string, epoch: number, targets: PushTarget[]): Promise<ManagedPush> {
    if (
      !workflowId ||
      !Number.isSafeInteger(epoch) ||
      epoch < 0 ||
      !targets.length ||
      targets.length > 8
    )
      throw safeError("푸시 요청 범위가 올바르지 않습니다.");
    const prepared: Target[] = [];
    for (const target of targets) prepared.push(await this.target(target));
    const keys = prepared.map((target) =>
      JSON.stringify([target.repository, target.remoteUrl, target.branch]),
    );
    if (new Set(keys).size !== keys.length)
      throw safeError("동일한 원격 브랜치는 한 요청에 한 번만 지정할 수 있습니다.");
    const timestamp = now();
    const record: ManagedPush = {
      id: randomUUID(),
      workflowId,
      epoch,
      state: "prepared",
      createdAt: timestamp,
      updatedAt: timestamp,
      approvedAt: null,
      targets: prepared,
      error: "",
    };
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      await mkdir(this.folder(record.id), { mode: 0o700 });
      await syncDirectory(this.directory);
      await this.save(record);
    } catch {
      throw safeError(unavailable);
    }
    return record;
  }

  private async raw(id: string): Promise<ManagedPush> {
    try {
      const record = managedPushSchema.parse(
        JSON.parse(await readFile(path.join(this.folder(id), "record.json"), "utf8")),
      );
      if (record.id !== id) throw safeError(unavailable);
      return record;
    } catch {
      throw safeError(unavailable);
    }
  }

  private async claimed(id: string) {
    return stat(path.join(this.folder(id), "claim")).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw safeError(unavailable);
      },
    );
  }

  async read(id: string): Promise<ManagedPush> {
    const record = await this.raw(id);
    const unfinished =
      ["running", "checking"].includes(record.state) ||
      (record.state === "prepared" && (await this.claimed(id)));
    if (!this.isRunning(id) && unfinished) {
      record.state = "unknown";
      record.error =
        "실행이 중단되었거나 다른 실행기가 처리 중입니다. 재푸시 없이 기록을 재확인하세요.";
    }
    return record;
  }

  async history(workflowId: string): Promise<ManagedPush[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw safeError(unavailable);
    });
    const result: ManagedPush[] = [];
    for (const id of names) {
      if (!managedPushSchema.shape.id.safeParse(id).success) continue;
      const record = await this.read(id).catch(() => null);
      if (record?.workflowId === workflowId) result.push(record);
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  isRunning(id: string) {
    return this.owned.has(id);
  }

  execute(id: string): Promise<ManagedPush> {
    const existing = this.active.get(id);
    if (existing) return existing;
    const running = this.executeOnce(id).finally(() => {
      this.active.delete(id);
      this.owned.delete(id);
    });
    this.active.set(id, running);
    return running;
  }

  private async claim(id: string) {
    try {
      const handle = await open(path.join(this.folder(id), "claim"), "wx", 0o600);
      try {
        await handle.writeFile(`${now()}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(this.folder(id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw safeError(unavailable);
    }
  }

  private async save(record: ManagedPush) {
    record.updatedAt = now();
    await atomicRecord(this.folder(record.id), record);
  }

  private async log(id: string, index: number, result: ManagedGitResult) {
    const handle = await open(
      path.join(this.folder(id), `target-${index + 1}-push.log`),
      "wx",
      0o600,
    );
    try {
      await handle.writeFile(
        `exitCode=${result.exitCode}\nstdout:\n${result.stdout.slice(0, 32768)}\nstderr:\n${result.stderr.slice(0, 32768)}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async current(target: Target) {
    const checked = await this.target(target);
    if (checked.repository !== target.repository || checked.remoteUrl !== target.remoteUrl)
      throw safeError(
        "승인 대기 중 저장소 또는 원격 주소가 변경되었습니다. 새 푸시 요청을 준비하세요.",
      );
  }

  private async verify(target: Target): Promise<boolean | null> {
    const ref = `refs/heads/${target.branch}`;
    if (!(await this.literalUrl(target.repository, target.remoteUrl, false))) return null;
    const result = await this.git(target.repository, [
      "-c",
      "protocol.ext.allow=never",
      "ls-remote",
      "--exit-code",
      "--",
      target.remoteUrl,
      ref,
    ]);
    if (result.exitCode !== 0) return null;
    const matches = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(/\s+/))
      .filter((row) => row[1] === ref);
    if (matches.length !== 1 || !hashPattern.test(matches[0][0])) return null;
    const remote = matches[0][0];
    if (remote === target.commit) return true;
    const object = await this.git(target.repository, ["cat-file", "-t", remote]);
    if (object.exitCode !== 0 || object.stdout.trim() !== "commit") return null;
    const ancestry = await this.git(target.repository, [
      "merge-base",
      "--is-ancestor",
      target.commit,
      remote,
    ]);
    if (ancestry.exitCode === 0) return true;
    return ancestry.exitCode === 1 ? false : null;
  }

  private async push(record: ManagedPush, target: Target, index: number) {
    await this.current(target);
    record.state = "running";
    target.startedAt = now();
    await this.save(record);
    const result = await this.git(target.repository, [
      "-c",
      "push.followTags=false",
      "-c",
      "push.recurseSubmodules=no",
      "-c",
      "protocol.ext.allow=never",
      "push",
      "--porcelain",
      "--no-follow-tags",
      "--no-force",
      "--no-mirror",
      "--recurse-submodules=no",
      "--",
      target.remoteUrl,
      `${target.commit}:refs/heads/${target.branch}`,
    ]);
    target.exitCode = result.exitCode;
    target.finishedAt = now();
    record.state = "checking";
    target.error = "";
    if (result.exitCode !== 0) {
      record.state = result.exitCode === null ? "unknown" : "failed";
      target.error =
        result.exitCode === null
          ? "Git 푸시의 종료 결과를 확인하지 못했습니다."
          : `Git 푸시가 종료 코드 ${result.exitCode}로 실패했습니다.`;
    }
    record.error = target.error;
    // The exit status is durable before logging, remote checks or the next push.
    await this.save(record);
    await this.log(record.id, index, result);
    if (result.exitCode === null) return false;
    target.verified = await this.verify(target);
    if (result.exitCode !== 0) {
      target.alreadyIncluded = target.verified === true;
      if (target.alreadyIncluded) {
        target.error = "";
        record.error = "";
        record.state = "checking";
      }
      await this.save(record);
      return target.alreadyIncluded;
    }
    if (target.verified !== true) {
      record.state = "unknown";
      record.error =
        "푸시는 종료됐지만 승인한 커밋의 원격 반영을 확인하지 못했습니다. 재확인하세요.";
    }
    await this.save(record);
    return target.verified === true;
  }

  private async executeOnce(id: string): Promise<ManagedPush> {
    const record = await this.raw(id);
    if (record.state !== "prepared" || !(await this.claim(id))) return this.read(id);
    this.owned.add(id);
    record.approvedAt = now();
    record.state = "running";
    try {
      await this.save(record);
      for (const [index, target] of record.targets.entries()) {
        if (!(await this.push(record, target, index))) return record;
      }
      record.state = "pushed";
      record.error = "";
      await this.save(record);
    } catch {
      record.state = record.targets.some((target) => target.startedAt) ? "unknown" : "failed";
      record.error =
        "푸시를 완료하지 못했습니다. 승인한 대상 변경 또는 기록 저장 실패 여부를 확인하세요. 자동 재푸시는 하지 않습니다.";
      await this.save(record).catch(() => {});
    }
    return record;
  }

  async recheck(id: string): Promise<ManagedPush> {
    if (this.isRunning(id)) return this.read(id);
    const record = await this.raw(id);
    // This records a completed operation, not the remote's current availability.
    // Once confirmed, later network failures or branch changes cannot undo it.
    if (record.state === "pushed") return record;
    if (record.state === "prepared" && !(await this.claimed(id))) return record;
    if (record.targets.some((target) => target.exitCode === null)) {
      record.state = record.targets.some(
        (target) => target.exitCode !== null && target.exitCode !== 0,
      )
        ? "failed"
        : "unknown";
      record.error = "성공 종료가 기록되지 않은 대상이 있어 재푸시 없이 확인이 필요합니다.";
      // An independent runner may still be executing; never overwrite its in-flight record.
      return record;
    }
    // A nonzero result in an in-flight record may belong to another runner.
    if (
      ["running", "checking"].includes(record.state) &&
      record.targets.some((target) => target.exitCode !== 0)
    )
      return this.read(id);
    for (const target of record.targets) {
      target.verified = await this.verify(target);
      target.alreadyIncluded = target.exitCode !== 0 && target.verified === true;
      if (target.verified === true) target.error = "";
    }
    record.state = "unknown";
    if (record.targets.every((target) => target.verified === true)) record.state = "pushed";
    else if (record.targets.some((target) => target.exitCode !== 0 && target.verified !== true))
      record.state = "failed";
    record.error =
      record.state === "pushed" ? "" : "승인한 커밋의 원격 반영을 아직 확인하지 못했습니다.";
    try {
      await this.save(record);
    } catch {
      throw safeError(unavailable);
    }
    return record;
  }
}
