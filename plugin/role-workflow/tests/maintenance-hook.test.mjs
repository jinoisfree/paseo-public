import { isolateOwnerHome, configureFixture } from "./owner-fixture.mjs";
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import contribute from "../index.server.ts";
import {settingsSchema} from "../shared/contracts.ts";

test("native maintenance lifecycle updates context without being consumed as a standalone product turn",async(t)=>{
 const dir=await mkdtemp(path.join(tmpdir(),"maintenance-hook-")),previous=process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;process.env.PASEO_ROLE_WORKFLOW_STATE_DIR=dir;
  isolateOwnerHome(t, dir);
 const before=new Map(),events=new Map(),rpcs=new Map(),sends=[];
 const agent={id:"A",provider:"claude",model:"model",workspaceId:"ws",cwd:dir,title:"Task",status:"idle",archivedAt:null,pendingPermissions:[],lastUsage:{contextWindowUsedTokens:499999,contextWindowMaxTokens:1000000}};
 const context={paseo:{
  agents:{ref:()=>({refresh:async()=>({agent}),send:async(...args)=>sends.push(args)})},
  workspaces:{ref:()=>({refresh:async()=>({projectId:"p",name:"Task"})})},
 }};
 const close=contribute({addHook:(name,fn)=>{(name==="agent.create.before"||name==="agent.open.before"?before:events).set(name,fn);return()=>{};},handle:(contract,fn)=>rpcs.set(contract.name,fn)});
 try{
  await configureFixture(rpcs, context, settingsSchema.parse({askMode:false,defaultMode:"general",claudeStartMode:"",koreanTitle:false,titleMarker:false,autoPinStarted:false,autoArchivePushed:false,codexCompression:"native",claudeCompression:{threshold:0.55,oneMillionTokenLimit:500000}}));
  const created=await before.get("agent.create.before")({request:{config:{provider:"claude",cwd:dir}}},context);
  await before.get("agent.open.before")({request:{agentId:"A",reason:"create",env:created.env}},context);
  await events.get("agent.create.after")({agent},context);
  const finish=timeline=>events.get("agent.turn.after")({agent,timeline,outcome:{kind:"completed"}},context);
  await finish([{type:"user_message",text:"일반개발\n작업",clientMessageId:"product-request"},{type:"assistant_message",text:"계속 작업 중"}]);
  let w=JSON.parse(await readFile(path.join(dir,"state.json"),"utf8")).workflows[0];const key=w.plan.lastTurnKey;assert.ok(key);
  agent.lastUsage.contextWindowUsedTokens=500000;
  const maintenance=[{type:"user_message",text:"/compact",clientMessageId:"manual-request"},{type:"compaction",status:"completed"},{type:"assistant_message",text:"요약 완료"}];
  await finish(maintenance);await finish(maintenance);w=JSON.parse(await readFile(path.join(dir,"state.json"),"utf8")).workflows[0];
  assert.equal(w.plan.lastTurnKey,key);assert.equal(w.plan.compactedForTurn,key);assert.equal(w.execute,null);assert.equal(w.pending,null);assert.equal(w.cycles,0);assert.equal(w.turns,0);assert.deepEqual(sends,[]);
 }finally{await close();if(previous===undefined)delete process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;else process.env.PASEO_ROLE_WORKFLOW_STATE_DIR=previous;await rm(dir,{recursive:true,force:true});}
});
