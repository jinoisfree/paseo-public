import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalDecision, decisionHash } from "../shared/plan-approval.ts";
import { parseDecision } from "../shared/decision.ts";

test("decision hash is canonical SHA-256 across server and message parsing", () => {
  const raw = {status:"plan", summary:"계획", next:"작업 ID: x", handoff:"문서", checks:[]};
  const a = parseDecision(`<paseo-workflow>${JSON.stringify(raw)}</paseo-workflow>`);
  const b = parseDecision(`<paseo-workflow>${JSON.stringify({handoff:raw.handoff,...raw})}</paseo-workflow>`);
  assert.equal(decisionHash(a), decisionHash(b));
  assert.equal(decisionHash(a), createHash("sha256").update(canonicalDecision(a)).digest("hex"));
  assert.notEqual(decisionHash(a), decisionHash({...a,summary:"다른 계획"}));
  assert.notEqual(decisionHash(a), decisionHash({...a,handoff:"다른 문서"}));
});

test("canonical SHA-256 agrees on nested, long and Unicode decisions", () => {
 for(const summary of ["", "a".repeat(56), "🌐한글\ud800".repeat(100)]) {
  const d={status:'plan',summary,checks:['a','b'],handoff:'x',constraints:[{text:'値',id:'1'}]};
  assert.equal(decisionHash(d),createHash('sha256').update(canonicalDecision(d)).digest('hex'));
 }
});
