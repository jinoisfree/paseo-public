import { test } from "node:test";
import assert from "node:assert/strict";
import { requestsFederation } from "../shared/mode-request.ts";

test("federation resume accepts affirmative mentions and trims whitespace", () => {
  for (const text of [
    "연합개발 재개해줘",
    "연합개발",
    "연합개발 계속",
    "연합개발로 다시 진행해",
    "  연합개발 계속\n",
    "먼저 테스트해줘. 연합개발 계속!",
    "질문이 있어?\n연합개발 재개해줘",
    "중지된 연합개발 다시 해줘",
    "중지했던 연합개발 재개해",
    "취소됐던 연합개발 재개",
    "멈췄던 연합개발 계속",
    "연합개발 마무리까지 진행해",
    "연합개발로 마저 해줘",
    "연합개발 마감까지 계속",
    "연합개발 진행하면서 테스트도 해줘",
    "중지됐던 연합개발 재개해",
    "취소된 연합개발 재개해",
    "멈춘 연합개발 재개해",
    "연합개발 중지 후 다시 진행해",
    "일반개발이 아니라 연합개발 계속",
  ])
    assert.equal(requestsFederation(text), true, text);
});

test("federation resume rejects questions, stops, explanations and quoted mentions", () => {
  for (const text of [
    "",
    "계속해줘",
    "연합개발 하지마",
    "연합개발이 뭐야?",
    "연합개발 중지해",
    "연합개발 말고 일반개발로 해",
    "연합개발과 일반개발 비교해줘",
    "일반개발로 해. 연합개발 계속",
    "연합개발 재개해줘?",
    "연합개발 재개해줘？",
    "연합개발 계속. 연합개발 중지해",
    "연합개발 중지시켜",
    "연합개발 취소해줘",
    "연합개발 그만해",
    "연합개발 멈춰줘",
    "연합개발 하지 마세요",
    "연합개발 하지 말아줘",
    "연합개발 마요",
    "연합개발 마세요",
    "연합개발 마라",
    "연합개발 중지",
    "연합개발 중지 하세요",
    "연합개발 그만둬",
    "연합개발 그만두자",
    "연합개발 멈추자",
    "연합개발 취소 하자",
    ...[
      "할까",
      "할지",
      "하면",
      "하려면",
      "말아",
      "마",
      "않",
      "아니",
      "금지",
      "취소",
      "그만",
      "멈춰",
      "설명",
      "차이",
      "뭔가",
    ].map((word) => `연합개발 ${word}`),
    ...['"', "'", "“", "”", "‘", "’", "`"].map((quote) => `${quote}연합개발${quote}`),
  ])
    assert.equal(requestsFederation(text), false, text);
});
