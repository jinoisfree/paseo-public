import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickerFocus, pickerBlockers } from '../shared/executor-picker.ts';

const base = { busy: false, stage: 'waiting_choice', earlyDraft: false, reviewRequired: true, automaticShown: false,
  localReview: true, reviewProvider: 'claude', reviewModel: 'reviewer', reviewThinking: 'high', model: 'builder', thinking: 'high',
  placement: 'worktree', primaryEnabled: false, automaticEnabled: false, limitApproveEnabled: false, limitExtraEnabled: false,
  reviewConfirmEnabled: false, primaryChoose: [] };
const cases = [
  [1, {busy:true,primaryEnabled:true}, null],
  [2, {earlyDraft:true,localReview:null,placement:null}, 'review-toggle'],
  [3, {earlyDraft:true,reviewProvider:null}, 'review-provider'],
  [4, {earlyDraft:true,reviewModel:''}, 'review-model'],
  [5, {earlyDraft:true,model:''}, 'executor-model'],
  [6, {earlyDraft:true,thinking:null}, 'executor-thinking'],
  [7, {earlyDraft:true,placement:null}, 'placement'],
  [8, {earlyDraft:true,primaryEnabled:true}, 'primary'],
  [9, {automaticShown:true,placement:null,primaryChoose:['계획 검증 확정 — 확인']}, 'placement'],
  [10, {automaticShown:true,automaticEnabled:true,primaryChoose:['계획 검증 확정 — 확인']}, 'automatic'],
  [11, {localReview:false,reviewConfirmEnabled:true,primaryChoose:['계획 검증 확정 — 확인']}, 'review-confirm'],
  [12, {stage:'passed',primaryEnabled:true}, 'primary'],
  [13, {stage:'reviewing'}, null],
  [14, {stage:'reviewing',model:''}, 'executor-model'],
  [15, {stage:'limit',limitApproveEnabled:true,limitExtraEnabled:true}, 'review-limit'],
  [16, {stage:'limit',model:''}, 'executor-model'],
  [17, {reviewRequired:false,stage:undefined}, null],
  [18, {earlyDraft:true,reviewThinking:null,model:''}, 'review-thinking'],
  [20, {stage:'unverified_approved',automaticShown:true,reviewProvider:null}, null],
  [19, {earlyDraft:true,reviewThinking:'',model:''}, 'executor-model'],
];
for (const [n, patch, expected] of cases) test(`pickerFocus F${n}`, () => assert.equal(pickerFocus({...base,...patch}), expected));

// Actual card combinations; expectations are invariants, never a copy of the focus ordering.
test('pickerFocus exhaustive invariants a-d across card states', () => {
  let count = 0;
  for (const contract of [5,6,7]) for (const firstPlan of [true,false]) for (const approval of [true,false])
  for (const stage of ['off','waiting_choice','reviewing','revising','passed','limit','unverified_approved','done'])
  for (const localReview of [null,false,true]) for (const savedReview of [null,false,true])
  for (const reviewProvider of [null,'claude']) for (const reviewModel of ['','r']) for (const reviewThinking of [null,'','high'])
  for (const model of ['','m']) for (const thinking of [null,'high']) for (const placement of [null,'wait']) for (const busy of [true,false]) {
    const earlyDraft = contract >= 7 && !approval, automaticShown = contract >= 7 && firstPlan && approval;
    const input = {contract,mode:'federated',firstPlan,approvalHash:approval?'h':null,reviewHash:'h',savedReview,localReview,
      localReviewComplete:localReview === false || !!(localReview && reviewProvider && reviewModel && reviewThinking !== null),stage,model,thinking,placement};
    const primary = pickerBlockers(input,'primary'), automatic = pickerBlockers(input,'automatic');
    const pending = ['reviewing','revising'].includes(stage);
    const i = {...base,busy,stage,earlyDraft,automaticShown,reviewRequired:contract>=7,localReview,reviewProvider,reviewModel,reviewThinking,model,thinking,placement,
      primaryEnabled:!primary.choose.length&&!primary.wait.length,
      automaticEnabled:automaticShown&&!automatic.choose.length&&!automatic.wait.length,
      limitApproveEnabled:contract>=7&&(!firstPlan||approval||earlyDraft)&&!!model&&thinking!==null,
      limitExtraEnabled:contract>=7&&approval,
      reviewConfirmEnabled:contract>=7&&!earlyDraft&&approval&&localReview!==null&&(localReview===false||(!pending&&input.localReviewComplete)),
      primaryChoose:primary.choose};
    const target = pickerFocus(i), context = JSON.stringify(i);
    if (busy) assert.equal(target,null,context);
    if (target === 'primary') assert.ok(i.primaryEnabled,context);
    if (target === 'automatic') assert.ok(i.automaticEnabled,context);
    if (target === 'review-limit') assert.ok(i.limitApproveEnabled||i.limitExtraEnabled,context);
    if (target === 'review-confirm') assert.ok(i.reviewConfirmEnabled,context);
    const reason = {'executor-model':'구현 모델','executor-thinking':'구현 추론 수준',placement:'다른 작업과 겹칠 때 방법'}[target];
    if (reason) assert.ok([...primary.choose,...automatic.choose].includes(reason),context);
    if (!target&&!busy) {
      assert.equal(i.primaryEnabled,false,context); assert.equal(i.automaticEnabled,false,context);
      const choices = [...primary.choose,...(automaticShown?automatic.choose:[])];
      for (const choice of choices) {
        // A limit with no active limit action, or a review selection locked by a running/completed review, has no available target.
        assert.ok((choice.startsWith('검증 횟수 소진')&&!i.limitApproveEnabled&&!i.limitExtraEnabled)
          || (choice.startsWith('계획 검증 확정')&&!i.reviewConfirmEnabled)
          || (['reviewing','revising','limit','done','unverified_approved'].includes(stage)&&['계획 검증 받을지','검증할 AI(제품·모델·추론)'].includes(choice)), context);
      }
    }
    count++;
  }
  assert.ok(count>100000);
});
