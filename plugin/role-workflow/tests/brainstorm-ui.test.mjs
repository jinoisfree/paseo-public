import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('AC-7/22: compact and desktop pickers bind the displayed plan snapshot and refresh after rejection',{timeout:60000},async t=>{
 const root=path.resolve(import.meta.dirname,'..');
 const bundle=await build({stdin:{contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ModePickerCard} from './client/mode-picker';
import {ExecutorPicker,ExecutorPickerCard,PlanExecutorPicker} from './client/executor-picker';
import {parseDecision} from './shared/decision';import {decisionHash} from './shared/plan-approval';
const a=parseDecision('<paseo-workflow>'+JSON.stringify({status:'plan',summary:'A',next:'instruction',handoff:'a.md'})+'</paseo-workflow>');
const b={...a,summary:'B',handoff:'b.md'};window.__a=a;window.__b=b;window.__hash=decisionHash;
window.__workflow={id:'task',contract:6,mode:'federated',status:'needs_input',executeAgentId:null,planAgentId:'A',heldPlan:true,selection:{provider:'codex',model:'builder',thinking:'high'},heldApproval:{id:1,summary:'A',handoff:'a.md',decisionHash:decisionHash(a)}};
window.__calls=[];window.__read=async()=>({workflows:[window.__workflow]});window.__models=async()=>({models:[{id:'builder',label:'Builder',thinkingOptions:[{id:'high',label:'High'}]}],error:null});
window.__choose=async input=>{window.__calls.push(input);return {ok:input.holdId===window.__workflow.heldApproval?.id,detail:input.holdId===window.__workflow.heldApproval?.id?'승인 완료':'계획이 바뀌었습니다. 현재 계획을 확인하고 다시 고르세요.'};};
window.__mode=async input=>{window.__calls.push(input);return {ok:true,detail:'논의 시작'};};
const theme={colors:{foreground:'#eee',foregroundMuted:'#aaa',border:'#555'}};const query=new URLSearchParams(location.search),kind=query.get('kind');
if(query.get('contract'))window.__workflow.contract=Number(query.get('contract'));
if(kind==='old'){window.__workflow.heldApproval={id:2,summary:'B',handoff:'b.md',decisionHash:decisionHash(b)};}
if(kind==='aba'){window.__workflow.heldApproval.id=3;}
if(kind==='replacement'){window.__workflow.firstPlan=false;window.__workflow.heldApproval=null;}
function Dashboard(){const [w,setW]=useState(window.__workflow);return <ExecutorPicker key={w.heldApproval?.id} workflow={w} theme={theme} onChanged={()=>setW({...window.__workflow})}/>;}
createRoot(document.getElementById('root')).render(kind==='mode'?<ModePickerCard item={{data:{workflowId:'task'}}} theme={theme}/>:kind==='dashboard'?<Dashboard/>:kind==='card'?<ExecutorPickerCard item={{data:{workflowId:'task'}}} theme={theme}/>:<PlanExecutorPicker agentId='A' theme={theme} decision={a}/>);
`,resolveDir:root,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',alias:{'react-native':'react-native-web'},plugins:[{name:'sdk',setup(b){b.onResolve({filter:/^@getpaseo\/plugin(?:\/client)?$/},args=>({path:args.path,namespace:'sdk'}));b.onLoad({filter:/.*/,namespace:'sdk'},args=>({contents:args.path.endsWith('/client')?"export const useRpc=c=>c.name==='workflow.status'?window.__read:c.name==='workflow.models'?window.__models:c.name==='workflow.select-mode'?window.__mode:window.__choose;":"export const defineRpc=x=>x;"}));}}]});
 const server=createServer((request,response)=>{response.setHeader('Content-Type',request.url.startsWith('/bundle.js')?'application/javascript':'text/html');response.end(request.url.startsWith('/bundle.js')?bundle.outputFiles[0].text:'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const viewport of [{width:1280,height:800},{width:390,height:844}]){
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));const url=`http://127.0.0.1:${server.address().port}`;
  for(const contract of [5,6]){await page.goto(`${url}?kind=mode&contract=${contract}`);await page.getByText('진행 방식을 선택하세요',{exact:true}).waitFor();if(contract===6)await page.getByRole('button',{name:'브레인스토밍',exact:true}).waitFor();assert.equal(await page.getByRole('button').count(),contract===6?3:2);if(contract===6){await page.getByRole('button',{name:'브레인스토밍',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.__calls),[{id:'task',mode:'brainstorm'}]);}}
  await page.goto(`${url}?kind=old`);await page.getByText('이전 계획입니다. 현재 계획을 확인하세요.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'이 담당으로 확정',exact:true}).count(),0);
  for(const kind of ['card','dashboard']){
   await page.goto(`${url}?kind=${kind}`);const submit=page.getByRole('button',{name:'이 담당으로 확정',exact:true});await submit.waitFor();await page.getByRole('button',{name:'✓ High',exact:true}).waitFor();
   await page.evaluate(()=>{window.__workflow={...window.__workflow,heldApproval:{id:2,summary:'B',handoff:'b.md',decisionHash:window.__hash(window.__b)}};});
   await submit.click();await page.getByText('보관 계획 #2\nB\nb.md',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.__calls.map(c=>c.holdId)),[1]);await submit.click();assert.deepEqual(await page.evaluate(()=>window.__calls.map(c=>c.holdId)),[1,2]);
  }
  await page.goto(`${url}?kind=replacement`);await page.getByRole('button',{name:'✓ High',exact:true}).waitFor();await page.getByRole('button',{name:'이 담당으로 확정',exact:true}).click();assert.equal(await page.evaluate(()=>window.__calls[0].holdId),undefined);
  await page.goto(`${url}?kind=aba`);await page.getByRole('button',{name:'✓ High',exact:true}).waitFor();await page.getByRole('button',{name:'이 담당으로 확정',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.__calls.map(c=>c.holdId)),[3]);assert.deepEqual(errors,[]);await page.close();
 }
});
