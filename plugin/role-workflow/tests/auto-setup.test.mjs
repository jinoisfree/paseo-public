import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { fixture, block, choice } from './brainstorm-fixture.mjs';

async function reply(f,role,status,extra={}) {
 const w=await f.live(),a=w[role],id=w.pending?.id,key=`auto-${role}-${f.sent.length}`,text=block(status,extra);
 f.agents.get(a.id).status='idle';f.histories.set(a.id,{text,key,failed:null,messageIds:id?[id]:[]});
 await f.engine.ended(a.id,key,text,null,'',false,'',false,id?[id]:[]);await f.settle();
}
async function setup(t,{overlap=false,fail=false}={}) {
 let root;
 const f=await fixture(t,{contract:7,probe:{snapshot:async()=>null,identity:async cwd=>({root:cwd===root+'/tree'?cwd:await realpath(cwd),common:root+'/.git',branch:cwd===root+'/tree'?'role-workflow/test':'main',head:'a'.repeat(40)})}});
 root=await realpath(f.dir);const cards=[],trees=[];
 f.port.reviewerModes=async()=>({enabled:true,modes:['auto','plan']});
 f.port.placementPicker=async(...args)=>cards.push(args);
 f.port.createWorktree=async()=>{trees.push(true);if(fail)throw Error('fixture worktree creation failed');return {path:root+'/tree',workspaceId:'tree-ws'};};
 if(overlap){const other={...f.agents.get('A'),id:'B',workspaceId:'other-ws'};f.agents.set('B',other);await f.engine.enroll(other,other.config,{},'general',true,6);}
 return Object.assign(f,{cards,trees});
}
const automatic=(placement='worktree',review={enabled:false})=>({...choice,review,placement});

test("AC-7'(g): direct federation posts exactly one early card before any plan, including after restart",async t=>{
 const f=await fixture(t,{mode:'undecided',contract:7});
 f.histories.set('A',{text:'',key:'',failed:null,messageIds:[],request:'연합개발로 진행해줘. 새 작업',goal:'연합개발로 진행해줘. 새 작업'});
 await f.engine.started('A');await f.settle();
 assert.equal((await f.live()).mode,'federated');assert.equal((await f.live()).heldApproval,null);
 assert.equal(f.pickers.length,1);assert.equal(f.pickers[0][2].id,0);
 await f.restart();await f.engine.tick();await f.settle();await f.say('','plan');
 assert.equal(f.pickers.length,1);assert.equal((await f.live()).pickerPostedFor,0);
});
for(const enabled of [true,false,null])test(`AC-7'(g): brainstorm federation posts early card with review=${enabled}`,async t=>{
 const f=await fixture(t,{mode:'undecided',contract:7});await f.question('브레인스토밍');(await f.live()).reviewSelection.enabled=enabled;
 await f.question('연합개발');assert.equal(f.pickers.length,1);assert.equal(f.pickers[0][2].id,0);assert.equal((await f.live()).heldApproval,null);
});
test("AC-7'(a): one setup saves review off and starts the first plan without another choice",async t=>{
 const f=await setup(t);assert.equal((await f.engine.selectExecutor(f.id,automatic())).ok,true);
 let w=await f.live();assert.equal(w.implementationReserved,true);assert.equal(w.reservedPlacement,'worktree');assert.equal(w.reviewSelection.enabled,false);assert.equal(w.execute,null);
 await f.restart();await f.say('','plan');w=await f.live();
 assert.equal(w.approvedHold,1);assert.equal(w.planReview.stage,'done');assert.equal(w.planReview.outcome,'off');assert.equal(w.implementationReserved,false);
 assert.equal(w.isolation,'shared','without overlap the reserved worktree is not created');assert.equal(f.trees.length,0);assert.deepEqual(f.created.map(c=>c.role),['execute']);
 const duplicate=await f.engine.selectExecutor(f.id,{...choice,holdId:1});assert.equal(duplicate.detail,'승인한 계획을 이미 처리했습니다.');
 await f.engine.tick();assert.equal(f.created.length,1);
 await reply(f,'execute','input');assert.equal((await f.live()).status,'needs_input',(await f.live()).detail);const sent=f.sent.length;await f.engine.tick();assert.equal(f.sent.length,sent);
});
for(const manual of [false,true])test(`AC-7'(d): reserved worktree skips placement card after ${manual?'manual':'automatic'} approval`,async t=>{
 const f=await setup(t,{overlap:true});await f.engine.selectExecutor(f.id,automatic());
 if(manual)await f.engine.selectPlanReview(f.id,{enabled:false});
 await f.restart();await f.say('','plan');
 if(manual){assert.equal(f.created.length,0);await f.engine.selectExecutor(f.id,{...choice,holdId:1});}
 const w=await f.live();assert.equal(w.isolation,'worktree');assert.equal(w.worktree.workspaceId,'tree-ws');assert.equal(f.cards.length,0);assert.equal(f.trees.length,1);assert.equal(f.created.filter(c=>c.role==='execute').length,1);
});
test("AC-7'(d): reserved wait overrides worktree setting and releases after the blocker finishes",async t=>{
 const f=await setup(t,{overlap:true});await f.engine.configure({...await f.engine.settings(),executorPlacement:'worktree'});
 await f.engine.selectExecutor(f.id,automatic('wait'));await f.say('','plan');let w=await f.live();
 assert.equal(w.placement.stage,'waiting');assert.equal(f.cards.length,0);assert.equal(f.created.length,0);assert.equal(f.trees.length,0);
 const db=await f.engine.db();db.workflows.find(other=>other.id!==f.id).status='completed';await f.engine.tick();
 w=await f.live();assert.equal(w.placement,null);assert.equal(w.isolation,'shared');assert.equal(f.created.filter(c=>c.role==='execute').length,1);
});
for(const kind of ['none','cancel','placement-failure'])test(`AC-7'(e): ${kind} stops automatic dispatch`,async t=>{
 const f=await setup(t,{overlap:true,fail:kind==='placement-failure'});
 if(kind!=='none')await f.engine.selectExecutor(f.id,automatic());
 if(kind==='cancel'){await f.engine.cancelImplementationReservation(f.id);assert.equal((await f.live()).reservedPlacement,null);}
 await f.say('','plan');const w=await f.live();assert.equal(f.created.filter(c=>c.role==='execute').length,0);
 if(kind==='placement-failure'){assert.equal(w.status,'error');assert.match(w.detail,/fixture worktree creation failed/);assert.equal(f.trees.length,1);await f.engine.tick();assert.equal(f.trees.length,1);}
 else {assert.equal(w.approvedHold,0);assert.equal(w.status,'needs_input');}
});
test("AC-7'(d): null reserved placement keeps the existing overlap card",async t=>{
 const f=await setup(t,{overlap:true});await f.engine.selectExecutor(f.id,automatic(null));await f.say('','plan');
 assert.equal((await f.live()).placement.stage,'choice');assert.equal(f.cards.length,1);assert.equal(f.created.length,0);
});
test("AC-7'(b): combined early setup reviews and then applies reserved worktree without further choices",async t=>{
 const f=await setup(t,{overlap:true});await f.engine.selectExecutor(f.id,automatic('worktree',{...choice,enabled:true}));await f.say('','plan');
 assert.deepEqual(f.created.map(c=>c.role),['reviewer']);const w=await f.live();
 await reply(f,'reviewer','result',{planReview:{planHash:w.heldApproval.decisionHash,verdict:'APPROVED',findings:[]}});
 assert.equal(f.trees.length,0);await reply(f,'plan','note');assert.equal(f.cards.length,0);assert.equal(f.trees.length,1);assert.deepEqual(f.created.map(c=>c.role),['reviewer','execute']);
});
test('contract6 ignores combined setup and reserved placement input',async t=>{
 const f=await fixture(t,{contract:6});assert.equal(f.pickers.length,0);await f.say('','plan');
 await f.engine.selectExecutor(f.id,{...automatic(),holdId:1});assert.equal((await f.live()).reservedPlacement,null);assert.deepEqual(f.created.map(c=>c.role),['execute']);
});

test('invalid combined reviewer choice preserves the previously saved reservation',async t=>{
 const f=await setup(t);await f.engine.selectExecutor(f.id,automatic());
 f.port.models=async()=>[{id:'builder',label:'Builder',thinkingOptions:[{id:'high',label:'High'},{id:'low',label:'Low'}]}];
 await assert.rejects(f.engine.selectExecutor(f.id,{...choice,thinking:'low',review:{enabled:true,provider:'codex',model:'missing',thinking:'high'},placement:'wait'}));
 const w=await f.live();assert.equal(w.selectionDraft.thinking,'high');assert.equal(w.reservedPlacement,'worktree');assert.equal(w.implementationReserved,true);
});

for(const contract of [6,7])test(`first turn mode detection contract${contract} does not infer federation from an ambiguous request`,async t=>{
 const f=await fixture(t,{mode:'undecided',contract});f.histories.set('A',{text:'',key:'',failed:null,messageIds:[],request:contract===6?'연합개발로 진행해줘':'연합개발 테스트',goal:''});
 await f.engine.started('A');await f.settle();assert.equal((await f.live()).mode,'undecided');assert.equal(f.pickers.length,0);
});
