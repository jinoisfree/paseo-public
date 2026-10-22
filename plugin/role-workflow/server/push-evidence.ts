import path from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { parseLoggedPush } from "./shell-push-log";

export interface PushExecution {
  callId: string;
  cwd: string;
  remote: string;
  branch: string;
  commit: string;
}
export interface TurnEvidence {
  report: string;
  changed: boolean;
  pushes: PushExecution[];
}

/** Tokenize quoted arguments and simple command lists, without executing shell syntax. */
function commands(command: string): string[][] {
  const result: string[][] = [[]];
  const pattern = /([ \t\r]+)|(&&|;|\n)|((?:'[^']*'|"[^"\\$`]*"|[^\s"';&|<>\\$`#(){}])+)/gy;
  let offset = 0;
  while (offset < command.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(command);
    if (!match) return [];
    offset = pattern.lastIndex;
    if (match[2]) result.push([]);
    if (match[3])
      result.at(-1)!.push(match[3].replace(/'([^']*)'|"([^"]*)"/g, (_, a, b) => a ?? b));
  }
  return result.filter((tokens) => tokens.length);
}

function gitCommand(tokens: string[], directory: string) {
  if (tokens[0] !== "git") return null;
  if (tokens[1] !== "-C") return { cwd: directory, args: tokens.slice(1) };
  if (!tokens[2]) return null;
  return { cwd: path.resolve(directory, tokens[2]), args: tokens.slice(3) };
}

function porcelainHash(source: string, branch: string, output: string, known?: string) {
  const exact = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(source);
  // --porcelain prints flag<TAB>source:destination<TAB>summary, not "source -> destination".
  // Match both refs and the successful flag before trusting an exact source hash.
  if (!/^To\s+\S+/m.test(output)) return null;
  const rows = output.split("\n").flatMap((line) => {
    const match = /^([ *+=!-])\t([^:\s]*):([^\s]+)\t(.+?)\r?$/.exec(line);
    return match?.[3] === `refs/heads/${branch}` ? [match] : [];
  });
  if (rows.length !== 1) return null;
  const [, flag, from, , summary] = rows[0];
  if (from !== source && from !== `refs/heads/${source}`) return null;
  if (flag === "=" && summary === "[up to date]") return exact ? source : (known ?? "");
  if (flag === "*" && summary === "[new branch]") return exact ? source : "";
  if (flag !== " " && flag !== "+") return null;
  const hash = /^([a-f0-9]+)\.{2,3}([a-f0-9]{7,64})(?: \(forced update\))?$/.exec(summary)?.[2];
  if (!hash) return null;
  return exact ? source : hash;
}

function pushedHash(
  source: string,
  branch: string,
  output: string,
  known?: string,
  porcelain = false,
) {
  const exact = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(source);
  if (porcelain) return porcelainHash(source, branch, output, known);
  if (/^Everything up-to-date\s*$/m.test(output)) return exact ? source : (known ?? "");
  // A successful process alone is not enough: require Git's actual update line.
  const update = output.split("\n").find((line) => {
    const match = /(?:^|\s)(\S+)\s+->\s+(\S+)(?:\s|$)/.exec(line);
    return match?.[2]?.replace(/^refs\/heads\//, "") === branch;
  });
  if (!update || !/^To\s+\S+/m.test(output)) return null;
  if (!exact && /\[new branch\]/.test(update)) return "";
  return exact ? source : /(?:^|\s)[a-f0-9]+\.{2,3}([a-f0-9]{7,64})(?:\s|$)/.exec(update)?.[1];
}

interface RemoteRef {
  commit: string;
  at: number;
}
interface PushPreflight extends RemoteRef {
  cwd: string;
  remote: string;
  branch: string;
}
function pushArguments(args: string[], output: string, known: Map<string, RemoteRef>, cwd: string) {
  if (args[0] !== "push") return null;
  let index = 1;
  while (
    ["-u", "--set-upstream", "-f", "--force", "--force-with-lease", "--porcelain"].includes(
      args[index],
    ) ||
    args[index]?.startsWith("--force-with-lease=")
  )
    index++;
  const [remote, ref, ...extra] = args.slice(index);
  if (!remote || !ref || extra.length || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(remote)) return null;
  const [source, destination = source, ...more] = ref.split(":");
  if (!source || source.startsWith("-") || more.length) return null;
  const branch = destination.replace(/^refs\/heads\//, "");
  if (!branch || branch === "HEAD" || branch.startsWith("-") || branch.includes("*")) return null;
  const commit = pushedHash(
    source,
    branch,
    output,
    known.get(refKey(cwd, remote, branch))?.commit,
    args.slice(1, index).includes("--porcelain"),
  );
  return commit == null ? null : { remote, branch, commit };
}

const readCommands = new Set([
  "status",
  "log",
  "show",
  "remote",
  "ls-remote",
  "rev-parse",
  "config",
  "merge-base",
]);
const refKey = (cwd: string, remote: string, branch: string) =>
  JSON.stringify([path.resolve(cwd), remote, branch]);

function safeCommands(command: string, cwd: string) {
  const parsed = commands(command);
  // Mixed output is attributable only when the batch contains one push and ordinary reads.
  // In particular, echo/printf, conditionals and swallowed failures cannot manufacture evidence.
  const git: { cwd: string; args: string[] }[] = [];
  for (const tokens of parsed) {
    if (tokens[0] === "cd" && tokens.length === 2 && !/[;\n]/.test(command)) {
      cwd = path.resolve(cwd, tokens[1]);
      continue;
    }
    const entry = gitCommand(tokens, cwd);
    if (!entry && tokens[0] === "rg") continue;
    if (!entry || (!["push", "commit"].includes(entry.args[0]) && !readCommands.has(entry.args[0])))
      return [];
    git.push(entry);
  }
  return git.filter((entry) => entry.args[0] === "push").length > 1 ? [] : git;
}

function remoteRefs(
  parsed: ReturnType<typeof safeCommands>,
  output: string,
  known: Map<string, RemoteRef>,
  at: number,
) {
  const queries = parsed.filter((entry) => entry.args[0] === "ls-remote");
  if (queries.length !== 1) return;
  const query = queries[0];
  const remote = query.args.slice(1).find((arg) => !["--heads", "--exit-code"].includes(arg));
  if (!remote || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(remote)) return;
  for (const match of output.matchAll(
    /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\s+refs\/heads\/(\S+)\s*$/gm,
  ))
    known.set(refKey(query.cwd, remote, match[2]), {
      commit: match[1],
      at: at + parsed.indexOf(query) / (parsed.length + 1),
    });
}

function successfulShell(item: Extract<AgentTimelineItem, { type: "tool_call" }>) {
  const detail = item.detail;
  if (detail?.type !== "shell" || item.status !== "completed" || item.error) return false;
  // Native Claude Bash maps is_error to status and omits the numeric exitCode.
  // Explicit unknown/null exits and failures from any provider still cannot prove a push.
  return (
    detail.exitCode === 0 || (detail.exitCode === undefined && ["Bash", "bash"].includes(item.name))
  );
}

function preflightBefore(args: string[], remoteRef: string) {
  return (
    args.length === 4 &&
    args[0] === "merge-base" &&
    args[1] === "--is-ancestor" &&
    /^[a-f0-9]{7,64}$/.test(args[2]) &&
    ["HEAD", remoteRef].includes(args[3])
  );
}

function preflightAfter(args: string[]) {
  if (args.length === 2 && args[0] === "status" && args[1] === "--short") return true;
  return (
    args.length >= 4 &&
    args[0] === "diff" &&
    /^[a-f0-9]{7,64}\.\.HEAD$/.test(args[1]) &&
    args[2] === "--" &&
    args.slice(3).every((arg) => !!arg && !arg.startsWith(":"))
  );
}

function preflightTail(output: string, trailing: { args: string[] }[]) {
  let diff = false;
  const hasStatus = trailing.some((entry) => entry.args[0] === "status");
  const hasDiff = trailing.some((entry) => entry.args[0] === "diff");
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    if (/^diff --git a\/.+ b\/.+$/.test(line) && hasDiff) {
      diff = true;
      continue;
    }
    if (!diff) {
      if (!hasStatus || !/^[ MADRCU?!]{2} .+$/.test(line)) return false;
    } else if (
      !/^(?:[ +@-]|index [a-f0-9]+\.\.[a-f0-9]+|(?:old|new|new file|deleted file) mode |(?:dis)?similarity index |(?:rename|copy) (?:from|to) |Binary files |\\ No newline at end of file)/.test(
        line,
      )
    )
      return false;
  }
  return true;
}

/**
 * A narrowly scoped historical preflight, never a general HEAD or remote lookup.
 * Ordinary Git remote-tracking configuration is assumed; the engine still verifies
 * the recorded target against its real remote. Silent ancestry checks are not used
 * as successful ancestry proof. No arbitrary script output or later read can qualify.
 */
function pushPreflight(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
  at: number,
  defaultCwd?: string,
): PushPreflight | null {
  if (!successfulShell(item) || item.detail.type !== "shell") return null;
  const detail = item.detail;
  const cwd = detail.cwd ?? defaultCwd;
  if (!cwd) return null;
  const entries = commands(detail.command).map((tokens) => gitCommand(tokens, cwd));
  if (!entries.length || entries.some((entry) => !entry)) return null;
  const parsed = entries as { cwd: string; args: string[] }[];
  const query = parsed.filter((entry) => entry.args[0] === "rev-parse");
  if (query.length !== 1 || query[0].args.length !== 3 || query[0].args[1] !== "HEAD") return null;
  const ref = query[0].args[2];
  const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_./-]*)$/.exec(ref);
  if (!match || /\.\.|\.lock(?:\/|$)|[/.]$/.test(match[2])) return null;
  return observedPreflight(parsed, query[0], match[1], match[2], detail.output ?? "", at);
}

function observedPreflight(
  parsed: { cwd: string; args: string[] }[],
  query: { cwd: string; args: string[] },
  remote: string,
  branch: string,
  output: string,
  at: number,
): PushPreflight | null {
  const first = parsed[0];
  const index = parsed.indexOf(query);
  if (first.args.join("\0") !== `fetch\0${remote}` || index === 0) return null;
  if (parsed.some((entry) => path.resolve(entry.cwd) !== path.resolve(query.cwd))) return null;
  if (!parsed.slice(1, index).every((entry) => preflightBefore(entry.args, `${remote}/${branch}`)))
    return null;
  const trailing = parsed.slice(index + 1);
  if (trailing.length > 2 || !trailing.every((entry) => preflightAfter(entry.args))) return null;
  if (trailing.length === 2 && trailing[0].args[0] !== "status") return null;
  if (new Set(trailing.map((entry) => entry.args[0])).size !== trailing.length) return null;
  const hashes = /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\r?\n\1(?:\r?\n|$)/.exec(output);
  if (!hashes || !preflightTail(output.slice(hashes[0].length), trailing)) return null;
  return { cwd: path.resolve(query.cwd), remote, branch, commit: hashes[1], at };
}

function preflightPush(
  command: string,
  parsed: ReturnType<typeof safeCommands>,
  output: string,
  observation: PushPreflight | null,
  at: number,
) {
  if (!observation || observation.at >= at || parsed.length !== 1 || commands(command).length !== 1)
    return null;
  const entry = parsed[0];
  if (path.resolve(entry.cwd) !== observation.cwd || output.trim() !== "Everything up-to-date")
    return null;
  return entry.args.join("\0") === `push\0${observation.remote}\0${observation.branch}`
    ? observation.commit
    : null;
}

/** Git's own report that only a moved-on branch stopped this exact commit. */
function rejectedOnlyBehind(output: string, commit: string, branch: string) {
  const rows = output.split("\n").filter((line) => /\s->\s/.test(line));
  const rejected = new RegExp(
    `^ ! \\[rejected\\]\\s+${commit}\\s+->\\s+${branch.replace(/[.]/g, "\\.")}\\s+\\((?:non-fast-forward|fetch first)\\)\\r?$`,
  );
  return /^To\s+\S+/m.test(output) && rows.length === 1 && rejected.test(rows[0]);
}

/** Native Claude Bash failures carry their output in the tool_result error, not the detail. */
function failureOutput(item: Extract<AgentTimelineItem, { type: "tool_call" }>) {
  if (item.detail.type === "shell" && item.detail.output) return item.detail.output;
  const error = item.error as { type?: unknown; content?: unknown } | null;
  return error?.type === "tool_result" && typeof error.content === "string" ? error.content : "";
}

function failedExit(item: Extract<AgentTimelineItem, { type: "tool_call" }>) {
  const detail = item.detail;
  if (detail?.type !== "shell" || item.status === "running" || item.status === "canceled")
    return false;
  if (successfulShell(item)) return false;
  // Native Claude Bash reports a failed status without a numeric exit code.
  return (
    detail.exitCode === 1 ||
    (detail.exitCode === undefined &&
      item.status === "failed" &&
      ["Bash", "bash"].includes(item.name))
  );
}

/**
 * A standalone push of an exact commit that Git rejected only because the branch had
 * moved on. It proves the approved attempt, not inclusion: the engine still requires the
 * real remote branch to equal or contain this commit before showing it as pushed.
 */
function rejectedPush(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
  defaultCwd?: string,
): PushExecution | null {
  const detail = item.detail;
  if (!failedExit(item) || detail.type !== "shell") return null;
  const directory = detail.cwd ?? defaultCwd;
  if (!directory || commands(detail.command).length !== 1) return null;
  const parsed = safeCommands(detail.command, directory);
  if (parsed.length !== 1) return null;
  const [verb, remote, ref, ...extra] = parsed[0].args;
  if (verb !== "push" || !remote || !ref || extra.length) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(remote)) return null;
  const match =
    /^([a-f0-9]{40}(?:[a-f0-9]{24})?):(?:refs\/heads\/)?([A-Za-z0-9][A-Za-z0-9_./-]*)$/.exec(ref);
  if (!match || !rejectedOnlyBehind(failureOutput(item), match[1], match[2])) return null;
  return { callId: item.callId, cwd: parsed[0].cwd, remote, branch: match[2], commit: match[1] };
}

function shellEvidence(
  evidence: TurnEvidence,
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
  known: Map<string, RemoteRef>,
  deferred: Map<PushExecution, number>,
  at: number,
  defaultCwd?: string,
  preflight: PushPreflight | null = null,
) {
  const detail = item.detail;
  if (detail?.type !== "shell") return;
  const directory = detail.cwd ?? defaultCwd;
  if (!directory) return;
  const logged = parseLoggedPush(detail.command, detail.output ?? "", directory);
  const parsed = logged?.commands ?? safeCommands(detail.command, directory);
  // A later ancestry check may fail after ls-remote returned its exact reference.
  // This captures only an immutable read result; failed tools never prove a push.
  remoteRefs(parsed, detail.output ?? "", known, at);
  if (!successfulShell(item)) return;
  if (logged && logged.pushExitCode !== 0) return;
  const observed = preflightPush(detail.command, parsed, detail.output ?? "", preflight, at);
  for (const git of parsed) {
    if (git.args[0] === "commit") {
      evidence.changed = true;
      evidence.pushes = [];
      known.clear();
    }
    const pushed = pushArguments(git.args, detail.output ?? "", known, git.cwd);
    if (pushed) {
      const execution = {
        callId: item.callId,
        cwd: git.cwd,
        ...pushed,
        commit: observed ?? pushed.commit,
      };
      evidence.pushes.push(execution);
      if (!execution.commit)
        deferred.set(execution, at + parsed.indexOf(git) / (parsed.length + 1));
    }
  }
}

/** Only successful tools in this user turn count. Later edits invalidate earlier pushes. */
export function turnEvidence(
  items: readonly AgentTimelineItem[],
  defaultCwd?: string,
): TurnEvidence {
  const evidence: TurnEvidence = { report: "", changed: false, pushes: [] };
  const known = new Map<string, RemoteRef>();
  const deferred = new Map<PushExecution, number>();
  let preflight: PushPreflight | null = null;
  for (const [index, item] of items.entries()) {
    if (item.type === "assistant_message") evidence.report = item.text;
    if (item.type !== "tool_call") continue;
    const previous = preflight;
    preflight = pushPreflight(item, index, defaultCwd);
    // Only the immediately following tool may consume this observation. It never
    // enters known/deferred, so later queries cannot retroactively prove a push.
    shellEvidence(evidence, item, known, deferred, index, defaultCwd, previous);
    const attempt = rejectedPush(item, defaultCwd);
    if (attempt) evidence.pushes.push(attempt);
    if (item.status !== "completed" || item.error) continue;
    if (item.detail.type === "edit" || item.detail.type === "write") {
      evidence.changed = true;
      evidence.pushes = [];
      known.clear();
    }
  }
  // A separate verification command often follows an already-current or first branch push.
  // Resolve only from a later observation in this turn, never the current checkout's HEAD.
  for (const execution of evidence.pushes) {
    const ref = known.get(refKey(execution.cwd, execution.remote, execution.branch));
    if (!execution.commit && ref && ref.at > (deferred.get(execution) ?? Infinity))
      execution.commit = ref.commit;
  }
  evidence.pushes = evidence.pushes.filter((execution) => !!execution.commit);
  return evidence;
}

/** A final approval request overrides stale success text in earlier commentary. */
export function pushPending(report: string): boolean {
  const prose = report
    .replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, "")
    .replace(/<paseo-workflow>[^]*?(?:<\/paseo-workflow>|$)/g, "")
    .replace(/[*_`]/g, "");
  return (
    /(?:푸시|git\s+push)[^\n.!?]{0,180}(?:할까요|진행할까요|승인하시겠|승인해\s*주|승인(?:을|이)?\s*(?:필요|기다|대기)|승인이\s*필요|미실행|보류|전입니다)/i.test(
      prose,
    ) ||
    /(?:아직|승인\s*전)[^\n.!?]{0,50}(?:푸시|원격\s*반영)[^\n.!?]{0,40}(?:않|안\s*했|보류)/.test(
      prose,
    ) ||
    /(?:push(?:ing)?\s+(?:approval|permission)|awaiting\s+.*push|not\s+(?:yet\s+)?pushed)/i.test(
      prose,
    )
  );
}
