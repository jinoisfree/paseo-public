import { realpath } from "node:fs/promises";
import path from "node:path";

export async function resolvedFolder(folder: string) {
  return realpath(folder).catch(() => path.resolve(folder));
}

export function pathsOverlap(left: string, right: string) {
  const contains = (base: string, target: string) => {
    const relative = path.relative(base, target);
    return (
      !relative ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  return contains(left, right) || contains(right, left);
}
