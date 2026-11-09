import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, block, choice } from './brainstorm-fixture.mjs';
import { capabilities } from '../shared/capabilities.ts';
import { parseDecision } from '../shared/decision.ts';
import { readFile, mkdtemp, symlink, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { composeCurrentPrompt, composePrompt } from '../server/roles.ts';
import { recommendedSettings } from '../shared/recommended.ts';
import { ownerPolicySchema } from '../shared/owner-policy.ts';

async function setup(t) {
  const f = await fixture(t, { contract: 7 });
  f.port.reviewerModes = async provider => ({ enabled: true, modes: provider === 'codex' ? ['read-only','full-access'] : ['plan','bypassPermissions'] });
  await f.say('', 'plan', { next: '작업 ID: test\ndocs/changes/test/handoff.md 구현' });
  return f;
}
async function enable(f) {
  await f.engine.selectPlanReview(f.id, { ...choice, enabled: true, holdId: (await f.live()).heldApproval.id });
}
async function reply(f, role, status, extra = {}, evidence) {
  const w = await f.live(), agent = w[role];
  f.agents.get(agent.id).status = 'idle';
  const key = `reply-${f.sent.length}-${role}`, text = block(status, extra), messageId = w.pending?.id;
  f.histories.set(agent.id, { text, key, failed: null, messageIds: messageId ? [messageId] : [], evidence });
  await f.engine.ended(agent.id, key, text, null, '', false, '', false, messageId ? [messageId] : [], evidence);
  await f.settle();
}
const verdict = (hash, blocked = false) => ({ planHash: hash, verdict: blocked ? 'BLOCKED' : 'APPROVED',
  findings: blocked ? [{ id:'F1', severity:'차단', text:'수락 시험 누락', evidence:'design.md 7절' }] : [] });

test('AC-1: contract7 capability is federated only', () => {
  for (const contract of [1,2,3,4,5,6,7]) for (const mode of ['general','federated','undecided'])
    assert.equal(capabilities({ contract, mode }).planReview, contract === 7 && mode === 'federated');
});
test('AC-12: unanswered review choice never dispatches implementation', async t => {
  const f = await setup(t), w = await f.live();
  assert.equal(w.reviewSelection.enabled, null); assert.equal(w.planReview.stage, 'waiting_choice');
  assert.equal(f.created.length, 0);
  assert.equal((await f.engine.selectExecutor(f.id, { ...choice, holdId:1 })).ok, false);
});
test('AC-2: disabled contract7 matches contract6 first-plan delivery', async t => {
  const seven = await setup(t);
  await seven.engine.selectPlanReview(seven.id, { enabled:false, holdId:1 });
  await seven.engine.selectExecutor(seven.id, { ...choice, holdId:1 });
  const six = await fixture(t); await six.say('', 'plan');
  await six.engine.selectExecutor(six.id, { ...choice, holdId:1 });
  assert.deepEqual(seven.created.map(c => c.role), ['execute']);
  assert.deepEqual(six.created.map(c => c.role), ['execute']);
  assert.equal(seven.sent.length, 1); assert.equal(six.sent.length, 1);
  assert.equal((await seven.live()).phase, (await six.live()).phase);
});
test('AC-4/5: read-only review precedes approval and executor delivery', async t => {
  const f = await setup(t); await enable(f);
  let w = await f.live();
  assert.equal(w.planReview.round, 1); assert.equal(w.cycles, 0);
  assert.deepEqual(f.created.map(c=>c.role), ['reviewer']);
  assert.equal(f.created[0].m.config.modeId, 'read-only');
  assert.match(f.sent[0].prompt, new RegExp(w.heldApproval.decisionHash));
  assert.match(f.sent[0].prompt, /handoff.md 구현/);
  assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:1})).ok,false);
  await reply(f, 'reviewer', 'result', {planReview:verdict(w.heldApproval.decisionHash)});
  w=await f.live(); assert.equal(w.planReview.stage,'revising'); assert.equal(w.pending.role,'plan');
  await reply(f,'plan','note'); w=await f.live(); assert.equal(w.planReview.stage,'passed');
  assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:1})).ok,true);
  w=await f.live(); assert.equal(w.planReview.stage,'done'); assert.equal(w.planReview.outcome,'passed');
  assert.deepEqual(f.created.map(c=>c.role),['reviewer','execute']);
  assert.equal(f.sent.filter(s=>s.id===w.reviewer.id).length,1);
});

async function blockedTwice(f) {
  await enable(f);
  await reply(f,'reviewer','result',{planReview:verdict((await f.live()).heldApproval.decisionHash,true)});
  await reply(f,'plan','plan',{summary:'수정1',next:'docs/changes/test/handoff.md 수정 구현'});
  let w=await f.live();
  assert.equal(w.planReview.round,2); assert.equal(w.cycles,0);
  assert.match(f.sent.at(-1).prompt,/이전 회차 기록: docs\/changes\/test\/plan-review.md/);
  await reply(f,'reviewer','result',{planReview:verdict(w.heldApproval.decisionHash,true)});
  assert.match(f.sent.at(-1).prompt,/다음 자동 검토 없음/);
  await reply(f,'plan','plan',{summary:'수정2',next:'docs/changes/test/handoff.md 최종 구현'});
  w=await f.live(); assert.equal(w.planReview.stage,'limit'); assert.equal(w.status,'needs_input');
  assert.equal(f.sent.filter(s=>s.id===w.reviewer.id).length,2);
}
test('AC-6/7: two blocked rounds wait for user; unverified approval dispatches once',async t=>{
  const f=await setup(t); await blockedTwice(f); const w=await f.live();
  assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:w.heldApproval.id})).ok,false);
  assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:w.heldApproval.id,unverified:true})).ok,true);
  assert.equal((await f.live()).planReview.outcome,'unverified_approved');
  assert.equal(f.created.filter(c=>c.role==='execute').length,1);
});
test('AC-7: explicit additional round authorizes exactly one further review',async t=>{
  const f=await setup(t);await blockedTwice(f);
  await assert.rejects(f.engine.selectPlanReview(f.id,{...choice,enabled:true,holdId:(await f.live()).heldApproval.id}),/검토 한도/);
  await f.engine.selectPlanReview(f.id,{enabled:true,extra:true,holdId:(await f.live()).heldApproval.id});
  const w=await f.live(); assert.equal(w.planReview.round,3);assert.equal(w.planReview.maxRounds,3);
  assert.equal(f.sent.filter(s=>s.id===w.reviewer.id).length,3);
});
for(const kind of ['hash','changed','push','format'])test(`AC-8: invalid verdict ${kind} consumes no round and never dispatches executor`,async t=>{
  const f=await setup(t);await enable(f); const w=await f.live();
  const result=verdict(kind==='hash'?'a'.repeat(64):w.heldApproval.decisionHash);
  if(kind==='format')result.verdict='INVALID';
  const evidence={changed:kind==='changed',pushes:kind==='push'?[{command:'git push'}]:[],report:''};
  await reply(f,'reviewer','result',{planReview:result},evidence);
  const after=await f.live();assert.equal(after.planReview.round,1);assert.equal(after.planReview.stage,'reviewing');
  assert.equal(f.created.filter(c=>c.role==='execute').length,0);
  if(kind==='format'){assert.equal(after.repairs,1);assert.equal(after.pending.role,'reviewer');}
  else {assert.equal(after.status,'needs_input');assert.equal(after.asker,'reviewer');assert.ok(after.planReview.error);}
});
test('AC-8: formatting repair cannot clear a read-only violation',async t=>{
  const f=await setup(t);await enable(f);
  await reply(f,'reviewer','result',{planReview:{verdict:'INVALID'}},{changed:true,pushes:[],report:''});
  const w=await f.live();assert.equal(w.status,'needs_input');assert.equal(w.asker,'reviewer');assert.equal(w.repairs,0);
  assert.equal(w.planReview.round,1);assert.equal(w.pending,null);
});
test('AC-9: revised passed plan invalidates approval and requires another review',async t=>{
  const f=await setup(t);await enable(f);
  await reply(f,'reviewer','result',{planReview:verdict((await f.live()).heldApproval.decisionHash)});
  await reply(f,'plan','note');const old=(await f.live()).heldApproval.id;
  await f.say('','plan',{summary:'새 계획',next:'새 구현 지시'});
  const w=await f.live();assert.equal(w.planReview.stage,'reviewing');assert.equal(w.planReview.round,2);
  assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:old})).ok,false);
});
test('reviewer thinking re-selection applies the exact choice in a separate read-only member',async t=>{
  const f=await setup(t);await enable(f);const first=(await f.live()).reviewer.id;
  await reply(f,'reviewer','result',{planReview:verdict((await f.live()).heldApproval.decisionHash)});await reply(f,'plan','note');
  f.port.models=async()=>[{id:'builder',label:'Builder',thinkingOptions:[{id:'high',label:'High'},{id:'low',label:'Low'}]}];
  await f.engine.selectPlanReview(f.id,{...choice,thinking:'low',enabled:true,holdId:1});
  const w=await f.live();assert.notEqual(w.reviewer.id,first);assert.equal(w.reviewer.config.thinkingOptionId,'low');
  assert.equal(w.reviewer.config.modeId,'read-only');assert.equal(w.reviewer.generation,2);assert.ok(w.history.includes(first));
});
for(const status of ['plan','complete','continue','note'])test(`AC-10: reviewer ${status} is assignment error`,async t=>{
  const f=await setup(t);await enable(f);await reply(f,'reviewer',status);
  const w=await f.live();assert.equal(w.planReview.stage,'reviewing');assert.equal(w.planReview.round,1);
  assert.match(w.detail,/assignmentError/);assert.equal(f.created.length,1);
});
for(const role of ['plan','execute'])test(`AC-10: ${role} cannot submit planReview`,async t=>{
  const f=await setup(t);const w=await f.live();
  assert.match(f.engine.assignmentError(w,role,parseDecision(block('result',{planReview:verdict(w.heldApproval.decisionHash)}))),/assignmentError/);
});
test('AC-10: public planner/executor events reject foreign verdicts without changing verification state',async t=>{
  const f=await setup(t);const initial=await f.live(),hold=initial.heldApproval.id;
  await f.say('','plan',{planReview:verdict(initial.heldApproval.decisionHash)});
  let w=await f.live();assert.match(w.planReview.error,/assignmentError/);
  assert.equal(w.heldApproval.id,hold);assert.equal(w.planReview.round,0);assert.equal(f.created.length,0);
  await f.engine.selectPlanReview(f.id,{enabled:false,holdId:hold});await f.engine.selectExecutor(f.id,{...choice,holdId:hold});
  const stage=(await f.live()).planReview.stage;
  await reply(f,'execute','result',{planReview:verdict('a'.repeat(64))});
  w=await f.live();assert.match(w.planReview.error,/assignmentError/);assert.equal(w.planReview.stage,stage);
  assert.equal(w.pending.role,'execute');assert.equal(w.repairs,1);assert.equal(f.sent.filter(s=>s.id==='A').length,0);
});
test('AC-11: same model, disabled product, and missing mode are rejected by live server eligibility',async t=>{
  const f=await setup(t);f.port.models=async()=>[{id:'planner',label:'Planner',thinkingOptions:[{id:'high',label:'High'}]}];
  await assert.rejects(f.engine.selectPlanReview(f.id,{enabled:true,provider:'claude',model:'planner',thinking:'high',holdId:1}),/다른/);
  f.port.reviewerModes=async()=>({enabled:false,modes:['plan','read-only']});
  const disabled=await f.engine.reviewOptions(f.id);assert.ok(disabled.providers.every(p=>p.reason));
  await assert.rejects(f.engine.selectPlanReview(f.id,{...choice,model:'planner',enabled:true,holdId:1}),/꺼진/);
  f.port.reviewerModes=async()=>({enabled:true,modes:['full-access']});
  await assert.rejects(f.engine.selectPlanReview(f.id,{...choice,model:'planner',enabled:true,holdId:1}),/읽기 전용/);
  assert.equal(f.created.length,0);
});
test('AC-13: implementation replanning never dispatches another reviewer',async t=>{
  const f=await setup(t);await f.engine.selectPlanReview(f.id,{enabled:false,holdId:1});await f.engine.selectExecutor(f.id,{...choice,holdId:1});
  await reply(f,'execute','result');await reply(f,'plan','plan',{summary:'재계획',next:'수정 구현'});
  assert.equal(f.created.filter(c=>c.role==='reviewer').length,0);
  assert.equal((await f.live()).pending.role,'execute');
});
test('AC-14: actual base_commit loads contract7 reviewing state and another workflow without dispatch',async t=>{
  const root=path.resolve(import.meta.dirname,'../../..'),base='77cb3c89c4409698af48a8e2229d3ede938b7a75';
  // Missing baseline objects are a failure for this required acceptance gate.
  execFileSync('git',['cat-file','-e',`${base}^{commit}`],{cwd:root});
  const dir=await mkdtemp(path.join(tmpdir(),'plan-review-rollback-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const archive=path.join(dir,'base.tar');execFileSync('git',['archive','--output',archive,base,'--','plugin/role-workflow/server','plugin/role-workflow/shared','plugin/role-workflow/package.json'],{cwd:root});
  execFileSync('tar',['-xf',archive,'-C',dir]);await symlink(path.join(root,'node_modules'),path.join(dir,'node_modules'));
  const {WorkflowEngine}=await import(pathToFileURL(path.join(dir,'plugin/role-workflow/server/engine.ts')).href);
  const f=await setup(t);await enable(f);
  const other={...f.agents.get('A'),id:'OTHER'};f.agents.set(other.id,other);
  await f.engine.enroll(other,f.config,{},'general',true,6);
  const disk=JSON.parse(await readFile(f.file,'utf8'));
  assert.equal(disk.workflows[0].status,'needs_input');assert.equal(disk.workflows[0].pending,null);
  assert.equal(disk.workflows[0].planReviewRuntime.pending.role,'reviewer');
  const before=f.sent.length;await f.restart(undefined,WorkflowEngine);await f.engine.tick();
  const loaded=await f.engine.list();assert.equal(loaded.workflows.length,2);
  assert.equal(loaded.workflows.find(w=>w.id===f.id).status,'needs_input');assert.equal(f.sent.length,before);
});
test('AC-15: reviewer pending survives restart without duplicate send',async t=>{
  const f=await setup(t);await enable(f);const before=f.sent.length;
  await f.restart();await f.engine.tick();assert.equal(f.sent.length,before);
  assert.equal((await f.live()).pending.role,'reviewer');
});
test('AC-15: reviewer event without message ids is recovered from the exact same history once',async t=>{
  const f=await setup(t);await enable(f);const w=await f.live(),id=w.reviewer.id;
  f.agents.get(id).status='idle';const text=block('result',{planReview:verdict(w.heldApproval.decisionHash)}),key='lost-correlation';
  f.histories.set(id,{text,key,failed:null,messageIds:[w.pending.id]});
  await f.engine.ended(id,key,text,null,'',false,'unrelated user text',false,[]);
  assert.equal((await f.live()).planReview.stage,'revising');
  assert.equal(f.sent.filter(s=>s.id==='A').length,1);await f.engine.tick();assert.equal(f.sent.filter(s=>s.id==='A').length,1);
});
test('AC-15: reviewer native compaction and quota/transient recovery reuse the common engine',async t=>{
  const f=await setup(t);await enable(f);let w=await f.live();const id=w.reviewer.id;
  await f.engine.configure({...await f.engine.settings(),autoResumeQuota:true,autoResumeTransient:true});
  let now=Date.now();f.engine.now=()=>now;
  const fail=async(message,key)=>{
    f.agents.get(id).status='error';const messageId=(await f.live()).pending.id;
    f.histories.set(id,{text:'',key,failed:message,messageIds:[messageId]});
    await f.engine.ended(id,key,'',message,'',false,'',false,[messageId]);
  };
  await fail("You've hit your usage limit",'quota');w=await f.live();
  assert.equal(w.quotaPause.role,'reviewer');assert.equal(w.status,'paused');
  const count=f.sent.length;f.port.quotaAvailable=async()=>true;f.agents.get(id).status='idle';now+=120000;
  await f.engine.tick();w=await f.live();assert.equal(w.pending.role,'reviewer');assert.equal(f.sent.length,count+1);
  await fail('503 overloaded','transient');w=await f.live();assert.equal(w.transientPause.role,'reviewer');
  f.agents.get(id).status='idle';now+=120000;await f.engine.tick();assert.equal(f.sent.length,count+2);
  w=await f.live();assert.equal(w.planReview.round,1);assert.equal(w.cycles,0);
  await f.engine.maintenanceEnded(id,'compact',true);w=await f.live();assert.equal(w.reviewer.compactedForTurn,w.reviewer.lastTurnKey);
  await f.engine.tick();assert.equal(f.sent.length,count+2);
});
test('AC-15: reviewer context compression uses common prepareCompaction and continues once',async t=>{
  const f=await setup(t);await enable(f);const w=await f.live();const id=w.reviewer.id;
  await reply(f,'reviewer','input');
  await f.engine.configure({...await f.engine.settings(),codexCompression:'threshold'});
  f.agents.get(id).usage=0.9;const compactions=[];f.port.compact=async(agent,message)=>{compactions.push({agent,message});f.agents.get(id).usage=0;};
  await f.engine.control(f.id,'resume','질문 답변');await f.settle();await f.engine.tick();
  assert.equal(compactions.length,1);assert.equal(compactions[0].agent,id);
  assert.equal((await f.live()).reviewer.compactions,1);
  assert.equal(f.sent.filter(s=>s.id===id).length,2);
});
test('review disabled while sent waits, ignores the old response and permits exactly one implementation',async t=>{
  const f=await setup(t);await enable(f);await f.engine.selectPlanReview(f.id,{enabled:false,holdId:1});
  assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:1})).ok,false);
  await reply(f,'reviewer','note');assert.equal((await f.live()).planReview.stage,'off');
  assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:1})).ok,true);
  assert.equal(f.created.filter(c=>c.role==='execute').length,1);
});
test('AC-16: unknown conversation turn is ignored',async t=>{
  const f=await setup(t),before=JSON.stringify(await f.live());
  await f.engine.ended('UNKNOWN','unknown',block('result'),null);
  assert.equal(JSON.stringify(await f.live()),before);assert.equal(f.sent.length,0);
});
test('P-1: explicit contract6 registration retains federation and standalone prompt behavior',async t=>{
  for(const mode of ['federated','general']){
    const f=await fixture(t,{contract:6,mode}), w=await f.live();
    assert.equal(w.contract,6);assert.equal(w.mode,mode);assert.equal(w.completeRepairs,0);assert.equal(w.execute,null);
    const prompt=composeCurrentPrompt('claude',undefined,mode,null,'','',6);
    if(mode==='federated')assert.equal(prompt.split('계획 담당이 complete를 낼 때 verdict').length-1,1);
    else {assert.equal(capabilities(w).standalone,true);assert.doesNotMatch(prompt,/<paseo-automation-v1>/);}
  }
});
test('N-1: contract7 general preserves contract6 standalone behavior without plan verification',async t=>{
  for(const contract of [6,7]){
    const f=await fixture(t,{contract,mode:'general'}), w=await f.live();
    assert.equal(w.contract,contract);assert.equal(w.execute,null);assert.equal(w.reviewer,null);
    assert.equal(capabilities(w).standalone,true);assert.equal(capabilities(w).planReview,false);
    assert.doesNotMatch(composeCurrentPrompt('claude',undefined,'general',null,'','',contract),/<paseo-automation-v1>/);
  }
});
test('AC-18: reviewer instructions are read-only, bounded, idempotent and include verdict protocol',()=>{
  for(const provider of ['claude','codex']){
    const prompt=composePrompt(provider,'project',{role:'reviewer',automated:true});
    assert.match(prompt,/읽기 전용/);assert.match(prompt,/파일 수정·커밋·푸시/);assert.match(prompt,/planHash/);
    assert.match(prompt,/APPROVED/);assert.match(prompt,/BLOCKED/);assert.match(prompt,/승인 도구나 계획 모드 종료 도구를 호출하지/);
    assert.ok(prompt.length<8000);assert.equal(composePrompt(provider,prompt,{role:'reviewer',automated:true}),prompt);
  }
});
test('AC-19: reviewer modes are recommended, policy-valid, and classified in ownership',async()=>{
  assert.equal(recommendedSettings.reviewerMode,'read-only');assert.equal(recommendedSettings.claudeReviewerMode,'plan');
  const schema=JSON.parse(await readFile(new URL('../shared/presets/schemas/policy.schema.json',import.meta.url),'utf8'));
  const ownership=JSON.parse(await readFile(new URL('../shared/presets/ownership.json',import.meta.url),'utf8'));
  for(const key of ['reviewerMode','claudeReviewerMode']){assert.ok(schema.properties.roleWorkflow.properties[key]);assert.equal(ownership.roleWorkflowSettings[key].slot,'policy');}
  const example=JSON.parse(await readFile(new URL('../shared/presets/examples/policy.example.json',import.meta.url),'utf8'));
  assert.equal(ownerPolicySchema.safeParse({...example,roleWorkflow:{...example.roleWorkflow,reviewerMode:'read-only',claudeReviewerMode:'plan'}}).success,true);
});
