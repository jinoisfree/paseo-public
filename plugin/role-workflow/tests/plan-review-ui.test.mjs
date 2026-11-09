import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// AC-11/12/17: observe the real picker and its submitted RPC at two viewport sizes.
test('review picker shows eligibility, progress and blocks approval before verification',{timeout:60000},async t=>{
 const bundle=await build({stdin:{contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ExecutorPicker} from './client/executor-picker';
window.calls=[];window.w={id:'task',contract:7,mode:'federated',status:'needs_input',executeAgentId:null,firstPlan:true,heldPlan:true,heldApproval:{id:1,summary:'계획',handoff:'handoff.md',decisionHash:'a'.repeat(64)},selection:{provider:'codex',model:'builder',thinking:'high'},reviewSelection:{enabled:null},planReview:{stage:'waiting_choice',round:0,maxRounds:2,path:'docs/changes/test/plan-review.md',verdict:null,outcome:null}};
window.options=async()=>({providers:[{provider:'codex',mode:'read-only',reason:'읽기 전용 모드 없음',models:[]},{provider:'claude',mode:'plan',reason:null,models:[{id:'same',label:'Same planner',reason:'계획담당과 같은 모델',thinkingOptions:[]},{id:'other',label:'Other reviewer',reason:null,thinkingOptions:[{id:'high',label:'Review high',isDefault:true}]}]}]});
if(location.search.includes('none'))window.options=async()=>({providers:[{provider:'codex',mode:'read-only',reason:'읽기 전용 모드 없음',models:[]},{provider:'claude',mode:'plan',reason:'꺼진 제품',models:[]}]});
if(location.search.includes('early'))Object.assign(window.w,{brainstorm:true,heldApproval:null,heldPlan:false,reviewSelection:{enabled:true}});
if(location.search.includes('reserve'))Object.assign(window.w,{reviewSelection:{enabled:true},planReview:{...window.w.planReview,stage:'reviewing',round:1}});
window.models=async()=>({models:[{id:'builder',label:'Builder',thinkingOptions:[{id:'high',label:'High'}]}],error:null});
window.choose=async input=>{window.calls.push(input);if(input.reserve||window.w.brainstorm)window.w={...window.w,implementationReserved:true};return {ok:true,detail:'구현 승인'};};
window.review=async input=>{window.calls.push(input);window.w={...window.w,reviewSelection:{...input},planReview:{...window.w.planReview,stage:input.enabled?'reviewing':'off',round:input.enabled?1:0}};return {ok:true,detail:'확인'};};
window.cancel=async input=>{window.calls.push(input);window.w={...window.w,implementationReserved:false};return {ok:true,detail:'예약 취소'};};
const theme={colors:{foreground:'#ddd',foregroundMuted:'#aaa',border:'#555'}};
function App(){const[w,setW]=useState(window.w);window.update=()=>setW({...window.w});return <ExecutorPicker workflow={w} theme={theme} onChanged={window.update}/>;}
createRoot(document.getElementById('root')).render(<App/>);
`,resolveDir:path.resolve(import.meta.dirname,'..'),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',alias:{'react-native':'react-native-web'},plugins:[{name:'sdk',setup(b){b.onResolve({filter:/^@getpaseo\/plugin(?:\/client)?$/},a=>({path:a.path,namespace:'sdk'}));b.onLoad({filter:/.*/,namespace:'sdk'},a=>({contents:a.path.endsWith('/client')?"export const useRpc=c=>c.name==='workflow.models'?window.models:c.name==='workflow.review-options'?window.options:c.name==='workflow.select-plan-review'?window.review:c.name==='workflow.cancel-implementation-reservation'?window.cancel:window.choose;":"export const defineRpc=x=>x;"}));}}]});
 const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'application/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0].text:'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const width of [390,1280]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);const approve=page.getByRole('button',{name:'이 담당으로 확정',exact:true});
  await page.getByRole('button',{name:'✓ High',exact:true}).waitFor();assert.equal(await approve.isDisabled(),true);
  await page.getByRole('button',{name:'켜기',exact:true}).click();
  assert.equal(await page.getByTestId('plan-review-picker').getByRole('button',{name:/Codex ·/}).isDisabled(),true);
  await page.getByTestId('plan-review-picker').getByRole('button',{name:'Claude Code',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:/Same planner/}).isDisabled(),true);
  await page.getByRole('button',{name:'Other reviewer',exact:true}).click();
  await page.getByRole('button',{name:'✓ Review high (기본)',exact:true}).waitFor();
  await page.getByRole('button',{name:/Review high/}).click();
  // AC-6: all four selection groups share wrapping rows and selected button styles.
  const review=page.getByTestId('plan-review-picker');
  const groups=[review.getByRole('button',{name:'✓ 켜기',exact:true}),review.getByRole('button',{name:'✓ Claude Code',exact:true}),review.getByRole('button',{name:'✓ Other reviewer',exact:true}),review.getByRole('button',{name:'✓ Review high (기본)',exact:true})];
  for(const group of groups)assert.deepEqual(await group.evaluate(el=>{const s=getComputedStyle(el.parentElement);return [s.flexDirection,s.flexWrap];}),['row','wrap']);
  const style=el=>{const s=getComputedStyle(el);return [s.paddingTop,s.paddingLeft,s.borderColor,s.borderWidth,s.borderRadius];};
  assert.deepEqual(await groups[3].evaluate(style),await page.getByRole('button',{name:'✓ High',exact:true}).evaluate(style));
  await page.getByRole('button',{name:'검증 선택·시작',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls),[{id:'task',holdId:1,enabled:true,provider:'claude',model:'other',thinking:'high'}]);
  await page.getByText(/계획 검증 1\/2 · reviewing/).waitFor();assert.equal(await approve.isDisabled(),true);
  await page.evaluate(()=>{window.w.planReview={...window.w.planReview,stage:'passed',hash:'a'.repeat(64),verdict:{verdict:'APPROVED',findings:[]}};window.update();});
  await page.getByText(/계획 검증 1\/2 · passed/).waitFor();assert.equal(await approve.isEnabled(),true);await approve.click();
  assert.equal(await page.evaluate(()=>window.calls.at(-1).holdId),1);
  await page.evaluate(()=>{window.w.planReview={...window.w.planReview,stage:'limit',verdict:{verdict:'BLOCKED',findings:[{severity:'차단'}]},round:2};window.update();});
  await page.getByRole('button',{name:'검토 1회 더',exact:true}).waitFor();
  await page.getByRole('button',{name:'미통과로 승인',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.at(-1).unverified),true);
  assert.equal(await page.getByText(/차단 1/).count(),1);assert.deepEqual(errors,[]);
  await page.goto(`http://127.0.0.1:${server.address().port}?none=1`);
  await page.getByText('적격 검증 후보가 없습니다. 켜진 제품·다른 모델·읽기 전용 모드를 확인하세요.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'켜기',exact:true}).isDisabled(),true);assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  await page.goto(`http://127.0.0.1:${server.address().port}?early=1`);
  await page.getByTestId('plan-review-picker').getByRole('button',{name:'Claude Code',exact:true}).click();
  await page.getByRole('button',{name:'Other reviewer',exact:true}).click();
  await page.getByRole('button',{name:/Review high/}).click();
  await page.getByRole('button',{name:'검증 담당 초안 저장',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls),[{id:'task',enabled:true,provider:'claude',model:'other',thinking:'high'}]);
  await page.getByRole('button',{name:'구현 담당 초안 저장',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),{id:'task',provider:'codex',model:'builder',thinking:'high'});
  await page.getByText(/구현 시작 예약됨/).waitFor();await page.getByRole('button',{name:'예약 취소',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),{id:'task'});
  assert.equal(await page.getByText(/구현 시작 예약됨/).count(),0);
  await page.goto(`http://127.0.0.1:${server.address().port}?reserve=1`);
  await page.getByRole('button',{name:'✓ High',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'이 담당으로 확정',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'검증 통과 시 구현 시작',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls),[{id:'task',provider:'codex',model:'builder',thinking:'high',holdId:1,reserve:true}]);
  await page.getByText(/구현 시작 예약됨/).waitFor();
  assert.deepEqual(errors,[]);
  await page.close();
 }
});
