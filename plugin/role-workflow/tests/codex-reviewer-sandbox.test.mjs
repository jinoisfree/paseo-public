import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPort } from '../server/paseo-port.ts';
import { reviewerEligibility } from '../shared/plan-review.ts';

test('AC-26: only Codex reviewer creation overrides sandbox and approval per conversation', async () => {
 const calls=[];
 const workspace={id:'ws',agents:{create:async input=>{calls.push(structuredClone(input));return {id:input.agentId};}}};
 const port=createPort(()=>({providers:{listModels:async()=>({models:[{id:'X'}]}),listModes:async()=>({modes:[{id:'auto'},{id:'plan'},{id:'full-access'}]})},workspaces:{create:async()=>workspace,ref:()=>workspace}}));
 const w={id:'task',cwd:'/work',projectId:'project',title:'Task',plan:{workspaceId:'ws'}};
 for(const [role,provider,modeId] of [['reviewer','codex','auto'],['execute','codex','full-access'],['plan','codex','full-access'],['reviewer','claude','plan']]){
  const options={sandbox_mode:'danger-full-access',approval_policy:'on-request'};
  const member={id:role+provider,generation:1,config:{provider:provider+'/X',modeId,options},env:{}};
  await port.create(w,role,member);
  assert.deepEqual(calls.at(-1).config.options,role==='reviewer'&&provider==='codex'?{sandbox_mode:'read-only',approval_policy:'never'}:options);
  assert.deepEqual(options,{sandbox_mode:'danger-full-access',approval_policy:'on-request'});
 }
 assert.equal(reviewerEligibility('claude/X','codex','X',true,['auto'],'auto'),null);
 assert.match(reviewerEligibility('claude/X','codex','X',true,['full-access'],'full-access'),/읽기 전용/);
 assert.match(reviewerEligibility('codex/X','codex','X',true,['auto'],'auto'),/다른/);
});
