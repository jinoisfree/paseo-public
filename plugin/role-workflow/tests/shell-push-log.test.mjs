import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLoggedPush } from "../server/shell-push-log.ts";

const command =
  'F=/tmp/ddots-final-aee13db9; git push origin main > $F/push.log 2>&1; e=$?; echo "push exit=$e" | tee $F/push-exit.txt; cat $F/push.log; git ls-remote origin refs/heads/main | tee $F/ls-remote.txt; git status --short --branch | tee $F/status-after-push.txt';
const output =
  "push exit=0\nTo https://github.com/jinoisfree/ddots.git\n   8f984bf..2121065  main -> main\n2121065e1b6c6543ccd25624e4765b0c63d68324\trefs/heads/main\n## main...origin/main\n?? paseo.json";
const expected = {
  commands: [
    { cwd: "/repo", args: ["push", "origin", "main"] },
    { cwd: "/repo", args: ["ls-remote", "origin", "refs/heads/main"] },
    { cwd: "/repo", args: ["status", "--short", "--branch"] },
  ],
  pushExitCode: 0,
};

test("recognizes the real Claude redirected push and preserves Git command order", () => {
  assert.deepEqual(parseLoggedPush(command, output, "/repo"), expected);
});

test("supports quoted paths, braced variables, printf and whitespace variants", () => {
  const variants = [
    command.replaceAll("; ", "\n"),
    command.replaceAll("; ", " && "),
    command.replaceAll("$F/", "${F}/"),
    command.replaceAll("$F/", '"$F"/'),
    command
      .replace("F=/tmp/ddots-final-aee13db9", 'F="/tmp/ddots final"')
      .replaceAll(/\$F\/([^ ;]+)/g, '"$F/$1"'),
    command.replace('echo "push exit=$e"', "printf 'push exit=%s\\n' \"$e\""),
    command.replace('echo "push exit=$e"', 'printf "push exit=%d\\n" "${e}"'),
    command.replace('echo "push exit=$e"', "echo push exit=$e"),
    command.replace(" > $F/push.log ", ">$F/push.log "),
    command.replaceAll("tee $F", "tee -- $F").replace("cat $F", "cat -- $F"),
    command.replace("; git push", "; \\\n git push"),
  ];
  for (const variant of variants)
    assert.deepEqual(parseLoggedPush(variant, output, "/repo"), expected, variant);
});

test("tracks cd and git -C without confusing the shell's log directory", () => {
  const variant = `cd '/actual repo' && ${command.replace("git push", "git -C child push")}`;
  assert.deepEqual(parseLoggedPush(variant, output, "/repo"), {
    commands: [
      { cwd: "/actual repo/child", args: ["push", "origin", "main"] },
      { cwd: "/actual repo", args: ["ls-remote", "origin", "refs/heads/main"] },
      { cwd: "/actual repo", args: ["status", "--short", "--branch"] },
    ],
    pushExitCode: 0,
  });
  assert.equal(parseLoggedPush(variant.replace("' && ", "'; "), output, "/repo"), null);
});

test("returns the captured nonzero exit status for the caller to reject", () => {
  assert.equal(
    parseLoggedPush(command, output.replace("exit=0", "exit=1"), "/repo")?.pushExitCode,
    1,
  );
  assert.equal(
    parseLoggedPush(command, output.replace("exit=0", "exit=255"), "/repo")?.pushExitCode,
    255,
  );
});

test("requires one exact captured exit marker in the output", () => {
  for (const invalid of [
    output.replace("push exit=0\n", ""),
    `${output}\npush exit=0`,
    output.replace("exit=0", "exit=256"),
    output.replace("exit=0", "exit=00"),
    output.replace("exit=0", "exit=-1"),
    output.replace("exit=0", "exit=0 extra"),
  ])
    assert.equal(parseLoggedPush(command, invalid, "/repo"), null, invalid);
});

test("rejects fabricated status, overwritten variables and mismatched or rewritten logs", () => {
  const variants = [
    command.replace('echo "push exit=$e"', 'echo "push exit=0"'),
    command.replace("e=$?", "e=0"),
    command.replace("e=$?", "true; e=$?"),
    command.replace("e=$?;", "e=$?; e=0;"),
    command.replace("e=$?", "e=$? e=0"),
    command.replace("cat $F/push.log", "cat $F/old.log"),
    command.replace("tee $F/push-exit.txt", "tee $F/push.log"),
    command.replace("tee $F/status-after-push.txt", "tee $F/push.log"),
    command.replace("e=$?;", "e=$?; F=/tmp/other;"),
    command.replace("; git push", "; F=/tmp/other; git push"),
    command.replace('echo "push exit=$e"', 'printf "push exit=0\\n" "$e"'),
    command.replace('echo "push exit=$e"', 'echo "push exit=$e $e"'),
    command.replace('echo "push exit=$e"', 'echo -e "push exit=$e"'),
    command.replace('echo "push exit=$e"', 'echo "push exit=$e\nTo fake"'),
    command.replace("; cat $F/push.log", "; echo 'To fake'; cat $F/push.log"),
    command.replace("e=$?", "e=$? | tee $F/captured"),
    command.replace("2>&1; e=$?", "2>&1 && e=$?"),
    command.replace("2>&1; e=$?;", "2>&1 && e=$? &&"),
    command.replace("e=$?", '"e="${?}'),
    command.replace("e=$?", '"e"=$?'),
    command.replace("e=$?", "'e='$?"),
  ];
  for (const variant of variants)
    assert.equal(parseLoggedPush(variant, output, "/repo"), null, variant);
});

test("rejects shell execution, swallowed failures, unsupported redirects and multiple pushes", () => {
  const variants = [
    command.replace("main >", "main || true >"),
    command.replace("main >", "main; true >"),
    command.replace("e=$?", "e=$(echo 0)"),
    command.replace("e=$?", "e=`echo 0`"),
    command.replace("F=/tmp/ddots-final-aee13db9", "F=$(mktemp -d)"),
    command.replace("F=/tmp/ddots-final-aee13db9", "F=$OTHER"),
    command.replace("F=/tmp/ddots-final-aee13db9", "F=${OTHER:-/tmp/log}"),
    command.replace("git push", "if git push"),
    command.replace("git push", "git -c alias.push=fake push"),
    command.replace(" > ", " >> "),
    command.replace(" 2>&1", ""),
    command.replace(" > $F/push.log 2>&1", " 2>&1 > $F/push.log"),
    command.replace("git status --short --branch", "git push origin main"),
    command.replace("git status --short --branch", "git commit -m changed"),
    command.replace("git status --short --branch", "git config alias.push fake"),
    `${command}; echo 'push exit=0'`,
    `${command} &&`,
    command.replace("cat $F/push.log", "cat /tmp/*/push.log"),
    command.replace("F=/tmp/ddots-final-aee13db9", 'F="/tmp/spaced path"'),
    command.replace("F=/tmp/ddots-final-aee13db9", '"F=/tmp/ddots-final-aee13db9"'),
    command.replace("F=/tmp/ddots-final-aee13db9", "'F'=/tmp/ddots-final-aee13db9"),
    command.replace("git push", "$G push").replace("F=", "G=git; F="),
    ...["PATH", "IFS", "ENV", "BASH_ENV", "ZDOTDIR", "GIT_EXEC_PATH"].map(
      (name) => `${name}=/tmp/unsafe; ${command}`,
    ),
  ];
  for (const variant of variants)
    assert.equal(parseLoggedPush(variant, output, "/repo"), null, variant);
});
