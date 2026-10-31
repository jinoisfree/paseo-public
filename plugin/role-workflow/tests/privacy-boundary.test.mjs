import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

// Personal home/volume paths and account identifiers must never become shared defaults.
const personal =
  /[/](?:Users|Volumes|home)[/][^/\s"']+|github\.com\/(?!example\/)[^/\s]+\/|\b(?:mac-mini|macbook|desktop)[-_][\w-]+/i;
const email = /[\w.%+-]+@([\w.-]+\.[a-z]{2,})/gi;
const exampleDomain = /^(?:[\w-]+\.)*example\.(?:com|org|net|invalid)$/i;

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) result.push(...(await files(file)));
    else if (/\.(?:ts|tsx|mts|mjs|md|json)$/.test(entry.name)) result.push(file);
  }
  return result;
}

test("shared plugin sources, generated rules and tests contain no personal configuration", async () => {
  const targets = [];
  for (const folder of ["server", "shared", "client", "rules", "scripts", "tests"])
    targets.push(...(await files(new URL(`../${folder}/`, import.meta.url))));
  for (const name of [
    "index.server.ts",
    "index.client.tsx",
    "package.json",
    "paseo-plugin.json",
    "README.md",
  ])
    targets.push(new URL(`../${name}`, import.meta.url));
  assert.ok(targets.some((file) => file.pathname.endsWith("/server/rules-content.ts")));
  for (const file of targets) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, personal, file.pathname);
    for (const match of text.matchAll(email)) assert.match(match[1], exampleDomain, file.pathname);
  }
});
