import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickerBlockers } from '../shared/executor-picker.ts';

const H = 'a'.repeat(64);
const LIMIT = "검증 횟수 소진 — '검증 통과 없이 구현' 또는 '검증 1회 더'";

// The button conditions as the picker wrote them before pickerBlockers owned them (busy left out).
function oldDisabled(i, kind) {
  const approval = i.approvalHash !== null, gated = i.firstPlan ?? i.contract >= 6;
  const earlyDraft = i.contract >= 7 && i.mode === 'federated' && !approval;
  const canSubmit = !gated || approval || earlyDraft;
  const pending = ['reviewing', 'revising'].includes(i.stage ?? '');
  const reviewRequired = i.contract >= 7;
  const reviewReady = earlyDraft || !reviewRequired || (i.savedReview === false && !pending) || (approval && i.stage === 'passed' && i.reviewHash === i.approvalHash);
  const reviewValid = i.localReview === false || (i.localReview === true && i.localReviewComplete && !pending);
  const automaticReady = reviewValid && !!i.placement && !['reviewing', 'revising', 'limit', 'done'].includes(i.stage ?? '');
  return kind === 'primary'
    ? !canSubmit || !reviewReady || !i.model || i.thinking === null || (earlyDraft && !automaticReady)
    : !canSubmit || !i.model || i.thinking === null || !automaticReady;
}

function* combinations() {
  for (const contract of [5, 6, 7]) for (const mode of ['federated', 'general']) for (const firstPlan of [undefined, true, false])
    for (const approvalHash of [null, H]) for (const savedReview of [null, false, true]) for (const localReview of [null, false, true])
      for (const localReviewComplete of localReview === false ? [true] : [true, false])
        for (const stage of [undefined, 'off', 'waiting_choice', 'reviewing', 'revising', 'passed', 'limit', 'unverified_approved', 'done'])
          for (const reviewHash of [H, 'b'.repeat(64)]) for (const placement of [null, 'worktree']) for (const model of ['', 'm']) for (const thinking of [null, 'high'])
            yield { contract, mode, firstPlan, approvalHash, savedReview, localReview, localReviewComplete, stage, reviewHash, placement, model, thinking };
}

// Protects the disabled decision: the extracted reasons block exactly what the old expressions blocked, never silently.
// The automatic button only exists from contract 7 (combined setup needs the review picker), so it is enumerated there.
test('pickerBlockers blocks exactly when the old disabled expressions did, and always says why', () => {
  let count = 0;
  for (const input of combinations()) for (const kind of ['primary', 'automatic']) {
    if (kind === 'automatic' && input.contract < 7) continue;
    const { choose, wait } = pickerBlockers(input, kind);
    const reasons = choose.length + wait.length;
    assert.equal(reasons > 0, oldDisabled(input, kind), `${kind} ${JSON.stringify(input)} -> ${JSON.stringify({ choose, wait })}`);
    assert.equal(new Set([...choose, ...wait]).size, reasons, 'no duplicate reasons');
    count++;
  }
  assert.ok(count > 100000);
});

const base = { contract: 7, mode: 'federated', firstPlan: true, approvalHash: H, savedReview: true, localReview: true, localReviewComplete: true,
  stage: 'waiting_choice', reviewHash: H, placement: 'worktree', model: 'm', thinking: 'high' };
const early = { approvalHash: null };
const cases = [
  [1, { stage: 'reviewing' }, 'primary', [], ['다른 AI가 계획을 검증하는 중']],
  [2, { stage: 'revising' }, 'primary', [], ['다른 AI가 계획을 검증하는 중']],
  [3, { stage: 'limit' }, 'primary', [LIMIT], []],
  [4, { stage: 'passed' }, 'primary', [], []],
  [5, { stage: 'passed', reviewHash: 'b'.repeat(64) }, 'primary', [], ['계획이 바뀌어 다시 검증해야 함']],
  [6, { stage: 'unverified_approved' }, 'primary', [], ['검증 통과 없이 구현 요청을 처리하는 중']],
  [7, { stage: 'done' }, 'primary', [], ['계획 검증이 이미 끝남']],
  [8, { stage: 'waiting_choice', savedReview: null }, 'primary', ["계획 검증 확정 — '이 AI로 검증 시작' 또는 '검증 없이 진행'"], []],
  [9, { savedReview: false, stage: 'off' }, 'primary', [], []],
  [10, { ...early, localReview: null, placement: null, stage: 'waiting_choice' }, 'primary', ['계획 검증 받을지', '다른 작업과 겹칠 때 방법'], []],
  [11, { ...early, localReviewComplete: false, stage: 'waiting_choice' }, 'primary', ['검증할 AI(제품·모델·추론)'], []],
  [12, { ...early, stage: 'reviewing' }, 'primary', [], ['다른 AI가 계획을 검증하는 중']],
  [13, { ...early, localReview: false, stage: 'revising' }, 'primary', [], ['다른 AI가 계획을 검증하는 중']],
  [14, { stage: 'limit', placement: null }, 'automatic', [LIMIT, '다른 작업과 겹칠 때 방법'], []],
  [15, { stage: 'done' }, 'automatic', [], ['계획 검증이 이미 끝남']],
  [16, { model: '' }, 'automatic', ['구현 모델'], []],
  [16, { thinking: null }, 'automatic', ['구현 추론 수준'], []],
  [17, { contract: 5, approvalHash: null, firstPlan: false }, 'primary', [], []],
  [17, { contract: 5, approvalHash: null, firstPlan: false, model: '' }, 'primary', ['구현 모델'], []],
  [18, { contract: 6, approvalHash: null }, 'primary', [], ['계획이 아직 나오지 않음']],
  [19, { ...early, localReview: false, placement: 'worktree', stage: 'waiting_choice' }, 'primary', [], []],
];
// Protects the wording the card shows: each expectation is written by hand from the reason table, not from the function.
for (const [n, patch, kind, choose, wait] of cases)
  test(`pickerBlockers reasons: case ${n} ${kind} ${JSON.stringify(patch)}`, () => {
    assert.deepEqual(pickerBlockers({ ...base, ...patch }, kind), { choose, wait });
  });
