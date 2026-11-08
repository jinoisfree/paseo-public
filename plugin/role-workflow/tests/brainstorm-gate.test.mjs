import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fixture,block,choice,flush } from './brainstorm-fixture.mjs';
import { workflowRequestedMode,requestsBrainstorm,normalizeModeLabel } from '../shared/mode-request.ts';
import { timelineMode,timelineBrainstorm,SCREEN_SELECTION_PROMPT } from '../server/executor-selection.ts';
import { parseDecision } from '../shared/decision.ts';
import { decisionHash } from '../shared/plan-approval.ts';
import { composeCurrentPrompt } from '../server/roles.ts';
import { titlePrompt,progressPrompt,pushApprovalPrompt } from '../server/protocol.ts';
import { isFinished } from '../server/archive.ts';
import { workflowLabel } from '../shared/workflow-list.ts';
import { createRepoProbe } from '../server/git.ts';
import { gitTestEnvironment } from './git-test-environment.mjs';

test('AC-3: contract6 prompt retains exact shared text and budgets',()=>{
 const trailing=titlePrompt()+progressPrompt()+pushApprovalPrompt();
 for(const [mode,max] of [['undecided',7500],['federated',7300]]){
  const prompt=composeCurrentPrompt('claude','',mode,'/x/rules/0123456789ab/README.md',SCREEN_SELECTION_PROMPT,trailing,6);
  assert.ok(prompt.length<=max,`${mode}: ${prompt.length}`);
  assert.ok(prompt.includes('본문에 사용자에게 묻는 결정 질문이 있으면 plan이 아니라 input'));
  if(mode==='undecided')assert.ok(prompt.includes('선택지는 정확히 브레인스토밍, 일반개발, 연합개발이다.'));
 }
 assert.doesNotMatch(composeCurrentPrompt('claude','','undecided',null,'','',5),/선택지는 정확히 브레인스토밍/);
});
for(const entry of ['question','card','chat'])test(`AC-4/5/7/8/15: ${entry} brainstorm then federation holds first plan`,async t=>{
 const f=await fixture(t,{mode:'undecided'});
 if(entry==='question')await f.question('브레인스토밍');else if(entry==='card')await f.engine.selectMode(f.id,'brainstorm');else await f.say('브레인스토밍');
 let w=await f.state();assert.equal(w.mode,'undecided');assert.equal(w.brainstorm,true);assert.equal(f.modeCards.length,0);assert.equal(f.pickers.length,0);
 await f.question('연합개발');w=await f.state();assert.equal(w.mode,'federated');assert.equal(w.plan.id,'A');assert.equal(f.pickers.length,0);
 await f.say('','plan');w=await f.state();assert.equal(w.heldApproval.id,1);assert.equal(w.selectionPlan,w.inbox.key);assert.equal(w.approvedHold,0);assert.equal(f.created.length,0);
 assert.equal(f.pickers.length,1);assert.equal(w.pickerPostedFor,1);assert.equal(w.heldApproval.decisionHash,decisionHash(parseDecision(w.inbox.text)));
 await f.restart();await f.engine.tick();assert.equal(f.created.length,0);
 assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:1})).ok,true);
 assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:1})).ok,true);
 assert.equal(f.created.length,1);assert.equal(f.sent.filter(s=>s.id!=='A').length,1);assert.equal((await f.state()).heldApproval,null);
});
test('AC-5/5c/6/8/8b/10: general, refusal, no development and exact mode title',async t=>{
 const f=await fixture(t,{mode:'undecided'});await f.question('브레인스토밍');
 f.setAvailability({available:false,reason:'실행 가능한 제품 0'});await f.question('연합개발');assert.equal((await f.state()).mode,'undecided');assert.equal((await f.state()).brainstorm,true);assert.match((await f.state()).detail,/제품 0/);
 const before=await f.state();await f.question('개발 안 함');assert.deepEqual(await f.state(),before);
 await f.say('','note');assert.equal(f.modeCards.length,0);
 await f.question('일반개발');assert.equal((await f.state()).mode,'general');assert.deepEqual((await f.state()).plan.config,f.config);
 const g=await fixture(t,{mode:'undecided'});await g.question('연합개발 (추천)','다른 질문');assert.equal((await g.state()).mode,'undecided');await g.question(' 연합개발 (Recommended) ');assert.equal((await g.state()).mode,'federated');
 const h=await fixture(t,{mode:'undecided'});await h.say('브레인스토밍 테스트');assert.equal((await h.state()).brainstorm,false);assert.equal(h.modeCards.length,1);
 const n=await fixture(t,{mode:'undecided'});await n.say('브레인스토밍');await n.engine.ended('A','no-push','작업상태: 푸시 불필요\n'+block('note'),null,'goal');const nw=await n.state();assert.equal(isFinished(nw),true);assert.equal(workflowLabel({...nw,status:'active'}),'완료 · 푸시 불필요');
 assert.equal(workflowLabel({...nw,status:'active',progress:'active'}),'논의 중');assert.equal(workflowLabel({...nw,status:'active',brainstorm:false,progress:'done'}),'방식 선택 전');
});
const ambiguous=['연합개발로 시작하기 전에 정리해줘','연합개발 하지 마','아니 연합개발','연합개발이랑 일반개발 차이가 뭐야?'];
test('AC-5b: every chat decision entry preserves discussion until an exact choice',async t=>{
 for(const text of ambiguous)assert.equal(workflowRequestedMode({contract:6,brainstorm:true},text),null,text);
 for(const route of ['ended','transitionTurn','finishGeneralChoice','generalTimeline']){
  const f=await fixture(t,{mode:'undecided'});await f.question('브레인스토밍');
  for(const text of ambiguous){const w=await f.live();
   if(route==='ended')await f.say(text);
   if(route==='transitionTurn')await f.engine.transitionTurn(w,{agentId:'A',key:'x',text:block('note'),failed:null},text);
   if(route==='finishGeneralChoice')await f.engine.generalMode.finishGeneralChoice(w,'A',block('note'),'goal',text,null,'x');
   if(route==='generalTimeline')await f.engine.generalTimeline('A',[],undefined,undefined,undefined,text);
   assert.equal((await f.live()).mode,'undecided',`${route}: ${text}`);
  }
  await f.engine.generalTimeline('A',[],undefined,undefined,undefined,'일반개발');assert.equal((await f.state()).mode,'general');
 }
 assert.equal(requestsBrainstorm('브레인스토밍 테스트'),false);assert.equal(requestsBrainstorm('브레인스토밍'),true);assert.equal(normalizeModeLabel(' 연합개발 (추천) '),'연합개발');
});
test('AC-8c: native brainstorm answer never masks a later federation choice',async t=>{
 const answer=value=>{const detail=`진행 방식을 선택하세요\n${value}`;return [{type:'tool_call',name:'request_user_input_async',callId:value,status:'completed',error:null,detail:{type:'plain_text',text:detail}},{type:'user_message',text:`Answers to your questions:\n\n${detail}`}];};
 const items=[...answer('브레인스토밍'),...answer('연합개발 (추천)')];assert.equal(timelineBrainstorm(items),true);assert.equal(timelineMode(items),'federated');assert.equal(timelineMode(answer('브레인스토밍')),null);
 const f=await fixture(t,{mode:'undecided'});await f.engine.generalTimeline('A',answer('브레인스토밍'));assert.equal((await f.state()).brainstorm,true);await f.engine.generalTimeline('A',items);assert.equal((await f.state()).mode,'federated');assert.equal(f.pickers.length,0);
});
test('AC-12: repository dirty growth warns once; excluded/outside files never warn',async t=>{
 const f=await fixture(t,{mode:'undecided',probe:createRepoProbe()});const env=gitTestEnvironment();const git=(...args)=>execFileSync('git',args,{cwd:f.dir,env});git('init','-q');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','init');
 await writeFile(path.join(f.dir,'.git/info/exclude'),'fixture.json\nignored\n');await writeFile(path.join(f.dir,'existing'),'dirty before');await f.question('브레인스토밍');const status=(await f.state()).status;
 const outside=path.join(f.dir,'..',path.basename(f.dir)+'-outside');await writeFile(outside,'outside');t.after(()=>rm(outside,{force:true}));await writeFile(path.join(f.dir,'ignored'),'ignored');await writeFile(path.join(f.dir,'existing'),'edit already dirty');await f.say('조사');assert.equal(f.notices.filter(e=>e.title.startsWith('브레인스토밍 변경')).length,0);
 await writeFile(path.join(f.dir,'new-product'),'new');await f.say('조사');assert.equal((await f.state()).status,status);assert.equal(f.notices.filter(e=>e.title.startsWith('브레인스토밍 변경')).length,1);await f.say('조사');assert.equal(f.notices.filter(e=>e.title.startsWith('브레인스토밍 변경')).length,1);
});
for(const variant of ['next','summary','handoff','ABA'])test(`AC-17/17c/17d: replacement ${variant} rejects stale hold`,async t=>{
 const f=await fixture(t);await f.say('','plan',{summary:'A'});const a=await f.state();
 await f.say('','plan',{...(variant==='next'?{next:'다른 지시'}:{}),...(variant==='handoff'?{handoff:'new.md'}:{}),summary:['summary','ABA'].includes(variant)?'B':'A'});
 if(variant==='ABA')await f.say('','plan',{summary:'A'});
 const w=await f.state();if(variant==='ABA')assert.equal(w.heldApproval.id,3);assert.ok(w.heldApproval.id>a.heldApproval.id);const result=await f.engine.selectExecutor(f.id,{...choice,holdId:a.heldApproval.id});assert.equal(result.ok,false);assert.equal(f.created.length,0);assert.equal((await f.state()).selection.provider,null);assert.equal((await f.state()).selectionDraft.provider,'codex');
 await f.engine.selectExecutor(f.id,{...choice,holdId:w.heldApproval.id});assert.equal(f.sent.filter(s=>s.id!=='A').length,1);
});
for(const replacement of ['input','plan'])test(`AC-17b/18: approval while paused then ${replacement} invalidates selection across restart`,async t=>{
 const f=await fixture(t);await f.say('','plan');await f.engine.control(f.id,'pause');await f.engine.selectExecutor(f.id,{...choice,holdId:1});assert.equal((await f.state()).approvedHold,1);assert.equal(f.created.length,0);
 await f.say('',replacement,{summary:'replacement'});let w=await f.state();assert.equal(w.approvedHold,0);assert.equal(w.selection.provider,null);assert.equal(w.selectionDraft.provider,'codex');
 await f.restart();assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:1})).ok,false);await f.engine.control(f.id,'resume');if(replacement==='input'){await f.say('','plan');}
 w=await f.state();assert.equal(f.created.length,0);assert.ok(w.heldApproval.id>1);assert.equal(w.approvedHold,0);await f.engine.selectExecutor(f.id,{...choice,holdId:w.heldApproval.id});assert.equal(f.created.length,1);
});
test('AC-18b/20: zero/empty hold and explicit initial selection are drafts only',async t=>{
 const f=await fixture(t);await f.say('연합개발\ncodex/builder 추론 high','plan');let w=await f.state();assert.equal(w.selection.provider,null);assert.equal(w.selectionDraft.provider,'codex');assert.equal(f.created.length,0);
 assert.equal((await f.engine.selectExecutor(f.id,{...choice})).ok,false);assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:0})).ok,false);assert.equal((await f.state()).approvedHold,0);await f.engine.selectExecutor(f.id,{...choice,holdId:1});assert.equal(f.created.length,1);
});
for(const stage of ['approval','queued','sending'])test(`AC-16: restart after ${stage} preserves exactly one delivery`,async t=>{
 const f=await fixture(t);await f.say('','plan');await f.engine.selectExecutor(f.id,{...choice,holdId:1});await flush();
 const snapshot=f.writes.find(db=>{const w=db.workflows[0];if(!w)return false;return stage==='approval'?w.approvedHold===1&&!w.pending&&!!w.inbox:stage==='queued'?w.pending?.stage==='queued':w.pending?.stage==='sending';});assert.ok(snapshot,stage);
 // Model the process dying at that write, not replaying writes performed later.
 if(stage!=='sending'){f.sent.length=0;f.histories.clear();for(const a of f.agents.values())a.status='idle';}
 await f.restart(snapshot);await f.engine.tick();await f.engine.tick();assert.equal(f.sent.filter(s=>s.id!=='A').length,1);
});
for(const phase of ['before','held','selected'])test(`AC-19: persisted contract5 ${phase} retains immediate picker and choice delivery`,async t=>{
 const f=await fixture(t,{contract:5});assert.equal(f.pickers.length,1);
 if(phase==='held')await f.say('','plan');
 if(phase==='selected')await f.engine.selectExecutor(f.id,choice);
 await f.restart();const w=await f.state();assert.equal(w.contract,5);assert.equal(w.heldApproval,null);
 if(phase!=='selected')await f.engine.selectExecutor(f.id,choice);
 if(phase!=='held')await f.say('','plan');
 assert.equal(f.created.length,1);assert.equal(f.sent.filter(s=>s.id!=='A').length,1);
});

test('AC-20: explicit first choice survives a note as a draft; native executor questions cannot approve',async t=>{
 const f=await fixture(t);await f.say('연합개발\ncodex/builder 추론 high','note');assert.equal((await f.state()).selectionDraft.provider,'codex');assert.equal((await f.state()).selection.provider,null);
 const {EXECUTOR_QUESTIONS:Q}=await import('../shared/executor-selection.ts');
 for(const [stage,value] of [['provider','codex'],['model','builder'],['thinking','high']]){
  await f.engine.permission('A',{id:stage,kind:'question',input:{questions:[{question:Q[stage].question,header:stage,options:[]}]}});await f.engine.permissionResolved('A',stage,{behavior:'allow',updatedInput:{answers:{[stage]:value}}});
 }
 assert.equal((await f.state()).selection.provider,null);await f.say('','plan');assert.equal((await f.state()).selectionDraft.provider,'codex');assert.equal(f.created.length,0);
});
test('AC-7: brainstorming card notice does not reuse the later development notice id',async t=>{
 const f=await fixture(t,{mode:'undecided'});await f.engine.selectMode(f.id,'brainstorm');f.agents.get('A').status='idle';await f.engine.selectMode(f.id,'federated');assert.equal(new Set(f.sent.map(s=>s.messageId)).size,2);
});

test('AC-19: after first delivery executor replacement retains selection without another hold',async t=>{
 const f=await fixture(t);await f.say('','plan');await f.engine.selectExecutor(f.id,{...choice,holdId:1});
 const w=await f.live();w.history.push(w.execute.id);w.execute=null;w.pending=null;w.status='active';await f.engine.save();
 assert.equal((await f.engine.list()).workflows[0].firstPlan,false);assert.equal((await f.engine.selectExecutor(f.id,choice)).ok,true);
 await f.say('','plan',{next:'후속 지시'});assert.equal(f.created.length,2);assert.equal((await f.state()).holdSeq,1);assert.equal((await f.state()).heldApproval,null);
});
test('AC-6: no-development discussion is collected as a finished archive, not discarded',async t=>{
 const f=await fixture(t,{mode:'undecided'});await f.say('브레인스토밍');await f.engine.ended('A','closed','작업상태: 푸시 불필요\n'+block('note'),null,'goal');f.agents.get('A').archived=true;await f.engine.archived('A');
 const status=await f.engine.list();assert.equal(status.workflows.length,0);assert.equal(status.archives[0].progress,'no_push');
});
test('AC-11: contract5 native choice labels retain their exact-match semantics',async t=>{
 const text='진행 방식을 선택하세요\n연합개발 (추천)';const items=[{type:'tool_call',name:'request_user_input_async',status:'completed',error:null,detail:{type:'plain_text',text}},{type:'user_message',text:'Answers to your questions:\n\n'+text}];
 for(const contract of [5,6]){const f=await fixture(t,{mode:'undecided',contract});await f.engine.generalTimeline('A',items);assert.equal((await f.state()).mode,contract===6?'federated':'undecided');}
});

test('AC-18/18b: cancellation before approval and initial zeros cannot authorize any hold',async t=>{
 const f=await fixture(t);const initial=await f.state();assert.equal(initial.holdSeq,0);assert.equal(initial.approvedHold,0);assert.equal(initial.heldApproval,null);assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:0})).ok,false);
 await f.say('','plan');await f.say('','input');assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:1})).ok,false);await f.say('','plan');assert.equal((await f.state()).heldApproval.id,2);assert.equal((await f.state()).approvedHold,0);assert.equal(f.created.length,0);
});
