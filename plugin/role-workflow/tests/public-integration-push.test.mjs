import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitTestEnvironment } from './git-test-environment.mjs';
import { createRepoProbe } from '../server/git.ts';
import { checkWorktreeBase, integrateWorktree } from '../server/worktree.ts';
import { ManagedPushRunner } from '../server/managed-push.ts';
import { ManagedPushes } from '../server/managed-pushes.ts';
import { WorktreeCleanup } from '../server/worktree-cleanup.ts';
import { archiveBlockReason } from '../server/archive.ts';
import { pushReviewKey } from '../server/push-review.ts';
import { pushTargetsSchema } from '../shared/artifacts.ts';
import { managedPushSchema } from '../shared/managed-push.ts';
import { parseDecision } from '../server/protocol.ts';
const exec = promisify(execFile);
async function fixture(t) {
 const dir=await realpath(await mkdtemp(path.join(tmpdir(),'snapshot-push-'))); t.after(()=>rm(dir,{recursive:true,force:true}));
 const repo=path.join(dir,'repo'),wt=path.join(dir,'wt'),remote=path.join(dir,'remote.git');
 const git=async (cwd,...args)=>(await exec('git',['-c','user.name=Snapshot Fixture','-c','user.email=fixture@example.invalid',...args],{cwd,env:gitTestEnvironment()})).stdout.trim();
 await git(dir,'init','-q','--bare',remote); await git(dir,'init','-q','-b','main',repo);
 await writeFile(path.join(repo,'file'),'base\n'); await git(repo,'add','file'); await git(repo,'commit','-qm','development base');
 const base=await git(repo,'rev-parse','HEAD'), tree=await git(repo,'rev-parse','HEAD^{tree}');
 const old=await git(repo,'commit-tree',tree,'-m','public base');
 // Seed only the temporary bare fixture, without any external destination.
 await git(remote,'fetch','-q',repo,`${old}:refs/heads/main`);
 await git(repo,'remote','add','origin',remote); await git(repo,'fetch','-q','origin');
 await git(repo,'worktree','add','-q','-b','implementation',wt,'main');
 await writeFile(path.join(wt,'file'),'improved\n'); await git(wt,'add','file'); await git(wt,'commit','-qm','implementation');
 const dev=await git(wt,'rev-parse','HEAD'), candidate=await git(wt,'commit-tree',await git(wt,'rev-parse','HEAD^{tree}'),'-p',old,'-m','public candidate');
 const publicWt=path.join(dir,'public'); await git(repo,'worktree','add','-q','-b','public-review',publicWt,candidate);
 await writeFile(path.join(publicWt,'public-only'),'preserved public feature');await git(publicWt,'add','.');await git(publicWt,'commit','-qm','public integration');
 const publicCandidate=await git(publicWt,'rev-parse','HEAD');
 const target={repository:publicWt,remote:'origin',branch:'main',commit:publicCandidate,publicIntegration:{developmentCommit:dev,publicBase:old}};
 const w={id:'fixture',number:1,cwd:repo,mode:'federated',isolation:'worktree',worktree:{path:wt,branch:'implementation',base,baseBranch:'main',workspaceId:'executor-space'},pushTargets:[target],integration:null,pushEpoch:1,progress:'done',status:'active',pending:null,inbox:null,plan:null,execute:null,reviewer:null,managedPush:null};
 const probe=createRepoProbe(), calls=[];
 const driver=async(cwd,args)=>{
  assert.ok(cwd===repo||cwd===wt||cwd===publicWt); // Never allow an operational repo or external remote in the test driver.
  calls.push({cwd,args});
  try {const p=await exec('git',args,{cwd,env:gitTestEnvironment()}); return {stdout:p.stdout,stderr:p.stderr,exitCode:0};}
  catch(e){return {stdout:e.stdout??'',stderr:e.stderr??'',exitCode:typeof e.code==='number'?e.code:null};}
 };
 const folder=path.join(dir,'records'), runner=new ManagedPushRunner(folder,driver);
 return {dir,repo,wt,publicWt,remote,git,base,old,dev,candidate,target,w,probe,calls,folder,runner,driver};
}
function host(f) {
 const notices=[], archives=[];
 const h={runner:()=>f.runner,executions:()=>new Map(),checking:()=>new Set(),port:()=>({inspect:async()=>({status:'idle'}),send:async(...a)=>notices.push(a)}),probe:()=>f.probe,stopped:()=>false,serial:fn=>fn(),db:async()=>({workflows:[f.w]}),save:async()=>{},now:()=>Date.now(),touch:(w,d)=>w.detail=d,settings:async()=>({titleMarker:false,autoArchiveWorktree:true}),invalidatePush:()=>{},setPushUnverified:()=>{},renameWorkspaces:async()=>{},queuePushReview:async()=>{},cleanupWorktree:async()=>{},quiet:()=>true,busyWriter:async()=>null};
 return {h,notices,archives};
}


test('public integration prepares without writes, binds mode, preserves development',async t=>{
 const f=await fixture(t),{h}=host(f),engine=new ManagedPushes(h);
 assert.equal((await checkWorktreeBase(f.w,f.probe,[f.target])).ok,true);
 assert.notEqual(await f.git(f.wt,'rev-parse','HEAD^{tree}'),await f.git(f.publicWt,'rev-parse','HEAD^{tree}'));
 const parsed=parseDecision(`<paseo-workflow>${JSON.stringify({status:'input',summary:'ready',next:'approve',handoff:'fixture',checks:[],pushTargets:[f.target]})}</paseo-workflow>`);
 assert.deepEqual(parsed.pushTargets,[f.target]);
 const prepared=await engine.prepareManagedPush(f.w.id);
 assert.deepEqual(prepared.targets[0].publicIntegration,f.target.publicIntegration);
 await assert.rejects(engine.executeManagedPush(f.w.id,prepared.id,false),/승인/);
 assert.equal(f.calls.some(x=>x.args.includes('push')),false);
 const before=await f.git(f.repo,'rev-parse','HEAD');await integrateWorktree(f.w,f.probe,prepared);
 assert.equal(await f.git(f.repo,'rev-parse','HEAD'),before);assert.equal(f.w.integration.ok,false);
 await new WorktreeCleanup({save:async()=>{},now:()=>Date.now(),touch:()=>{}}).run(f.w);
 assert.equal(f.w.worktreeCleanup.preserveSnapshot,true);assert.equal(f.w.worktreeCleanup.stage,'skipped');
 const normal={...f.target};delete normal.publicIntegration;
 assert.notEqual(pushReviewKey([normal]),pushReviewKey([f.target]));
 assert.notEqual(pushReviewKey([f.target]),pushReviewKey([{...f.target,publicIntegration:{...f.target.publicIntegration,publicBase:f.base}}]));
 assert.equal(pushTargetsSchema.safeParse([{...f.target,snapshot:{developmentCommit:f.dev}}]).success,false);
 assert.equal(managedPushSchema.safeParse({...prepared,targets:[{...prepared.targets[0],snapshot:{developmentCommit:f.dev},snapshotTree:'a'.repeat(40)}]}).success,false);
});
test('public integration rejects ordinary mode, stale identities, dirty checkouts and newer development base',async t=>{
 const f=await fixture(t),check=async target=>(await checkWorktreeBase(f.w,f.probe,[target])).ok;
 const normal={...f.target};delete normal.publicIntegration;assert.equal(await check(normal),false);
 assert.equal(await check({...f.target,publicIntegration:{...f.target.publicIntegration,developmentCommit:f.base}}),false);
 assert.equal(await check({...f.target,publicIntegration:{...f.target.publicIntegration,publicBase:f.dev}}),false);
 assert.equal(await check({...f.target,repository:f.wt}),false);
 for(const cwd of [f.publicWt,f.wt]){await writeFile(path.join(cwd,'dirty'),'dirty');assert.equal(await check(f.target),false);await rm(path.join(cwd,'dirty'));}
 await writeFile(path.join(f.repo,'base-new'),'new');await f.git(f.repo,'add','.');await f.git(f.repo,'commit','-qm','base advanced');assert.equal(await check(f.target),false);
});
test('public integration remote advancement after prepare refuses before write',async t=>{
 const f=await fixture(t),{h}=host(f),engine=new ManagedPushes(h),prepared=await engine.prepareManagedPush(f.w.id);
 const advanced=await f.git(f.repo,'commit-tree',await f.git(f.repo,'rev-parse','HEAD^{tree}'),'-p',f.old,'-m','another publication');
 await f.git(f.remote,'fetch','-q',f.repo,`${advanced}:refs/heads/main`);
 assert.equal((await checkWorktreeBase(f.w,f.probe,[f.target])).ok,false);
 await assert.rejects(engine.executeManagedPush(f.w.id,prepared.id,true),/공개 통합/);
 assert.equal(f.calls.some(x=>x.args.includes('push')),false);
});

test('public integration approval survives runner restart and writes only after explicit approval in bare fixture',async t=>{
 const f=await fixture(t),{h}=host(f),engine=new ManagedPushes(h),prepared=await engine.prepareManagedPush(f.w.id);
 f.runner=new ManagedPushRunner(f.folder,f.driver);
 await engine.executeManagedPush(f.w.id,prepared.id,true);
 const record=await f.runner.read(prepared.id);assert.equal(record.state,'pushed');
 assert.equal(await f.git(f.remote,'rev-parse','refs/heads/main'),f.target.commit);
 assert.equal(await f.git(f.wt,'rev-parse','HEAD'),f.dev);
 await engine.executeManagedPush(f.w.id,prepared.id,true);
 assert.equal(f.calls.filter(x=>x.args.includes('push')).length,1);
});

test('paused exact planner approval request does not require resuming implementation; other inboxes block',async t=>{
 const f=await fixture(t),{h}=host(f),engine=new ManagedPushes(h);
 f.w.status='paused';f.w.plan={id:'planner'};
 const text=status=>`<paseo-workflow>${JSON.stringify({status,summary:'ready',next:'approve',handoff:'fixture',checks:[],pushTargets:[f.target]})}</paseo-workflow>`;
 f.w.inbox={agentId:'planner',failed:null,text:text('continue'),canceled:false,compacted:false,answers:false};
 await assert.rejects(engine.prepareManagedPush(f.w.id),/작업 전달/);
 f.w.inbox.text=text('input');const before=structuredClone(f.w.inbox);
 const prepared=await engine.prepareManagedPush(f.w.id);assert.equal(prepared.state,'prepared');
 assert.deepEqual(f.w.inbox,before);assert.equal(f.calls.some(x=>x.args.includes('push')),false);
 f.w.inbox.agentId='executor';await assert.rejects(engine.prepareManagedPush(f.w.id),/작업 전달/);
 f.w.inbox.agentId='planner';f.w.inbox.failed='failed';await assert.rejects(engine.prepareManagedPush(f.w.id),/작업 전달/);
 f.w.inbox.failed=null;f.w.pushTargets=[{...f.target,commit:f.old}];await assert.rejects(engine.prepareManagedPush(f.w.id),/작업 전달/);
});
