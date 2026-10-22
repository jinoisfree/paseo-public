import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class JsonStore<T> {
  constructor(
    readonly file: string,
    private readonly initial: () => T,
    private readonly validate: (value: unknown) => T,
  ) {}
  async read(): Promise<T> {
    try {
      return this.validate(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.initial();
      throw error; // Corrupt state must not start a second workflow.
    }
  }
  async write(value: T): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
