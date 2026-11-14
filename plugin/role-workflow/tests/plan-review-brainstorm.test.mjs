import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, choice } from './brainstorm-fixture.mjs';
import { composeCurrentPrompt } from '../server/roles.ts';
import { titlePrompt, progressPrompt, pushApprovalPrompt } from '../server/protocol.ts';
import { SCREEN_SELECTION_PROMPT } from '../server/executor-selection.ts';
import { resolveModelFromCatalog } from '../server/model-resolution.ts';
import { RULES } from '../server/rules-content.ts';

async function finish(f, first, second, {include=true}={}) {
 const id='finish';
 await f.engine.permission('A',{id,kind:'question',input:{questions:[
  {question:'진행 방식을 선택하세요',header:'방식',options:['일반개발','연합개발','개발 안 함'].map(label=>({label}))},
  ...(include?[{question:'계획 검증을 켤까요?',header:'계획검증',options:[{label:'켜기'},{label:'끄기'}]}]:[]),
 ]}});
 await f.engine.permissionResolved('A',id,{behavior:'allow',updatedInput:{answers:{방식:first,...(second===undefined?{}:{계획검증:second})}}});
 await f.settle(); return f.live();
}
async function brainstorm(t,contract=7) {
 const f=await fixture(t,{mode:'undecided',contract});
 f.port.reviewerModes=async()=>({enabled:true,modes:['plan','auto']});
 await f.question('브레인스토밍');return f;
}
test('AC-22: finish enables review, posts one early card, saves drafts, then reviews the first plan immediately',async t=>{
 const f=await brainstorm(t);let w=await finish(f,'연합개발','켜기');
 assert.equal(w.mode,'federated');assert.equal(w.reviewSelection.enabled,true);assert.equal(w.heldApproval,null);
 assert.equal(f.pickers.length,1);assert.equal(f.pickers[0][2].id,0);
 assert.equal((await f.engine.selectPlanReview(f.id,{...choice,enabled:true})).ok,true);
 assert.equal((await f.engine.selectExecutor(f.id,choice)).ok,true);w=await f.live();
 assert.equal(w.selectionDraft.stage,'ready');assert.equal(w.reviewSelection.stage,'ready');assert.equal(f.created.length,0);
 await f.say("", "note");await f.engine.tick();
 await f.restart();await f.engine.tick();await f.settle();assert.equal(f.pickers.length,1);
 assert.equal(f.created.length,0);assert.equal(f.sent.length,0);
 await f.say('','plan');w=await f.live();
 assert.equal(w.planReview.stage,'reviewing');assert.equal(w.planReview.round,1);assert.equal(w.status,'active');
 assert.deepEqual(f.created.map(c=>c.role),['reviewer']);assert.equal(f.sent.length,1);assert.equal(f.pickers.length,1);
 assert.equal(w.approvedHold,0);assert.equal(w.execute,null);
});
test('AC-22: early draft cannot approve a plan that arrived after the card snapshot',async t=>{
 const f=await brainstorm(t);await finish(f,'연합개발','켜기');await f.say('','plan');
 assert.equal((await f.engine.selectPlanReview(f.id,{...choice,enabled:true})).ok,false);
 assert.equal((await f.engine.selectExecutor(f.id,choice)).ok,false);assert.equal(f.created.length,0);
});
test('AC-22: turning review off after the early card reuses that card at the held plan',async t=>{
 const f=await brainstorm(t);await finish(f,'연합개발','켜기');
 await f.engine.selectPlanReview(f.id,{enabled:false});await f.say('','plan');
 const w=await f.live();assert.equal(w.planReview.stage,'off');assert.equal(f.pickers.length,1);
 assert.equal(w.pickerPostedFor,0);assert.equal(f.created.length,0);
});
test('AC-23 / AC-7′: off and unknown answers post an early card; other modes and contract6 ignore the second answer',async t=>{
 const off=await brainstorm(t);let w=await finish(off,'연합개발','끄기');
 assert.equal(w.reviewSelection.enabled,false);assert.equal(off.pickers.length,1);
 await off.say('','plan');assert.equal(off.pickers.length,1);
 for(const first of ['일반개발','개발 안 함']){
  const f=await brainstorm(t);w=await finish(f,first,'켜기');assert.equal(w.reviewSelection.enabled,null);assert.equal(f.pickers.length,0);
 }
 for(const [answer,include] of [[undefined,true],['추천 켜기',true],['켜기',false]]){
  const f=await brainstorm(t);w=await finish(f,'연합개발',answer,{include});assert.equal(w.reviewSelection.enabled,null);assert.equal(f.pickers.length,1);
 }
 const legacy=await brainstorm(t,6);w=await finish(legacy,'연합개발','켜기');assert.equal(w.reviewSelection.enabled,null);assert.equal(legacy.pickers.length,0);
 const initial=await fixture(t,{mode:'undecided',contract:7});w=await finish(initial,'연합개발','켜기');assert.equal(w.reviewSelection.enabled,null);
});
test('AC-24: contract7 instructions contain the exact review question and retain bounded prompts',()=>{
 const trailing=titlePrompt()+progressPrompt()+pushApprovalPrompt();
 // Captured from 9be6c39's roles.ts, before TASK-6; preserve every contract6 byte.
 const legacyHashes={undecided:'07afa9457203c95c48d824dbb5500568a59276fa1903d134b252cf61193b33aa',federated:'6822178c144f7adb94b11042f2c1af9a998e25d7e2650cc55b398586447a9a94'};
 for(const mode of ['undecided','federated']){
  const seven=composeCurrentPrompt('claude','',mode,'/x/rules/0123456789ab/README.md',SCREEN_SELECTION_PROMPT,trailing,7);
  assert.match(seven,/계획 검증을 켤까요\?/);assert.match(seven,/header: 계획검증/);assert.match(seven,/선택지 라벨: 켜기, 끄기/);
  assert.ok(seven.length <= (mode==='undecided'?7900:7700));
  assert.doesNotMatch(composeCurrentPrompt('claude','',mode,null,'','',6),/계획 검증을 켤까요/);
  assert.equal(createHash('sha256').update(composeCurrentPrompt('claude','',mode,null,'','',6)).digest('hex'),legacyHashes[mode]);
 }
 assert.match(RULES['15-design-guide.md'],/같은 질문 도구 호출에 두 번째 질문 `계획 검증을 켤까요\?`/);
});
test('AC-25: unspecified planner resolves the same catalog default as agent creation',async t=>{
 const f=await brainstorm(t);await finish(f,'연합개발','켜기');
 f.agents.get('A').config={provider:'claude'};
 f.port.models=async()=>[{id:'X',label:'X',isDefault:true},{id:'Y',label:'Y'},{id:'hidden',label:'Hidden',isDefault:true,isSelectable:false}];
 let rows=(await f.engine.reviewOptions(f.id)).providers.find(p=>p.provider==='claude').models;
 assert.match(rows.find(m=>m.id==='X').reason,/다른/);assert.equal(rows.find(m=>m.id==='Y').reason,null);
 await assert.rejects(f.engine.selectPlanReview(f.id,{enabled:true,provider:'claude',model:'X',thinking:''}),/다른/);
 assert.equal((await f.engine.selectPlanReview(f.id,{enabled:true,provider:'claude',model:'Y',thinking:''})).ok,true);
 assert.equal(resolveModelFromCatalog({provider:'claude'},await f.port.models()),'X');
 let lookups=0;f.port.models=async provider=>{if(provider==='claude'&&lookups++===0)throw Error('default unavailable');return [{id:'Y',label:'Y'}];};
 rows=(await f.engine.reviewOptions(f.id)).providers.find(p=>p.provider==='claude').models;
 assert.match(rows.find(m=>m.id==='Y').reason,/계획 담당 모델을 확인/);
 f.port.models=async()=>[];rows=(await f.engine.reviewOptions(f.id)).providers.find(p=>p.provider==='claude').models;assert.deepEqual(rows,[]);
 assert.equal(resolveModelFromCatalog({provider:'claude'},[{id:'first',label:'First'},{id:'second',label:'Second'}]),'first');
});
