import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,copyFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {WorkflowEngine} from "../server/engine.ts";

async function fixture(t,{provider="claude",used=499999,max=1000000}={}){
 const dir=await mkdtemp(path.join(tmpdir(),"standalone-maintenance-")),file=path.join(dir,"fixture.json");
 const config={provider:`${provider}/initial`,thinkingOptionId:"high"};
 const agent={id:"A",workspaceId:"ws",projectId:"p",cwd:dir,title:"Task",status:"idle",archived:false,permission:false,usage:used/max,contextUsage:{contextWindowUsedTokens:used,contextWindowMaxTokens:max},config};
 const compacted=[],sent=[],created=[],pending=[];let failure=false,hold=false;let history={text:"",key:"",messageIds:[],failed:null};
 const port={inspect:async()=>agent,history:async()=>history,projectName:async()=>"Project",workspaceName:async()=>"Task",rename:async()=>{},
  compact:async(id,messageId)=>{compacted.push({id,messageId});if(failure)throw Error("Failed to compact context: injected native failure");if(hold)await new Promise(r=>pending.push(r));},
  send:async(...args)=>sent.push(args),create:async(...args)=>{created.push(args);return "replacement";},quotaAccount:async()=>null,quotaAvailable:async()=>null};
 let engine=new WorkflowEngine(file,port);await engine.configure({...await engine.settings(),threshold:0.7,codexCompression:"native",claudeCompression:{threshold:0.55,oneMillionTokenLimit:500000},autoArchivePushed:false,autoPinStarted:false,titleMarker:false});
 const id=await engine.enroll(agent,config,{},"general",true,4);
 t.after(async()=>{for(const done of pending)done();await engine.close();await rm(dir,{recursive:true,force:true});});
 const state=async()=>JSON.parse(await readFile(file,"utf8")).workflows[0];
 const settle=async()=>{await new Promise(r=>setImmediate(r));await engine.tick();};
 const finish=async(key="product",text="자체 점검 진행 중",compacted=false)=>engine.ended("A",key,text,null,"goal",compacted);
 return {dir,file,id,config,agent,port,compacted,sent,created,state,settle,finish,pending,get engine(){return engine;},setFailure:x=>{failure=x;},setHold:x=>{hold=x;},setHistory:x=>{history=x;},restart:async()=>{await engine.close();engine=new WorkflowEngine(file,port);}};
}
for(const [max,before,at] of [[1000000,499999,500000],[200000,109999,110000]])
test(`standalone Claude ${max} exact boundary reuses identity without role delivery`,async t=>{
 const f=await fixture(t,{max,used:before});await f.finish();assert.equal(f.compacted.length,0);
 f.agent.contextUsage.contextWindowUsedTokens=at;await f.engine.tick();await f.settle();assert.equal(f.compacted.length,1);
 let w=await f.state();assert.equal(w.plan.compactedForTurn,"product");assert.equal(w.plan.lastTurnKey,"product");assert.deepEqual(w.plan.config,f.config);
 f.agent.contextUsage.contextWindowUsedTokens=at+1;await f.finish();await f.engine.tick();assert.equal(f.compacted.length,1);
 await f.restart();await f.engine.tick();assert.equal(f.compacted.length,1);w=await f.state();assert.equal(w.execute,null);assert.equal(w.pending,null);assert.equal(w.cycles,0);assert.equal(w.turns,0);assert.equal(f.created.length,0);assert.equal(f.sent.length,0);
});
for(const blocked of ["running","permission","paused","completed","archived"])
test(`standalone ${blocked} prevents compaction and keeps product/role state`,async t=>{
 const f=await fixture(t);if(blocked==="paused")await f.engine.control(f.id,"pause");
 if(blocked==="running")f.agent.status="running";if(blocked==="permission")f.agent.permission=true;if(blocked==="archived")f.agent.archived=true;
 f.agent.contextUsage.contextWindowUsedTokens=500000;await f.finish("blocked",blocked==="completed"?"작업상태: 완료":"진행 중");await f.engine.tick();
 assert.equal(f.compacted.length,0);const w=await f.state();assert.equal(w?.execute??null,null);assert.equal(f.sent.length,0);assert.equal(f.created.length,0);
 if(blocked==="paused")assert.equal(w.status,"paused");if(blocked==="completed")assert.equal(w.progress,"done");
});
for(const ratio of [0.7,0.9,1])test(`standalone Codex native keeps plugin compact zero at ${ratio}`,async t=>{
 const f=await fixture(t,{provider:"codex",used:ratio*1000000});await f.finish();await f.engine.tick();assert.equal(f.compacted.length,0);assert.equal(f.sent.length,0);
});
test("manual/native maintenance never becomes a product turn or repeats itself",async t=>{
 const f=await fixture(t);await f.finish();await f.engine.maintenanceEnded("A","manual",true,"user-compact");
 f.agent.contextUsage.contextWindowUsedTokens=500000;await f.engine.tick();assert.equal(f.compacted.length,0);assert.equal((await f.state()).plan.lastTurnKey,"product");
 await f.restart();await f.engine.maintenanceEnded("A","manual",true,"user-compact");await f.engine.tick();assert.equal(f.compacted.length,0);
 await f.finish("new-product");await f.settle();assert.equal(f.compacted.length,1);assert.equal(f.sent.length,0);assert.equal((await f.state()).execute,null);
});
test("embedded native Codex compaction records context without a plugin request",async t=>{
 const f=await fixture(t,{provider:"codex",used:1000000});await f.finish("native-product","계속 작업 중",true);await f.engine.tick();const w=await f.state();
 assert.equal(w.plan.compactedForTurn,"native-product");assert.equal(w.plan.lastTurnKey,"native-product");assert.equal(f.compacted.length,0);
});
test("standalone failure survives restart and explicit retry replaces only an exact confirmed failed request",async t=>{
 const f=await fixture(t,{used:500000});f.setFailure(true);await f.finish();await f.settle();let w=await f.state();assert.equal(w.status,"error");const marker=w.plan.compaction;assert.ok(marker);
 await f.restart();await f.engine.tick();assert.equal(f.compacted.length,1);await assert.rejects(f.engine.control(f.id,"resume"),/압축 복구/);
 f.setHistory({text:"Failed to compact context: injected native failure",key:"failed-maintenance",failed:null,maintenance:true,maintenanceId:marker,compacted:false,messageIds:[marker]});
 f.setFailure(false);await f.engine.control(f.id,"retry_compaction");await f.settle();w=await f.state();assert.equal(w.status,"active");assert.equal(w.plan.compaction,null);assert.equal(w.plan.compactedForTurn,"product");
 assert.equal(f.compacted.length,2);assert.notEqual(f.compacted[1].messageId,marker);assert.equal(f.sent.length,0);assert.equal(f.created.length,0);
});
test("orphaned in-flight marker is not replayed; exact completed history settles without send",async t=>{
 const f=await fixture(t,{used:500000});f.setHold(true);await f.finish();const w=await f.state();const restoredFile=path.join(f.dir,"restored.json");await copyFile(f.file,restoredFile);
 const restored=new WorkflowEngine(restoredFile,f.port);t.after(()=>restored.close());await restored.tick();assert.equal((await restored.list()).workflows[0].status,"error");assert.equal(f.compacted.length,1);
 f.setHistory({text:"summary",key:"maintenance",failed:null,messageIds:[w.plan.compaction],maintenance:true,maintenanceId:w.plan.compaction,compacted:true});
 await restored.control(f.id,"retry_compaction");assert.equal((await restored.list()).workflows[0].status,"active");await restored.tick();assert.equal(f.compacted.length,1);assert.equal(f.sent.length,0);
});
test("failed job followed by confirmed manual compaction remains recoverable without a second request",async t=>{
 const f=await fixture(t,{used:500000});f.setFailure(true);await f.finish();await f.settle();await f.engine.maintenanceEnded("A","manual-recovery",true,"user-compact");
 assert.equal((await f.state()).status,"error");await f.engine.control(f.id,"retry_compaction");await f.engine.tick();assert.equal((await f.state()).status,"active");assert.equal(f.compacted.length,1);assert.equal(f.sent.length,0);
});
test("pause during an in-flight success never resumes maintenance",async t=>{
 const f=await fixture(t,{used:500000});f.setHold(true);await f.finish();await f.engine.control(f.id,"pause");f.pending.shift()();await f.settle();assert.equal((await f.state()).status,"paused");assert.equal(f.compacted.length,1);assert.equal(f.sent.length,0);
});

test("unknown or stale maintenance history never authorizes a retry send",async t=>{
 const f=await fixture(t,{used:500000});f.setFailure(true);await f.finish();await f.settle();const marker=(await f.state()).plan.compaction;
 for(const history of [{text:"",key:"",failed:null,messageIds:[]},{text:"Failed to compact context: old failure",key:"old",failed:null,maintenance:true,maintenanceId:"different-request",compacted:false,messageIds:[marker]}]){
  f.setHistory(history);await assert.rejects(f.engine.control(f.id,"retry_compaction"),/재전송하지 않습니다/);assert.equal(f.compacted.length,1);assert.equal((await f.state()).plan.compaction,marker);
 }
});

test("failure after user pause remains paused and has an explicit reachable recovery path",async t=>{
 const f=await fixture(t,{used:500000});let reject;
 f.port.compact=async(id,messageId)=>{f.compacted.push({id,messageId});await new Promise((_,r)=>reject=r);};
 await f.finish();await f.engine.control(f.id,"pause");reject(Error("Failed to compact context: native failure"));await f.settle();assert.equal((await f.state()).status,"paused");
 await f.engine.control(f.id,"resume");assert.equal((await f.state()).status,"error");assert.equal((await f.engine.list()).workflows[0].compactionRecovery,true);
 await f.engine.maintenanceEnded("A","manual-after-pause",true,"user-manual");await f.engine.control(f.id,"retry_compaction");assert.equal((await f.state()).status,"active");assert.equal(f.compacted.length,1);assert.equal(f.sent.length,0);
});
test("a new high-usage standalone conversation waits for a real completed product turn",async t=>{
 const f=await fixture(t,{used:500000});await f.engine.tick();assert.equal(f.compacted.length,0);await f.finish();await f.settle();assert.equal(f.compacted.length,1);
});

test("a failed idle-state read has an explicit maintenance-only recovery without role resume",async t=>{
 const f=await fixture(t);await f.finish();const inspect=f.port.inspect;f.port.inspect=async()=>{throw Error("temporary read failure");};await f.engine.tick();assert.equal((await f.state()).status,"error");
 f.port.inspect=inspect;await f.engine.control(f.id,"resume");assert.equal((await f.state()).status,"active");assert.equal(f.sent.length,0);assert.equal(f.created.length,0);
});
