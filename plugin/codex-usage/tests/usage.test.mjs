import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import contribute from '../index.server.ts';
import {discover,fetchUsage} from '../server/usage.ts';
test('usage contribution and provider CODEX_HOME routing read only the selected credential',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'usage-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const auth=join(dir,'selected');await mkdir(auth);await writeFile(join(auth,'auth.json'),JSON.stringify({tokens:{access_token:'fixture-token',account_id:'fixture-id'}}));
 await writeFile(join(dir,'config.json'),JSON.stringify({agents:{providers:{codex:{env:{CODEX_HOME:auth}}}}}));
 let source;contribute({registerUsageSource:value=>{source=value;}});assert.equal(source.id,'codex-paseo');
 const accounts=await discover({kind:'global'},{home:dir,env:{PASEO_HOME:dir}});assert.equal(accounts.length,1);assert.equal(accounts[0].input.route.path,join(auth,'auth.json'));
 let request;const report=await fetchUsage(accounts[0].input,async(url,options)=>{request={url,options};return {ok:true,status:200,text:async()=>JSON.stringify({rate_limit:{primary_window:{used_percent:30,limit_window_seconds:18000}}})};});
 assert.ok(request.options.headers.Authorization.endsWith('fixture-token'));assert.equal(report.status,'available');assert.ok(report.windows.length);
 assert.ok(!JSON.stringify(report).includes('fixture-token'));
 assert.deepEqual(await discover({kind:'session',provider:'claude',env:{}},{home:dir,env:{PASEO_HOME:dir}}),[]);
});
