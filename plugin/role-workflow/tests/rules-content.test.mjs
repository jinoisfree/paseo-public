import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { RULES, RULES_VERSION } from "../server/rules-content.ts";

test("generated rules exactly match their sorted LF sources and content version", async () => {
  const source = new URL("../rules/", import.meta.url);
  const names = (await readdir(source)).filter((name) => name.endsWith(".md")).sort();
  const expected = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await readFile(new URL(name, source), "utf8")]),
    ),
  );
  assert.deepEqual(Object.keys(RULES), names, "npm run rules:sync 필요");
  assert.deepEqual(RULES, expected, "npm run rules:sync 필요");
  assert.ok(
    Object.values(RULES).every((body) => !body.includes("\r")),
    "LF sources required",
  );
  assert.equal(
    RULES_VERSION,
    createHash("sha256").update(JSON.stringify(expected)).digest("hex").slice(0, 12),
    "npm run rules:sync 필요",
  );
});
