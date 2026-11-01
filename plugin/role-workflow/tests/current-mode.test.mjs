import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { WorkflowEngine } from "../server/engine.ts";
import { EXECUTOR_QUESTIONS as Q } from "../shared/executor-selection.ts";
import { composeCurrentPrompt } from "../server/roles.ts";
import { executorSelectionPrompt } from "../server/executor-selection.ts";

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
  const bundle = async(values, requestId=`bundle-${++sequence}`, stages=["provider","model","thinking"]) => {
    const questions=stages.map((stage,index)=>({id:`field-${stage}`,question:Q[stage].question,header:`Question ${index+1}`,options:[]}));
    await engine.permission("A",{id:requestId,kind:"question",input:{questions}});
    await engine.permissionResolved("A",requestId,{behavior:"allow",updatedInput:{answers:Object.fromEntries(Object.entries(values).map(([stage,value])=>[`field-${stage}`,value]))}});
    return requestId;
  };
  const resolve = async(id,answers)=>engine.permissionResolved("A",id,{behavior:"allow",updatedInput:{answers}});
  return {bundle,resolve,dir,id,original,agents,created,sent,port,state,finish,answer,askQuestion,get engine(){return engine;},get modelCalls(){return modelCalls;},setModels:v=>{models=v;},failCatalog:v=>{catalogFailure=v;},restart:async()=>{await engine.close();engine=new WorkflowEngine(file,port);}};
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
test(`contract4 ${initial} planner -> ${selected} one request with three answers preserves identities across restart`,async t=>{
  const f=await fixture(t,{provider:initial});
  const questions=Object.values(Q).map((q,i)=>({id:String(i),question:q.question,header:`Question ${i+1}`,options:[]}));
  await f.engine.permission("A",{id:"permission-bundle",kind:"question",input:{questions}});
  await f.restart();await f.resolve("permission-bundle",{"0":selected,"1":`${selected}/builder`,"2":"high"});
  let w=await f.state();assert.equal(w.selection.stage,"ready");assert.deepEqual(w.selection.answered,["bundle"]);assert.equal(w.selection.pending,null);
  await f.restart();await f.resolve("permission-bundle",{"0":"wrong","1":"wrong","2":"wrong"});
  assert.equal((await f.state()).selection.provider,selected);
  await f.finish("A","plan");w=await f.state();assert.equal(f.created.length,1);
  assert.equal(w.execute.config.provider,`${selected}/builder`);assert.equal(w.execute.config.thinkingOptionId,"high");assert.deepEqual(w.plan.config,f.original);
  await f.finish(w.execute.id,"result");assert.equal((await f.state()).phase,"review");
  await f.finish("A","complete");assert.notEqual((await f.state()).status,"completed","federated verdict remains required");
});

for(const options of [[],[{id:"low",label:"Low"}]])test(`contract4 model has ${options.length} thinking options, explicit none or single value`,async t=>{
  const f=await fixture(t,{options});await f.bundle({provider:"Codex",model:"builder",thinking:options[0]?.id??"추론 없음"});
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
  const prompt=composeCurrentPrompt("codex","caller","undecided",null,executorSelectionPrompt({}),"");
  assert.match(prompt,/실제 답변 전/);assert.match(prompt,/일반개발.*직접 조사·구현·자체 검증/);assert.match(prompt,/연합개발 전용/);
  assert.match(prompt,/3질문을 한 호출/);assert.match(prompt,/카탈로그를 읽지 못/);
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
 await f.engine.generalTimeline('A',[],{},[{id:'native',fields:[{stage:'provider',keys:[Q.provider.question]}],values:{provider:'Claude Code'}}]);
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
 const f=await fixture(t);f.setModels([{id:'model[1m]',label:'Long context',thinkingOptions:[{id:'low',label:'Low'}]}]);
 await f.engine.ended('A','explicit-context',block('plan'),null,'연합개발\nclaude/model[1m] 추론 low\n작업');
 assert.equal(f.created[0].provider,'claude/model[1m]');
});

for(const order of [["provider","model","thinking"],["thinking","model","provider"],["model","provider","thinking"]])
test(`partial bundle ${order.join("/")} survives restart and cannot execute before all answers`,async t=>{
 const f=await fixture(t);const values={provider:"Codex",model:"codex/builder",thinking:"high"};
 await f.bundle({[order[0]]:values[order[0]]},"partial");
 assert.notEqual((await f.state()).selection.stage,"ready");assert.deepEqual((await f.state()).selection.answered,[]);
 await f.finish("A","plan");assert.equal(f.created.length,0);await f.restart();
 await f.resolve("partial",{[`field-${order[1]}`]:values[order[1]]});await f.restart();
 assert.equal(f.created.length,0);assert.notEqual((await f.state()).selection.stage,"ready");
 await f.resolve("partial",{[`field-${order[2]}`]:values[order[2]]});
 assert.equal((await f.state()).selection.stage,"ready");assert.deepEqual((await f.state()).selection.answered,["partial"]);
 await f.finish("A","plan");assert.equal(f.created.length,1);
});
for(const [values,missing] of [
 [{provider:"Codex",model:"claude/builder",thinking:"high"},"model"],
 [{provider:"Codex",model:"builder",thinking:"unsupported"},"thinking"],
 [{provider:"invalid",model:"builder",thinking:"high"},"provider"],
 [{provider:"Codex",model:"builder"},"thinking"],
])test(`invalid/missing bundle ${JSON.stringify(values)} blocks execution and preserves other fields`,async t=>{
 const f=await fixture(t);await f.bundle(values,"invalid");await f.finish("A","plan");
 assert.equal(f.created.length,0);assert.equal((await f.state()).selection.stage,missing);
 const correction={provider:"Codex",model:"builder",thinking:"high"}[missing];
 await f.bundle({[missing]:correction},"correction",[missing]);
 const s=(await f.state()).selection;assert.equal(s.stage,"ready");assert.equal(s.thinking,"high");
 await f.resolve("invalid",{"field-provider":"Claude Code","field-model":"missing","field-thinking":"low"});
 assert.deepEqual((await f.state()).selection,s);await f.finish("A","plan");assert.equal(f.created.length,1);
});
for(const [options,value,ready,expected,defaultId] of [
 [[],"추론 없음",true,""], [[],"low",false], [[],"모델 기본값",false],
 [[{id:"low",label:"Low"}],undefined,false], [[{id:"low",label:"Low"}],"low",true,"low"],
 [[{id:"low",label:"Low"}],"추론 없음",false], [[{id:"low",label:"Low"}],"모델 기본값",false],
 [[{id:"low",label:"Low",isDefault:true}],"모델 기본값",true,"low"],
 [[{id:"low",label:"Low"},{id:"high",label:"High"}],"모델 기본값",true,"high","high"],
])test(`bundled thinking ${options.length} options / ${value} / ${defaultId??"no explicit default"}`,async t=>{
 const f=await fixture(t,{options});f.setModels([{id:"builder",label:"Builder",thinkingOptions:options,defaultThinkingOptionId:defaultId}]);
 await f.bundle({provider:"Codex",model:"builder",...(value===undefined?{}:{thinking:value})});
 const s=(await f.state()).selection;assert.equal(s.stage==="ready",ready);if(ready)assert.equal(s.thinking,expected);
 await f.finish("A","plan");assert.equal(f.created.length,ready?1:0);
});
test("native three-question timeline uses one callId, ignores unsubmitted options and duplicate/delayed answers",async t=>{
 const f=await fixture(t);const detail=Object.entries({provider:"Codex",model:"codex/builder",thinking:"high"}).map(([stage,value])=>Q[stage].question+"\n"+value).join("\n\n");
 const tool={type:"tool_call",name:"request_user_input_async",callId:"native-bundle",status:"completed",error:null,detail:{type:"plain_text",text:detail}};
 await f.engine.generalTimeline("A",[tool]);assert.equal((await f.state()).selection.stage,"provider");
 const items=[tool,{type:"user_message",text:"Answers to your questions:\n\n"+detail}];
 await f.engine.generalTimeline("A",items);await f.restart();await f.engine.generalTimeline("A",items);
 assert.equal((await f.state()).selection.stage,"ready");assert.deepEqual((await f.state()).selection.answered,["native-bundle"]);
 await f.finish("A","plan");assert.equal(f.created.length,1);
});
test("bundle catalog failure preserves raw fields for a validated retry, never uses defaults",async t=>{
 const f=await fixture(t);f.failCatalog(true);await f.bundle({provider:"Codex",model:"builder",thinking:"high"});await f.finish("A","plan");assert.equal(f.created.length,0);
 await f.restart();f.failCatalog(false);await f.bundle({model:"builder"},"retry",["model"]);
 assert.equal((await f.state()).selection.stage,"ready");await f.finish("A","plan");assert.equal(f.created.length,1);
});
test("replacement for partial request preserves valid fields and retires delayed old request",async t=>{
 const f=await fixture(t);await f.bundle({provider:"Codex",model:"builder"},"old");await f.restart();
 await f.bundle({thinking:"high"},"new",["thinking"]);const s=(await f.state()).selection;assert.equal(s.stage,"ready");
 await f.resolve("old",{"field-thinking":"low"});assert.deepEqual((await f.state()).selection,s);
});
test("native answer aliases are bound to exact definitions, never guessed from body or conflicting keys",async t=>{
 const f=await fixture(t);await f.bundle({},"aliases");
 await f.resolve("other",{"Question 1":"Codex","Question 2":"builder","Question 3":"high"});assert.equal((await f.state()).selection.provider,null);
 await f.resolve("aliases",{"Question 1":"Codex","field-provider":"Claude Code","Question 2":"builder","Question 3":"high"});
 assert.equal((await f.state()).selection.provider,null);assert.equal(f.created.length,0);
 await f.resolve("aliases",{"Question 1":"Codex"});assert.equal((await f.state()).selection.stage,"ready");
});
test("ready bundled selection is revalidated against changed catalog without silent single-option substitution",async t=>{
 const f=await fixture(t);await f.bundle({provider:"Codex",model:"builder",thinking:"high"});await f.restart();
 f.setModels([{id:"builder",label:"Builder",thinkingOptions:[{id:"low",label:"Low"}]}]);await f.finish("A","plan");
 assert.equal(f.created.length,0);assert.equal((await f.state()).selection.stage,"thinking");assert.equal((await f.state()).selection.thinking,null);
});
test("already-open legacy v4 single-stage pending and ready snapshots are read compatible",async t=>{
 const f=await fixture(t);const file=path.join(f.dir,"fixture.json");await f.engine.close();const db=JSON.parse(await readFile(file,"utf8"));
 db.workflows[0].selection={stage:"model",provider:"codex",model:"",thinking:null,pending:{id:"legacy-model",stage:"model"},answered:["legacy-product"],explicitRead:true,error:""};
 await writeFile(file,JSON.stringify(db));await f.restart();await f.resolve("permission-legacy-model",{"Question 1":"builder"});
 assert.equal((await f.state()).selection.stage,"thinking");await f.bundle({thinking:"high"},"remaining",["thinking"]);
 assert.equal((await f.state()).selection.stage,"ready");await f.restart();await f.engine.list();await f.finish("A","plan");assert.equal(f.created.length,1);
});

test("new single-field follow-ups do not inherit legacy zero/one option auto confirmation",async t=>{
 const f=await fixture(t,{options:[]});await f.answer("provider","Codex");await f.answer("model","builder");
 assert.equal((await f.state()).selection.stage,"thinking");await f.finish("A","plan");assert.equal(f.created.length,0);
 await f.answer("thinking","추론 없음");await f.finish("A","plan");assert.equal(f.created.length,1);
});
for(const options of [[],[{id:"low",label:"Low"}]])test(`legacy open model pending preserves ${options.length}-option confirmation`,async t=>{
 const f=await fixture(t,{options});const file=path.join(f.dir,"fixture.json");await f.engine.close();const db=JSON.parse(await readFile(file,"utf8"));
 db.workflows[0].selection={stage:"model",provider:"codex",model:"",thinking:null,pending:{id:"legacy",stage:"model"},answered:[],explicitRead:true,error:""};
 await writeFile(file,JSON.stringify(db));await f.restart();await f.resolve("legacy",{"Question 1":"builder"});
 assert.equal((await f.state()).selection.stage,"ready");assert.equal((await f.state()).selection.thinking,options[0]?.id??"");await f.finish("A","plan");assert.equal(f.created.length,1);
});

for(const provider of ["claude","codex"])test(`new standalone ${provider} uses maintenance without role-driven delivery`,async t=>{
 const f=await fixture(t,{mode:"general",provider});let compactions=0;f.port.compact=async()=>{compactions++;};
 await f.engine.configure({...await f.engine.settings(),threshold:0.7,codexCompression:"native",claudeCompression:{threshold:0.55,oneMillionTokenLimit:500000}});
 f.agents.get("A").contextUsage={contextWindowUsedTokens:900000,contextWindowMaxTokens:1000000};f.agents.get("A").usage=0.9;
 await f.engine.ended("A","high-context","자체 점검 진행 중",null,"goal");await f.engine.tick();
 assert.equal(compactions,provider==="claude"?1:0);assert.equal(f.created.length,0);assert.equal(f.sent.length,0);assert.equal((await f.state()).execute,null);
 const view=(await f.engine.list()).workflows[0];assert.match(view.planCompressionReason,provider==="claude"?/Claude 1M/:/자체 압축/);
});
