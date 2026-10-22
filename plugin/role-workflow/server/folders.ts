import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { RpcOutput } from "@getpaseo/plugin";
import { folderList } from "../shared/folders";

/** Immediate children only; resolving the root permits ~/paseo-work symlinks. */
export async function listFolders(
  roots: string[],
  registeredPaths: string[] | null,
  home = homedir(),
): Promise<RpcOutput<typeof folderList>> {
  const expand = (value: string) => {
    if (value === "~") return home;
    if (value.startsWith("~/")) return path.resolve(home, value.slice(2));
    return path.resolve(value);
  };
  const registered =
    registeredPaths === null
      ? null
      : new Set(
          await Promise.all(
            registeredPaths.map(async (value) => {
              const absolute = expand(value);
              return realpath(absolute).catch(() => absolute);
            }),
          ),
        );
  const result: RpcOutput<typeof folderList> = { roots, folders: [], errors: [] };
  const seen = new Set<string>();
  for (const root of roots) {
    try {
      const absolute = expand(root);
      const resolved = await realpath(absolute);
      for (const entry of await readdir(resolved, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const candidate = path.join(resolved, entry.name);
        if (
          !entry.isDirectory() &&
          !(
            entry.isSymbolicLink() &&
            (await stat(candidate).then(
              (value) => value.isDirectory(),
              () => false,
            ))
          )
        )
          continue;
        const realPath = await realpath(candidate).catch(() => null);
        if (!realPath || seen.has(realPath)) continue;
        seen.add(realPath);
        const absolutePath = path.join(absolute, entry.name);
        const relative = path.relative(home, absolutePath);
        result.folders.push({
          name: entry.name,
          path: absolutePath,
          displayPath:
            relative && !relative.startsWith(`..${path.sep}`) && relative !== ".."
              ? `~/${relative}`
              : absolutePath,
          realPath,
          registered: registered ? registered.has(realPath) : null,
        });
      }
    } catch {
      result.errors.push(`폴더 목록을 읽지 못했습니다: ${root}`);
    }
  }
  result.folders.sort((a, b) => a.name.localeCompare(b.name, "ko") || a.path.localeCompare(b.path));
  return result;
}
