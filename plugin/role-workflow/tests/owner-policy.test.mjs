import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OwnerPolicyStore } from '../server/owner-policy.ts';
import { ownerPolicySchema } from '../shared/owner-policy.ts';
import { settingsSchema, configure } from '../shared/contracts.ts';
import { WorkflowEngine } from '../server/engine.ts';
import { createNotifier } from '../server/notify.ts';
import { quotaAccount } from '../server/paseo-port.ts';
import { federationAvailability } from '../server/federation.ts';
import { paseoHome, ownerPolicyPath, legacyPublicConfigs } from '../server/paths.ts';
import { recommendedSettings } from '../shared/recommended.ts';

async function fixture(t) {
 const dir=await mkdtemp(path.join(tmpdir(),'owner-policy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'owner/policy.json');const old=path.join(dir,'public.json');
 await writeFile(old,JSON.stringify({phoneNotifications:true,phoneNotificationEndpoint:'https://example.invalid/push'}));
 return {dir,file,old,store:new OwnerPolicyStore(file,[old])};
}
test('C1 PASEO_HOME and PASEO_PUBLIC_CONFIG determine owner and legacy paths',()=>{
 const prior=process.env.PASEO_HOME,old=process.env.PASEO_PUBLIC_CONFIG;
 try {
  process.env.PASEO_HOME='/fixture/custom';process.env.PASEO_PUBLIC_CONFIG='/fixture/public.json';
  assert.equal(paseoHome(),'/fixture/custom');assert.equal(ownerPolicyPath(),'/fixture/custom/owner/policy.json');
  assert.equal(legacyPublicConfigs()[0],'/fixture/public.json');
 } finally {for(const [key,value] of [['PASEO_HOME',prior],['PASEO_PUBLIC_CONFIG',old]]) value===undefined?delete process.env[key]:process.env[key]=value;}
});
test('C2-C5 migrate once, save differences, retain owner decisions and atomically reject stale revisions',async t=>{
 const f=await fixture(t),legacy={...recommendedSettings,archiveAfterDays:7};const legacyBytes=await readFile(f.old,'utf8');
 const first=await f.store.load({settings:legacy,source:path.join(f.dir,'state.json')});
 assert.equal(first.error,null);assert.equal(first.policy.revision,1);assert.deepEqual(first.policy.roleWorkflow,{archiveAfterDays:7});
 assert.equal(first.policy.notifications.phoneNotifications,true);assert.match(first.policy.migratedFrom.stateSettingsSha256,/^[a-f0-9]{64}$/);
 const bytes=await readFile(f.file,'utf8');await f.store.load({settings:{...legacy,archiveAfterDays:12},source:'changed'});
 assert.equal(await readFile(f.file,'utf8'),bytes);assert.equal(await readFile(f.old,'utf8'),legacyBytes);
 const result=await f.store.save({...recommendedSettings,maxTurns:77},1);
 assert.equal(result.revision,2);let policy=JSON.parse(await readFile(f.file,'utf8'));
 assert.deepEqual(policy.roleWorkflow,{maxTurns:77});assert.deepEqual(policy.notifications,first.policy.notifications);
 assert.equal((await stat(f.file)).mode&0o777,0o600);assert.deepEqual(await readdir(path.dirname(f.file)),['policy.json']);
 const other=new OwnerPolicyStore(f.file);
 const results=await Promise.allSettled([f.store.save({...recommendedSettings,maxTurns:66},2),other.save({...recommendedSettings,maxTurns:88},2)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.match(results.find(x=>x.status==='rejected').reason.message,/revision 충돌/);
 policy=JSON.parse(await readFile(f.file,'utf8'));assert.equal(policy.revision,3);assert.deepEqual(policy.migratedFrom,first.policy.migratedFrom);
 assert.equal(ownerPolicySchema.safeParse(policy).success,true);
});
test('C2 invalid JSON, schema and setting values remain byte-for-byte unchanged and refuse saves',async t=>{
 const f=await fixture(t);await f.store.load({settings:recommendedSettings,source:'state'});const valid=JSON.parse(await readFile(f.file,'utf8'));
 for(const text of ['{broken',JSON.stringify({...valid,revision:-1}),JSON.stringify({...valid,roleWorkflow:{maxTurns:0}}),JSON.stringify({...valid,roleWorkflow:{unexpected:true}})]){
  await writeFile(f.file,text);const result=await f.store.load({settings:recommendedSettings,source:'state'});
  assert.equal(result.policy,null);assert.match(result.error,new RegExp('policy.json'));assert.deepEqual(result.settings,recommendedSettings);
  await assert.rejects(f.store.save(recommendedSettings,0),/지시서/);assert.equal(await readFile(f.file,'utf8'),text);
 }
});
test('C4 state settings freeze across configuration, state saves and restart; changed legacy values cannot overwrite policy',async t=>{
 const f=await fixture(t);const stateFile=path.join(f.dir,'state.json');
 await writeFile(stateFile,JSON.stringify({version:1,settings:{...recommendedSettings,maxTurns:71,obsolete:'preserve raw'},workflows:[]}));
 let engine=new WorkflowEngine(stateFile,{});t.after(()=>engine.close());
 assert.equal((await engine.settings()).maxTurns,71);await engine.configure({...await engine.settings(),maxTurns:91});
 await engine.forgetProject('/fixture');await engine.close();let state=JSON.parse(await readFile(stateFile,'utf8'));
 assert.equal(state.settings.maxTurns,71);assert.equal(state.settings.obsolete,'preserve raw');
 state.settings.maxTurns=11;await writeFile(stateFile,JSON.stringify(state));
 engine=new WorkflowEngine(stateFile,{});assert.equal((await engine.settings()).maxTurns,91);
 const policy=JSON.parse(await readFile(engine.policy.file,'utf8'));assert.deepEqual(policy.roleWorkflow,{maxTurns:91});
});
test('C6 configure RPC rejects empty settings, partial settings and missing revision',()=>{
 assert.equal(configure.input.safeParse({settings:{},expectedRevision:0}).success,false);
 assert.equal(configure.input.safeParse({settings:recommendedSettings}).success,false);
 assert.equal(configure.input.safeParse({settings:recommendedSettings,expectedRevision:0}).success,true);
});
test('C7 notification owner preferences win over explicit legacy config; explicit file wins over old fallback',async t=>{
 const f=await fixture(t);const migrated=await f.store.load({settings:recommendedSettings,source:'state'});
 await writeFile(path.join(f.dir,'push-tokens.json'),JSON.stringify({subscriptions:[{token:'fixture',expiresAt:'2030-01-01'}]}));
 const sent=[];const notifier=createNotifier({home:f.dir,configPath:f.old,log:()=>{},fetch:async (url)=>{sent.push(url);return new Response(JSON.stringify({data:[{status:'ok'}]}));}});
 let policy=migrated.policy;policy.notifications={phoneNotifications:false};await writeFile(f.file,JSON.stringify(policy));
 assert.equal(await notifier.activeCount(),0);
 policy.notifications={phoneNotifications:true,phoneNotificationEndpoint:'https://owner.example.invalid/push'};await writeFile(f.file,JSON.stringify(policy));
 await notifier.send({kind:'completed',title:'fixture',body:'fixture',agentId:'fixture',workspaceId:'fixture'});
 assert.deepEqual(sent,['https://owner.example.invalid/push']);
 await rm(f.file);await writeFile(f.old,JSON.stringify({phoneNotifications:false,phoneNotificationEndpoint:'https://example.invalid/push'}));
 assert.equal(await notifier.activeCount(),0);
});
test('C8 quota account uses provider env CODEX_HOME and retains the default when absent',async t=>{
 const f=await fixture(t);const custom=path.join(f.dir,'custom-codex'),fallback=path.join(f.dir,'codex-home');
 const {symlink}=await import('node:fs/promises');await mkdir(custom);await mkdir(fallback);
 const auth=path.join(f.dir,'account-auth.json');await writeFile(auth,'{}');await symlink(auth,path.join(custom,'auth.json'));await symlink(auth,path.join(fallback,'auth.json'));
 await writeFile(path.join(f.dir,'config.json'),JSON.stringify({agents:{providers:{codex:{env:{CODEX_HOME:custom}}}}}));
 assert.equal(await quotaAccount('codex',f.dir),await realpath(auth));await rm(path.join(fallback,'auth.json'));
 await writeFile(path.join(f.dir,'config.json'),'{}');assert.equal(await quotaAccount('codex',f.dir),null);
 await symlink(auth,path.join(fallback,'auth.json'));assert.equal(await quotaAccount('codex',f.dir),await realpath(auth));
});
test('C9 requires enabled core provider, actual availability and a selectable model; either product suffices',async t=>{
 const f=await fixture(t);let models=[],enabled=true,available=true;
 const api={providers:{listAvailable:async()=>({providers:[{provider:'codex',available}]}),listModels:async()=>({models})}};
 const file=path.join(f.dir,'config.json');await writeFile(file,'{}');
 assert.equal((await federationAvailability(api,'/fixture',f.dir)).available,false);
 models=[{id:'fixture',isSelectable:false}];assert.equal((await federationAvailability(api,'/fixture',f.dir)).available,false);
 models=[{id:'fixture'}];assert.equal((await federationAvailability(api,'/fixture',f.dir)).available,true);
 await writeFile(file,JSON.stringify({agents:{providers:{codex:{enabled:false}}}}));assert.equal((await federationAvailability(api,'/fixture',f.dir)).available,false);
 await writeFile(file,'{}');available=false;assert.equal((await federationAvailability(api,'/fixture',f.dir)).available,false);
});
test('C9 server rejects mode card and enrollment with zero products without changing contract',async t=>{
 const f=await fixture(t);const blocked={available:false,reason:'실행 가능한 제품이 없습니다.'};
 const port={federationAvailability:async()=>blocked,projectName:async()=>'',inspect:async()=>null,rename:async()=>{}};
 const engine=new WorkflowEngine(path.join(f.dir,'state.json'),port);t.after(()=>engine.close());
 const id=await engine.enroll({id:'plan',workspaceId:'ws',projectId:'project',cwd:f.dir,title:'fixture',status:'idle',archived:false,permission:false,usage:0},{provider:'codex'}, {},'federated',false,5);
 assert.equal((await engine.list()).workflows[0].mode,'undecided');const result=await engine.selectMode(id,'federated');assert.equal(result.ok,false);assert.match(result.detail,/제품/);
 assert.equal((await engine.list()).workflows[0].contract,5);
});

test('generated policy workflow JSON Schema matches the canonical settings constraints',async()=>{
 const {z}=await import('zod');const {settingsValuesSchema}=await import('../shared/settings-schema.ts');
 const raw=JSON.parse(await readFile(new URL('../shared/presets/schemas/policy.schema.json',import.meta.url),'utf8'));
 const {$schema,...expected}=z.toJSONSchema(settingsValuesSchema.partial().strict());
 assert.deepEqual(raw.properties.roleWorkflow,expected,'run tsx scripts/sync-policy-schema.mts');
});

test('C6 status failure returns no settings and blocks saves until a successful fresh read',async t=>{
 const f=await fixture(t);const {isolateOwnerHome}=await import('./owner-fixture.mjs');isolateOwnerHome(t,f.dir);
 const previous=process.env.PASEO_ROLE_WORKFLOW_STATE_DIR;process.env.PASEO_ROLE_WORKFLOW_STATE_DIR=f.dir;
 t.after(()=>previous===undefined?delete process.env.PASEO_ROLE_WORKFLOW_STATE_DIR:process.env.PASEO_ROLE_WORKFLOW_STATE_DIR=previous);
 const {default:contribute}=await import('../index.server.ts');const handlers=new Map();
 const close=contribute({addHook:()=>()=>{},handle:(contract,handler)=>handlers.set(contract.name,handler)});t.after(close);
 const context={paseo:{}};t.mock.method(console,'error',()=>{});
 await assert.rejects(handlers.get('workflow.configure')({settings:recommendedSettings,expectedRevision:1},context),/상태 조회/);
 const stateFile=path.join(f.dir,'state.json');await writeFile(stateFile,'{invalid');
 const bad=await handlers.get('workflow.status')({},context);assert.equal(bad.settings,null);assert.ok(bad.error);
 await writeFile(stateFile,JSON.stringify({version:1,settings:recommendedSettings,workflows:[]}));
 await assert.rejects(handlers.get('workflow.configure')({settings:recommendedSettings,expectedRevision:1},context),/상태 조회/);
 const good=await handlers.get('workflow.status')({},context);assert.equal(good.error,null);
 const saved=await handlers.get('workflow.configure')({settings:{...good.settings,maxTurns:87},expectedRevision:good.settingsRevision},context);
 assert.equal(saved.settings.maxTurns,87);
 const ownerFile=path.join(process.env.PASEO_HOME,'owner/policy.json');const before=await readFile(ownerFile,'utf8');
 await assert.rejects(handlers.get('workflow.configure')({settings:{},expectedRevision:saved.revision},context));
 assert.equal(await readFile(ownerFile,'utf8'),before);
});
test('C7 environment config falls back to the old account config only when unavailable',async t=>{
 const f=await fixture(t);const previous={HOME:process.env.HOME,PASEO_PUBLIC_CONFIG:process.env.PASEO_PUBLIC_CONFIG};
 try {
  process.env.HOME=path.join(f.dir,'account');process.env.PASEO_PUBLIC_CONFIG=f.old;
  const oldPath=path.join(process.env.HOME,'.config/paseo-public/config.json');await mkdir(path.dirname(oldPath),{recursive:true});
  await writeFile(oldPath,JSON.stringify({phoneNotifications:true,phoneNotificationEndpoint:'https://old.example.invalid/push'}));
  await writeFile(path.join(f.dir,'push-tokens.json'),JSON.stringify({subscriptions:[{token:'fixture',expiresAt:'2030-01-01'}]}));
  const sent=[];const notifier=createNotifier({home:f.dir,log:()=>{},fetch:async url=>{sent.push(url);return new Response(JSON.stringify({data:[{status:'ok'}]}));}});
  const event={kind:'completed',title:'fixture',body:'fixture',agentId:'fixture',workspaceId:'fixture'};
  await notifier.send(event);await rm(f.old);await notifier.send(event);
  assert.deepEqual(sent,['https://example.invalid/push','https://old.example.invalid/push']);
 }finally {for(const [key,value] of Object.entries(previous)) value===undefined?delete process.env[key]:process.env[key]=value;}
});

test('V6 catalog errors allow federation with a warning; confirmed zero alone blocks',async t=>{
 const f=await fixture(t);
 const providers={listAvailable:async()=>({error:'fixture',providers:[]}),listModels:async()=>({models:[]})};
 for (const failure of ['catalog-error','catalog-throw','models-error','models-throw']) {
  providers.listAvailable=async()=> failure==='catalog-throw' ? Promise.reject(new Error('fixture')) : {error:failure==='catalog-error'?'fixture':null,providers:[{provider:'codex',available:true}]};
  providers.listModels=async()=> failure==='models-throw' ? Promise.reject(new Error('fixture')) : {error:'fixture',models:[]};
  const result=await federationAvailability({providers},'',f.dir);
  assert.equal(result.available,true);assert.match(result.reason,/경고/);
 }
});
test('V8 policy cache reuses validation and invalidates on external atomic replacement',async t=>{
 const f=await fixture(t);const store=new OwnerPolicyStore(f.file);
 const initial=await store.load({settings:recommendedSettings,source:'fixture'});
 const {mock}=await import('node:test');
 const {ownerPolicySchema}=await import('../shared/owner-policy.ts');
 const spy=mock.method(ownerPolicySchema,'parse');t.after(()=>spy.mock.restore());
 await store.load();const count=spy.mock.callCount();await store.load();assert.equal(spy.mock.callCount(),count);
 const {rename,utimes}=await import('node:fs/promises');
 const before=await stat(f.file);const external={...initial.policy,revision:9};
 const temporary=f.file+'.external';await writeFile(temporary,JSON.stringify(external,null,2)+'\n');await utimes(temporary,before.atime,before.mtime);await rename(temporary,f.file);
 assert.equal((await store.load()).policy.revision,9);assert.ok(spy.mock.callCount()>count);
});
