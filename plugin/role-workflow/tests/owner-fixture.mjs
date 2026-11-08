import path from 'node:path';
import { writeFileSync } from 'node:fs';

/** Policy and old notification configuration must be isolated as well as state.json. */
export function isolateOwnerHome(t, directory) {
  const keys=['PASEO_HOME','PASEO_PUBLIC_CONFIG'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.PASEO_HOME=path.join(directory,'paseo-home');
  process.env.PASEO_PUBLIC_CONFIG=path.join(directory,'public.config.json');
  writeFileSync(process.env.PASEO_PUBLIC_CONFIG,JSON.stringify({phoneNotifications:false}));
  t.after(()=>{for(const [key,value] of Object.entries(previous)) value===undefined?delete process.env[key]:process.env[key]=value;});
}
/** C5/C6: a real status read and its revision are required before every configuration RPC. */
export async function configureFixture(rpcs, context, settings) {
  context.paseo.providers ??= {};
  context.paseo.providers.listAvailable ??= async()=>({providers:[{provider:'claude',available:true},{provider:'codex',available:true}]});
  context.paseo.providers.listModels ??= async()=>({models:[{id:'fixture'}]});
  const status=await rpcs.get('workflow.status')({},context);
  if(status.error) throw new Error(status.error);
  return rpcs.get('workflow.configure')({settings,expectedRevision:status.settingsRevision},context);
}
