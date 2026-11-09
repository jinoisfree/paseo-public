import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowEngine } from '../server/engine.ts';
export const block=(status='plan',extra={})=>`<paseo-workflow>${JSON.stringify({status,summary:status,next:'작업 ID: fixture\n구현 지시',handoff:'handoff.md',checks:[],...extra})}</paseo-workflow>`;
export const choice={provider:'codex',model:'builder',thinking:'high'};
export const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
export async function fixture(t,{mode='federated',contract=6,probe=null,deferEnrollment=false}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'brainstorm-gate-')),file=path.join(dir,'fixture.json');
 const config={provider:'claude/planner',thinkingOptionId:'medium',modeId:'bypassPermissions'};
 const agents=new Map([['A',{id:'A',workspaceId:'ws',projectId:'project',cwd:dir,title:'Task',status:'idle',archived:false,permission:false,usage:0,config}]]);
 const sent=[],created=[],pickers=[],modeCards=[],notices=[],writes=[],histories=new Map();
 let availability={available:true,reason:null};
 const port={inspect:async id=>agents.get(id)??null,history:async id=>histories.get(id)??{text:'',key:'',failed:null,messageIds:[]},
  models:async()=>[{id:'builder',label:'Builder',thinkingOptions:[{id:'high',label:'High'}]}],
  projectName:async()=> 'Project',workspaceName:async()=> 'Task',rename:async()=>{},quotaAccount:async()=>null,quotaAvailable:async()=>null,
  federationAvailability:async()=>availability,
  create:async(w,role,m)=>{created.push(structuredClone({w,role,m}));agents.set(m.id,{...agents.get('A'),id:m.id,config:m.config});return 'ws';},
  executorPicker:async(...args)=>pickers.push(args),ensurePickerCard:async(...args)=>{pickers.push(args);return true;},
  modePicker:async(...args)=>modeCards.push(args),
  send:async(id,prompt,messageId)=>{sent.push({id,prompt,messageId});agents.get(id).status='running';histories.set(id,{text:'',key:'',failed:null,messageIds:[messageId]});}};
 let engine;
 function open(Engine=WorkflowEngine){engine=new Engine(file,port,async e=>notices.push(e),probe);const write=engine.store.write.bind(engine.store);engine.store.write=async db=>{writes.push(structuredClone(db));return write(db);};}
 open();
 await engine.configure({...await engine.settings(),autoPinStarted:false,autoArchivePushed:false,titleMarker:false,autoResumeQuota:false,autoResumeTransient:false});
 const enroll=(firstPrompt='')=>engine.enroll(agents.get('A'),config,{},mode,true,contract,firstPrompt);
 const id=deferEnrollment?null:await enroll();let seq=0;
 const state=async()=>JSON.parse(await readFile(file,'utf8')).workflows[0];
 const live=async()=> (await engine.db()).workflows[0];
 const settle=async()=>{await flush();await Promise.all(engine.pickerInFlight?.values()??[]);await flush();};
 const say=async(request='',status='note',extra={})=>{const text=block(status,extra),key=`turn-${++seq}`;agents.get('A').status='idle';histories.set('A',{text,key,failed:null,messageIds:[]});await engine.ended('A',key,text,null,request||'goal',false,request);await settle();return state();};
 const question=async(label,title='진행 방식을 선택하세요')=>{const q=`q-${++seq}`;await engine.permission('A',{id:q,kind:'question',input:{questions:[{question:title,header:'방식',options:[{label:'브레인스토밍'},{label:'일반개발'},{label:'연합개발'}]}]}});await engine.permissionResolved('A',q,{behavior:'allow',updatedInput:{answers:{방식:label}}});await settle();return state();};
 const restart=async(snapshot,Engine=WorkflowEngine)=>{await flush();await engine.close();if(snapshot)await writeFile(file,JSON.stringify(snapshot));open(Engine);await engine.list();return engine;};
 t.after(async()=>{await flush();await engine.close();await rm(dir,{recursive:true,force:true});});
 return {dir,file,id,enroll,config,port,agents,sent,created,pickers,modeCards,notices,writes,histories,state,live,say,question,restart,flush,
  settle,get engine(){return engine;},setAvailability:v=>{availability=v;}};
}
