import { test } from "node:test";
import assert from "node:assert/strict";
import { turnEvidence, pushPending } from "../server/push-evidence.ts";
import { readTurn } from "../server/paseo-port.ts";

const hash = "a".repeat(40);
const shell = (
  command,
  output = `To example:repo.git\n   bbbbbbb..aaaaaaa  main -> main\n`,
  overrides = {},
) => ({
  type: "tool_call",
  callId: "push-command",
  name: "shell",
  status: "completed",
  error: null,
  detail: { type: "shell", cwd: "/repo", command, output, exitCode: 0, ...overrides },
});
const assistant = (text) => ({ type: "assistant_message", text });
const porcelain = (source = hash, flag = " ", summary = "bbbbbbb..aaaaaaa", branch = "main") =>
  `To example:repo.git\n${flag}\t${source}:refs/heads/${branch}\t${summary}\nDone\n`;

const preflightCommand =
  "git fetch origin; git merge-base --is-ancestor bbbbbbb HEAD; git merge-base --is-ancestor bbbbbbb origin/main; git rev-parse HEAD origin/main; git status --short; git diff bbbbbbb..HEAD -- README.md";
const preflightOutput = `${hash}\n${hash}\ndiff --git a/README.md b/README.md\nindex bbbbbbb..ccccccc 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n`;
const currentPush = () => shell("git push origin main", "Everything up-to-date\n");

test("a pure Git preflight proves only the immediately following matching already-current push", () => {
  for (const separator of ["; ", "\n", " && "]) {
    const observed = shell(preflightCommand.replaceAll("; ", separator), preflightOutput);
    const evidence = turnEvidence([observed, assistant("푸시를 실행합니다."), currentPush()]);
    assert.deepEqual(evidence.pushes, [
      { callId: "push-command", cwd: "/repo", remote: "origin", branch: "main", commit: hash },
    ]);
    assert.equal(evidence.changed, false);
  }
  const observed = shell(
    preflightCommand.replaceAll("git ", "git -C '/actual repo' "),
    preflightOutput,
  );
  assert.equal(
    turnEvidence([
      observed,
      shell("git -C '/actual repo' push origin main", "Everything up-to-date\n"),
    ]).pushes[0].cwd,
    "/actual repo",
  );
  assert.equal(
    turnEvidence([
      shell("git ls-remote origin refs/heads/main", `${"b".repeat(40)}\trefs/heads/main\n`),
      shell(preflightCommand, preflightOutput),
      currentPush(),
    ]).pushes[0].commit,
    hash,
    "the immediate observation takes precedence over older observations",
  );
});

test("preflight rejects scripts, state changes, ref overrides and ambiguous Git commands", () => {
  for (const command of [
    preflightCommand.replace("git fetch origin; ", ""),
    preflightCommand.replace("git fetch origin", "git fetch elsewhere"),
    preflightCommand.replace("git fetch origin", "git fetch origin main:refs/remotes/origin/main"),
    preflightCommand.replace(
      "git fetch origin",
      "git -c remote.origin.fetch=+refs/heads/other:refs/remotes/origin/main fetch origin",
    ),
    preflightCommand.replace("git fetch origin", "REMOTE=origin; git fetch $REMOTE"),
    preflightCommand.replace("git fetch origin", "echo ignored; git fetch origin"),
    preflightCommand.replace("git fetch origin", "python3 inspect.py; git fetch origin"),
    preflightCommand.replace("git fetch origin", "git log --format=%H; git fetch origin"),
    preflightCommand.replace("git fetch origin", "git reset --hard HEAD; git fetch origin"),
    preflightCommand.replace("git fetch origin", "git commit -m new; git fetch origin"),
    preflightCommand.replace("git fetch origin", "git -C /other fetch origin"),
    preflightCommand.replace(
      "git merge-base --is-ancestor bbbbbbb HEAD",
      "git merge-base bbbbbbb HEAD",
    ),
    preflightCommand.replace(
      "git merge-base --is-ancestor bbbbbbb origin/main",
      "git merge-base --is-ancestor bbbbbbb other/main",
    ),
    preflightCommand.replace(
      "git rev-parse HEAD origin/main",
      "git rev-parse HEAD origin/main; git rev-parse HEAD origin/main",
    ),
    preflightCommand.replace("git rev-parse HEAD origin/main", "git rev-parse main origin/main"),
    preflightCommand.replace(
      "git rev-parse HEAD origin/main",
      "git rev-parse HEAD origin/main; git fetch origin",
    ),
    preflightCommand.replace("git status --short", "git merge-base --is-ancestor bbbbbbb HEAD"),
    preflightCommand.replace("git status --short", "git config remote.origin.url other"),
    preflightCommand.replace("git status --short", "git status --short; git status --short"),
    preflightCommand.replace(
      "git diff bbbbbbb..HEAD -- README.md",
      "git diff --output=/tmp/log HEAD",
    ),
    `${preflightCommand}; echo ${hash}`,
    `${preflightCommand} || true`,
  ])
    assert.deepEqual(
      turnEvidence([shell(command, preflightOutput), currentPush()]).pushes,
      [],
      command,
    );
});

test("preflight requires matching full hashes at the start and unambiguous successful output", () => {
  for (const output of [
    `${hash}\n${"b".repeat(40)}\n`,
    `${hash}\n`,
    `${hash}\n${hash}\n${hash}\n`,
    `fetch failed\n${preflightOutput}`,
    `${preflightOutput}fatal: fetch failed\n`,
    `${preflightOutput}unattributed output\n`,
    preflightOutput.replaceAll(hash, "aaaaaaa"),
    preflightOutput.replaceAll(hash, "HEAD"),
  ])
    assert.deepEqual(
      turnEvidence([shell(preflightCommand, output), currentPush()]).pushes,
      [],
      output,
    );
  for (const observation of [
    shell(preflightCommand, preflightOutput, { exitCode: 1 }),
    shell(preflightCommand, preflightOutput, { exitCode: null }),
    shell(preflightCommand, preflightOutput, { exitCode: undefined }),
    { ...shell(preflightCommand, preflightOutput), status: "failed" },
    { ...shell(preflightCommand, preflightOutput), error: { message: "failed" } },
  ])
    assert.deepEqual(turnEvidence([observation, currentPush()]).pushes, []);
});

test("preflight cannot cross a tool, source, repository, remote, branch or user turn", () => {
  const observation = shell(preflightCommand, preflightOutput);
  for (const command of [
    "git push other main",
    "git push origin other",
    "git push origin other:main",
    "git push origin HEAD:main",
    "git push origin main:main",
    "git -C /other push origin main",
    "git push --force origin main",
    "git push origin main; git status --short",
    "rg ignored README.md; git push origin main",
    "cd /repo && git push origin main",
  ])
    assert.deepEqual(
      turnEvidence([observation, shell(command, "Everything up-to-date\n")]).pushes,
      [],
      command,
    );
  for (const middle of [
    shell("git status --short", ""),
    shell("git status --short", "", { exitCode: 1 }),
    {
      type: "tool_call",
      callId: "read",
      name: "Read",
      status: "completed",
      error: null,
      detail: { type: "read", path: "README.md" },
    },
  ])
    assert.deepEqual(turnEvidence([observation, middle, currentPush()]).pushes, []);
  assert.deepEqual(
    turnEvidence([currentPush(), observation]).pushes,
    [],
    "a later preflight cannot prove an earlier push",
  );
  assert.deepEqual(
    turnEvidence([
      observation,
      shell("git push origin main", "Everything up-to-date\n", { exitCode: 1 }),
    ]).pushes,
    [],
  );
  assert.deepEqual(
    turnEvidence([
      observation,
      shell("git push origin main", "To example:repo.git\n * [new branch] main -> main\n"),
    ]).pushes,
    [],
  );
  assert.deepEqual(
    readTurn([
      { type: "user_message", text: "old", messageId: "old" },
      observation,
      { type: "user_message", text: "new", messageId: "new" },
      currentPush(),
    ]).evidence.pushes,
    [],
  );
});

test("native Claude Bash uses its completed result when the provider omits numeric exit codes", () => {
  const item = {
    ...shell(`git push origin ${hash}:refs/heads/main`, undefined, {
      exitCode: undefined,
      cwd: undefined,
    }),
    name: "Bash",
  };
  assert.equal(turnEvidence([item], "/repo").pushes[0].commit, hash);
  assert.equal(turnEvidence([item], "/repo").pushes[0].cwd, "/repo");
  for (const invalid of [
    { ...item, name: "shell" },
    { ...item, status: "failed" },
    { ...item, status: "running" },
    { ...item, error: { message: "failed" } },
    { ...item, detail: { ...item.detail, exitCode: null } },
    { ...item, detail: { ...item.detail, exitCode: 1 } },
  ])
    assert.deepEqual(turnEvidence([invalid], "/repo").pushes, []);
});

const rejectedOutput = (source = hash, branch = "main", reason = "non-fast-forward") =>
  `To https://github.com/example/repo.git\n ! [rejected]        ${source} -> ${branch} (${reason})\nerror: failed to push some refs to 'https://github.com/example/repo.git'\nhint: Updates were rejected because the tip of your current branch is behind\n`;
const rejected = (command, output = rejectedOutput(), overrides = {}) => ({
  ...shell(command, output, { exitCode: 1, ...overrides }),
  status: "failed",
  error: { message: "exit 1" },
});

test("an exact commit rejected because the branch moved on is an attempt for the engine to verify", () => {
  const command = `git -C /repo push origin ${hash}:refs/heads/main`;
  const expected = [
    { callId: "push-command", cwd: "/repo", remote: "origin", branch: "main", commit: hash },
  ];
  assert.deepEqual(turnEvidence([rejected(command)]).pushes, expected);
  assert.deepEqual(
    turnEvidence([rejected(command, rejectedOutput(hash, "main", "fetch first"))]).pushes,
    expected,
  );
  // Native Claude Bash: failed status, no numeric exit code, "Exit code 1" prefix.
  const claude = {
    ...rejected(command, `Exit code 1\n${rejectedOutput()}`, {
      exitCode: undefined,
      cwd: undefined,
    }),
    name: "Bash",
  };
  assert.deepEqual(turnEvidence([claude], "/other").pushes, expected);
  // Paseo's recorded Claude failure: no detail output, the text sits in the tool_result error.
  const recorded = {
    type: "tool_call",
    callId: "push-command",
    name: "Bash",
    status: "failed",
    detail: { type: "shell", command },
    error: { type: "tool_result", content: `Exit code 1\n${rejectedOutput()}`, is_error: true },
  };
  assert.deepEqual(turnEvidence([recorded], "/other").pushes, expected);
  assert.deepEqual(
    turnEvidence([{ ...recorded, error: { type: "other", content: rejectedOutput() } }], "/other")
      .pushes,
    [],
  );
  // A later edit still invalidates the attempt.
  assert.deepEqual(
    turnEvidence([rejected(command), { ...shell("x"), detail: { type: "edit" } }]).pushes,
    [],
  );
});

test("other push failures, ambiguous commands and unexplained rejections give no attempt", () => {
  const command = `git push origin ${hash}:refs/heads/main`;
  for (const item of [
    rejected(command, rejectedOutput(hash, "main", "stale info")),
    rejected(command, rejectedOutput(hash, "other")),
    rejected(command, rejectedOutput("b".repeat(40))),
    rejected(command, rejectedOutput().replace(/^To .*\n/, "")),
    rejected(command, `${rejectedOutput()}   bbbbbbb..ccccccc  other -> other\n`),
    rejected(command, "fatal: unable to access 'https://github.com/example/repo.git/'\n"),
    rejected("git push origin main", rejectedOutput("main")),
    rejected(`git push origin ${hash.slice(0, 7)}:main`, rejectedOutput(hash.slice(0, 7))),
    rejected(`git push --force origin ${hash}:main`),
    rejected(`git push origin ${hash}:main other`),
    rejected(`git fetch origin; git push origin ${hash}:main`),
    rejected(`git push origin ${hash}:main || true`),
    rejected(command, rejectedOutput(), { exitCode: null }),
    rejected(command, rejectedOutput(), { exitCode: 128 }),
    { ...rejected(command), status: "running" },
    { ...rejected(command), status: "canceled" },
    { ...rejected(command, rejectedOutput(), { exitCode: undefined }), name: "shell" },
  ])
    assert.deepEqual(turnEvidence([item]).pushes, [], JSON.stringify(item.detail));
});

const loggedCommand =
  'F=/tmp/push-log; git push origin main > $F/push.log 2>&1; e=$?; echo "push exit=$e" | tee $F/push-exit.txt; cat $F/push.log; git ls-remote origin refs/heads/main | tee $F/ls-remote.txt; git status --short --branch | tee $F/status.txt';
const loggedOutput = `push exit=0\nTo example:repo.git\n   bbbbbbb..aaaaaaa  main -> main\n${hash}\trefs/heads/main\n## main...origin/main`;
const loggedShell = (command = loggedCommand, output = loggedOutput) => ({
  ...shell(command, output, { exitCode: undefined, cwd: undefined }),
  name: "Bash",
});

test("Claude logging wrappers produce same-task evidence with the captured push exit and target", () => {
  const result = turnEvidence([loggedShell()], "/repo");
  assert.deepEqual(result.pushes, [
    { callId: "push-command", cwd: "/repo", remote: "origin", branch: "main", commit: "aaaaaaa" },
  ]);
  for (const item of [
    loggedShell(loggedCommand, loggedOutput.replace("push exit=0", "push exit=1")),
    loggedShell(loggedCommand.replace("git push origin", "git push --dry-run origin")),
    loggedShell(loggedCommand.replace("e=$?", "e=0")),
    loggedShell(loggedCommand.replace("cat $F/push.log", "cat /tmp/other.log")),
    loggedShell(loggedCommand, loggedOutput.replace("main -> main", "main -> other")),
    loggedShell(loggedCommand, "push exit=0\nNothing to verify"),
  ])
    assert.deepEqual(turnEvidence([item], "/repo").pushes, [], JSON.stringify(item));
});

test("porcelain push results prove exact commits, branch updates and forced updates", () => {
  for (const [source, flag, summary, commit] of [
    [hash, " ", "bbbbbbb..aaaaaaa", hash],
    [hash, "=", "[up to date]", hash],
    [hash, "*", "[new branch]", hash],
    ["refs/heads/main", " ", "bbbbbbb..aaaaaaa", "aaaaaaa"],
    ["refs/heads/main", "+", "bbbbbbb...aaaaaaa (forced update)", "aaaaaaa"],
  ]) {
    const ref = source === "refs/heads/main" ? "main" : `${source}:refs/heads/main`;
    const evidence = turnEvidence([
      shell(`git push --porcelain origin ${ref}`, porcelain(source, flag, summary)),
    ]);
    assert.deepEqual(evidence.pushes, [
      { callId: "push-command", cwd: "/repo", remote: "origin", branch: "main", commit },
    ]);
  }
});

test("porcelain rejects dry runs, deletions, rejections, mismatched refs and failed tools", () => {
  const command = `git push --porcelain origin ${hash}:refs/heads/main`;
  for (const item of [
    shell(command.replace("--porcelain", "--porcelain --dry-run"), porcelain()),
    shell(command.replace("--porcelain", "-n --porcelain"), porcelain()),
    shell(command, porcelain(hash, "!", "[rejected] (non-fast-forward)")),
    shell(command, porcelain("", "-", "[deleted]")),
    shell(command, porcelain("b".repeat(40))),
    shell(command, porcelain(hash, " ", "bbbbbbb..aaaaaaa", "other")),
    shell(command, porcelain().replace("refs/heads/main", "refs/tags/main")),
    shell(command, porcelain().replace("To example:repo.git\n", "")),
    shell(command, porcelain(hash, " ", "unrecognized")),
    shell(command, porcelain(), { exitCode: 1 }),
    shell(command, porcelain(), { exitCode: null }),
    { ...shell(command, porcelain()), status: "failed" },
    shell(`${command} || true`, porcelain()),
  ])
    assert.deepEqual(turnEvidence([item]).pushes, [], JSON.stringify(item));
});

test("porcelain branch pushes require matching remote observations for current and new refs", () => {
  const read = shell("git ls-remote origin refs/heads/main", `${hash}\trefs/heads/main\n`);
  for (const [flag, summary] of [
    ["=", "[up to date]"],
    ["*", "[new branch]"],
  ]) {
    const push = shell(
      "git push -u --porcelain origin main",
      porcelain("refs/heads/main", flag, summary),
    );
    assert.deepEqual(turnEvidence([push]).pushes, []);
    assert.equal(turnEvidence([push, read]).pushes[0].commit, hash);
    assert.deepEqual(
      turnEvidence([push, { ...read, detail: { ...read.detail, cwd: "/other" } }]).pushes,
      [],
    );
    assert.deepEqual(
      turnEvidence([push, shell('git commit -m "new"', "new commit"), read]).pushes,
      [],
    );
    if (flag === "*") assert.deepEqual(turnEvidence([read, push]).pushes, []);
    else assert.equal(turnEvidence([read, push]).pushes[0].commit, hash);
  }
});

test("observes exact push commands and their result, including quoted cwd and && checks", () => {
  const result = turnEvidence([
    shell(
      `git -C '/actual repo' push origin ${hash}:refs/heads/main && git ls-remote origin refs/heads/main`,
    ),
    assistant("푸시 완료\n작업상태: 푸시"),
  ]);
  assert.deepEqual(result.pushes, [
    { callId: "push-command", cwd: "/actual repo", remote: "origin", branch: "main", commit: hash },
  ]);
  assert.equal(result.changed, false);
  assert.equal(result.report, "푸시 완료\n작업상태: 푸시");
  assert.equal(turnEvidence([shell("git push -u origin main")]).pushes[0].commit, "aaaaaaa");
  assert.equal(
    turnEvidence([shell(`cd child && git push origin ${hash}:refs/heads/main`)]).pushes[0].cwd,
    "/repo/child",
  );
  assert.equal(
    turnEvidence(
      [shell(`git push origin ${hash}:refs/heads/main`, undefined, { cwd: undefined })],
      "/agent/repo",
    ).pushes[0].cwd,
    "/agent/repo",
  );
  assert.equal(
    turnEvidence([shell(`git push origin ${hash}:refs/heads/main`, "Everything up-to-date\n")])
      .pushes[0].commit,
    hash,
  );
});

test("claims, dry runs, failed or masked commands, unrelated branches and unknown output give no receipt", () => {
  for (const item of [
    assistant("git push origin main\n작업상태: 푸시"),
    shell("git push --dry-run origin main"),
    shell("git push -n origin main"),
    shell("git push origin main || true"),
    shell("git push origin main; true"),
    shell(
      `git push origin ${hash}:main; git status`,
      `To example:repo.git\n ! [rejected]        ${hash} -> main (non-fast-forward)\n`,
    ),
    shell("git push origin main\ntrue"),
    shell('echo "git push origin main"'),
    shell("git push origin other"),
    shell("git push origin main", "Everything up-to-date\n"),
    shell("git push origin main", undefined, { exitCode: 1 }),
    shell("git push origin main", undefined, { exitCode: null }),
    { ...shell("git push origin main"), status: "failed" },
  ])
    assert.deepEqual(turnEvidence([item]).pushes, [], JSON.stringify(item));
});

test("already-up-to-date pushes use exact remote observations from the same turn and handle command lists", () => {
  const observed = `${hash}\trefs/heads/main\n`;
  for (const separator of ["; ", "\n", " && "]) {
    const result = turnEvidence([
      shell(
        `git show -s --format='%H %s' ${hash}${separator}git push origin main${separator}git ls-remote --heads origin main`,
        `${hash} work\nEverything up-to-date\n${observed}`,
      ),
    ]);
    assert.equal(result.pushes[0].commit, hash);
  }
  const failedAncestry = {
    ...shell(
      `git push origin main; git ls-remote --heads origin refs/heads/main; git merge-base --is-ancestor bbbbbbb HEAD`,
      `Everything up-to-date\n${observed}`,
      { exitCode: 1 },
    ),
    status: "failed",
    error: { message: "Tool call failed" },
  };
  assert.deepEqual(turnEvidence([failedAncestry]).pushes, []);
  const retry = shell(
    `git log -4 --oneline -- code.py; rg -n 'kept_report_only' code.py; git push origin main`,
    "aaaaaaa fix\n82:kept_report_only\nEverything up-to-date\n",
  );
  assert.equal(turnEvidence([failedAncestry, retry]).pushes[0].commit, hash);
  assert.deepEqual(turnEvidence([retry]).pushes, []);
});

test("remote observations cannot cross repositories, remotes, branches, edits or user turns", () => {
  const read = shell("git ls-remote origin refs/heads/main", `${hash}\trefs/heads/main\n`);
  for (const push of [
    shell("git push other main", "Everything up-to-date\n"),
    shell("git push origin next", "Everything up-to-date\n"),
    shell("git -C /other push origin main", "Everything up-to-date\n"),
    shell('echo "Everything up-to-date"; git push origin main', "Everything up-to-date\n"),
    shell("git push --dry-run origin main", "Everything up-to-date\n"),
  ])
    assert.deepEqual(turnEvidence([read, push]).pushes, []);
  const push = shell("git push origin main", "Everything up-to-date\n");
  assert.deepEqual(
    turnEvidence([read, shell('git commit -m "new"', "new commit"), push]).pushes,
    [],
  );
  assert.deepEqual(
    readTurn([
      { type: "user_message", text: "old", messageId: "old" },
      read,
      { type: "user_message", text: "new", messageId: "new" },
      push,
    ]).evidence.pushes,
    [],
  );
});

test("a later separate verification resolves an already-current or first branch push without guessing HEAD", () => {
  const read = shell("git ls-remote origin refs/heads/main", `${hash}\trefs/heads/main\n`);
  for (const output of [
    "Everything up-to-date\n",
    "To example:repo.git\n * [new branch] main -> main\n",
  ]) {
    const push = shell("git push -u origin main", output);
    assert.deepEqual(turnEvidence([push]).pushes, []);
    assert.equal(turnEvidence([push, read]).pushes[0].commit, hash);
    assert.deepEqual(
      turnEvidence([push, shell('git commit -m "new work"', "new commit"), read]).pushes,
      [],
    );
  }
  const firstPush = shell(
    "git push -u origin main",
    "To example:repo.git\n * [new branch] main -> main\n",
  );
  assert.deepEqual(
    turnEvidence([read, firstPush]).pushes,
    [],
    "old observations cannot prove a new branch tip",
  );
  assert.equal(
    turnEvidence([
      shell(
        "git push -u origin main; git ls-remote origin refs/heads/main",
        `To example:repo.git\n * [new branch] main -> main\n${hash}\trefs/heads/main\n`,
      ),
    ]).pushes[0].commit,
    hash,
  );
});

test("later writes and new commits invalidate an earlier push; a subsequent push proves the new commit", () => {
  const write = {
    type: "tool_call",
    callId: "edit",
    status: "completed",
    error: null,
    detail: { type: "edit", filePath: "/repo/app.ts" },
  };
  const push = shell(`git push origin ${hash}:refs/heads/main`);
  for (const change of [write, shell('git commit -m "new work"', "[main bbbbbbb] new work")]) {
    const after = turnEvidence([push, change]);
    assert.equal(after.changed, true);
    assert.deepEqual(after.pushes, []);
    assert.equal(turnEvidence([change, push]).pushes.length, 1);
  }
});

test("old user turns cannot lend a push to a new approval request", () => {
  const turn = readTurn([
    { type: "user_message", text: "푸시", messageId: "approved-old" },
    shell(`git push origin ${hash}:refs/heads/main`),
    assistant("작업상태: 푸시"),
    { type: "user_message", text: "자동 업데이트도 추가해", messageId: "new-work" },
    assistant(
      "Windows·Mac 자동 업데이트를 커밋했습니다. origin에 feature/github-updates를 푸시하고 CI 통과 후 배포까지 진행할까요?",
    ),
  ]);
  assert.deepEqual(turn.evidence.pushes, []);
  assert.equal(pushPending(turn.evidence.report), true);
});

test("final pending language is separate from earlier successes and installation-only notes", () => {
  for (const report of [
    "검증 끝. 커밋을 푸시할까요?",
    "아직 푸시하지 않았습니다.",
    "git push: 미실행, 사용자 명시적 승인 대기.",
    "이번 개선을 함께 반영하는 --force-with-lease 푸시를 승인하시겠습니까?",
    "원격 반영은 보류했습니다. 이 푸시는 별도 승인이 필요합니다.",
    "Push approval pending.",
  ])
    assert.equal(pushPending(report), true, report);
  for (const report of [
    "승인한 커밋을 푸시했고 원격 반영까지 확인했습니다.\n작업상태: 푸시",
    "추가 푸시는 하지 않았고 같은 코드를 설치했습니다.",
    "```\n푸시할까요?\n```\n푸시 완료했습니다.",
    "푸시 완료.\n\n다음 릴리스 배포는 별도 승인이 필요합니다.",
  ])
    assert.equal(pushPending(report), false, report);
});
