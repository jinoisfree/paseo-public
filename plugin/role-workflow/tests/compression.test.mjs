import { test } from "node:test";
import assert from "node:assert/strict";
import { compressionDecision, contextUsage, contextRatio } from "../shared/compression.ts";
import { settingsSchema } from "../shared/contracts.ts";

const settings=settingsSchema.parse({threshold:0.7,claudeCompression:{threshold:0.55,oneMillionTokenLimit:500000}});
const sample=(used,max)=>({usage:0.99,contextUsage:{contextWindowUsedTokens:used,contextWindowMaxTokens:max}});
for(const [provider,max,below,at,policy] of [
 ["claude/sonnet[1m]",1000000,499999,500000,"claude-1m"],
 ["claude/ordinary",200000,109999,110000,"claude-ratio"],
 ["claude/not-a-1m-name",400000,219999,220000,"claude-ratio"],
 ["claude/label[1m]",1048576,576716,576717,"claude-ratio"],
 ["claude/large",2000000,1099999,1100000,"claude-ratio"],
 ["codex/any",200000,139999,140000,"common"],
 ["codex/any",1000000,699999,700000,"common"],
])test(`${provider} actual capacity ${max} threshold boundary`,()=>{
 const before=compressionDecision(provider,settings,sample(below,max));assert.equal(before.due,false);assert.equal(before.policy,policy);
 const after=compressionDecision(provider,settings,sample(at,max));assert.equal(after.due,true);assert.equal(after.policy,policy);
});
test("old settings retain their common threshold; override is disabled by default",()=>{
 const old=settingsSchema.parse({threshold:0.7});assert.equal(old.claudeCompression,null);
 for(const provider of ["claude","codex"]){
  assert.equal(compressionDecision(provider,old,sample(500000,1000000)).due,false);
  assert.equal(compressionDecision(provider,old,{usage:0.7}).due,true);
 }
 assert.equal(compressionDecision("codex",{...settings,claudeCompression:{threshold:0.05,oneMillionTokenLimit:1}},sample(699999,1000000)).due,false);
});
for(const [used,max] of [[undefined,1000000],[500000,undefined],[NaN,1000000],[Infinity,1000000],[-1,1000000],[1,0],[1,-1],[1,NaN],[1,Infinity],[Number.MAX_VALUE,Number.MIN_VALUE]])
test(`invalid raw usage ${used}/${max} is never replaced with a cached ratio`,()=>{
 assert.equal(contextUsage({contextWindowUsedTokens:used,contextWindowMaxTokens:max}),null);
 for(const provider of ["claude","codex"]){
  const result=compressionDecision(provider,settings,sample(used,max));assert.equal(result.due,false);assert.equal(result.policy,"unavailable");
 }
});
test("Claude needs both raw values even when a ratio/model name suggests 1M",()=>{
 for(const observation of [null,{usage:0.99},{usage:0.99,contextUsage:null}]){
  const result=compressionDecision("claude/sonnet[1m]",settings,observation);assert.equal(result.due,false);assert.match(result.reason,/없거나 잘못/);
 }
 assert.equal(contextRatio({contextWindowUsedTokens:0,contextWindowMaxTokens:1000000}),0);
 assert.equal(compressionDecision("claude",settings,sample(0,1000000)).due,false);
 assert.equal(compressionDecision("claudex/model",settings,sample(900000,1000000)).due,false);
});
test("settings reject invalid Claude policy without silently normalizing its values",()=>{
 for(const policy of [{threshold:0,oneMillionTokenLimit:500000},{threshold:Infinity,oneMillionTokenLimit:500000},{threshold:0.55,oneMillionTokenLimit:0},{threshold:0.55,oneMillionTokenLimit:1000001},{threshold:0.55,oneMillionTokenLimit:1.5}])
  assert.equal(settingsSchema.safeParse({...settings,claudeCompression:policy}).success,false);
});

test("configure and reload preserve unrelated settings, including Codex 70% and limits 20/50",async t=>{
 const {WorkflowEngine}=await import("../server/engine.ts");const {mkdtemp,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const path=await import("node:path");
 const dir=await mkdtemp(path.join(tmpdir(),"compression-settings-"));const file=path.join(dir,"fixture.json");const engine=new WorkflowEngine(file,{});
 t.after(async()=>{await engine.close();await rm(dir,{recursive:true,force:true});});
 const before={...await engine.settings(),threshold:0.7,maxCycles:20,maxTurns:50,askMode:false};await engine.configure(before);
 const wanted={...before,claudeCompression:{threshold:0.55,oneMillionTokenLimit:500000}};assert.deepEqual(await engine.configure(wanted),wanted);
 await engine.close();const restored=new WorkflowEngine(file,{});t.after(()=>restored.close());assert.deepEqual(await restored.settings(),wanted);
});

for(const ratio of [0.7,0.9,1])test(`Codex native mode does not precompact at ${ratio*100}%`,()=>{
 const native={...settings,codexCompression:"native"};
 for(const provider of ["codex","codex/model"]){const d=compressionDecision(provider,native,sample(ratio*1000000,1000000));assert.equal(d.due,false);assert.equal(d.policy,"native");}
 assert.equal(compressionDecision("claude/model",native,sample(500000,1000000)).due,true);
});
