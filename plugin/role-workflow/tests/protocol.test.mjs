import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecision, contextRatio, pushApprovalPrompt } from "../server/protocol.ts";

test("only a final validated control block may dispatch work", () => {
  const decision = {
    status: "plan",
    summary: "fix",
    next: "implement and test",
    handoff: "original goal",
  };
  assert.equal(
    parseDecision(`계획\n<paseo-workflow>${JSON.stringify(decision)}</paseo-workflow>`).status,
    "plan",
  );
  for (const text of [
    "work finished",
    `\n<paseo-workflow>${JSON.stringify(decision)}</paseo-workflow>\nmore`,
    '<paseo-workflow>{"status":"plan"}</paseo-workflow>',
  ])
    assert.throws(() => parseDecision(text));
});
test("context threshold uses current window usage and rejects missing/invalid values", () => {
  assert.equal(contextRatio({ contextWindowUsedTokens: 71, contextWindowMaxTokens: 100 }), 0.71);
  for (const usage of [
    undefined,
    {},
    { contextWindowUsedTokens: 4, contextWindowMaxTokens: 0 },
    { contextWindowUsedTokens: NaN, contextWindowMaxTokens: 100 },
  ])
    assert.equal(contextRatio(usage), null);
});

const validDecision = { status: "plan", summary: "fix", next: "implement", handoff: "goal" };
const block = (value) => `<paseo-workflow>${JSON.stringify(value)}</paseo-workflow>`;
test("final block accepts prose without a newline", () => {
  assert.equal(parseDecision(`앞 문장${block(validDecision)}`).status, "plan");
});
test("final block ignores earlier protocol examples", () => {
  assert.equal(
    parseDecision(`예시: ${block({ status: "input" })}\n${block(validDecision)}`).next,
    "implement",
  );
});
test("tag names inside JSON strings do not hide the final block", () => {
  const value = {
    ...validDecision,
    next: "mention <paseo-workflow>",
    handoff: "mention <paseo-workflow> and </paseo-workflow>",
  };
  assert.deepEqual(parseDecision(block(value)), { ...value, checks: [], remember: [] });
});
test("missing, trailing, malformed, invalid and empty-next blocks are rejected", () => {
  for (const text of [
    "no tag",
    `${block(validDecision)} trailing`,
    "<paseo-workflow>{broken}</paseo-workflow>",
    block({ ...validDecision, status: "unknown" }),
    block({ ...validDecision, extra: true }),
    block({ ...validDecision, next: " " }),
    block({ ...validDecision, status: "continue", next: "" }),
  ]) {
    assert.throws(() => parseDecision(text));
  }
});

test("executor model format and prompt choices", async () => {
  const { decisionSchema, executorModelPrompt, automationPrompt } =
    await import("../server/protocol.ts");
  const base = { status: "plan", summary: "s", next: "n", handoff: "h" };
  for (const executorModel of ["unknown/model", "codex/has space", "codex/"])
    assert.equal(decisionSchema.safeParse({ ...base, executorModel }).success, false);
  assert.equal(decisionSchema.safeParse({ ...base, executorModel: "codex/model" }).success, true);
  assert.equal(decisionSchema.safeParse({ ...base, executorModel: "claude/model" }).success, true);
  const models = Array.from({ length: 6 }, (_, i) => ({
    id: `m${i}`,
    label: `Model ${i}`,
    isDefault: i === 2,
    isSelectable: i !== 0,
  }));
  const prompt = executorModelPrompt(models, "codex/m4");
  assert.ok(prompt.indexOf("codex/m4") < prompt.indexOf("codex/m1"));
  assert.equal((prompt.match(/Model /g) || []).length, 4);
  assert.ok(!prompt.includes("codex/m0"));
  assert.ok(
    executorModelPrompt(models, "codex").indexOf("codex/m2") <
      executorModelPrompt(models, "codex").indexOf("codex/m1"),
  );
  assert.equal(executorModelPrompt([], "codex"), "");
  assert.ok(!automationPrompt(prompt).includes("Model 4"));
});

test("mode prompt offers two choices and a safe default without duplicate blocks", async () => {
  const { modeSelectPrompt, automationPrompt } = await import("../server/protocol.ts");
  const prompt = modeSelectPrompt();
  assert.equal((prompt.match(/^- /gm) || []).length, 2);
  for (const text of [
    "일반개발",
    "연합개발",
    "paseo-role-workflow-v1",
    "paseo-automation-v1",
    "paseo-executor-model-v1",
    "답이 없으면 일반개발",
    "첫 응답을 쓰기 전에",
    "첫 메시지",
    "상태 블록을 출력하지",
    "Codex용 명령도 작성하지",
  ])
    assert.ok(prompt.includes(text));
  const reapplied = automationPrompt(automationPrompt("base") + prompt) + modeSelectPrompt();
  assert.equal((reapplied.match(/<paseo-mode-select-v1>/g) || []).length, 1);
  assert.equal((reapplied.match(/<paseo-automation-v1>/g) || []).length, 1);
});

test("thinking format and per-model options retain defaults and full ids", async () => {
  const { decisionSchema, executorModelPrompt } = await import("../server/protocol.ts");
  const base = { status: "plan", summary: "s", next: "n", handoff: "h" };
  for (const value of ["", "bad value", "bad/value", "x".repeat(41)])
    assert.equal(decisionSchema.safeParse({ ...base, executorThinking: value }).success, false);
  assert.equal(decisionSchema.safeParse({ ...base, executorThinking: "xhigh" }).success, true);
  const options = ["low", "medium", "high", "xhigh", "max", "ultra"].map((id) => ({
    id,
    label: id,
  }));
  const text = executorModelPrompt(
    [
      { id: "m", label: "Model", thinkingOptions: options, defaultThinkingOptionId: "medium" },
      {
        id: "one",
        label: "One",
        thinkingOptions: [{ id: "xhigh", label: "Extra high", isDefault: true }],
      },
    ],
    "codex/m",
  );
  assert.match(text, /추론 선택지: medium \(medium\), low \(low\), high \(high\), xhigh \(xhigh\)/);
  assert.match(text, /전체 추론 id: low, medium, high, xhigh, max, ultra/);
  assert.match(text, /선택지가 1개뿐/);
  assert.match(text, /executorThinking/);
});
test("title parser ignores workflow strings, normalizes last line and limits length", async () => {
  const { parseTitle, titlePrompt, automationPrompt } = await import("../server/protocol.ts");
  assert.equal(parseTitle("제목: 앞 제목\n내용\n제목:  새   제목  "), "새 제목");
  assert.equal(
    parseTitle("제목: 한국어 제목\n" + block({ ...validDecision, handoff: "제목: 내부 문자열" })),
    "한국어 제목",
  );
  assert.equal(parseTitle(block({ ...validDecision, handoff: "제목: 내부 문자열" })), null);
  assert.equal(parseTitle("없음"), null);
  assert.equal(parseTitle("제목:   "), null);
  assert.equal(parseTitle("제목: " + "가".repeat(70)).length, 60);
  assert.equal(automationPrompt(titlePrompt()).includes("<paseo-title-v1>"), false);
});

test("title decorations carry project, provider, role, number and progress and stay idempotent", async () => {
  const { stripTitleDecor, decorateTitle } = await import("../server/protocol.ts");
  assert.equal(stripTitleDecor(" 🟠 계획2: 🟢 실행: 계획: 제목 "), "제목");
  assert.equal(
    stripTitleDecor("🔵 G[연합:실행2]-07 🟣 ClAUDE[일반개발]-112 GPT[실행]-03 제목"),
    "제목",
  );
  assert.equal(stripTitleDecor("GPT 계획서: 실행 환경"), "GPT 계획서: 실행 환경");
  assert.equal(stripTitleDecor("C 언어 [정리]-1"), "C 언어 [정리]-1");
  for (const [provider, role, detail, expected] of [
    ["claude", null, {}, "🟠 C[AIpet]-00 제목"],
    ["claude", "plan", { number: 7, progress: "plan" }, "🟣 C[AIpet:계획]-07 제목"],
    ["codex/m", "execute", { number: 7, progress: "done" }, "🟢 G[AIpet:실행]-07 제목"],
    ["codex", null, { number: 123, progress: "pushed" }, "🔵 G[AIpet]-123 [PUSH] 제목"],
    ["codex", "execute", { number: 3, generation: 2 }, "🟠 G[AIpet:실행2]-03 제목"],
  ]) {
    detail.projectName = "AIpet";
    const actual = decorateTitle(provider, role, "제목", true, detail);
    assert.equal(actual, expected);
    assert.equal(decorateTitle(provider, role, actual, true, detail), expected);
  }
  assert.equal(
    decorateTitle("codex", "execute", "🟠 계획: 제목", false, {
      number: 4,
      projectName: "AIpet",
    }),
    "G[AIpet:실행]-04 제목",
  );
  assert.equal(decorateTitle("claude", null, "🟠 C[AIpet:계획]-02 제목", false), "제목");
  assert.equal(decorateTitle("other", null, "🟢 제목", true), "제목");
});

test("project labels keep short names and abbreviate long names without breaking decoration", async () => {
  const { projectTitleLabel, decorateTitle, stripTitleDecor } =
    await import("../server/protocol.ts");
  for (const [name, expected] of [
    ["AIpet", "AIpet"],
    ["hermes-setting", "hermes-setting"],
    ["sample-development", "sample dev"],
    ["My Application Management", "My app"],
    ["  local   llm  ", "local llm"],
    ["[프로젝트]: 이름\n", "프로젝트 이름"],
    ["", "프로젝트"],
  ])
    assert.equal(projectTitleLabel(name), expected);
  for (const name of ["가".repeat(30), "🚀".repeat(30), "very_long_project_name_here"]) {
    const label = projectTitleLabel(name);
    assert.ok(Array.from(label).length <= 16);
    assert.ok(label.split(/\s+/).length <= 2);
    assert.ok(!label.includes("\uFFFD"));
  }
  for (const role of [null, "pair"]) {
    const detail = {
      projectName: "sample-development",
      number: 7,
      progress: "pushed",
      pushReview: true,
    };
    const title = decorateTitle("codex", role, "🔵 G[연합]-07 [푸시 완료] 제목", true, detail);
    assert.equal(title, "🔵 G[sample dev]-07 [PUSH] 제목");
    assert.equal(decorateTitle("codex", role, title, true, detail), title);
    assert.equal(stripTitleDecor(title), "제목");
  }
});

test("progress line is read only as a whole line outside the state block", async () => {
  const { parseProgress, progressPrompt, automationPrompt } = await import("../server/protocol.ts");
  assert.equal(parseProgress("끝\n작업상태: 완료"), "done");
  assert.equal(parseProgress("작업상태: 계획\n본문\n작업상태:푸시  \n"), "pushed");
  assert.equal(parseProgress("작업상태: 진행\n<paseo-workflow>{}</paseo-workflow>"), "active");
  for (const text of [
    "현재 작업상태: 완료",
    "작업상태: 완료했습니다",
    "작업상태: 보류",
    '<paseo-workflow>{"summary":"\n작업상태: 완료\n"}</paseo-workflow>',
  ])
    assert.equal(parseProgress(text), null);
  assert.equal(automationPrompt(progressPrompt()).includes("<paseo-progress-v1>"), false);
});

test("remember remains optional and enforces item and array bounds", () => {
  assert.deepEqual(parseDecision(block(validDecision)).remember, []);
  assert.deepEqual(
    parseDecision(block({ ...validDecision, remember: ["a".repeat(500)] })).remember,
    ["a".repeat(500)],
  );
  assert.throws(() => parseDecision(block({ ...validDecision, remember: ["a".repeat(501)] })));
  assert.throws(() => parseDecision(block({ ...validDecision, remember: Array(11).fill("rule") })));
  assert.equal(
    parseDecision(block({ ...validDecision, remember: Array(10).fill("rule") })).remember.length,
    10,
  );
});
test("model prompt requires separate model and thinking questions with combined answer exception", async () => {
  const { executorModelPrompt, AUTOMATION_INSTRUCTIONS } = await import("../server/protocol.ts");
  const prompt = executorModelPrompt([{ id: "model", label: "Model" }], "codex");
  for (const phrase of [
    "다른 질문과 한 번의 질문 도구 호출에 묶지 않는다",
    "반드시 질문 도구로 이어서 묻는다",
    "추론 정도를 함께 적었으면",
    "처음 plan 상태",
    "선택지가 1개뿐",
    "추론 목록이 없을 때도 생략",
  ])
    assert.ok(prompt.includes(phrase));
  assert.ok(AUTOMATION_INSTRUCTIONS.includes('"remember":["압축 뒤에도 반드시 지킬 사항"]'));
});

test("GPT mode prompt and Claude model choices describe the reverse assignment", async () => {
  const { modeSelectPrompt, executorModelPrompt } = await import("../server/protocol.ts");
  assert.match(modeSelectPrompt("codex"), /Codex 계획·검토, Claude 실행/);
  const prompt = executorModelPrompt(
    [
      { id: "a", label: "A", isDefault: true },
      { id: "b", label: "B" },
    ],
    "claude/b",
  );
  assert.ok(prompt.indexOf("claude/b") < prompt.indexOf("claude/a"));
  assert.ok(!prompt.includes("codex/"));
});

test("a rejected block says what was wrong with it", async () => {
  const { DecisionError } = await import("../server/protocol.ts");
  const reason = (text) => {
    try {
      parseDecision(text);
    } catch (error) {
      assert.ok(error instanceof DecisionError);
      return error.reason;
    }
    assert.fail("accepted");
  };
  const wrap = (body) => `결과입니다.\n<paseo-workflow>${body}</paseo-workflow>`;
  assert.match(reason("블록 없는 응답"), /상태 블록이 없음/);
  assert.match(reason(wrap('{"status":"result"}') + "\n덧붙임"), /맨 끝에 있지 않거나/);
  assert.match(
    reason(wrap('{"status":"result","summary":"줄\n바꿈","handoff":"h"}')),
    /JSON 형식 오류/,
  );
  assert.match(reason(wrap('{"status":"result","summary":"s"}')), /필드 오류: handoff/);
  assert.match(
    reason(wrap('{"status":"plan","summary":"s","handoff":"h","next":" "}')),
    /next가 비어/,
  );
  // An earlier example must not mask the reason the final block failed.
  assert.match(
    reason(wrap('{"status":"result","summary":"s","handoff":"h"}') + wrap("{oops")),
    /JSON 형식 오류/,
  );
});

test("note is a valid non-driving decision and the instructions distinguish it from input", async () => {
  const { AUTOMATION_INSTRUCTIONS } = await import("../server/protocol.ts");
  assert.equal(
    parseDecision(
      '<paseo-workflow>{"status":"note","summary":"현황","handoff":"유지"}</paseo-workflow>',
    ).status,
    "note",
  );
  assert.match(AUTOMATION_INSTRUCTIONS, /complete\|input\|note/);
  assert.match(AUTOMATION_INSTRUCTIONS, /사용자의 답이 있어야만 진행/);
});
test("bundled Claude questions retain model ids, thinking validation and asynchronous waiting", async () => {
  const { executorModelPrompt, modeSelectPrompt } = await import("../server/protocol.ts");
  const models = [
    {
      id: "model",
      label: "Model",
      thinkingOptions: ["low", "medium", "high", "max"].map((id) => ({ id, label: id })),
    },
  ];
  const prompt = executorModelPrompt(models, "codex/model", true, true);
  assert.doesNotMatch(prompt, /세 질문/);
  assert.match(prompt, /\[연합개발 전용\]/);
  assert.match(prompt, /연합개발로 정해진 직후, 조사를 시작하기 전에 질문 도구를 한 번만 호출/);
  assert.match(prompt, /모델·추론 두 질문을 한 번의 호출/);
  assert.match(prompt, /진행 방식이 일반개발이면 모델·추론을 묻지 않는다/);
  assert.match(
    prompt,
    /일반개발로 진행하다가 연합개발로 바뀐 경우에도 연합개발로 정해진 직후에 묻는다/,
  );
  assert.match(prompt, /추론 선택지는 다음 id를 쓴다: low, medium, high, max\./);
  assert.match(prompt, /전체 추론 id: low, medium, high, max/);
  assert.match(prompt, /전체 추론 id에 없으면 executorThinking을 생략/);
  assert.match(prompt, /호출 반환은 사용자 답변이 아니다/);
  assert.match(prompt, /처음 plan.*executorModel.*executorThinking/);
  assert.match(modeSelectPrompt("claude"), /진행 방식 질문은 모델·추론 질문과 묶지 않는다/);
  assert.doesNotMatch(modeSelectPrompt("claude"), /세 질문/);
  assert.match(executorModelPrompt(models, "claude/model"), /묶지 않는다/);
  assert.doesNotMatch(executorModelPrompt(models, "codex/model", false, true), /연합개발/);
});

test("bundled thinking ranks model support then orders low through xhigh", async () => {
  const { executorModelPrompt } = await import("../server/protocol.ts");
  const model = (id, ids) => ({
    id,
    label: id,
    thinkingOptions: ids.map((optionId) => ({ id: optionId, label: optionId })),
  });
  const full = ["low", "medium", "high", "xhigh", "max", "ultra"];
  const models = [
    model("6.1-sol", ["xhigh"]),
    model("astra", full),
    model("sol", full),
    model("luna", full.slice(0, 5)),
  ];
  const prompt = executorModelPrompt(models, "codex/6.1-sol", false, true);
  const line = prompt.split("\n").find((text) => text.startsWith("추론 선택지는"));
  assert.equal(
    line,
    "추론 선택지는 다음 id를 쓴다: low, medium, high, xhigh. 그 외는 직접 입력한다.",
  );
  assert.doesNotMatch(line, /기본값/);
  assert.match(prompt, /직접 입력으로 '기본값' 또는 '모델 기본값'/);
  const separate = executorModelPrompt([models[1]], "codex/astra");
  assert.match(
    separate,
    /추론 선택지: low \(low\), medium \(medium\), high \(high\), xhigh \(xhigh\)/,
  );
});

test("bundled thinking keeps short lists and ignores models beyond four", async () => {
  const { executorModelPrompt } = await import("../server/protocol.ts");
  const model = (id, ids) => ({
    id,
    label: id,
    thinkingOptions: ids.map((optionId) => ({ id: optionId, label: optionId })),
  });
  for (const ids of [[], ["high"], ["low", "high"], ["low", "medium", "high", "xhigh"]]) {
    const prompt = executorModelPrompt([model("one", ids)], "codex/one", false, true);
    assert.ok(prompt.includes(`추론 선택지는 다음 id를 쓴다: ${ids.join(", ") || "없음"}.`));
  }
  const models = [
    model("one", ["b"]),
    model("two", ["a", "b", "c", "d", "e"]),
    model("three", ["a", "b", "c", "d", "e"]),
    model("four", ["a", "b", "c", "d"]),
    model("ignored", ["e"]),
  ];
  assert.match(
    executorModelPrompt(models, "codex/one", false, true),
    /추론 선택지는 다음 id를 쓴다: a, b, c, d\./,
  );
});

test("push approval instructs direct execution and verification without a required dedicated tool", () => {
  const prompt = pushApprovalPrompt();
  assert.doesNotMatch(
    prompt,
    /기본 실행 경로로 쓰지 않는다|전용 푸시 기능을 사용한다|전용 실행 경로를 사용한다/,
  );
  for (const text of [
    "명시적으로 승인하면 에이전트가 직접 실행",
    "사용자에게 되돌리지 않는다",
    "단독 셸 명령 git -C <저장소> push <원격> <전체 커밋 해시>:refs/heads/<브랜치>",
    "git -C <저장소> ls-remote",
    "--force/--mirror/--tags/--all은 금지",
    "다른 에이전트에게 넘기지 않는다",
    "선택 경로",
    "원칙의 예외",
    "merge-base --is-ancestor",
    "non-fast-forward",
    "이미 원격에 반영됨",
    "pull/rebase/merge/강제 푸시로 우회하지 않고",
    "대상 커밋 변경에는 새 승인이 필요",
  ]) {
    assert.ok(prompt.includes(text), text);
  }
});

test("only line-start fences hide metadata; inline backticks and nested fences do not", async () => {
  const { parseProgress, parseTitle } = await import("../server/protocol.ts");
  const { proseArtifacts } = await import("../shared/artifacts.ts");
  const inline = "마크다운에서는 ``` 세 개로 코드 블록을 엽니다.\n작업상태: 푸시";
  assert.equal(parseProgress(inline), "pushed");
  const nested = "````md\n```\n작업상태: 푸시\n```\n````\n작업상태: 완료";
  assert.equal(parseProgress(nested), "done");
  assert.equal(parseProgress("```\n작업상태: 푸시\n```"), null);
  assert.equal(parseProgress("  ~~~\n작업상태: 푸시\n~~~\n작업상태: 진행"), "active");
  assert.equal(parseTitle("```\n제목: 예시 제목\n```\n본문"), null);
  assert.equal(parseTitle("```\n제목: 예시\n```\n제목: 실제 제목"), "실제 제목");
  const target = { repository: "/repo", remote: "origin", branch: "main", commit: "a".repeat(40) };
  assert.equal(
    proseArtifacts(`인라인 \`\`\` 설명\n푸시대상: ${JSON.stringify([target])}`).pushTargets?.length,
    1,
  );
});
