import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

test("AC-02/AC-03/AC-04/AC-15: placement card explains both choices, sends the RPC, then hides buttons", { timeout: 60000 }, async t => {
  const root = path.resolve(import.meta.dirname, "..");
  const bundle = await build({
    stdin: { contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PlacementPickerCard } from './client/placement-picker';
window.__calls=[];window.__fail=false;
window.__choose=async input=>{window.__calls.push(input);return {ok:!window.__fail,detail:window.__fail?'이미 정해졌습니다.':input.placement==='wait'?'앞 작업이 끝나면 자동으로 시작합니다.':'따로 작업 공간에서 시작합니다.'};};
createRoot(document.getElementById('root')).render(<PlacementPickerCard item={{data:{workflowId:'task',number:7,title:'기존 작업'}}} theme={{colors:{foreground:'#111',foregroundMuted:'#555',border:'#bbb'}}}/>);
`, resolveDir: root, loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    alias: { "react-native": "react-native-web" },
    plugins: [{ name: "sdk", setup(builder) {
      builder.onResolve({ filter: /^@getpaseo\/plugin(?:\/client)?$/ }, args => ({ path: args.path, namespace: "sdk" }));
      builder.onLoad({ filter: /.*/, namespace: "sdk" }, args => ({ contents: args.path.endsWith("/client") ? "export const useRpc=()=>window.__choose;" : "export const defineRpc=x=>x;" }));
    } }],
  });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/bundle.js" ? "application/javascript" : "text/html");
    response.end(request.url === "/bundle.js" ? bundle.outputFiles[0].text : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const [placement, label, confirmation] of [
    ["worktree", "따로 작업 공간 만들어 바로 시작", "따로 작업 공간에서 시작합니다."],
    ["wait", "앞 작업이 끝나면 시작", "앞 작업이 끝나면 자동으로 시작합니다."],
  ]) {
    await page.goto(url);
    await page.getByText("같은 폴더에서 다른 작업이 아직 진행 중이에요", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button").count(), 2);
    await page.getByText("#7 기존 작업 작업이 이 폴더의 파일을 고치고 있어요. 두 작업이 같은 파일을 동시에 고치면 서로의 변경이 섞일 수 있어서, 어떻게 진행할지 골라 주세요.", { exact: true }).waitFor();
    await page.getByText("이 폴더의 복사본(Git worktree)을 따로 만들어 지금 바로 구현을 시작해요. 서로 섞이지 않지만, 사이드바에 줄이 하나 더 생기고, 끝나면 원래 폴더로 합치는 단계가 있어요. 그사이 앞 작업이 먼저 끝났다면 구현 담당이 그 변경까지 합쳐 겹친 곳을 정리하고, 다시 검증한 뒤 푸시해요. 어느 쪽 의도를 살릴지 판단이 필요할 때만 물어봐요.", { exact: true }).waitFor();
    await page.getByText("지금 화면(같은 작업 공간)에서 그대로 진행해요. #7 작업이 끝나면 자동으로 시작해요. 섞일 걱정은 없지만 그동안 기다려야 해요.", { exact: true }).waitFor();
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByText(confirmation, { exact: true }).waitFor();
    assert.equal(await page.getByRole("button").count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__calls), [{ id: "task", placement }]);
  }
  await page.goto(url);
  await page.getByRole("button", { name: "앞 작업이 끝나면 시작", exact: true }).waitFor();
  await page.evaluate(() => { window.__fail = true; });
  await page.getByRole("button", { name: "앞 작업이 끝나면 시작", exact: true }).click();
  await page.getByText("이미 정해졌습니다.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button").count(), 2);
  assert.deepEqual(errors, []);
});
