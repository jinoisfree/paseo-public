import path from "node:path";

type Piece = { text: string } | { variable: string; quoted: boolean };
interface Word {
  pieces: Piece[];
  raw?: string;
}
type Token = Word | ";" | "&&" | "|" | ">" | "2>&1";
interface GitCommand {
  cwd: string;
  args: string[];
}

function escapeSequence(source: string, index: number, quote: string) {
  const next = source[index + 1];
  if (!quote) return next === "\n" ? { text: "", skip: 1 } : null;
  if (next && ['"', "\\", "$"].includes(next)) return { text: next, skip: 1 };
  return { text: "\\", skip: 0 };
}

function operator(
  source: string,
  index: number,
  active: boolean,
): { token?: Exclude<Token, Word>; skip: number } | null {
  const char = source[index];
  if (!active && source.startsWith("2>&1", index)) return { token: "2>&1" as const, skip: 3 };
  if (char === "&") return source[index + 1] === "&" ? { token: "&&" as const, skip: 1 } : null;
  if (char === "|" && source[index + 1] === "|") return null;
  if (/[<(){}#*?[\]~]/.test(char)) return null;
  if (char === ";" || char === "\n" || char === "|" || char === ">")
    return { token: char === "\n" ? (";" as const) : char, skip: 0 };
  return { token: undefined, skip: 0 };
}

function expansion(source: string) {
  const match = /^(?:\$([A-Za-z_][A-Za-z_0-9]*|\?)|\$\{([A-Za-z_][A-Za-z_0-9]*)\})/.exec(source);
  return match ? { variable: match[1] ?? match[2], length: match[0].length } : null;
}

/** A deliberately small shell lexer. No commands or substitutions are ever evaluated. */
function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let pieces: Piece[] = [];
  let active = false;
  let quote = "";
  let wordStart = 0;
  let index = 0;
  const append = (text: string) => {
    active = true;
    const previous = pieces.at(-1);
    if (previous && "text" in previous) previous.text += text;
    else pieces.push({ text });
  };
  const flush = () => {
    if (active) tokens.push({ pieces, raw: source.slice(wordStart, index) });
    pieces = [];
    active = false;
  };
  for (; index < source.length; index++) {
    if (!active) wordStart = index;
    const char = source[index];
    if (["`", "\0"].includes(char)) return null;
    if (quote === "'") {
      if (char === "'") quote = "";
      else append(char);
      continue;
    }
    if (char === '"') {
      active = true;
      quote = quote === '"' ? "" : '"';
      continue;
    }
    if (!quote && char === "'") {
      active = true;
      quote = "'";
      continue;
    }
    if (char === "\\") {
      const escaped = escapeSequence(source, index, quote);
      if (!escaped) return null;
      if (escaped.text) append(escaped.text);
      index += escaped.skip;
      continue;
    }
    if (char === "$") {
      const match = expansion(source.slice(index));
      if (!match) return null;
      pieces.push({ variable: match.variable, quoted: !!quote });
      active = true;
      index += match.length - 1;
      continue;
    }
    if (quote) {
      append(char);
      continue;
    }
    if (/[ \t\r]/.test(char)) {
      flush();
      continue;
    }
    const symbol = operator(source, index, active);
    if (!symbol) return null;
    if (symbol.token) {
      flush();
      tokens.push(symbol.token);
      index += symbol.skip;
      continue;
    }
    append(char);
  }
  if (quote) return null;
  flush();
  return tokens;
}

function resolve(word: Word, variables: Map<string, string>): string | null {
  let value = "";
  for (const piece of word.pieces) {
    if ("text" in piece) value += piece.text;
    else {
      const found = variables.get(piece.variable);
      // Unquoted shell expansion would split words and expand globs.
      if (found === undefined || (!piece.quoted && /[\s*?[\]]/.test(found))) return null;
      value += found;
    }
  }
  return value.includes("\0") || /[\r\n]/.test(value) ? null : value;
}

function assignment(word: Word) {
  // Quoting the name or '=' turns this into a command word, not a shell assignment.
  if (!/^[A-Za-z_][A-Za-z_0-9]*=/.test(word.raw ?? "")) return null;
  const [first, ...rest] = word.pieces;
  if (!first || !("text" in first)) return null;
  const match = /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(first.text);
  return match ? { name: match[1], value: { pieces: [{ text: match[2] }, ...rest] } } : null;
}

const reads = new Set(["status", "log", "show", "remote", "ls-remote", "rev-parse", "merge-base"]);
const shellVariables =
  /^(?:PATH|path|FPATH|fpath|CDPATH|cdpath|IFS|ENV|BASH.*|ZDOTDIR|SHELL.*|HOME|GIT_.*|LD_.*|DYLD_.*|RANDOM|SRANDOM|SECONDS|LINENO|EUID|UID|PPID|GROUPS|PIPESTATUS|status|pipestatus|_)$/;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exitPlaceholder = "\0";

function exitMarker(markerWords: Word[], variable: string): string | null {
  const markerWord = (word: Word): string | null => {
    let value = "";
    for (const piece of word.pieces) {
      if ("text" in piece) value += piece.text;
      else if (piece.variable === variable) value += exitPlaceholder;
      else return null;
    }
    return value;
  };
  const args = markerWords.map(markerWord);
  if (args.some((value) => value === null)) return null;
  let marker: string;
  if (args[0] === "echo" && args.length > 1 && !args[1]!.startsWith("-")) {
    marker = args.slice(1).join(" ");
    if (marker.includes("\\")) return null;
  } else if (args[0] === "printf" && args.length === 3 && args[2] === exitPlaceholder) {
    const format = args[1]!;
    if (!format.endsWith("\\n")) return null;
    const body = format.slice(0, -2);
    if (body.includes("\\") || (body.match(/%/g) ?? []).length !== 1 || !/%[sd]/.test(body))
      return null;
    marker = body.replace(/%[sd]/, exitPlaceholder);
  } else return null;
  if (
    marker.split(exitPlaceholder).length !== 2 ||
    /[\r\n]/.test(marker) ||
    !/(?:push|exit|status|code)/i.test(marker)
  )
    return null;
  return marker;
}

type CommandToken = Exclude<Token, ";" | "&&">;
interface Statement {
  tokens: CommandToken[];
  next: string;
}

function statements(tokens: Token[]): Statement[] | null {
  const result: Statement[] = [];
  let current: CommandToken[] = [];
  for (const token of tokens) {
    if (token === ";" || token === "&&") {
      if (!current.length && token === "&&") return null;
      if (current.length) result.push({ tokens: current, next: token });
      current = [];
    } else current.push(token);
  }
  if (current.length) result.push({ tokens: current, next: "" });
  else if (result.at(-1)?.next === "&&") return null;
  return result;
}

function words(tokens: CommandToken[]): Word[] | null {
  return tokens.some((token) => typeof token === "string") ? null : (tokens as Word[]);
}

function literal(word: Word | undefined) {
  return word?.pieces.every((piece) => "text" in piece) ?? false;
}

function argumentsOf(tokens: CommandToken[], variables: Map<string, string>) {
  const parsed = words(tokens);
  if (!parsed || !literal(parsed[0])) return null;
  const args = parsed.map((word) => resolve(word, variables));
  return args.some((arg) => arg === null) ? null : (args as string[]);
}

function singleFileCommand(tokens: CommandToken[], name: string, variables: Map<string, string>) {
  const args = argumentsOf(tokens, variables);
  if (!args) return null;
  if (args[1] === "--") args.splice(1, 1);
  if (args.length !== 2 || args[0] !== name || !args[1] || args[1].startsWith("-")) return null;
  return args[1];
}

function pipeline(tokens: CommandToken[], variables: Map<string, string>) {
  const index = tokens.indexOf("|");
  if (index === -1) return { head: tokens, file: null };
  const file = singleFileCommand(tokens.slice(index + 1), "tee", variables);
  return file ? { head: tokens.slice(0, index), file } : null;
}

function captureVariable(tokens: CommandToken[], variables: Map<string, string>) {
  if (tokens.length !== 1 || typeof tokens[0] === "string") return null;
  const capture = assignment(tokens[0]);
  if (!capture || variables.has(capture.name) || shellVariables.test(capture.name)) return null;
  const pieces = capture.value.pieces;
  if (pieces.length !== 2) return null;
  if (!("text" in pieces[0]) || pieces[0].text !== "") return null;
  if (!("variable" in pieces[1]) || pieces[1].variable !== "?") return null;
  return capture.name;
}

function redirection(tokens: CommandToken[], variables: Map<string, string>) {
  const index = tokens.indexOf(">");
  if (index === -1) return { head: tokens, file: null };
  if (
    tokens.length !== index + 3 ||
    typeof tokens[index + 1] === "string" ||
    tokens[index + 2] !== "2>&1"
  )
    return null;
  const file = resolve(tokens[index + 1] as Word, variables);
  return file && !file.startsWith("-") ? { head: tokens.slice(0, index), file } : null;
}

class LoggedPush {
  variables = new Map<string, string>();
  commands: GitCommand[] = [];
  teeFiles: string[] = [];
  cwd: string;
  log = "";
  captured = "";
  marker = "";
  conditionalCapture = false;
  phase: "scan" | "capture" | "marker" | "log" = "scan";
  printed = false;

  constructor(cwd: string) {
    this.cwd = path.resolve(cwd);
  }

  step(statement: Statement) {
    const pipe = pipeline(statement.tokens, this.variables);
    if (!pipe) return false;
    if (pipe.file) this.teeFiles.push(path.resolve(this.cwd, pipe.file));
    const { head } = pipe;
    const next = statement.next;
    switch (this.phase) {
      case "capture": {
        if (pipe.file || (this.conditionalCapture && next !== "&&")) return false;
        this.captured = captureVariable(head, this.variables) ?? "";
        this.phase = "marker";
        return !!this.captured;
      }
      case "marker": {
        const parsed = words(head);
        if (!parsed || (this.conditionalCapture && next !== "&&")) return false;
        this.marker = exitMarker(parsed, this.captured) ?? "";
        this.phase = "log";
        return !!this.marker;
      }
      case "log": {
        if (pipe.file) return false;
        const file = singleFileCommand(head, "cat", this.variables);
        if (!file || path.resolve(this.cwd, file) !== this.log) return false;
        this.printed = true;
        this.phase = "scan";
        return true;
      }
      default:
        return this.scan(head, next, !!pipe.file);
    }
  }

  assign(tokens: CommandToken[], piped: boolean) {
    if (tokens.length !== 1 || typeof tokens[0] === "string") return null;
    const assign = assignment(tokens[0]);
    if (!assign) return null;
    if (this.log || piped || this.variables.has(assign.name) || shellVariables.test(assign.name))
      return false;
    if (!literal(assign.value)) return false;
    const value = resolve(assign.value, this.variables);
    if (!value || /[$`]/.test(value)) return false;
    this.variables.set(assign.name, value);
    return true;
  }

  scan(tokens: CommandToken[], next: string, piped: boolean): boolean {
    const assigned = this.assign(tokens, piped);
    if (assigned !== null) return assigned;
    const redirect = redirection(tokens, this.variables);
    if (!redirect || (redirect.file && piped)) return false;
    const args = argumentsOf(redirect.head, this.variables);
    if (!args) return false;
    if (args[0] === "cd") {
      if (args.length !== 2 || this.log || next !== "&&" || piped || redirect.file) return false;
      this.cwd = path.resolve(this.cwd, args[1]);
      return true;
    }
    if (args[0] !== "git") return false;
    return this.git(args, redirect, next);
  }

  git(args: string[], redirect: { head: CommandToken[]; file: string | null }, next: string) {
    let directory = this.cwd;
    let offset = 1;
    if (args[1] === "-C") {
      if (!args[2]) return false;
      directory = path.resolve(this.cwd, args[2]);
      offset = 3;
    }
    if (!literal(redirect.head[offset] as Word | undefined)) return false;
    const gitArgs = args.slice(offset);
    if (gitArgs[0] === "push") {
      if (this.log || !redirect.file) return false;
      this.log = path.resolve(this.cwd, redirect.file);
      this.conditionalCapture = next === "&&";
      this.phase = "capture";
    } else if (!reads.has(gitArgs[0]) || redirect.file) return false;
    this.commands.push({ cwd: directory, args: gitArgs });
    return true;
  }
}

function capturedCode(marker: string, output: string) {
  const [prefix, suffix] = marker.split(exitPlaceholder);
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(0|[1-9][0-9]{0,2})${escapeRegExp(suffix)}$`);
  const matches = output.split(/\r?\n/).flatMap((line) => {
    const match = pattern.exec(line);
    return match ? [Number(match[1])] : [];
  });
  return matches.length === 1 && matches[0] <= 255 ? matches[0] : null;
}

/**
 * Recognize a redirected push only when its immediate exit status and the same
 * log are printed. This is not a shell interpreter: unfamiliar syntax fails closed.
 * Git output and provider success must still be checked by the caller.
 */
export function parseLoggedPush(command: string, output: string, defaultCwd: string) {
  const tokens = tokenize(command);
  if (!tokens) return null;
  const parsed = statements(tokens);
  if (!parsed) return null;
  const state = new LoggedPush(defaultCwd);
  if (!parsed.every((statement) => state.step(statement))) return null;
  if (!state.log || !state.marker || !state.printed || state.teeFiles.includes(state.log))
    return null;
  const pushExitCode = capturedCode(state.marker, output);
  return pushExitCode === null ? null : { commands: state.commands, pushExitCode };
}
