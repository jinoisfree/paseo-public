import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickerCardPresence } from '../server/timeline-cards.ts';
import { withBudget } from '../server/call-budget.ts';
import { parseDecision } from '../shared/decision.ts';
import { decisionHash } from '../shared/plan-approval.ts';
import { fixture,block,flush } from './brainstorm-fixture.mjs';
const text=block(),hash=decisionHash(parseDecision(text)),id='role-workflow-executor-picker:task:1';
const card={item:{type:'plugin',id,kind:'executor-picker',data:{workflowId:'task'}}};
const plan={item:{type:'assistant_message',text}};
const noise=()=>({item:{type:'assistant_message',text:'ordinary'}});
function api(pages){let reads=0;return {api:{agents:{ref:()=>({timeline:{refetch:async options=>{const p=pages[reads++]??pages.at(-1);return typeof p==='function'?p(options):p;}}})}},get reads(){return reads;}};}
const page=(entries,hasOlder=false)=>({entries,hasOlder,startCursor:hasOlder?{id:'cursor'}:null});

test('AC-23: presence crosses 200-entry boundary and stops at the matching plan, not old cards',async()=>{
 const a=api([page(Array.from({length:200},noise),true),page([plan,card],true)]);assert.equal(await pickerCardPresence(a.api,'A',id,hash),'present');assert.equal(a.reads,2);
 const b=api([page([card,plan,...Array.from({length:10},noise)])]);assert.equal(await pickerCardPresence(b.api,'A',id,hash),'absent','a matching id before this hold boundary is ignored');
 const c=api([page([{...card,item:{...card.item,id:id+'old'}},plan])]);assert.equal(await pickerCardPresence(c.api,'A',id,hash),'absent');
});
for(const kind of ['error','reset','limit','cursor'])test(`AC-23: ${kind} is unknown, never guessed absent`,async()=>{
 const pages=kind==='error'?[()=>{throw Error('offline');}]:kind==='reset'?[{...page([card]),reset:true}]:kind==='cursor'?[{...page([],true),startCursor:null}]:[page(Array.from({length:200},noise),true)];
 const a=api(pages);assert.equal(await pickerCardPresence(a.api,'A',id,hash),'unknown');if(kind==='limit')assert.equal(a.reads,25);
});
test('AC-23: actual query timeout keeps the underlying request alive and returns unknown on completion',async()=>{
 let finish;const a=api([()=>new Promise(resolve=>{finish=resolve;})]);const request=pickerCardPresence(a.api,'A',id,hash,5);
 await assert.rejects(withBudget('test',10,request),/시간 초과/);finish(page([plan]));assert.equal(await request,'unknown');
});
test('AC-23: failed post retries; crash after post before persisted marker rechecks without append',async t=>{
 const f=await fixture(t);let calls=0,appends=0,available=false;const posted=new Set();
 f.port.ensurePickerCard=async(a,w,h)=>{calls++;if(!available)throw Error('offline');if(!posted.has(h.id)){posted.add(h.id);appends++;}return true;};
 await f.say('','plan');assert.equal((await f.state()).pickerPostedFor,0);available=true;await f.engine.tick();await f.settle();assert.equal(appends,1);
 const snapshot=f.writes.find(db=>db.workflows[0]?.heldApproval?.id===1&&db.workflows[0].pickerPostedFor===0);await f.restart(snapshot);await f.engine.tick();await f.settle();assert.equal(appends,1);assert.equal((await f.state()).pickerPostedFor,1);
});
test('AC-23: concurrent saves and a timed-out waiter share one request until actual completion',async t=>{
 const f=await fixture(t);await f.say('','plan');const w=await f.live();w.pickerPostedFor=0;let finish,calls=0;
 f.port.ensurePickerCard=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
 const first=f.engine.ensurePickerCard(f.id,1);await flush();await assert.rejects(withBudget('picker',5,first),/시간 초과/);
 await f.engine.save();const second=f.engine.ensurePickerCard(f.id,1);assert.equal(second,first);assert.equal(calls,1);finish(true);await Promise.all([first,second]);assert.equal((await f.state()).pickerPostedFor,1);
});
test('AC-23: completion of an old hold cannot overwrite the new hold marker',async t=>{
 const f=await fixture(t);await f.say('','plan');const w=await f.live();w.pickerPostedFor=0;let finish;
 f.port.ensurePickerCard=(a,id,hold)=>hold.id===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve(true);
 const old=f.engine.ensurePickerCard(f.id,1);await flush();
 // Deliver the replacement while the old request remains unresolved; don't await a drain of that request.
 f.agents.get('A').status='idle';await f.engine.ended('A','replacement',block('plan',{summary:'new'}),null,'goal');
 await f.engine.ensurePickerCard(f.id,2);finish(true);await old;assert.equal((await f.state()).heldApproval.id,2);assert.equal((await f.state()).pickerPostedFor,2);
});
