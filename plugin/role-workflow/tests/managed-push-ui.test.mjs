import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

test(
  "managed push UI previews before approval, prevents repeat execution and offers read-only recovery",
  { timeout: 60000 },
  async (t) => {
    const root = path.resolve(import.meta.dirname, "..");
    const bundle = await build({
      stdin: {
        contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './client/dashboard';
import contribute from './index.client';
import { settingsSchema, workflowViewSchema } from './shared/contracts';
const target={repository:'/example/repo',remote:'origin',remoteUrl:'https://example.com/repo.git',branch:'main',commit:'a'.repeat(40),exitCode:null,verified:null,startedAt:null,finishedAt:null,error:''};
const flow=workflowViewSchema.parse({id:'task',number:1,title:'승인 대기 작업',cwd:'/example/repo',mode:'general',status:'active',phase:'plan',cycles:0,turns:0,updatedAt:'2026-10-15',progress:'done',planAgentId:'planner',executeAgentId:null,planGeneration:1,executeGeneration:0,planCompactions:0,executeCompactions:0,planUsage:null,executeUsage:null,detail:'구현과 검증 완료',artifactNotice:'푸시 결과를 확인하지 못했습니다.',verification:[{command:'npm test',cwd:'/example/repo',commit:'a'.repeat(40),exitCode:0,logPath:'/private/test.log',criterion:'관련 회귀 검사 통과',checkedAt:'2026-10-15',state:'matched',detail:'검증 대상 일치'}]});
const state={settings:settingsSchema.parse({}),projects:{},workflows:[flow],archives:[],error:null,devices:0};
window.__calls=[];window.__slash={};window.__failure=false;window.__state=state;
window.__rpc={
 'workflow.status':async()=>structuredClone(state),
 'workflow.configure':async()=>state.settings,
 'workflow.forget-project':async()=>({ok:true}),
 'workflow.control':async()=>({ok:true,status:'active',detail:''}),
 'workflow.repositories':async()=>({repositories:[]}),
 'workflow.test-notification':async()=>({ok:true,tokens:0,status:null,error:null}),
 'workflow.models':async()=>({models:[],error:null}),
 'workflow.archive-finished':async()=>({rows:[],archivedIds:[],errors:[]}),
 'workflow.push-prepare':async input=>{window.__calls.push({name:'prepare',input}); if(flow.managedPush)flow.pushHistory.unshift(flow.managedPush);flow.managedPush={id:crypto.randomUUID(),workflowId:flow.id,epoch:0,state:'prepared',createdAt:'2026-10-15T00:00:00Z',updatedAt:'2026-10-15T00:00:00Z',approvedAt:null,targets:[structuredClone(target)],error:''};return structuredClone(flow.managedPush);},
 'workflow.push-execute':async input=>{window.__calls.push({name:'execute',input});if(window.__failure)throw Error('connection lost: private raw process log');await new Promise(resolve=>{window.__resolveExecute=resolve});flow.managedPush={...flow.managedPush,state:'pushed',approvedAt:'2026-10-15T00:01:00Z',targets:[{...target,exitCode:0,verified:true}]};return structuredClone(flow.managedPush);},
 'workflow.push-recheck':async input=>{window.__calls.push({name:'recheck',input});flow.managedPush={...flow.managedPush,state:window.__recheckState??'unknown',error:'원격 반영을 확인하지 못했습니다.'};return structuredClone(flow.managedPush);}
};
const rpc=(contract,input)=>window.__rpc[contract.name](input);
const noop=()=>()=>{};
contribute({rpc,paseo:{agents:{list:async()=>({subscription:{subscribe:()=>{}}})}},addTimelineTransformer:noop,addTimelineRenderer:noop,addSlashCommand:command=>{window.__slash[command.name]=command;return ()=>{};},addSurface:noop,addSidebarItem:noop,addCommandCenterItem:noop,openSurface:name=>{window.__surface=name;}});
window.__invokePush=()=>window.__slash.push.onSubmit({agent:{id:'planner'},rpc});
const colors={foreground:'#111',foregroundMuted:'#555',border:'#bbb',surface0:'#fff',surface1:'#eee',surface2:'#ddd',statusDanger:'#b00',statusSuccess:'#070'};
createRoot(document.getElementById('root')).render(<Dashboard theme={{colors}} host={{id:'test',label:'test'}} layout={{compact:false,platform:'web'}}/>);
`,
        resolveDir: root,
        loader: "tsx",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      alias: { "react-native": "react-native-web" },
      plugins: [
        {
          name: "fake-plugin-sdk",
          setup(builder) {
            builder.onResolve(
              { filter: /^@getpaseo\/plugin(?:\/client(?:\/react-native)?)?$/ },
              ({ path: modulePath }) => ({ path: modulePath, namespace: "sdk" }),
            );
            builder.onLoad({ filter: /.*/, namespace: "sdk" }, ({ path: modulePath }) => {
              let contents = "export const useRpc=contract=>window.__rpc[contract.name];";
              if (modulePath === "@getpaseo/plugin") contents = "export const defineRpc=x=>x;";
              else if (modulePath.endsWith("/react-native"))
                contents = 'export {ScrollView,TextInput} from "react-native-web";';
              return { loader: "js", resolveDir: root, contents };
            });
          },
        },
      ],
    });
    const server = createServer((request, response) => {
      response.setHeader(
        "Content-Type",
        request.url === "/bundle.js" ? "application/javascript" : "text/html",
      );
      response.end(
        request.url === "/bundle.js"
          ? bundle.outputFiles[0].text
          : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>',
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const panel = page.getByTestId("managed-push-task");
    await panel
      .getByText("푸시할 대상을 확인하고 승인하면 앱이 실행 결과를 기록합니다.", { exact: true })
      .waitFor();
    assert.equal(await page.getByTestId("managed-push-execute-task").count(), 0);
    await panel.getByText("판정: 판정 없음", { exact: true }).waitFor();
    await panel
      .getByText("검증 완료 판정이 없습니다. 푸시 전 확인하세요.", { exact: true })
      .waitFor();
    await page.evaluate(() => window.__invokePush());
    await page.getByTestId("managed-push-execute-task").waitFor();
    assert.deepEqual(await page.evaluate(() => window.__calls.map((call) => call.name)), [
      "prepare",
    ]);
    assert.equal(await page.evaluate(() => window.__surface), "workflow");
    await panel.getByText(`커밋: ${"a".repeat(40)}`, { exact: true }).waitFor();
    await panel.getByText("원격: origin · https://example.com/repo.git", { exact: true }).waitFor();
    await panel.getByText("npm test", { exact: true }).waitFor();
    assert.ok(!(await panel.textContent()).includes("/private/test.log"));
    assert.equal(
      await page.getByTestId("managed-push-execute-task").isEnabled(),
      true,
      "missing verdict is nonblocking",
    );
    for (const status of ["부분 완료", "미완료", "판정 불일치", "완료"]) {
      await page.evaluate((judgement) => {
        window.__state.workflows[0].verdict = {
          status: judgement,
          path: "docs/task/verdict.md",
          condition: "교차 모델",
          recordedAt: "2026-11-01",
          reason: judgement === "판정 불일치" ? "판정 보고 경로 없음" : "",
        };
      }, status);
      await panel.getByText(`판정: ${status}`, { exact: true }).waitFor();
      await panel.getByText("검증 조건: 교차 모델", { exact: true }).waitFor();
      await panel.getByText("판정 보고: docs/task/verdict.md", { exact: true }).waitFor();
      assert.equal(
        await panel
          .getByText("검증 완료 판정이 없습니다. 푸시 전 확인하세요.", { exact: true })
          .count(),
        status === "완료" ? 0 : 1,
      );
      assert.equal(
        await page.getByTestId("managed-push-execute-task").isEnabled(),
        true,
        "judgement must not change approval availability",
      );
    }
    await page.getByTestId("managed-push-execute-task").evaluate((element) => {
      element.click();
      element.click();
    });
    assert.equal(
      await page.evaluate(() => window.__calls.filter((call) => call.name === "execute").length),
      1,
    );
    assert.equal(
      await page.evaluate(
        () => window.__calls.find((call) => call.name === "execute").input.approved,
      ),
      true,
    );
    await page.evaluate(() => window.__resolveExecute());
    await panel.getByText("[PUSH] 원격 반영 확인", { exact: true }).waitFor();

    await page.getByTestId("managed-push-prepare-task").click();
    await page.getByTestId("managed-push-execute-task").waitFor();
    await panel.getByText("이전 푸시 기록", { exact: true }).waitFor();
    await page.evaluate(() => {
      window.__failure = true;
    });
    await page.getByTestId("managed-push-execute-task").click();
    await panel.getByText(/요청 결과를 확인하지 못했습니다/).waitFor();
    assert.equal(await page.getByTestId("managed-push-execute-task").count(), 0);
    assert.equal(await page.getByTestId("managed-push-prepare-task").count(), 0);
    await page.getByTestId("managed-push-recheck-task").click();
    await panel.getByText("푸시 결과 확인 필요", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.__calls.filter((call) => call.name === "execute").length),
      2,
    );
    assert.equal(
      await page.evaluate(() => window.__calls.filter((call) => call.name === "recheck").length),
      1,
    );
    assert.ok(!(await panel.textContent()).includes("private raw"));
    assert.equal(await page.getByTestId("managed-push-execute-task").count(), 0);
    assert.equal(await page.getByTestId("managed-push-prepare-task").count(), 0);
    await page.evaluate(() => {
      window.__recheckState = "failed";
    });
    await page.getByTestId("managed-push-recheck-task").click();
    await panel.getByText("푸시 실패", { exact: true }).waitFor();
    await panel.getByText("원격 반영을 확인하지 못했습니다.", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("managed-push-execute-task").count(), 0);
    await page.getByTestId("managed-push-prepare-task").click();
    await page.getByTestId("managed-push-execute-task").waitFor();
    await page.evaluate(() => {
      window.__state.workflows[0].managedPush = null;
    });
    await page.getByTestId("managed-push-execute-task").waitFor({ state: "detached" });
    await panel.getByText("이전 푸시 기록", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.__calls.filter((call) => call.name === "execute").length),
      2,
    );
    await page.evaluate(() => {
      window.__state.workflows[0].mode = "general";
      window.__state.workflows[0].generalAgent = {
        provider: "codex",
        model: "chosen",
        thinking: "high",
      };
    });
    await page
      .getByTestId("workflow-task")
      .getByText("Codex · chosen · high", { exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
  },
);
