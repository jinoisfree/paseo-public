import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowEngine } from '../server/engine.ts';

// Isolate the real engine from model/network effects. All state changes use engine APIs.
// Every synthetic database is owned by WorkflowEngine. No direct state writes or live agents.
const NEW = 'REPRO: handoff.md를 읽고 새 지시를 구현하세요';
const OLD = 'REPRO: 이전 구현 지시';
const block = (status, next = NEW) => `<paseo-workflow>${JSON.stringify({
  status, summary: status, next, handoff: '격리 재현', checks: [],
})}</paseo-workflow>`;
async function fixture(t, mode, contract = mode === 'general' ? 3 : 2) {
  const dir = await mkdtemp(path.join(tmpdir(), 'resume-2acb3d85-'));
  const file = path.join(dir, 'fixture-db.json');
  const agents = new Map([['A', { id: 'A', workspaceId: 'ws', projectId: 'project', cwd: dir,
    title: 'Isolated resume', status: 'idle', archived: false, permission: false, usage: 0,
    config: { provider: 'codex/planner', thinkingOptionId: 'medium' } }]]);
  const sent = [], histories = new Map();
  let failSend = false, executorBusy = false;
  const port = {
    inspect: async id => agents.get(id) ?? null,
    projectName: async () => 'Fixture', workspaceName: async () => 'Fixture', rename: async () => {},
    quotaAccount: async () => null, quotaAvailable: async () => null,
    history: async id => histories.get(id) ?? { text: '', key: '', messageIds: [], failed: null },
    create: async (w, role, member) => {
      agents.set(member.id, { ...agents.get('A'), id: member.id, config: member.config,
        status: executorBusy && role === 'execute' ? 'running' : 'idle' });
      return 'ws';
    },
    send: async (id, prompt, messageId) => {
      sent.push({ id, prompt, messageId });
      if (failSend) throw Error('injected lost acknowledgement');
      agents.get(id).status = 'running';
    },
  };
  let engine;
  function install() {
    engine = new WorkflowEngine(file, port);

  }
  install();
  await engine.configure({ ...await engine.settings(), askExecutorModel: mode === 'general',
    autoPinStarted: false, autoArchivePushed: false, autoResumeTransient: false,
    autoResumeQuota: false, titleMarker: false, maxCycles: 20, maxTurns: 50 });
  const id = await engine.enroll(agents.get('A'), agents.get('A').config, {}, mode, true, contract);
  if (mode === 'general' && contract === 3) await engine.generalTimeline('A', [], {
    agent: 'Codex', model: 'codex/builder', thinking: 'high',
  });
  const state = async () => JSON.parse(await readFile(file, 'utf8')).workflows[0];
  const finish = async (agentId, status, next = NEW, key = `${status}-${sent.length}`) => {
    const delivery = sent.findLast(row => row.id === agentId);
    const text = block(status, next);
    agents.get(agentId).status = 'idle';
    const h = { text, key, failed: null, messageIds: delivery ? [delivery.messageId] : [] };
    histories.set(agentId, h);
    await engine.ended(agentId, key, text, null, 'fixture goal', false,
      delivery?.prompt ?? '', false, h.messageIds);
  };
  t.after(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, id, agents, sent, histories, state, finish, port,
    get engine() { return engine; },
    failSend: value => { failSend = value; }, executorBusy: value => { executorBusy = value; },
    restart: async () => { await engine.close(); install(); },
    prepare: async (phase, stage = 'sent') => {
      if (phase === 'plan') {
        await finish('A', 'note');
        // General selection can issue its own planner continuation. Cancel that turn
        // through the lifecycle API before testing a fresh button resume.
        const warmup = await state();
        if (warmup.pending) {
          agents.get('A').status = 'idle';
          await engine.ended('A', 'selection-canceled', '', 'interrupted', '', false,
            sent.at(-1).prompt, true, [warmup.pending.id]);
        }
      }
      else {
        await finish('A', 'plan', OLD);
        await engine.control(id, 'pause');
        await finish((await state()).execute.id, 'result');
      }
      await engine.control(id, 'pause');
      if (stage === 'queued') agents.get('A').status = 'running';
      if (stage === 'sending') failSend = true;
      await engine.control(id, 'resume');
      failSend = false;
      const w = await state();
      assert.equal(w.pending.role, 'plan');
      assert.equal(w.pending.stage, stage);
      assert.equal(w.phase, phase);
      return w;
    },
  };
}


for (const mode of ['general', 'federated']) for (const phase of ['plan', 'review']) {
  test(`${mode}/${phase}: exact history restores a partial plan once across duplicate and restart`, async t => {
    const f = await fixture(t, mode);
    const old = (await f.prepare(phase)).pending;
    const key = 'partial'; const text = block('plan');
    f.agents.get('A').status = 'idle';
    f.histories.set('A', {key,text,failed:null,messageIds:[old.id,'steer']});
    const before=f.sent.length;
    await f.engine.ended('A',key,text,null,'',false,'추가 지시',false,['steer']);
    await f.engine.ended('A',key,text,null,'',false,'추가 지시',false,['steer']);
    await f.restart(); await f.engine.tick();
    assert.equal(f.sent.slice(before).filter(x=>x.prompt.endsWith(`이번 지시:\n${NEW}`)).length,1);
    const w=await f.state(); assert.equal(w.planIssue,null);
    await f.finish(w.execute.id,'result');
    assert.equal((await f.state()).phase,'review');
  });
  for (const failure of ['missing','other-key','other-text','failed','unavailable'])
  test(`${mode}/${phase}: ${failure} history preserves the unconfirmed plan without execution`,async t=>{
    const f=await fixture(t,mode);const old=(await f.prepare(phase)).pending;
    const key='unconfirmed';const text=block('plan');f.agents.get('A').status='idle';
    f.histories.set('A',{key:failure==='other-key'?'older':key,text:failure==='other-text'?'older':text,
      failed:failure==='failed'?'failed':null,messageIds:failure==='missing'?[]:[old.id]});
    if(failure==='unavailable') f.port.history=async()=>{throw Error('offline');};
    const before=f.sent.length;
    await f.engine.ended('A',key,text,null,'',false,'추가 지시',false,['steer']);
    let w=await f.state();assert.equal(w.status,'needs_input');assert.equal(w.planIssue.response.text,text);
    assert.equal(w.processed.includes(key),false);assert.equal(f.sent.length,before);
    await f.restart();await f.engine.control(f.id,'resume');
    assert.equal(f.sent.length,before);assert.equal((await f.state()).planIssue.response.key,key);
    f.port.history=async id=>f.histories.get(id);
    f.histories.set('A',{key,text,failed:null,messageIds:[old.id]});
    await f.engine.control(f.id,'resume');
    assert.equal((await f.state()).lastInstruction,NEW);
    assert.equal(f.sent.length,before+1);
  });
  test(`${mode}/${phase}: queued earlier response cannot answer a future delivery`,async t=>{
    const f=await fixture(t,mode);await f.prepare(phase,'queued');const before=f.sent.length;
    f.agents.get('A').status='idle';await f.engine.ended('A','early',block('plan'),null,'',false,'사용자',false,['early']);
    assert.equal(f.sent.length,before+1);assert.equal(f.sent.at(-1).id,'A');
    assert.notEqual((await f.state()).lastInstruction,NEW);
  });
}
for(const mode of ['general','federated']) for(const stage of ['queued','sending','sent'])
test(`${mode}: revised plan while ${stage} is replaced or durably conflicts, then reviewed`,async t=>{
  const f=await fixture(t,mode);f.executorBusy(stage==='queued');f.failSend(stage==='sending');
  await f.finish('A','plan',OLD);f.failSend(false);await f.engine.control(f.id,'pause');
  await f.engine.control(f.id,'resume');const w0=await f.state();const before=f.sent.length;
  f.agents.get('A').status='idle';
  await f.engine.ended('A','new',block('plan'),null,'',false,'수정',false,['new-user']);
  if(stage==='sending') await f.engine.control(f.id,'resume');
  let w=await f.state();assert.equal(f.sent.length,before);
  if(stage==='queued') {
    assert.equal(w.lastInstruction,NEW);f.agents.get(w.execute.id).status='idle';await f.engine.tick();
    assert.equal(f.sent.at(-1).prompt.endsWith(`이번 지시:\n${NEW}`),true);return;
  }
  assert.equal(w.planConflict.next,NEW);assert.equal(w.planConflict.key,'new');
  await f.restart();w=await f.state();assert.equal(w.planConflict.text,block('plan'));
  // A second revision is explicitly rejected; the first pending proposal survives.
  await f.engine.ended('A','newer',block('plan','second revision'),null,'',false,'수정',false,['newer-user']);
  if(stage==='sending') await f.engine.control(f.id,'resume');
  w=await f.state();assert.equal(w.planConflict.next,NEW);assert.equal(w.planConflict.rejected.key,'newer');
  // The existing execution result must reach the original planner before reconfirmation.
  if(stage==='sending') {
    f.histories.set(w.execute.id,{text:'',key:'',failed:null,messageIds:[w0.pending.id]});
    await f.engine.control(f.id,'resume');
  }
  await f.finish(w.execute.id,'result');w=await f.state();
  assert.equal(w.phase,'review');assert.match(f.sent.at(-1).prompt,/적용하지 않은 새 계획/);
  assert.equal(w.planConflict.stage,'review');
  await f.finish('A','plan',NEW,'reconfirm');w=await f.state();
  assert.equal(w.planConflict.stage,'resolved');assert.equal(w.planConflict.confirmedKey,'reconfirm');
  assert.equal(f.sent.at(-1).prompt.endsWith(`이번 지시:\n${NEW}`),true);
});

for(const kind of ['undefined','empty-blank','empty-steer','mismatched','matched','task-prefix'])
test(`message correlation boundary ${kind}`,async t=>{
 const f=await fixture(t,'federated');const old=(await f.prepare('plan')).pending;f.agents.get('A').status='idle';
 const ids=kind==='undefined'?undefined:kind==='matched'?[old.id]:kind==='mismatched'?['unrelated']:[];
 const request=kind==='empty-blank'?'':kind==='task-prefix'?`작업 ID: ${f.id}\n추가 지시`:'사용자 지시';
 const before=f.sent.length;await f.engine.ended('A',kind,block('plan'),null,'',false,request,false,ids);
 const accepts=['undefined','empty-blank','matched','task-prefix'].includes(kind);
 assert.equal(f.sent.length,before+(accepts?1:0));assert.equal(!!(await f.state()).planIssue,!accepts);
});
