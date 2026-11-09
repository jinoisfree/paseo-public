import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, block, choice } from './brainstorm-fixture.mjs';

const LEGACY_REVIEW = '구현 결과를 검토하세요. 규칙 30-verification 3.2–7절에 따라 handoff·impl-report와 실제 변경 파일·시험을 직접 확인하고, 설계 적합성(4.2)을 따로 판정한 뒤 작업 문서 폴더에 verdict.md를 쓰세요. 완료 조건 충족 시 complete, 부분 완료·미완료면 원인을 분류해 구체적 수정 계획과 함께 plan을 반환하세요.';
const OFF = '계획 검증 끔 — 구현 담당을 확정하면 구현을 시작합니다.';

async function reply(f, role, status, extra={}) {
 const w=await f.live(), agent=w[role], key=`live-${role}-${f.sent.length}`, text=block(status,extra), messageId=w.pending?.id;
 f.agents.get(agent.id).status='idle';
 f.histories.set(agent.id,{text,key,failed:null,messageIds:messageId?[messageId]:[]});
 await f.engine.ended(agent.id,key,text,null,'',false,'',false,messageId?[messageId]:[]);
 await f.settle();
}

for(const scenario of [
 {name:'relative handoff',next:'구현',handoff:'docs/changes/live/handoff.md',folder:'docs/changes/live',enabled:true},
 {name:'absolute design',next:'/tmp/c7-live-docs/design.md 구현',handoff:'계획',folder:'/tmp/c7-live-docs',enabled:true},
 {name:'no document path',next:'구현',handoff:'계획',enabled:true},
 {name:'disabled before first plan',next:'구현',handoff:'docs/changes/off/handoff.md',folder:'docs/changes/off',enabled:false},
 {name:'disabled with no document path',next:'구현',handoff:'계획',enabled:false},
 {name:'existing disabled task without a stored path',next:'docs/changes/existing/handoff.md 구현',handoff:'계획',folder:'docs/changes/existing',enabled:false,missingPath:true},
])test(`C7-LIVE AC-2: ${scenario.name} sends the exact verdict path beside plan-review`,async t=>{
 const f=await fixture(t,{contract:7});
 f.port.reviewerModes=async()=>({enabled:true,modes:['auto','plan']});
 if(!scenario.enabled)(await f.live()).reviewSelection.enabled=false;
 await f.say('','plan',{next:scenario.next,handoff:scenario.handoff});
 const folder=scenario.folder??`docs/changes/${f.id}`;
 assert.equal((await f.live()).planReview.path,`${folder}/plan-review.md`);
 if(scenario.enabled){
  assert.equal((await f.engine.selectPlanReview(f.id,{...choice,enabled:true,holdId:1})).ok,true);
  await reply(f,'reviewer','result',{planReview:{planHash:(await f.live()).heldApproval.decisionHash,verdict:'APPROVED',findings:[]}});
  await reply(f,'plan','note');
 }
 assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:1})).ok,true);
 if(scenario.missingPath)(await f.live()).planReview.path='';
 await reply(f,'execute','result');
 const prompt=f.sent.at(-1).prompt;
 assert.ok(prompt.includes(`판정한 뒤 ${folder}/verdict.md를 쓰세요.`),prompt);
 assert.doesNotMatch(prompt,/작업 문서 폴더에 verdict.md/);
});

test('C7-LIVE AC-2/5: contract6 final review instruction retains every legacy byte',async t=>{
 const f=await fixture(t,{contract:6});
 await f.say('','plan',{next:'docs/changes/legacy/handoff.md 구현'});
 await f.engine.selectExecutor(f.id,{...choice,holdId:1});await reply(f,'execute','result');
 const prompt=f.sent.at(-1).prompt, start=prompt.indexOf('구현 결과를 검토하세요.');
 assert.ok(start>=0);assert.equal(prompt.slice(start).split('\n')[0],LEGACY_REVIEW);
 assert.doesNotMatch(prompt,/docs\/changes\/legacy\/verdict.md/);
});

test('C7-LIVE AC-3: disabling review returns and persists the current instruction',async t=>{
 const f=await fixture(t,{contract:7});await f.say('','plan');
 const result=await f.engine.selectPlanReview(f.id,{enabled:false,holdId:1});
 assert.equal(result.detail,OFF);assert.equal((await f.live()).detail,OFF);
 assert.doesNotMatch(result.detail,/켜기\/끄기를 선택하세요/);
 await f.restart();assert.equal((await f.live()).detail,OFF);
});

test('C7-LIVE AC-3: early-card review off also returns the new instruction',async t=>{
 const f=await fixture(t,{contract:7,mode:'undecided'});await f.question('브레인스토밍');await f.question('연합개발');
 (await f.live()).reviewSelection.enabled=true;
 const result=await f.engine.selectPlanReview(f.id,{enabled:false});
 assert.equal(result.detail,OFF);assert.equal((await f.live()).detail,OFF);assert.equal(f.created.length,0);
});

test('C7-LIVE AC-3: a sent reviewer keeps the existing delayed-disable message',async t=>{
 const f=await fixture(t,{contract:7});f.port.reviewerModes=async()=>({enabled:true,modes:['auto','plan']});
 await f.say('','plan');await f.engine.selectPlanReview(f.id,{...choice,enabled:true,holdId:1});
 const result=await f.engine.selectPlanReview(f.id,{enabled:false,holdId:1});
 assert.equal(result.detail,'진행 중인 검증 응답을 기다린 뒤 검증을 끕니다.');
 assert.equal((await f.live()).detail,result.detail);assert.notEqual((await f.live()).planReview.stage,'off');
});
