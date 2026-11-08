import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture,choice } from './brainstorm-fixture.mjs';

// Load the actual rollback build, not a hand-written imitation of its schema or gate.
test('AC-9: actual f1ead3b loads contract6 fields/card data and never dispatches an unapproved hold',async t=>{
 const root=path.resolve(import.meta.dirname,'../../..');
 const baseline='f1ead3b36266c1780edd17457beff9b74aaab46f';
 try {
  execFileSync('git',['cat-file','-e',`${baseline}^{commit}`],{cwd:root,stdio:'pipe'});
 } catch(error) {
  const reason=`롤백 기준 커밋 ${baseline}을 읽을 수 없습니다(git 또는 객체 없음): ${error.message}`;
  if(process.env.CI)assert.fail(reason);
  t.skip(reason);return;
 }
 const dir=await mkdtemp(path.join(tmpdir(),'brainstorm-rollback-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const archive=path.join(dir,'baseline.tar');
 execFileSync('git',['archive','--output',archive,baseline,'--','plugin/role-workflow/server','plugin/role-workflow/shared','plugin/role-workflow/package.json'],{cwd:root});
 execFileSync('tar',['-xf',archive,'-C',dir]);
 await symlink(path.resolve(import.meta.dirname,'../../../node_modules'),path.join(dir,'node_modules'));
 const base=path.join(dir,'plugin/role-workflow');const {WorkflowEngine}=await import(pathToFileURL(path.join(base,'server/engine.ts')).href);const {timelineCardSchemas}=await import(pathToFileURL(path.join(base,'shared/timeline-cards.ts')).href);
 assert.deepEqual(timelineCardSchemas['executor-picker'].parse({workflowId:'task'}),{workflowId:'task'});assert.deepEqual(timelineCardSchemas['mode-picker'].parse({workflowId:'task'}),{workflowId:'task'});
 for(const variant of ['prefill','approved-replaced','approved-cancelled']){
  const f=await fixture(t);await f.say('연합개발\ncodex/builder 추론 high','plan');
  if(variant!=='prefill'){
   await f.engine.control(f.id,'pause');await f.engine.selectExecutor(f.id,{...choice,holdId:1});
   if(variant==='approved-cancelled')await f.say('','input');
   await f.say('','plan',{summary:'B'});await f.engine.control(f.id,'resume');
  }
  assert.equal((await f.state()).selection.provider,null);await f.restart(undefined,WorkflowEngine);await f.engine.tick();assert.equal((await f.state()).contract,6,variant);assert.equal(f.created.length,0,variant);
  await f.engine.selectExecutor(f.id,choice);assert.equal(f.created.length,1,variant);assert.equal(f.sent.filter(s=>s.id!=='A').length,1,variant);
 }
});
