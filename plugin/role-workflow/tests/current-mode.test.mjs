import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { WorkflowEngine } from "../server/engine.ts";
import { EXECUTOR_QUESTIONS as Q } from "../shared/executor-selection.ts";
import { composeCurrentPrompt } from "../server/roles.ts";
import { sequentialSelectionPrompt } from "../server/executor-selection.ts";

const block=(status,extra={})=>`<paseo-workflow>${JSON.stringify({status,summary:status,next:"구현 지시",handoff:"인계",checks:[],...extra})}</paseo-workflow>`;
async function fixture(t,{mode="federated",provider="codex",ask=false,options=[{id:"low",label:"Low"},{id:"high",label:"High"}],contract=4}={}){
  const dir=await mkdtemp(path.join(tmpdir(),"current-mode-"));const file=path.join(dir,"fixture.json");
  const original={provider:`${provider}/planner`,thinkingOptionId:"medium",modeId:"full-access"};
  const agents=new Map([["A",{id:"A",workspaceId:"ws",projectId:"project",cwd:dir,title:"Task",status:"idle",archived:false,permission:false,usage:0,config:original}]]);
  const created=[],sent=[],histories=new Map();let models=[{id:"builder",label:"Builder",thinkingOptions:options},{id:"planner",label:"Planner",thinkingOptions:[{id:"medium",label:"Medium"}]}],catalogFailure=false,modelCalls=0;
  const port={inspect:async id=>agents.get(id)??null,history:async id=>histories.get(id)??{text:"",key:"",failed:null,messageIds:[]},
    models:async()=>{modelCalls++;if(catalogFailure)throw Error("catalog offline");return models;},
    projectName:async()=>"Project",workspaceName:async()=>"Task",rename:async()=>{},quotaAccount:async()=>null,quotaAvailable:async()=>null,
    create:async(w,role,m)=>{created.push({...m.config,id:m.id});agents.set(m.id,{...agents.get("A"),id:m.id,config:m.config});return "ws";},
    send:async(id,prompt,messageId)=>{sent.push({id,prompt,messageId});agents.get(id).status="running";}};
  let engine=new WorkflowEngine(file,port);
  await engine.configure({...await engine.settings(),askExecutorModel:ask,autoPinStarted:false,autoArchivePushed:false,titleMarker:false,autoResumeQuota:false,autoResumeTransient:false});
  const id=await engine.enroll(agents.get("A"),original,{},mode,true,contract);
  t.after(async()=>{await engine.close();await rm(dir,{recursive:true,force:true});});
  let sequence=0;
  const state=async()=>JSON.parse(await readFile(file,"utf8")).workflows[0];
  const finish=async(agentId,status,extra={})=>{const key=`turn-${++sequence}`;const delivery=sent.findLast(x=>x.id===agentId);const text=block(status,extra);agents.get(agentId).status="idle";const h={key,text,failed:null,messageIds:delivery?[delivery.messageId]:[]};histories.set(agentId,h);await engine.ended(agentId,key,text,null,"goal",false,delivery?.prompt??"",false,h.messageIds);};
  const askQuestion=async(stage,requestId)=>engine.permission("A",{id:requestId,kind:"question",input:{questions:[{question:Q[stage].question,header:Q[stage].header,options:[]}]}});
  const answer=async(stage,value,requestId=`q-${++sequence}`)=>{await askQuestion(stage,requestId);await engine.permissionResolved("A",requestId,{behavior:"allow",updatedInput:{answers:{[Q[stage].header]:value}}});return requestId;};
  return {dir,id,original,agents,created,sent,port,state,finish,answer,askQuestion,get engine(){return engine;},get modelCalls(){return modelCalls;},setModels:v=>{models=v;},failCatalog:v=>{catalogFailure=v;},restart:async()=>{await engine.close();engine=new WorkflowEngine(file,port);}};
}

for(const provider of ["codex","claude"])for(const ask of [false,true])
test(`contract4 general ${provider} ask=${ask} stays in the first conversation for implementation and self-check`,async t=>{
  const f=await fixture(t,{mode:"general",provider,ask});
  await writeFile(path.join(f.dir,"result.txt"),"self-check\n");
  await f.engine.ended("A","self","작업상태: 완료\n자체 점검: result.txt 확인",null,"goal");
  const w=await f.state();assert.equal(w.contract,4);assert.deepEqual(w.plan.config,f.original);
  assert.equal(w.execute,null);assert.equal(f.created.length,0);assert.equal(f.sent.length,0);assert.equal(f.modelCalls,0);
  assert.equal(w.progress,"done");assert.equal(w.verdict,null);
  await f.engine.generalTimeline("A",[],{agent:"Claude Code",model:"claude/builder",thinking:"high"});
  assert.deepEqual((await f.state()).plan.config,f.original);assert.equal(f.sent.length,0);
  const prompt=composeCurrentPrompt(provider,"user rules","general",null,"","");
  assert.doesNotMatch(prompt,/<paseo-role-workflow-v1>|<paseo-automation-v1>|<paseo-executor-selection-v4>/);
  assert.match(prompt,/직접 조사·구현·자체 검증/);
});

for(const initial of ["codex","claude"])for(const selected of ["codex","claude"])
test(`contract4 ${initial} planner -> ${selected} sequential choice validates answers and preserves identities across restart`,async t=>{
  const f=await fixture(t,{provider:initial});
  await f.askQuestion("model","too-early");await f.engine.permissionResolved("A","too-early",{behavior:"allow",updatedInput:{answers:{[Q.model.header]:"builder"}}});
  assert.equal((await f.state()).selection.stage,"provider");
  await f.finish("A","plan");assert.equal(f.created.length,0);
  const q=await f.answer("provider",selected);assert.equal((await f.state()).selection.stage,"model");
  await f.restart();await f.engine.permissionResolved("A",q,{behavior:"allow",updatedInput:{answers:{[Q.provider.header]:selected==="codex"?"claude":"codex"}}});
  assert.equal((await f.state()).selection.provider,selected);
  await f.answer("model","builder");assert.equal((await f.state()).selection.stage,"thinking");
  await f.finish("A","plan");assert.equal(f.created.length,0);
  await f.answer("thinking","unsupported");assert.equal((await f.state()).selection.stage,"thinking");
  await f.answer("thinking","high");assert.equal((await f.state()).selection.stage,"ready");
  await f.finish("A","plan");let w=await f.state();assert.equal(f.created.length,1);
  assert.equal(w.execute.config.provider,`${selected}/builder`);assert.equal(w.execute.config.thinkingOptionId,"high");assert.deepEqual(w.plan.config,f.original);
  await f.finish(w.execute.id,"result");assert.equal((await f.state()).phase,"review");
  await f.finish("A","complete");assert.notEqual((await f.state()).status,"completed","federated verdict remains required");
});

for(const options of [[],[{id:"low",label:"Low"}]])test(`contract4 model has ${options.length} thinking options, explicit none or single value`,async t=>{
  const f=await fixture(t,{options});await f.answer("provider","codex");await f.answer("model","builder");
  const s=(await f.state()).selection;assert.equal(s.stage,"ready");assert.equal(s.thinking,options[0]?.id??"");
  assert.equal(s.pending,null);await f.finish("A","plan");assert.equal(f.created.length,1);
});

test("provider/model reselection invalidates dependent answers; stale question response does not overwrite",async t=>{
  const f=await fixture(t);await f.answer("provider","codex");await f.answer("model","builder");
  const old=await f.answer("thinking","high");await f.answer("provider","claude");
  let s=(await f.state()).selection;assert.equal(s.model,"");assert.equal(s.thinking,null);assert.equal(s.stage,"model");
  await f.engine.permissionResolved("A",old,{behavior:"allow",updatedInput:{answers:{[Q.thinking.header]:"low"}}});
  assert.deepEqual((await f.state()).selection,s);
});
test("missing catalog and removed model never fall back to project defaults or the opposite provider",async t=>{
  const f=await fixture(t);f.failCatalog(true);await f.answer("provider","codex");await f.finish("A","plan");
  assert.equal(f.created.length,0);assert.equal((await f.state()).selection.provider,"codex");
  f.failCatalog(false);await f.answer("model","not-in-catalog");assert.equal((await f.state()).selection.stage,"model");
  await f.answer("model","builder");await f.answer("thinking","low");await f.restart();f.setModels([]);await f.finish("A","plan");
  assert.equal(f.created.length,0);assert.equal((await f.state()).selection.stage,"model");assert.deepEqual((await f.state()).plan.config,f.original);
});
test("native async answers are exact pairs and duplicates do not replay a prior selection",async t=>{
  const f=await fixture(t);const detail=Q.provider.question+"\nCodex";
  const tool={type:"tool_call",name:"request_user_input_async",callId:"async-provider",status:"completed",error:null,detail:{type:"plain_text",text:detail}};
  await f.engine.generalTimeline("A",[tool]);assert.equal((await f.state()).selection.stage,"provider");
  const items=[tool,{type:"user_message",text:"Answers to your questions:\n\n"+detail}];
  await f.engine.generalTimeline("A",items);await f.restart();await f.engine.generalTimeline("A",items);
  assert.equal((await f.state()).selection.stage,"model");assert.deepEqual((await f.state()).selection.answered,["async-provider"]);
});
test("contract4 mode change requests are safely refused and current mode is retained",async t=>{
  const f=await fixture(t,{mode:"general"});await f.engine.ended("A","switch","알겠습니다",null,"",false,"연합개발로 전환해");
  assert.equal((await f.state()).mode,"general");assert.equal(f.created.length,0);assert.match((await f.state()).detail,/새 작업/);
});
test("explicit first request is validated as answered choices and uses the selected same-provider model",async t=>{
  const f=await fixture(t);await f.engine.ended("A","explicit",block("plan"),null,"연합개발\ncodex/builder 추론 high\n작업");
  assert.equal(f.created[0].provider,"codex/builder");assert.equal(f.created[0].thinkingOptionId,"high");
});
test("contract4 undecided prompts gate roles and sequential selection to federation",()=>{
  const prompt=composeCurrentPrompt("codex","caller","undecided",null,sequentialSelectionPrompt({}),"");
  assert.match(prompt,/실제 답변 전/);assert.match(prompt,/일반개발.*직접 조사·구현·자체 검증/);assert.match(prompt,/연합개발 전용/);
  assert.match(prompt,/제품→모델→추론/);assert.match(prompt,/카탈로그를 읽지 못/);
});

test("native mode answer establishes standalone behavior without a permission event",async t=>{
 const f=await fixture(t,{mode:"undecided"});const detail="진행 방식을 선택하세요\n일반개발";
 await f.engine.generalTimeline("A",[{type:"tool_call",name:"request_user_input_async",callId:"mode",status:"completed",error:null,detail:{type:"plain_text",text:detail}},{type:"user_message",text:"Answers to your questions:\n\n"+detail}]);
 await f.engine.ended("A","done","작업상태: 완료",null,"goal");
 assert.equal((await f.state()).mode,"general");assert.equal((await f.state()).progress,"done");assert.equal(f.created.length,0);
});

for(const contract of [1,2,3])for(const mode of ['general','federated'])
test(`reading contract${contract} ${mode} preserves the persisted workflow and project preferences`,async t=>{
 const f=await fixture(t,{contract,mode});const file=path.join(f.dir,'fixture.json');
 const before=await readFile(file,'utf8');await f.restart();await f.engine.list();
 assert.equal(await readFile(file,'utf8'),before);assert.equal(f.created.length,0);assert.equal(f.sent.length,0);
});
test('contract4 federation cannot become standalone through an ordinary mode change request',async t=>{
 const f=await fixture(t);await f.engine.ended('A','switch','알겠습니다',null,'',false,'일반개발로 전환해');
 assert.equal((await f.state()).mode,'federated');assert.equal(f.created.length,0);
 await assert.rejects(f.engine.control(f.id,'general'),/새 작업/);
});
test('a first request naming only the implementation product skips only that validated question',async t=>{
 const f=await fixture(t);await f.engine.ended('A','product',block('plan'),null,'연합개발\nCodex\n작업');
 assert.equal((await f.state()).selection.provider,'codex');assert.equal((await f.state()).selection.stage,'model');assert.equal(f.created.length,0);
});

test('initial native question preceding mode enrollment and an empty event recovers the real request identity',async t=>{
 const f=await fixture(t,{mode:'undecided'});
 f.agents.get('A').permission=true;
 f.agents.get('A').questions=[{id:'permission-native',input:{questions:[{header:'Question 1',question:Q.provider.question,options:[]}]}}];
 await f.engine.generalTimeline('A',[],{},[],undefined,'연합개발\n작업');
 let w=await f.state();assert.equal(w.mode,'federated');assert.equal(w.selection.pending.id,'native');
 await f.engine.ended('A','question-only','제품을 선택하세요',null,'연합개발\n작업');
 assert.equal((await f.state()).status,'active');assert.doesNotMatch((await f.state()).detail,/상태 블록/);
 await f.restart();await f.engine.permissionResolved('A','permission-native',{behavior:'allow',updatedInput:{answers:{'Question 1':'Codex'}}});
 assert.equal((await f.state()).selection.stage,'model');
 await f.engine.generalTimeline('A',[],{},[{id:'native',stage:'provider',value:'Claude Code'}]);
 assert.equal((await f.state()).selection.provider,'codex');
});

test('creation failure and provider reselection restore the same intended executor identity with the new verified config',async t=>{
 const f=await fixture(t);await f.answer('provider','codex');await f.answer('model','builder');await f.answer('thinking','high');
 const create=f.port.create;f.port.create=async()=>{throw Error('creation failed');};await f.finish('A','plan');
 const id=(await f.state()).execute.id;assert.equal((await f.state()).execute.workspaceId,null);
 await f.answer('provider','claude');await f.answer('model','builder');await f.answer('thinking','low');
 f.port.create=create;await f.engine.control(f.id,'resume');
 const w=await f.state();assert.equal(w.execute.id,id);assert.equal(f.created.length,1);
 assert.equal(f.created[0].provider,'claude/builder');assert.equal(f.created[0].thinkingOptionId,'low');assert.deepEqual(w.plan.config,f.original);
});
test('explicit catalog model identifiers may include provider-supported context suffixes',async t=>{
 const f=await fixture(t);f.setModels([{id:'model[1m]',label:'Long context',thinkingOptions:[]}]);
 await f.engine.ended('A','explicit-context',block('plan'),null,'연합개발\nclaude/model[1m]\n작업');
 assert.equal(f.created[0].provider,'claude/model[1m]');
});
