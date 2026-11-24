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
 const target={repository:wt,remote:'origin',branch:'main',commit:candidate,snapshot:{developmentCommit:dev}};
 const w={id:'fixture',number:1,cwd:repo,mode:'federated',isolation:'worktree',worktree:{path:wt,branch:'implementation',base,baseBranch:'main',workspaceId:'executor-space'},pushTargets:[target],integration:null,pushEpoch:1,progress:'done',status:'active',pending:null,inbox:null,plan:null,execute:null,reviewer:null,managedPush:null};
 const probe=createRepoProbe(), calls=[];
 const driver=async(cwd,args)=>{
  assert.ok(cwd===repo||cwd===wt); // Never allow an operational repo or external remote in the test driver.
  calls.push({cwd,args});
  try {const p=await exec('git',args,{cwd,env:gitTestEnvironment()}); return {stdout:p.stdout,stderr:p.stderr,exitCode:0};}
  catch(e){return {stdout:e.stdout??'',stderr:e.stderr??'',exitCode:typeof e.code==='number'?e.code:null};}
 };
 const folder=path.join(dir,'records'), runner=new ManagedPushRunner(folder,driver);
 return {dir,repo,wt,remote,git,base,old,dev,candidate,target,w,probe,calls,folder,runner,driver};
}
function host(f) {
 const notices=[], archives=[];
 const h={runner:()=>f.runner,executions:()=>new Map(),checking:()=>new Set(),port:()=>({inspect:async()=>({status:'idle'}),send:async(...a)=>notices.push(a)}),probe:()=>f.probe,stopped:()=>false,serial:fn=>fn(),db:async()=>({workflows:[f.w]}),save:async()=>{},now:()=>Date.now(),touch:(w,d)=>w.detail=d,settings:async()=>({titleMarker:false,autoArchiveWorktree:true}),invalidatePush:()=>{},setPushUnverified:()=>{},renameWorkspaces:async()=>{},queuePushReview:async()=>{},cleanupWorktree:async()=>{},quiet:()=>true,busyWriter:async()=>null};
 return {h,notices,archives};
}

test('AT-PS-01/04/05: separate real Git histories prepare, approve, run once, restore and preserve checkouts/evidence',async t=>{
 const f=await fixture(t); assert.equal((await checkWorktreeBase(f.w,f.probe,[f.target])).ok,true);
 const parsed=parseDecision(`<paseo-workflow>${JSON.stringify({status:'input',summary:'ready',next:'approve',handoff:'fixture',checks:[],pushTargets:[f.target]})}</paseo-workflow>`);
 assert.deepEqual(parsed.pushTargets,[f.target]);
 const {h}=host(f); const engine=new ManagedPushes(h);
 const prepared=await engine.prepareManagedPush(f.w.id); assert.equal(prepared.targets[0].snapshotTree,await f.git(f.wt,'rev-parse','HEAD^{tree}'));
 assert.deepEqual(prepared.targets[0].snapshot,f.target.snapshot); assert.equal(f.calls.filter(x=>x.args.includes('push')).length,0);
 await assert.rejects(engine.executeManagedPush(f.w.id,prepared.id,false),/승인/);
 // Durable prepared record, new runner after process restart; no operational plugin registration.
 f.runner=new ManagedPushRunner(f.folder,f.driver);
 await engine.executeManagedPush(f.w.id,prepared.id,true);
 const done=await f.runner.read(prepared.id); assert.equal(done.state,'pushed');
 await engine.executeManagedPush(f.w.id,prepared.id,true);
 assert.equal(f.calls.filter(x=>x.args.includes('push')).length,1);
 await engine.managedCompleted(f.w,done); assert.deepEqual(f.w.pushTargets[0].snapshot,f.target.snapshot);
 assert.equal(f.w.integration.ok,false); assert.match(f.w.integration.detail,/보존/);
 assert.equal(await f.git(f.repo,'rev-parse','HEAD'),f.base); assert.equal(await f.git(f.wt,'rev-parse','HEAD'),f.dev);
 await mkdir(path.join(f.wt,'evidence')); await writeFile(path.join(f.wt,'evidence','observation'),'keep');
 f.w.worktreeCleanup={stage:'done'}; // Old cleanup metadata must never override snapshot retention.
 const cleanHost={...h,stateFolder:()=>f.dir,lifecycle:()=>{throw Error('archive must not run');}};
 await new WorktreeCleanup(cleanHost).run(f.w); assert.equal(f.w.worktreeCleanup.stage,'skipped');
 assert.equal(f.w.worktreeCleanup.preserveSnapshot,true);
 const retained=structuredClone(f.w);retained.pushTargets=[];retained.managedPush=null;
 assert.match(archiveBlockReason(retained),/보존/);
 assert.match(archiveBlockReason(f.w),/보존/); assert.equal(await readFile(path.join(f.wt,'evidence','observation'),'utf8'),'keep');
 await rm(path.join(f.wt,'evidence'),{recursive:true});
 f.runner=new ManagedPushRunner(f.folder,f.driver);
 f.w.managedPush=managedPushSchema.parse(JSON.parse(JSON.stringify(done)));
 const again=await f.runner.recheck(prepared.id); assert.equal(again.state,'pushed');
 assert.equal((await checkWorktreeBase(f.w,f.probe,[f.target])).ok,true);
 const replay=await engine.prepareManagedPush(f.w.id); assert.equal(replay.id,prepared.id);
 assert.equal(f.calls.filter(x=>x.args.includes('push')).length,1);
 const already=await f.runner.prepare('new-fixture-request',2,[f.target]);
 const settled=await f.runner.execute(already.id); assert.equal(settled.state,'pushed');
 assert.equal(settled.targets[0].alreadyIncluded,true); assert.equal(settled.targets[0].exitCode,null);
 assert.equal(f.calls.filter(x=>x.args.includes('push')).length,1);
});

test('AT-PS-02: reject modified tree, foreign repo, stale HEAD/main, wrong/multiple parents and unreadable or empty remote',async t=>{
 const f=await fixture(t),check=async target=>(await checkWorktreeBase(f.w,f.probe,[target])).ok;
 assert.equal(await check(f.target),true);
 await writeFile(path.join(f.wt,'file'),'uncommitted mutation');assert.equal(await check(f.target),false);await writeFile(path.join(f.wt,'file'),'improved\n');
 for(const key of ['commitInfo','branchTips','identity'])assert.equal((await checkWorktreeBase(f.w,{...f.probe,[key]:async()=>null},[f.target])).ok,false);
 const wrongTree=await f.git(f.wt,'commit-tree',await f.git(f.repo,'rev-parse','HEAD^{tree}'),'-p',f.old,'-m','wrong tree');
 assert.equal(await check({...f.target,commit:wrongTree}),false);
 await f.git(f.wt,'replace',wrongTree,f.candidate);
 assert.equal(await check({...f.target,commit:wrongTree}),false);
 await f.git(f.wt,'replace','-d',wrongTree);
 assert.equal(await check({...f.target,repository:f.repo}),false);
 assert.equal(await check({...f.target,snapshot:{developmentCommit:f.base}}),false);
 const foreign=path.join(f.dir,'foreign'); await f.git(f.dir,'init','-q','-b','main',foreign);await f.git(foreign,'commit','-q','--allow-empty','-m','foreign');
 assert.equal(await check({...f.target,snapshot:{developmentCommit:await f.git(foreign,'rev-parse','HEAD')}}),false);
 assert.equal(await check({...f.target,repository:foreign}),false);
 const none=await f.git(f.wt,'commit-tree',await f.git(f.wt,'rev-parse','HEAD^{tree}'),'-m','no parent');
 const wrong=await f.git(f.wt,'commit-tree',await f.git(f.wt,'rev-parse','HEAD^{tree}'),'-p',f.base,'-m','wrong parent');
 const many=await f.git(f.wt,'commit-tree',await f.git(f.wt,'rev-parse','HEAD^{tree}'),'-p',f.old,'-p',f.base,'-m','many');
 for(const commit of [none,wrong,many])assert.equal(await check({...f.target,commit}),false);
 for(const remoteTip of [async()=>null,async()=>'',async()=>f.dev])assert.equal((await checkWorktreeBase(f.w,{...f.probe,remoteTip},[f.target])).ok,false);
 await writeFile(path.join(f.repo,'file'),'advanced main');await f.git(f.repo,'add','file');await f.git(f.repo,'commit','-qm','advance main');
 assert.equal(await check(f.target),false);
});

test('AT-PS-03: approval key binds mode/development/public/destination; stale target cannot execute and incomplete receipts fail closed',async t=>{
 const f=await fixture(t);const {h}=host(f);const engine=new ManagedPushes(h);
 const key=pushReviewKey([f.target]); const normal={...f.target};delete normal.snapshot;
 for(const target of [normal,{...f.target,commit:f.old},{...f.target,remote:'other'},{...f.target,snapshot:{developmentCommit:f.base}}])assert.notEqual(pushReviewKey([target]),key);
 assert.equal(pushTargetsSchema.safeParse([{...f.target,snapshot:{}}]).success,false);
 const prepared=await engine.prepareManagedPush(f.w.id);
 assert.equal(managedPushSchema.safeParse({...prepared,targets:[{...prepared.targets[0],snapshotTree:undefined}]}).success,false);
 assert.equal((await checkWorktreeBase(f.w,f.probe,[normal])).ok,false);
 for(const changed of [normal,{...f.target,commit:f.old},{...f.target,remote:'other'},{...f.target,snapshot:{developmentCommit:f.base}}]) {
  f.w.pushTargets=[changed];await assert.rejects(engine.executeManagedPush(f.w.id,prepared.id,true),/대상/);
 }
 const recordPath=path.join(f.folder,prepared.id,'record.json');
 await writeFile(recordPath,JSON.stringify({...prepared,targets:[{...prepared.targets[0],snapshotTree:undefined}]}));
 await assert.rejects(f.runner.read(prepared.id),/기록/);
 await writeFile(recordPath,JSON.stringify(prepared));
 assert.equal(f.calls.filter(x=>x.args.includes('push')).length,0);
 f.w.pushTargets=[f.target]; await writeFile(path.join(f.wt,'file'),'changed');await f.git(f.wt,'add','file');await f.git(f.wt,'commit','-qm','new dev');
 await assert.rejects(engine.executeManagedPush(f.w.id,prepared.id,true),/스냅샷/);
 assert.equal(f.calls.filter(x=>x.args.includes('push')).length,0);
});

test('AT-PS-03: runner revalidates snapshot after prepare; remote advancement refuses write without generic fallback',async t=>{
 const f=await fixture(t);const prepared=await f.runner.prepare('fixture',0,[f.target]);
 const advanced=await f.git(f.wt,'commit-tree',await f.git(f.wt,'rev-parse','HEAD^{tree}'),'-p',f.old,'-m','different public');
 await f.git(f.remote,'fetch','-q',f.repo,`${advanced}:refs/heads/main`);
 const result=await f.runner.execute(prepared.id); assert.notEqual(result.state,'pushed');
 assert.equal(f.calls.filter(x=>x.args.includes('push')).length,0);
});
