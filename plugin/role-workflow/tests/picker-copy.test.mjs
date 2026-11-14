import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from '@babel/parser';
import { reviewProgress } from '../shared/plan-review.ts';

// Independently transcribed from handoff REQ-2's old column (unchanged '구현 모델' excluded).
export const oldLabels = ['끄기','켜기','검증 선택·시작','검증 끄기 확정','검토 1회 더','미통과로 승인','이 담당으로 확정','워크트리','앞 작업 대기',
  '계획 검증 켜기/끄기','검증 제품·모델·추론','검증 한도 처리(미통과로 승인 또는 검토 1회 더)',
  '계획 검증 확정(검증 선택·시작 또는 검증 끄기 확정)','구현 추론','겹칠 때 배치','현재 계획 대기',
  '계획 검증 진행 중','계획이 바뀌어 재검증 대기','미통과 승인 처리 중','계획 검증 기록 완료'];
const oldPhrases = ['남은 선택:', '대기:', '3. 겹칠 때 배치', '구현 담당을 선택하면 보관한 계획을 바로 전달합니다.',
  '계획이 나오면 바로 구현을 시작합니다. 계획 확인 없이 구현이 시작됩니다.', '검증을 통과하면 이 담당으로 바로 구현을 시작합니다.',
  '계획이 나오면 그 계획을 확인하고 구현 담당을 고르면 전달합니다.', '같은 저장소의 작업과 겹칠 때만 적용합니다.',
  '적격 검증 후보가 없습니다. 켜진 제품·다른 모델·읽기 전용 모드를 확인하세요.'];
function* texts(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'StringLiteral' || node.type === 'JSXText') yield node.value.trim();
  if (node.type === 'TemplateElement') yield node.value.cooked;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) yield* texts(child);
    else if (value && typeof value === 'object') yield* texts(value);
  }
}
test('AC-2.1: no replaced copy remains in picker string literals or JSX', async () => {
  for (const file of ['client/executor-picker.tsx','shared/executor-picker.ts']) {
    const ast = parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), {sourceType:'module',plugins:['typescript','jsx']});
    for (const text of texts(ast)) {
      assert.ok(!oldLabels.includes(text), `${file}: old label ${text}`);
      for (const phrase of oldPhrases) assert.ok(!text.includes(phrase), `${file}: old phrase ${phrase}`);
    }
  }
});
test('AC-2.1: every progress stage, verdict and outcome has the prescribed Korean text', () => {
  for (const [stage, label] of Object.entries({off:'검증 안 함',waiting_choice:'선택 기다리는 중',reviewing:'검증 중',revising:'계획 담당이 반영 중',passed:'통과',limit:'횟수 소진',unverified_approved:'통과 없이 승인',done:'구현에 넘김'})) {
    assert.equal(reviewProgress({stage,round:2,maxRounds:5,path:'record.md'}), `검증 2/5회 · ${label} · 판정: 아직 없음 · 꼭 고칠 점 0개\n기록 파일: record.md\n최종 결과: 아직 없음`);
  }
  for (const [verdict,label] of [['APPROVED','통과'],['BLOCKED','고칠 점 있음']])
    for (const [outcome,result] of [['passed','통과'],['unverified_approved','통과 없이 승인'],['off','검증 안 함']])
      assert.equal(reviewProgress({stage:'limit',round:5,maxRounds:6,path:'record.md',verdict:{verdict,findings:[{severity:'차단'},{severity:'권고'}]},outcome}),
        `검증 5/6회 · 횟수 소진 · 판정: ${label} · 꼭 고칠 점 1개\n기록 파일: record.md\n최종 결과: ${result}`);
});
