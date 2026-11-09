import {test} from 'node:test';
import assert from 'node:assert/strict';
import {realpath} from 'node:fs/promises';
import {fixture,block,choice} from './brainstorm-fixture.mjs';

async function setup(t,{contract=7,overlap=true,fail=false}={}){
 let root;const cards=[],trees=[];
 const f=await fixture(t,{contract,probe:{snapshot:async()=>null,identity:async cwd=>({root:cwd===root+'/tree'?cwd:await realpath(cwd),common:root+'/.git',branch:cwd===root+'/tree'?'role-workflow/test':'main',head:'a'.repeat(40)})}});
 root=await realpath(f.dir);f.port.reviewerModes=async()=>({enabled:true,modes:['auto','plan']});
 f.port.placementPicker=async(...args)=>cards.push(args);
 f.port.createWorktree=async()=>{trees.push(true);if(fail)throw Error('fixture placement failed');return{path:root+'/tree',workspaceId:'tree-ws'};};
 if(overlap){const other={...f.agents.get('A'),id:'B',workspaceId:'other-ws'};f.agents.set('B',other);await f.engine.enroll(other,other.config,{},'general',true,6);}
 await f.say('','plan');return Object.assign(f,{cards,trees});
}
async function reply(f,role,status,extra={}){
 const w=await f.live(),id=w.pending.id,agent=w[role].id,text=block(status,extra),key=`held-${role}-${f.sent.length}`;
 f.agents.get(agent).status='idle';f.histories.set(agent,{text,key,failed:null,messageIds:[id]});
 await f.engine.ended(agent,key,text,null,'',false,'',false,[id]);await f.settle();
}
const combined=(enabled,placement='worktree',holdId=1)=>({...choice,holdId,review:enabled?{...choice,enabled:true}:{enabled:false},placement});
for(const enabled of [false,true])test(`AC-P3 held plan combined setup review=${enabled} dispatches once through reserved worktree`,async t=>{
 const f=await setup(t);assert.equal((await f.live()).planReview.stage,'waiting_choice');
 assert.equal((await f.engine.selectExecutor(f.id,combined(enabled))).ok,true);await f.settle();
 if(enabled){
  assert.deepEqual(f.created.map(c=>c.role),['reviewer']);assert.equal((await f.live()).approvedHold,0);
  const during=await f.engine.selectExecutor(f.id,combined(enabled));assert.equal(during.ok,false);
  await reply(f,'reviewer','result',{planReview:{planHash:(await f.live()).heldApproval.decisionHash,verdict:'APPROVED',findings:[]}});
  assert.equal(f.trees.length,0);await f.restart();await reply(f,'plan','note');
 }
 const w=await f.live();assert.equal(w.approvedHold,1);assert.equal(w.isolation,'worktree');assert.equal(w.planReview.stage,'done');
 assert.equal(w.planReview.outcome,enabled?'passed':'off');assert.equal(w.implementationReserved,false);
 assert.equal(w.reservedPlacement,'worktree');assert.equal(f.trees.length,1);assert.equal(f.cards.length,0);
 assert.equal(f.created.filter(c=>c.role==='execute').length,1);
 const duplicate=await f.engine.selectExecutor(f.id,combined(enabled));assert.equal(duplicate.ok,true);assert.match(duplicate.detail,/이미 처리/);
 await f.engine.tick();assert.equal(f.created.filter(c=>c.role==='execute').length,1);assert.equal(f.trees.length,1);
});
for(const placement of ['wait',null])test(`AC-P3 held combined setup preserves ${placement} placement semantics`,async t=>{
 const f=await setup(t);await f.engine.selectExecutor(f.id,combined(false,placement));const w=await f.live();
 assert.equal(w.approvedHold,1);assert.equal(w.placement.stage,placement==='wait'?'waiting':'choice');
 assert.equal(f.cards.length,placement==='wait'?0:1);assert.equal(f.created.length,0);assert.equal(f.trees.length,0);
});
test('AC-P3 placement failure stops after combined setup without repeating approval',async t=>{
 const f=await setup(t,{fail:true});await f.engine.selectExecutor(f.id,combined(false));const w=await f.live();
 assert.equal(w.status,'error');assert.match(w.detail,/fixture placement failed/);assert.equal(f.created.length,0);
 await f.engine.tick();await f.engine.selectExecutor(f.id,combined(false));assert.equal(f.trees.length,1);
});
test('AC-P3 stale held setup cannot change review or queue a reviewer',async t=>{
 const f=await setup(t);const before=structuredClone((await f.live()).reviewSelection);
 assert.equal((await f.engine.selectExecutor(f.id,combined(true,'worktree',99))).ok,false);
 assert.deepEqual((await f.live()).reviewSelection,before);assert.equal((await f.live()).implementationReserved,false);assert.equal(f.created.length,0);
});
test('AC-P3 contract6 ignores combined review and reserved placement',async t=>{
 const f=await setup(t,{contract:6,overlap:false});await f.engine.selectExecutor(f.id,combined(true));const w=await f.live();
 assert.equal(w.reviewSelection.enabled,null);assert.equal(w.implementationReserved,false);assert.equal(w.reservedPlacement,null);
 assert.deepEqual(f.created.map(c=>c.role),['execute']);
});
