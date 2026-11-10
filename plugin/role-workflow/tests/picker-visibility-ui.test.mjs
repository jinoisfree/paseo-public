import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const H = 'a'.repeat(64);
const LIMIT = '검증 한도 처리(미통과로 승인 또는 검토 1회 더)';
const FINAL = '계획 검증 확정(검증 선택·시작 또는 검증 끄기 확정)';
const OLD = '계획 검증 선택·판정·기록이 끝날 때까지 구현 승인은 비활성입니다.';
const ACCENT = 'rgb(51, 102, 255)';

// Observes the real picker card in a browser: step boxes, per-button reasons, selection and button emphasis.
// The executor selection is complete from the start so each case isolates the verification and placement steps.
test('picker card shows numbered steps, why each button is off, and filled selections', { timeout: 120000 }, async t => {
  const bundle = await build({ stdin: { contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ExecutorPicker} from './client/executor-picker';
const q=new URLSearchParams(location.search);
window.calls=[];window.w={id:'task',contract:7,mode:'federated',status:'needs_input',executeAgentId:null,firstPlan:true,heldPlan:true,heldApproval:{id:1,summary:'계획',handoff:'handoff.md',decisionHash:'${H}'},selection:{provider:'codex',model:'builder',thinking:'high'},reviewSelection:{enabled:null},planReview:{stage:'waiting_choice',round:0,maxRounds:2,path:'docs/changes/test/plan-review.md',verdict:null,outcome:null}};
window.options=async()=>({providers:[{provider:'claude',mode:'plan',reason:null,models:[{id:'other',label:'Other reviewer',reason:null,thinkingOptions:[{id:'high',label:'Review high',isDefault:true}]}]}]});
window.models=async()=>({models:[{id:'builder',label:'Builder',thinkingOptions:[{id:'high',label:'High'}]}],error:null});
if(q.has('early'))Object.assign(window.w,{heldApproval:null,heldPlan:false});
if(q.has('c5'))Object.assign(window.w,{contract:5,firstPlan:false,heldApproval:null,heldPlan:false,reviewSelection:undefined,planReview:undefined});
if(q.has('limit'))Object.assign(window.w,{reviewSelection:{enabled:true},planReview:{...window.w.planReview,stage:'limit',round:2,verdict:{verdict:'BLOCKED',findings:[]}}});
window.choose=async input=>{window.calls.push(input);return {ok:true,detail:'구현 승인'};};
window.review=async input=>{window.calls.push(input);window.w={...window.w,reviewSelection:{...input},planReview:{...window.w.planReview,stage:input.enabled?'reviewing':'off',round:input.enabled?1:0}};return {ok:true,detail:'확인'};};
window.cancel=async()=>({ok:true,detail:'취소'});
const theme=q.has('plain')?{colors:{foreground:'#ddd',foregroundMuted:'#aaa',border:'#555'}}:{colors:{surface0:'#111',surface1:'#181818',surface2:'#222',border:'#555',foreground:'#eee',foregroundMuted:'#aaa',accent:'#3366ff',accentForeground:'#ffffff',statusSuccess:'#22aa55',statusWarning:'#e0a020',statusDanger:'#d33'}};
function App(){const[w,setW]=useState(window.w);window.update=()=>setW({...window.w});document.body.style.background=theme.colors.surface0??'#fff';return <ExecutorPicker workflow={w} theme={theme} onChanged={window.update} placementDefault="ask"/>;}
createRoot(document.getElementById('root')).render(<App/>);
`, resolveDir: path.resolve(import.meta.dirname, '..'), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { 'react-native': 'react-native-web' },
    plugins: [{ name: 'sdk', setup(b) { b.onResolve({ filter: /^@getpaseo\/plugin(?:\/client)?$/ }, a => ({ path: a.path, namespace: 'sdk' }));
      b.onLoad({ filter: /.*/, namespace: 'sdk' }, a => ({ contents: a.path.endsWith('/client') ? "export const useRpc=c=>c.name==='workflow.models'?window.models:c.name==='workflow.review-options'?window.options:c.name==='workflow.select-plan-review'?window.review:c.name==='workflow.cancel-implementation-reservation'?window.cancel:window.choose;" : "export const defineRpc=x=>x;" })); } }] });
  const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/bundle.js' ? 'application/javascript' : 'text/html'); res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const shots = process.env.PICKER_SHOTS_DIR; if (shots) mkdirSync(shots, { recursive: true });
  const bg = locator => locator.evaluate(el => getComputedStyle(el).backgroundColor);
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }), errors = []; page.on('pageerror', e => errors.push(e.message));
    const open = async query => { await page.goto(`http://127.0.0.1:${server.address().port}?${query}`); await page.getByRole('button', { name: '✓ High', exact: true }).waitFor(); };
    const primary = page.getByRole('button', { name: /^이 담당으로 확정$|^이 설정으로 자동 진행$/ }).first();
    const primaryHint = page.getByTestId('primary-blockers'), automaticHint = page.getByTestId('automatic-blockers');
    const review = page.getByTestId('plan-review-picker');

    // a) early draft with nothing chosen: steps are numbered, the missing choices are listed, and finishing them clears the hint.
    await open('early=1');
    for (const title of ['1. 계획 검증', '2. 구현 담당', '3. 겹칠 때 배치']) await page.getByText(title, { exact: true }).waitFor();
    await page.getByTestId('executor-zone').getByText('선택 완료', { exact: true }).waitFor();
    await review.getByText('선택 필요', { exact: true }).waitFor();
    await page.getByTestId('placement-zone').getByText('선택 필요', { exact: true }).waitFor();
    assert.equal(await primary.isDisabled(), true);
    assert.equal(await primaryHint.innerText(), '남은 선택: 계획 검증 켜기/끄기, 겹칠 때 배치');
    assert.equal(await primaryHint.getByText(/대기:/).count(), 0);
    assert.equal(await page.getByText(OLD).count(), 0);
    assert.notEqual(await bg(primary), ACCENT);
    assert.equal(await bg(page.getByRole('button', { name: '✓ High', exact: true })), ACCENT);
    assert.notEqual(await bg(review.getByRole('button', { name: '끄기', exact: true })), ACCENT);
    if (shots) await page.screenshot({ path: path.join(shots, `picker-${width}-unselected.png`), fullPage: true });
    await review.getByRole('button', { name: '끄기', exact: true }).click();
    await review.getByText('선택 완료', { exact: true }).waitFor();
    assert.equal(await bg(review.getByRole('button', { name: '✓ 끄기', exact: true })), ACCENT);
    assert.equal(await primaryHint.innerText(), '남은 선택: 겹칠 때 배치');
    await page.getByRole('button', { name: '앞 작업 대기', exact: true }).click();
    await page.getByTestId('placement-zone').getByText('선택 완료', { exact: true }).waitFor();
    assert.equal(await primaryHint.count(), 0);
    assert.equal(await primary.isEnabled(), true);
    assert.equal(await bg(primary), ACCENT);
    assert.equal(await page.getByText(/남은 선택:|대기:/).count(), 0);
    if (shots) await page.screenshot({ path: path.join(shots, `picker-${width}-ready.png`), fullPage: true });

    // b) early draft whose verification is already running: only the waiting reason shows, and the verification step stays "done".
    await open('early=1');
    await review.getByRole('button', { name: '켜기', exact: true }).click();
    await review.getByRole('button', { name: 'Claude Code', exact: true }).click();
    await review.getByRole('button', { name: 'Other reviewer', exact: true }).click();
    await page.getByRole('button', { name: '워크트리', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="primary-blockers"]') === null);
    await page.evaluate(() => { window.w.planReview = { ...window.w.planReview, stage: 'reviewing', round: 1 }; window.update(); });
    await primaryHint.getByText('대기: 계획 검증 진행 중', { exact: true }).waitFor();
    assert.equal(await primaryHint.getByText(/남은 선택/).count(), 0);
    await review.getByText('선택 완료', { exact: true }).waitFor();
    assert.equal(await primary.isDisabled(), true);

    // c) held plan whose verification was never confirmed: the confirm step is named, then passing clears it.
    await open('held=1');
    assert.equal(await primary.isDisabled(), true);
    assert.equal(await primaryHint.innerText(), `남은 선택: ${FINAL}`);
    assert.equal(await primaryHint.getByText(/대기:/).count(), 0);
    assert.match(await automaticHint.innerText(), /남은 선택: 계획 검증 켜기\/끄기, 겹칠 때 배치/);
    await review.getByRole('button', { name: '켜기', exact: true }).click();
    await review.getByRole('button', { name: 'Claude Code', exact: true }).click();
    await review.getByRole('button', { name: 'Other reviewer', exact: true }).click();
    await page.getByRole('button', { name: '검증 선택·시작', exact: true }).click();
    await primaryHint.getByText('대기: 계획 검증 진행 중', { exact: true }).waitFor();
    await page.evaluate(h => { window.w.planReview = { ...window.w.planReview, stage: 'passed', hash: h, verdict: { verdict: 'APPROVED', findings: [] } }; window.update(); }, H);
    await page.waitForFunction(() => document.querySelector('[data-testid="primary-blockers"]') === null);
    assert.equal(await primary.isEnabled(), true);
    assert.equal(await page.getByText(OLD).count(), 0);
    // The automatic button still needs its placement; its own hint says so while the primary one is silent.
    assert.equal(await automaticHint.innerText(), '남은 선택: 겹칠 때 배치');
    await page.getByRole('button', { name: '워크트리', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="automatic-blockers"]') === null);
    assert.equal(await page.getByText(/남은 선택:|대기:/).count(), 0);
    assert.equal(await bg(page.getByRole('button', { name: '이 설정으로 자동 진행', exact: true })), ACCENT);

    // d) held plan at the review limit: the limit decision is the remaining choice.
    await open('limit=1');
    assert.equal(await primaryHint.innerText(), `남은 선택: ${LIMIT}`);
    assert.equal(await primary.isDisabled(), true);

    // Contract 5 has no verification or placement step; only the executor step, numbered 1.
    await open('c5=1');
    await page.getByText('1. 구현 담당', { exact: true }).waitFor();
    assert.equal(await page.getByText(/^[2-3]\. |계획 검증|겹칠 때 배치/).count(), 0);
    assert.equal(await primary.isEnabled(), true);
    assert.equal(await page.getByText(/남은 선택:|대기:/).count(), 0);

    // A theme without accent colors still renders.
    await open('early=1&plain=1');
    assert.equal(await primaryHint.innerText(), '남은 선택: 계획 검증 켜기/끄기, 겹칠 때 배치');
    assert.deepEqual(errors, []);
    await page.close();
  }
});
