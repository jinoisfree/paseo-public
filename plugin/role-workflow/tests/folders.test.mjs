import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listFolders } from "../server/folders.ts";
import { folderList, folderRootsSchema } from "../shared/folders.ts";

test("folder RPC resolves a symlink root, excludes hidden entries/files, sorts and marks real-path registration", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-folders-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, "home"),
    root = path.join(temp, "volume");
  await mkdir(home);
  await mkdir(root);
  await symlink(root, path.join(home, "paseo-work"));
  for (const name of ["zebra", "hermes-starter", "alpha", ".hidden"])
    await mkdir(path.join(root, name));
  await mkdir(path.join(root, "alpha", "nested"));
  await writeFile(path.join(root, "file.txt"), "file");
  await symlink("missing", path.join(root, "broken"));
  const data = folderList.output.parse(
    await listFolders(["~/paseo-work", root], [path.join(root, "alpha")], home),
  );
  assert.deepEqual(
    data.folders.map((folder) => folder.name),
    ["alpha", "hermes-starter", "zebra"],
  );
  assert.deepEqual(data.errors, []);
  assert.equal(data.folders[0].registered, true);
  assert.equal(data.folders[1].registered, false);
  assert.equal(data.folders[1].displayPath, "~/paseo-work/hermes-starter");
  assert.equal(data.folders[1].path, path.join(home, "paseo-work/hermes-starter"));
  assert.equal(data.folders[1].realPath, path.join(root, "hermes-starter"));
});

test("bad roots are reported independently and registration can be unknown", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-folders-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(path.join(temp, "hermes"));
  const data = await listFolders([path.join(temp, "missing"), temp], null);
  assert.equal(data.errors.length, 1);
  assert.equal(data.folders[0].registered, null);
  assert.deepEqual(folderRootsSchema.parse(undefined), ["~/paseo-work"]);
  assert.equal(folderRootsSchema.safeParse(["relative"]).success, false);
});
