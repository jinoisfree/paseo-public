import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";

const source = new URL("../rules/", import.meta.url);
const names = (await readdir(source)).filter((name) => name.endsWith(".md")).sort();
const rules = Object.fromEntries(
  await Promise.all(
    names.map(async (name) => [
      name,
      (await readFile(new URL(name, source), "utf8")).replace(/\r\n?/g, "\n"),
    ]),
  ),
);
// Hash the sorted file names and bodies together so renames also change the version.
const version = createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 12);
// Keep JSON inside a raw template stable under formatters; escape JS interpolation syntax.
const encoded = JSON.stringify(rules, null, 2)
  .replaceAll("`", "\\u0060")
  .replaceAll("$", "\\u0024");
await writeFile(
  new URL("../server/rules-content.ts", import.meta.url),
  "// 자동 생성: rules/*.md에서 npm run rules:sync로 만든다. 직접 수정 금지\n" +
    "export const RULES: Readonly<Record<string, string>> = JSON.parse(String.raw`" +
    encoded +
    "`);\n" +
    `export const RULES_VERSION = ${JSON.stringify(version)};\n`,
);
