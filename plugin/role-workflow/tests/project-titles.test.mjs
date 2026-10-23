import { test } from "node:test";
import assert from "node:assert/strict";
import { createProjectTitleSync } from "../server/project-titles.ts";

function fixture() {
  const project = {
    projectId: "p",
    projectDisplayName: "sample-development",
    projectCustomName: null,
  };
  const rows = [
    { id: "one", projectId: "p", name: "🔵 G[일반]-07 [푸시 완료] 작업" },
    { id: "two", projectId: "p", name: "🟢 C[연합:계획2]-08 기존 제목" },
    { id: "three", projectId: "other", name: "🟠 C[AIpet]-01 다른 작업" },
    { id: "plain", projectId: "p", name: "직접 정한 제목" },
  ];
  const renamed = [];
  let lists = 0,
    fail = false;
  const api = {
    projects: {
      list: async () => ({
        projects: [project, { projectId: "other", projectDisplayName: "AIpet" }],
      }),
    },
    workspaces: {
      list: async ({ page }) => {
        lists++;
        return {
          entries: page.cursor ? rows.slice(2) : rows.slice(0, 2),
          pageInfo: { nextCursor: page.cursor ? null : "next" },
        };
      },
      ref: (id) => ({
        refresh: async () => rows.find((row) => row.id === id),
        setTitle: async (name) => {
          if (fail) throw Error("temporary rename failure");
          rows.find((row) => row.id === id).name = name;
          renamed.push({ id, name });
        },
      }),
    },
  };
  return {
    api,
    project,
    rows,
    renamed,
    lists: () => lists,
    fail: (value) => {
      fail = value;
    },
    sync: createProjectTitleSync(() => api),
  };
}

test("project rename follows custom names, reset and reload without changing task decorations", async () => {
  const f = fixture();
  await f.sync();
  assert.deepEqual(f.renamed, [
    { id: "one", name: "🔵 G[sample dev]-07 [푸시 완료] 작업" },
    { id: "two", name: "🟢 C[sample dev:계획2]-08 기존 제목" },
  ]);
  assert.equal(f.lists(), 2);
  await f.sync();
  assert.equal(f.lists(), 2, "unchanged projects do not rescan workspaces");
  f.project.projectCustomName = "paseo-dev";
  await f.sync();
  assert.equal(f.rows[0].name, "🔵 G[paseo-dev]-07 [푸시 완료] 작업");
  assert.equal(f.rows[1].name, "🟢 C[paseo-dev:계획2]-08 기존 제목");
  assert.equal(f.rows[2].name, "🟠 C[AIpet]-01 다른 작업");
  assert.equal(f.rows[3].name, "직접 정한 제목");
  f.project.projectCustomName = null;
  await createProjectTitleSync(() => f.api)();
  assert.equal(f.rows[0].name, "🔵 G[sample dev]-07 [푸시 완료] 작업");
});

test("failed project lookups and renames keep titles and retry using current task text", async () => {
  const f = fixture();
  await f.sync();
  const list = f.api.projects.list;
  f.api.projects.list = async () => {
    throw Error("offline");
  };
  await assert.rejects(f.sync(), /offline/);
  assert.equal(f.renamed.length, 2);
  f.api.projects.list = list;
  f.project.projectCustomName = "새 이름";
  f.fail(true);
  await assert.rejects(f.sync(), /다시 시도/);
  f.fail(false);
  f.rows[0].name = "🟠 G[sample dev]-07 사용자가 변경한 제목";
  await f.sync();
  assert.equal(f.rows[0].name, "🟠 G[새 이름]-07 사용자가 변경한 제목");
  assert.equal(f.rows[1].name, "🟢 C[새 이름:계획2]-08 기존 제목");
});
