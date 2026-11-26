import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { fixture, block, choice } from './brainstorm-fixture.mjs';

async function reply(f,role,status,extra={}) {
 const w=await f.live(), a=w[role], key=`reservation-${role}-${f.sent.length}`, text=block(status,extra), id=w.pending?.id;
 f.agents.get(a.id).status='idle';f.histories.set(a.id,{text,key,failed:null,messageIds:id?[id]:[]});
 await f.engine.ended(a.id,key,text,null,'',false,'',false,id?[id]:[]);await f.settle();
}
async function setup(t,{early=false,reserve=true,probe=null}={}) {
 const f=await fixture(t,{contract:7,mode:early?'undecided':'federated',probe});
 f.port.reviewerModes=async()=>({enabled:true,modes:['auto','plan']});
 if(early){
  await f.question('브레인스토밍');await f.question('연합개발');(await f.live()).reviewSelection.enabled=true;
  await f.engine.selectPlanReview(f.id,{...choice,enabled:true});
  if(reserve)await f.engine.selectExecutor(f.id,choice);
 }
 await f.say('','plan');
 if(!early){await f.engine.selectPlanReview(f.id,{...choice,enabled:true,holdId:1});if(reserve)assert.equal((await f.engine.selectExecutor(f.id,{...choice,holdId:1,reserve:true})).ok,true);}
 return f;
}
async function approved(f) {
 await reply(f,'reviewer','result',{planReview:{planHash:(await f.live()).heldApproval.decisionHash,verdict:'APPROVED',findings:[]}});
 assert.equal((await f.live()).execute,null);await reply(f,'plan','note');
}
for(const early of [true,false])test(`AC-7: ${early?'early draft':'held-card reservation'} starts exactly once after recorded approval`,async t=>{
 const f=await setup(t,{early});assert.equal((await f.live()).implementationReserved,true);
 await f.restart();assert.equal((await f.live()).implementationReserved,true);
 await approved(f);const w=await f.live();assert.equal(w.approvedHold,1);assert.equal(w.planReview.stage,'done');assert.equal(w.implementationReserved,false);
 assert.deepEqual(f.created.map(c=>c.role),['reviewer','execute']);
 assert.equal(w.detail,'계획 검증 통과 — 예약한 구현 담당으로 구현을 시작합니다.');
 const duplicate=await f.engine.selectExecutor(f.id,{...choice,holdId:1});assert.equal(duplicate.detail,'승인한 계획을 이미 처리했습니다.');
 await f.engine.tick();assert.equal(f.created.filter(c=>c.role==='execute').length,1);assert.equal(f.sent.filter(s=>s.id===w.execute.id).length,1);
});
for(const kind of ['none','cancel','off','not-ready'])test(`AC-7: ${kind} cannot automatically approve implementation`,async t=>{
 const f=await setup(t,{reserve:kind!=='none'});
 if(kind==='cancel'){assert.equal((await f.engine.cancelImplementationReservation(f.id)).ok,true);await f.restart();}
 if(kind==='off'){await f.engine.selectPlanReview(f.id,{enabled:false,holdId:1});await reply(f,'reviewer','result',{planReview:{planHash:(await f.live()).heldApproval.decisionHash,verdict:'APPROVED',findings:[]}});}
 else {if(kind==='not-ready')(await f.live()).selectionDraft.stage='model';await approved(f);}
 const w=await f.live();assert.equal(w.approvedHold,0);assert.equal(w.execute,null);assert.equal(f.created.filter(c=>c.role==='execute').length,0);
 if(kind==='off')assert.equal(w.implementationReserved,false);
});
test('AC-7: BLOCKED and the five-round limit never consume the reservation as approval',async t=>{
 const f=await setup(t);const blocked=()=>({planHash:'',verdict:'BLOCKED',findings:[{id:'F1',severity:'차단',text:'보완',evidence:'설계'}]});
 for(let round=1;round<=5;round++){
  await reply(f,'reviewer','result',{planReview:{...blocked(),planHash:(await f.live()).heldApproval.decisionHash}});
  assert.equal((await f.live()).approvedHold,0);await reply(f,'plan','plan',{summary:`수정${round}`});
 }
 const w=await f.live();assert.equal(w.planReview.stage,'limit');assert.equal(w.execute,null);assert.equal(w.approvedHold,0);
});
test('AC-7: a reservation survives a blocked plan and starts only after the revised plan passes',async t=>{
 const f=await setup(t);
 await reply(f,'reviewer','result',{planReview:{planHash:(await f.live()).heldApproval.decisionHash,verdict:'BLOCKED',findings:[{id:'F1',severity:'차단',text:'보완',evidence:'설계'}]}});
 assert.equal((await f.live()).approvedHold,0);assert.equal((await f.live()).execute,null);
 await reply(f,'plan','plan',{summary:'보완한 계획'});assert.equal((await f.live()).implementationReserved,true);
 await approved(f);const w=await f.live();assert.equal(w.approvedHold,2);assert.equal(w.planReview.round,2);assert.equal(w.planReview.stage,'done');
 assert.equal(f.created.filter(c=>c.role==='execute').length,1);
});
test('AC-7: pending, hash mismatch and unverified stages are never auto-approved',async t=>{
 const f=await setup(t,{reserve:false});await approved(f);const w=await f.live();w.implementationReserved=true;w.selectionDraft={...choice,stage:'ready',pending:null,answered:[],explicitRead:false,error:''};
 for(const field of ['pending','hash','stage']){
  const hash=w.planReview.hash;w.pending=field==='pending'?{id:'busy'}:null;w.planReview.hash=field==='hash'?'f'.repeat(64):hash;w.planReview.stage=field==='stage'?'unverified_approved':'passed';
  assert.equal(await f.engine.startReservedImplementation(w),false);assert.equal(w.approvedHold,0);w.pending=null;w.planReview.hash=hash;
 }
});
test('AC-7: a changed reserved selection is the one created',async t=>{
 const f=await setup(t);f.port.models=async()=>[{id:'builder',label:'Builder',thinkingOptions:[{id:'high',label:'High'},{id:'low',label:'Low'}]}];
 await f.engine.selectExecutor(f.id,{...choice,thinking:'low',holdId:1,reserve:true});await approved(f);
 assert.equal((await f.live()).execute.config.thinkingOptionId,'low');
});
test('AC-7: overlap reaches the existing placement choice after automatic approval',async t=>{
 const f=await setup(t,{probe:{identity:async cwd=>({root:await realpath(cwd),common:cwd+'/.git',branch:'main',head:'a'.repeat(40)})}});
 f.port.createWorktree=async()=>{throw Error('worktree needs a placement choice');};const cards=[];f.port.placementPicker=async(...args)=>cards.push(args);
 const other={...f.agents.get('A'),id:'B',workspaceId:'other-workspace',status:'idle'};f.agents.set('B',other);await f.engine.enroll(other,other.config,{},'general',true,6);
 await approved(f);const w=await f.live();assert.equal(w.approvedHold,1);assert.equal(w.placement.stage,'choice');assert.equal(cards.length,1);assert.equal(f.created.filter(c=>c.role==='execute').length,0);
});
test('AC-7: contract6 ignores reservation input and retains manual approval',async t=>{
 const f=await fixture(t,{contract:6});await f.say('','plan');await f.engine.selectExecutor(f.id,{...choice,holdId:1,reserve:true});
 assert.equal((await f.live()).implementationReserved,false);assert.equal(f.created.filter(c=>c.role==='execute').length,1);
});

for (const reserve of [true, false]) {
  for (const verdict of ['APPROVED', 'BLOCKED']) {
    for (const atLimit of [false, true]) {
      test(`AT-ESN-02: ${verdict}, ${reserve ? 'reserved' : 'unreserved'}, ${atLimit ? 'last' : 'earlier'} round`, async t => {
        const f = await setup(t, { reserve });
        const w = await f.live();
        if (atLimit) w.planReview.maxRounds = 1;
        const approved = verdict === 'APPROVED';
        const planReview = {
          planHash: w.heldApproval.decisionHash, verdict,
          findings: approved ? [] : [{ id: 'F1', severity: '차단', text: '보완', evidence: '설계' }],
        };
        await reply(f, 'reviewer', 'result', { planReview });
        const { prompt } = f.sent.findLast(sent => sent.id === w.plan.id);
        assert.ok(prompt.includes(`계획 검증 결과를 ${w.planReview.path}에 기록하세요. 지적별 수용/반박/보류와 이유를 남기세요.`));
        assert.ok(prompt.includes(JSON.stringify(planReview)));
        assert.ok(prompt.includes(approved
          ? '계획을 유지하면 기록 후 note, 계획이 달라지면 새 plan을 반환하세요.'
          : '보완 또는 근거 있는 반박 뒤 plan을 반환하세요.'));

        const blockedLimit = '다음 자동 검토 없음. 보완·기록 뒤 사용자 결정으로 올라갑니다.';
        if (!approved && atLimit) {
          assert.ok(prompt.includes(blockedLimit));
          assert.doesNotMatch(prompt, /이미 예약|자동 시작/);
        } else {
          assert.ok(!prompt.includes(blockedLimit));
          assert.doesNotMatch(prompt, /구현은 아직 승인되지 않았습니다/);
          if (reserve) {
            assert.match(prompt, /구현 담당은 이미 예약돼 있습니다/);
            assert.match(prompt, /codex\/builder/);
            assert.match(prompt, /사용자에게 구현 담당 선택이나 시작 승인을 요청하지 마세요/);
            assert.match(prompt, approved ? /note[^\n]*예약한 구현 담당으로 자동 시작/ : /보완한 계획[^\n]*검증을 통과[^\n]*자동 시작/);
          } else {
            assert.doesNotMatch(prompt, /이미 예약/);
            assert.match(prompt, approved && atLimit ? /note[^\n]*사용자가 화면에서 승인해야[^\n]*시작/ : /사용자가 화면에서 승인해야[^\n]*시작/);
          }
          if (atLimit) assert.match(prompt, /새 plan[^\n]*자동 검토 없이 사용자 결정으로 올라갑니다/);
        }

        if (!atLimit) return;
        if (approved) await reply(f, 'plan', 'note');
        else await reply(f, 'plan', 'plan', { summary: '보완한 계획' });
        const started = approved && reserve;
        assert.equal(f.created.filter(created => created.role === 'execute').length, started ? 1 : 0);
        if (started) assert.equal(f.sent.filter(sent => sent.id === w.execute.id).length, 1);
        else assert.equal(w.planReview.stage, approved ? 'passed' : 'limit');
      });
    }
  }
}
