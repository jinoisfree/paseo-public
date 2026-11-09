import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './brainstorm-fixture.mjs';

const request='연합개발로 진행해줘. 등록 경쟁 재현';
const history=(extra={})=>({text:'',key:'',failed:null,messageIds:[],...extra});

for(const ordering of ['start-enroll','enroll-start'])test(`AC-P1 ${ordering}: first reply is not required for federation and one early card`,async t=>{
 const f=await fixture(t,{mode:'undecided',contract:7,deferEnrollment:true});
 const mode=t.mock.method(f.engine,'applyModeChoice');
 if(ordering==='enroll-start')await f.enroll();
 f.histories.set('A',history({request,goal:request}));f.agents.get('A').status='running';
 await f.engine.started('A');
 if(ordering==='start-enroll')await f.enroll();
 await f.settle();
 const w=await f.live();assert.equal(w.mode,'federated');assert.equal(w.goal,request);
 assert.equal(w.turns,0);assert.equal(w.inbox,null);assert.equal(w.heldApproval,null);assert.equal(w.execute,null);
 assert.equal(f.pickers.length,1);assert.equal(f.pickers[0][2].id,0);assert.equal(mode.mock.callCount(),1);
 await f.engine.started('A');await f.enroll();await f.engine.started('A');await f.settle();
 assert.equal(f.pickers.length,1);assert.equal(mode.mock.callCount(),1);
});
for(const source of ['goal','seed','history-over-seed','history-error'])test(`AC-P1 enrollment request source: ${source}`,async t=>{
 const f=await fixture(t,{mode:'undecided',contract:7,deferEnrollment:true});
 if(source==='goal')f.histories.set('A',history({goal:request}));
 if(source==='history-over-seed')f.histories.set('A',history({request:'일반개발로 진행해줘'}));
 if(source==='history-error')f.port.history=async()=>{throw Error('history temporarily unavailable');};
 await f.enroll(source==='goal'?'':request);await f.settle();
 assert.equal((await f.live()).mode,source==='history-over-seed'?'undecided':'federated');
 assert.equal(f.pickers.length,source==='history-over-seed'?0:1);
});
for(const [contract,initial] of [[6,request],[7,'연합개발 테스트'],[7,'']])test(`AC-P1 preserves contract${contract} request ${JSON.stringify(initial)}`,async t=>{
 const f=await fixture(t,{mode:'undecided',contract,deferEnrollment:true});
 f.histories.set('A',history({request:initial}));await f.engine.started('A');await f.enroll(initial);await f.engine.started('A');await f.settle();
 assert.equal((await f.live()).mode,'undecided');assert.equal(f.pickers.length,0);
});

test('REQ-P3 delayed history is retried with a deterministic clock, outside the serial queue',async t=>{
 const f=await fixture(t,{mode:'undecided',contract:7});t.mock.timers.enable({apis:['setTimeout']});
 let reads=0;f.port.history=async()=>history(++reads===3?{request}:{});
 const started=f.engine.started('A');await f.engine.setProgress(1,'active');await f.flush();
 assert.equal(reads,1);t.mock.timers.tick(299);await f.flush();assert.equal(reads,1);
 t.mock.timers.tick(1);await f.flush();await f.engine.setProgress(1,'active');assert.equal(reads,2);
 t.mock.timers.tick(300);await started;await f.settle();assert.equal(reads,3);
 assert.equal((await f.live()).mode,'federated');assert.equal(f.pickers.length,1);assert.equal((await f.live()).turns,0);
});
test('REQ-P3 at most five reads leave an invisible request undecided',async t=>{
 const f=await fixture(t,{mode:'undecided',contract:7});t.mock.timers.enable({apis:['setTimeout']});
 let reads=0;f.port.history=async()=>{reads++;return history();};const started=f.engine.started('A');
 await f.engine.setProgress(1,'active');await f.flush();
 for(let n=1;n<5;n++){t.mock.timers.tick(300);await f.flush();await f.engine.setProgress(1,'active');await f.flush();}
 await started;t.mock.timers.tick(3000);await f.flush();assert.equal(reads,5);
 assert.equal((await f.live()).mode,'undecided');assert.equal(f.pickers.length,0);
});
test('REQ-P3 a slow retry read does not block a mode choice or override it later',async t=>{
 const f=await fixture(t,{mode:'undecided',contract:7});t.mock.timers.enable({apis:['setTimeout']});
 let reads=0,release;f.port.history=async()=>++reads===1?history():new Promise(resolve=>{release=resolve;});
 const started=f.engine.started('A');await f.engine.setProgress(1,'active');await f.flush();
 t.mock.timers.tick(300);await f.flush();assert.equal(typeof release,'function');
 assert.equal((await f.engine.selectMode(f.id,'general')).ok,true);release(history({request}));await started;await f.settle();
 assert.equal((await f.live()).mode,'general');assert.equal(f.pickers.length,0);
});
test('REQ-P3 closing the engine stops deferred detection without another history read',async t=>{
 const f=await fixture(t,{mode:'undecided',contract:7});t.mock.timers.enable({apis:['setTimeout']});
 let reads=0;f.port.history=async()=>{reads++;return history();};const started=f.engine.started('A');
 await f.engine.setProgress(1,'active');await f.flush();await f.engine.close();
 t.mock.timers.tick(300);await started;assert.equal(reads,1);assert.equal(f.pickers.length,0);
});
