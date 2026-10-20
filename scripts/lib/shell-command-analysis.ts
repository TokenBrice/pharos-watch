import { resolve } from "node:path";

export interface ShellInvocation {
  readonly name: string;
  readonly packageSpec?: string;
  readonly tokens: readonly string[];
}

export interface AnalyzedShellInvocation extends ShellInvocation {
  readonly cwd: string | null;
}

interface ShellHereDoc {
  readonly body: string;
  readonly expansionText: string | null;
  readonly quoted: boolean;
  readonly stripTabs: boolean;
  readonly tokenIndex: number;
  readonly receiver: readonly string[];
  readonly feedsStdin: boolean;
}

export interface ShellCommandAnalysis {
  readonly command: string;
  readonly cwd: string;
  readonly executableText: string;
  readonly hereDocs: readonly ShellHereDoc[];
  /** Lines swallowed by a heredoc whose delimiter never arrived; non-empty means the parser diverged from the shell. */
  readonly unresolvedHereDocBody: string;
  readonly tokens: readonly string[];
  readonly invocations: readonly AnalyzedShellInvocation[];
  readonly hasBackgroundSeparator: boolean;
  readonly hasNestedCommands: boolean;
  readonly hasOpaqueSyntax: boolean;
  readonly hasShellStdin: boolean;
  readonly shellStdinInputs: readonly { readonly text: string; readonly script: string | null }[];
  readonly hasXargsShell: boolean;
  readonly isRawPatchPayload: boolean;
}

const OPAQUE_SHELL_CONSTRUCT_RE = [/\$\(/, /`/, /\beval\b/i, /\b(?:sh|bash|zsh)\s+(?:-[^\s;&|]*c[^\s;&|]*|--command)(?=\s|$)/i];

const SHELL_CONTROL_TOKENS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);
const SHELL_PREFIX_TOKENS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "}"]);
export const SHELL_LITERAL_PREFIX = "\0";
export const shellValue = (value: string) => value.startsWith(SHELL_LITERAL_PREFIX) ? value.slice(1) : value;
const ENV_VALUE_OPTIONS = new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]);
const NPX_VALUE_OPTIONS = new Set(["-c", "--call", "-p", "--package", "--cache", "--shell", "--userconfig"]);
export const PACKAGE_MANAGER_NAMES = new Set(["bun", "npm", "pnpm", "yarn"]);
const PACKAGE_MANAGER_EXEC_COMMANDS = new Set(["dlx", "exec", "x"]);
const PACKAGE_MANAGER_GLOBAL_VALUE_OPTIONS = new Set(["-C", "-w", "--prefix", "--workspace"]);
const PACKAGE_MANAGER_GLOBAL_FLAG_OPTIONS = new Set(["-s", "--silent"]);
const PACKAGE_MANAGER_WRAPPER_VALUE_OPTIONS = new Set([
  ...NPX_VALUE_OPTIONS,
  ...PACKAGE_MANAGER_GLOBAL_VALUE_OPTIONS,
]);
const NICE_VALUE_OPTIONS = new Set(["-n", "--adjustment"]);
const TIME_VALUE_OPTIONS = new Set(["-f", "--format", "-o", "--output"]);
const SHELL_EVAL_COMMANDS = new Set(["bash", "dash", "fish", "sh", "zsh"]);
export const GIT_GLOBAL_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);
export const GIT_GLOBAL_VALUE_OPTION_PREFIXES = [...GIT_GLOBAL_VALUE_OPTIONS].map((option) => `${option}=`);
export const GIT_GLOBAL_FLAG_OPTIONS = new Set([
  "--bare",
  "--help",
  "--html-path",
  "--info-path",
  "--literal-pathspecs",
  "--man-path",
  "--no-optional-locks",
  "--no-pager",
  "--no-replace-objects",
  "--paginate",
  "--version",
]);
export const WRANGLER_GLOBAL_VALUE_OPTIONS = new Set(["-c", "--config", "-e", "--env", "--cwd"]);
export function commandIsRawPatchPayload(command: unknown): boolean {
  return String(command ?? "")
    .trimStart()
    .startsWith("*** Begin Patch");
}


/** Heredoc expansion treats quote characters as data; executable text honors single quotes. */
function removeShellContinuations(text: string, initialQuote = "", heredocExpansion = false): string {
  let result = "";
  let quote = initialQuote;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && quote !== "'") {
      if (text[index + 1] === "\n") {
        index += 1;
        continue;
      }
      result += char;
      if (index + 1 < text.length) result += text[++index];
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
    } else if (!heredocExpansion && (char === "'" || char === '"')) {
      quote = char;
    }
    result += char;
  }
  return result;
}

const INPUT_REDIRECTION_RE = /^\d*(?:<<<-|<<-|<<<|<<|<&|<)$/;

interface HereDocMarker {
  marker: string;
  quoted: boolean;
  stripTabs: boolean;
  offset: number;
}
interface HereDocScan {
  records: ShellHereDoc[];
  executableText: string;
  /** Lines swallowed by a heredoc that never met its delimiter; empty when every heredoc terminated. */
  unresolvedBody: string;
}

/**
 * Recognizes heredoc delimiters only where the shell itself would start one:
 * outside quotes, comments, and backslash escapes, and never for `<<<`
 * here-strings. Lexical `<<MARKER` text in a comment or quoted argument must
 * not queue a delimiter, because the shell will still execute the commands
 * after the real heredoc ends. A delimiter that never terminates by end of
 * input is reported through `unresolvedBody` instead of silently dropping the
 * swallowed lines, so callers fail closed on any command hidden there.
 */
function scanHereDocs(command: unknown): HereDocScan {
  const lines = String(command ?? "").split(/\r?\n/g);
  const records: ShellHereDoc[] = [];
  const kept: string[] = [];
  const pending: Array<HereDocMarker & { lines: string[]; tokenIndex: number }> = [];
  let quote = "";

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    let line = lines[lineIndex];
    const active = pending[0];
    if (active) {
      const bodyLines = [line];
      let delimiterLine = active.stripTabs ? line.replace(/^\t+/, "") : line;
      while (!active.quoted && lineIndex + 1 < lines.length &&
          (delimiterLine.match(/\\+$/)?.[0].length ?? 0) % 2 === 1) {
        line = lines[++lineIndex];
        bodyLines.push(line);
        delimiterLine = delimiterLine.slice(0, -1) + (active.stripTabs ? line.replace(/^\t+/, "") : line);
      }
      if (delimiterLine === active.marker) {
        records.push({
          body: active.lines.join("\n"), quoted: active.quoted, stripTabs: active.stripTabs,
          expansionText: active.quoted ? null : removeShellContinuations(active.lines.join("\n"), "", true),
          tokenIndex: active.tokenIndex, receiver: [], feedsStdin: false,
        });
        pending.shift();
        quote = "";
      } else {
        active.lines.push(...bodyLines);
      }
      continue;
    }

    // Join executable logical lines before finding markers; heredoc bodies above stay literal.
    while (lineIndex + 1 < lines.length && !removeShellContinuations(`${line}\n`, quote).endsWith("\n")) {
      line += `\n${lines[++lineIndex]}`;
    }
    line = removeShellContinuations(line, quote);
    const prefix = kept.length === 0 ? "" : `${kept.join("\n")}\n`;
    kept.push(line);
    const scanned = scanHereDocMarkers(line, quote);
    quote = scanned.quote;
    for (const marker of scanned.markers) {
      pending.push({ ...marker, lines: [], tokenIndex: tokenizeShell(prefix + line.slice(0, marker.offset)).length });
    }
  }
  const active = pending[0];
  if (active) {
    records.push({
      body: active.lines.join("\n"), quoted: active.quoted, stripTabs: active.stripTabs,
      expansionText: active.quoted ? null : removeShellContinuations(active.lines.join("\n"), "", true),
      tokenIndex: active.tokenIndex, receiver: [], feedsStdin: false,
    });
  }
  const tokens = tokenizeShell(kept.join("\n"));
  const associated = records.map((record) => {
    let start = record.tokenIndex;
    while (start > 0 && !isShellControlToken(tokens[start - 1])) start -= 1;
    let end = record.tokenIndex;
    while (end < tokens.length && !isShellControlToken(tokens[end])) end += 1;
    let lastStdin = -1;
    for (let index = start; index < end; index += 1) {
      if (INPUT_REDIRECTION_RE.test(tokens[index]) && !/^[1-9]\d*</.test(tokens[index])) lastStdin = index;
    }
    return { ...record, receiver: tokens.slice(start, end), feedsStdin: lastStdin === record.tokenIndex };
  });

  return {
    records: associated,
    executableText: kept.join("\n"),
    unresolvedBody: active ? active.lines.join("\n") : "",
  };
}

function scanHereDocMarkers(line: string, carriedQuote: string): { markers: HereDocMarker[]; quote: string } {
  const markers: HereDocMarker[] = [];
  let quote = carriedQuote;
  let word = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\" && quote === "\"") {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "\\") {
      index += 1;
      word = true;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      word = true;
      continue;
    }
    if (char === "#" && !word) break;
    if (char === "<" && line[index + 1] === "<") {
      let offset = index;
      while (offset > 0 && /\d/.test(line[offset - 1])) offset -= 1;
      if (offset > 0 && !/[\s;()&|]/.test(line[offset - 1])) offset = index;
      const stripTabs = line[index + 2] === "-";
      let cursor = index + 2;
      if (line[cursor] === "<" || line[cursor] === "=") {
        word = true;
        index = cursor;
        continue;
      }
      if (line[cursor] === "-") cursor += 1;
      while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
      let quoted = false;
      let marker = "";
      let delimiterQuote = "";
      while (cursor < line.length) {
        const delimiterChar = line[cursor];
        if (!delimiterQuote && /[\s;<>&|()]/.test(delimiterChar)) break;
        if (delimiterChar === "\\" && delimiterQuote !== "'") {
          quoted = true;
          if (cursor + 1 < line.length) marker += line[++cursor];
        } else if (delimiterQuote) {
          if (delimiterChar === delimiterQuote) delimiterQuote = "";
          else marker += delimiterChar;
        } else if (delimiterChar === "'" || delimiterChar === '"') {
          quoted = true;
          delimiterQuote = delimiterChar;
        } else {
          marker += delimiterChar;
        }
        cursor += 1;
      }
      if (marker) markers.push({ marker, quoted, stripTabs, offset });
      index = cursor - 1;
      word = false;
      continue;
    }
    word = !/[\s;()&|]/.test(char);
  }

  return { markers, quote };
}

function tokenizeShell(command: unknown): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let escaping = false;
  let literalToken = false;
  const text = removeShellContinuations(String(command ?? ""));

  const pushToken = () => {
    if (token) {
      tokens.push(literalToken && (SHELL_PREFIX_TOKENS.has(token) || SHELL_CONTROL_TOKENS.has(token) || /^[<>]/.test(token))
        ? SHELL_LITERAL_PREFIX + token : token);
      token = "";
      literalToken = false;
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      literalToken = true;
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        token += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      literalToken = true;
      continue;
    }

    if (char === "\n") {
      pushToken();
      tokens.push("\n");
      continue;
    }

    if (/\s/.test(char)) {
      pushToken();
      continue;
    }

    if ((char === "&" && text[i + 1] === "&") || (char === "|" && text[i + 1] === "|")) {
      pushToken();
      tokens.push(`${char}${char}`);
      i += 1;
      continue;
    }

    if (char === "#" && !token) {
      while (i < text.length && text[i] !== "\n") i += 1;
      pushToken();
      tokens.push("\n");
      continue;
    }

    if (char === "&" || char === "|" || char === ";" || char === "(" || char === ")") {
      pushToken();
      tokens.push(char);
      continue;
    }

    if (char === "<") {
      const fd = /^\d+$/.test(token) ? token : "";
      if (fd) token = "";
      pushToken();
      let operator = "<";
      if (text[i + 1] === "<") {
        operator += text[++i];
        if (text[i + 1] === "-" || text[i + 1] === "<") operator += text[++i];
      } else if (text[i + 1] === "&") {
        operator += text[++i];
      }
      tokens.push(fd + operator);
      continue;
    }

    if (char === ">") {
      pushToken();
      if (text[i + 1] === "|") {
        tokens.push(">|");
        i += 1;
      } else if (text[i + 1] === ">") {
        tokens.push(">>");
        i += 1;
      } else {
        tokens.push(">");
      }
      continue;
    }

    token += char;
  }

  pushToken();
  return tokens;
}



export function shellCommandName(token: unknown): string {
  return (
    String(token ?? "")
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.(?:cmd|exe)$/i, "") ?? ""
  );
}

function isShellControlToken(token: unknown): boolean {
  return typeof token === "string" && SHELL_CONTROL_TOKENS.has(token);
}

function isEnvAssignment(token: unknown): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(token ?? ""));
}

export function skipLeadingOptions(
  tokens: readonly string[],
  startIndex: number,
  valueOptions: ReadonlySet<string> = new Set<string>(),
): number {
  let index = startIndex;
  while (index < tokens.length && !isShellControlToken(tokens[index]) && tokens[index]?.startsWith("-")) {
    const option = tokens[index].split("=")[0];
    index += 1;
    if (!tokens[index - 1].includes("=") && valueOptions.has(option)) {
      index += 1;
    }
  }
  return index;
}

function skipPackageManagerGlobalOptions(tokens: readonly string[], startIndex: number): number {
  let index = startIndex;
  while (index < tokens.length && !isShellControlToken(tokens[index])) {
    const token = tokens[index];
    if (!token?.startsWith("-")) break;
    // eslint-disable-next-line security/detect-possible-timing-attacks -- compares a policy delimiter, never a secret
    if (token === "--") return index + 1;

    const option = token.split("=", 1)[0];
    const isValueOption = PACKAGE_MANAGER_GLOBAL_VALUE_OPTIONS.has(option);
    const isFlagOption = PACKAGE_MANAGER_GLOBAL_FLAG_OPTIONS.has(option);
    if (!isValueOption && !isFlagOption) break;

    index += 1;
    if (!token.includes("=") && isValueOption) {
      index += 1;
    }
  }
  return index;
}

function packageManagerSubcommandIndex(tokens: readonly string[]): number {
  return skipPackageManagerGlobalOptions(tokens, 1);
}

export function packageManagerScriptIndex(tokens: readonly string[], name: string): number | null {
  if (!PACKAGE_MANAGER_NAMES.has(name)) return null;

  const commandIndex = packageManagerSubcommandIndex(tokens);
  const command = tokens[commandIndex];
  if (!command || isShellControlToken(command)) return null;

  if (command === "run") {
    return skipLeadingOptions(tokens, commandIndex + 1, PACKAGE_MANAGER_GLOBAL_VALUE_OPTIONS);
  }

  if (command === "workspace") {
    let scriptIndex = skipLeadingOptions(tokens, commandIndex + 1, PACKAGE_MANAGER_GLOBAL_VALUE_OPTIONS);
    if (scriptIndex >= tokens.length || isShellControlToken(tokens[scriptIndex])) return null;
    scriptIndex += 1;
    if (tokens[scriptIndex] === "run") {
      scriptIndex = skipLeadingOptions(tokens, scriptIndex + 1, PACKAGE_MANAGER_GLOBAL_VALUE_OPTIONS);
    }
    return scriptIndex;
  }

  return commandIndex;
}

function packageManagerWrapperExecutableIndex(tokens: readonly string[]): number | null {
  const name = shellCommandName(tokens[0]);
  if (!PACKAGE_MANAGER_NAMES.has(name)) return null;

  const commandIndex = packageManagerSubcommandIndex(tokens);
  if (!PACKAGE_MANAGER_EXEC_COMMANDS.has(tokens[commandIndex] ?? "")) return null;

  return skipLeadingOptions(tokens, commandIndex + 1, PACKAGE_MANAGER_WRAPPER_VALUE_OPTIONS);
}

export function isVariableExpandedExecutable(token: unknown): boolean {
  return /\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[?@*])/.test(String(token ?? ""));
}

function resolveExecutableIndex(tokens: readonly string[], startIndex: number, depth = 0): number | null {
  if (depth > 4 || startIndex >= tokens.length || isShellControlToken(tokens[startIndex])) {
    return null;
  }

  const name = shellCommandName(tokens[startIndex]);
  if (name === "env") {
    let index = skipLeadingOptions(tokens, startIndex + 1, ENV_VALUE_OPTIONS);
    while (index < tokens.length && isEnvAssignment(tokens[index])) {
      index += 1;
    }
    return resolveExecutableIndex(tokens, index, depth + 1);
  }

  if (name === "npx" || name === "bunx") {
    const index = skipLeadingOptions(tokens, startIndex + 1, NPX_VALUE_OPTIONS);
    return index < tokens.length && !isShellControlToken(tokens[index]) ? index : startIndex;
  }

  if (PACKAGE_MANAGER_NAMES.has(name)) {
    const relativeTokens = tokens.slice(startIndex);
    const index = packageManagerWrapperExecutableIndex(relativeTokens);
    if (index === null) return startIndex;
    const resolvedIndex = startIndex + index;
    return resolvedIndex < tokens.length && !isShellControlToken(tokens[resolvedIndex]) ? resolvedIndex : startIndex;
  }

  if (name === "sudo" || name === "command" || name === "exec") {
    const index = skipLeadingOptions(tokens, startIndex + 1);
    return resolveExecutableIndex(tokens, index, depth + 1);
  }

  if (name === "nice") {
    const index = skipLeadingOptions(tokens, startIndex + 1, NICE_VALUE_OPTIONS);
    return resolveExecutableIndex(tokens, index, depth + 1);
  }

  if (name === "nohup") {
    const index = skipLeadingOptions(tokens, startIndex + 1);
    return resolveExecutableIndex(tokens, index, depth + 1);
  }

  if (name === "time") {
    const index = skipLeadingOptions(tokens, startIndex + 1, TIME_VALUE_OPTIONS);
    return resolveExecutableIndex(tokens, index, depth + 1);
  }

  return startIndex;
}

function isPackageRunnerPrefix(tokens: readonly string[], startIndex: number, resolvedIndex: number): boolean {
  for (let index = startIndex; index < resolvedIndex; index += 1) {
    const name = shellCommandName(tokens[index]);
    if (name === "npx" || name === "bunx") return true;
    if (PACKAGE_MANAGER_EXEC_COMMANDS.has(tokens[index])) return true;
  }
  return false;
}

interface ShellEvalDetails {
  command: string;
}

function getShellEvalDetails(tokens: readonly string[]): ShellEvalDetails | null {
  if (!SHELL_EVAL_COMMANDS.has(shellCommandName(tokens[0]))) return null;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== "-c" && token !== "--command" && !(/^-[A-Za-z]+$/.test(token) && token.includes("c"))) {
      continue;
    }

    const commandIndex = index + 1;
    const argument0Index = commandIndex + 1;
    const command = tokens[commandIndex] ?? "";
    const positionalArguments = tokens.slice(argument0Index + 1);
    const joinedPositionalArguments = positionalArguments.join(" ");
    return {
      command: command
        .replace(/"\$(?:@|\*)"|"\$\{[@*]\}"/g, joinedPositionalArguments)
        .replace(/\$(?:@|\*)|\$\{[@*]\}/g, joinedPositionalArguments)
        .replace(
          /\$(\d)|\$\{(\d)\}/g,
          (_match, shortIndex: string | undefined, bracedIndex: string | undefined) => {
            const position = Number(shortIndex ?? bracedIndex) - 1;
            return position >= 0 ? tokens[argument0Index + position + 1] ?? "" : "";
          },
        ),
    };
  }

  return null;
}

function getShellEvalArgument(tokens: readonly string[]): string {
  return getShellEvalDetails(tokens)?.command ?? "";
}

function getNestedShellCommands(command: unknown): string[] {
  const text = removeShellContinuations(String(command ?? ""));
  const commands: string[] = [];
  let quote = "";
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = "";
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = "";
      } else if (char === "$" && text[index + 1] === "(") {
        const nested = readCommandSubstitution(text, index);
        if (nested) {
          commands.push(nested.command);
          index = nested.endIndex;
        }
      } else if (char === "`") {
        const nested = readBacktickCommand(text, index);
        if (nested) {
          commands.push(nested.command);
          index = nested.endIndex;
        }
      }
      continue;
    }

    if (char === "#" && (index === 0 || /\s/.test(text[index - 1]))) {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "'") {
      quote = "'";
      continue;
    }
    if (char === '"') {
      quote = '"';
      continue;
    }
    if (char === "$" && text[index + 1] === "(") {
      const nested = readCommandSubstitution(text, index);
      if (nested) {
        commands.push(nested.command);
        index = nested.endIndex;
      }
      continue;
    }
    if (char === "`") {
      const nested = readBacktickCommand(text, index);
      if (nested) {
        commands.push(nested.command);
        index = nested.endIndex;
      }
    }
  }

  return commands;
}

function readCommandSubstitution(text: string, startIndex: number): { command: string; endIndex: number } | null {
  let depth = 1;
  let quote = "";
  let escaping = false;

  for (let index = startIndex + 2; index < text.length; index += 1) {
    const char = text[index];

    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "$" && text[index + 1] === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { command: text.slice(startIndex + 2, index), endIndex: index };
      }
    }
  }

  return null;
}

function readBacktickCommand(text: string, startIndex: number): { command: string; endIndex: number } | null {
  let escaping = false;
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "`") {
      return { command: text.slice(startIndex + 1, index), endIndex: index };
    }
  }
  return null;
}

function getInvocationNestedShellCommands(invocation: ShellInvocation): string[] {
  const nestedCommands: string[] = [];
  const shellEval = getShellEvalArgument(invocation.tokens);
  if (shellEval) nestedCommands.push(shellEval);

  if (invocation.name === "eval") {
    const evalTokens = invocation.tokens.slice(1).filter((token) => token !== "--");
    if (evalTokens.length > 0) nestedCommands.push(evalTokens.join(" "));
  }

  if (invocation.name === "xargs") {
    for (let index = 1; index < invocation.tokens.length; index += 1) {
      if (!SHELL_EVAL_COMMANDS.has(shellCommandName(invocation.tokens[index]))) continue;
      const shellTokens = invocation.tokens.slice(index);
      const shellEval = getShellEvalArgument(shellTokens);
      if (shellEval) nestedCommands.push(shellEval);
      break;
    }
  }

  return nestedCommands;
}

function getStaticStdinScript(tokens: readonly string[]): string | null {
  const executableIndex = resolveExecutableIndex(tokens, 0);
  if (executableIndex === null) return null;
  const name = shellCommandName(tokens[executableIndex]);
  const args = tokens.slice(executableIndex + 1).map(shellValue);
  // Expansion and option-dependent producers are opaque, not literal scripts.
  if (args.some((arg) => /[$`]/.test(arg))) return null;
  if (name === "echo") {
    if (args[0]?.startsWith("-") || args.some((arg) => arg.includes("\\"))) return null;
    return `${args.join(" ")}\n`;
  }
  if (name !== "printf" || args.length === 0) return null;
  const format = args[0]!;
  const values = args.slice(1);
  if (format.startsWith("-") || format.replace(/%%|%s/g, "").includes("%") ||
      format.replace(/\\[ntr\\]/g, "").includes("\\")) return null;
  const conversions = [...format.matchAll(/%%|%s/g)].filter(([match]) => match === "%s").length;
  if (conversions === 0 && values.length > 0) return null;
  const decodedFormat = format.replace(/\\([ntr\\])/g, (_match, char: string) =>
    ({ n: "\n", t: "\t", r: "\r", "\\": "\\" })[char]!);
  let script = "";
  let cursor = 0;
  do {
    script += decodedFormat.replace(/%%|%s/g, (match) =>
      match === "%%" ? "%" : values[cursor++] ?? "");
  } while (conversions > 0 && cursor < values.length);
  return script;
}

/** A script filename or -c consumes stdin as data, not as a shell program. */
function shellReadsStdin(tokens: readonly string[]): boolean {
  const args = tokens.filter((token, index) =>
    !INPUT_REDIRECTION_RE.test(token) && ![">", ">>", ">|"].includes(token) &&
    !(index > 0 && (INPUT_REDIRECTION_RE.test(tokens[index - 1]) || [">", ">>", ">|"].includes(tokens[index - 1]))) &&
    !(/^\d+$/.test(token) && [">", ">>", ">|"].includes(tokens[index + 1])));
  let start = 0;
  while (isEnvAssignment(args[start]) || SHELL_PREFIX_TOKENS.has(args[start])) start += 1;
  const executableIndex = resolveExecutableIndex(args, start);
  if (executableIndex === null || !SHELL_EVAL_COMMANDS.has(shellCommandName(args[executableIndex]))) return false;
  let stdin = false;
  for (let index = executableIndex + 1; index < args.length; index += 1) {
    const arg = shellValue(args[index]);
    if (arg === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) return false;
    if (arg === "--") return stdin || index + 1 === args.length || args[index + 1] === "-";
    if (arg === "-") return true;
    if (!arg.startsWith("-")) return stdin;
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(arg)) stdin = true;
    if (["-o", "-O", "--rcfile", "--init-file"].includes(arg)) index += 1;
  }
  return true;
}

function getShellCommandInvocations(
  command: unknown,
  depth = 0,
  pretokenized?: readonly string[],
  state: {
    hasNestedCommands: boolean;
    shellStdinInputs: Array<{ text: string; script: string | null }>;
  } = { hasNestedCommands: false, shellStdinInputs: [] },
  suppliedHereDocs?: HereDocScan,
): ShellInvocation[] {
  const hereDocs = suppliedHereDocs ?? scanHereDocs(command);
  const executableText = commandIsRawPatchPayload(command) ? "" : hereDocs.executableText;
  const tokens = pretokenized ?? tokenizeShell(executableText);
  const invocations: ShellInvocation[] = [];
  let atCommandStart = true;
  let pipelineStart = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const shellToken = tokens[index];
    if (isShellControlToken(shellToken)) {
      if (shellToken === "|") {
        const consumerEnd = tokens.findIndex((token, next) => next > index && isShellControlToken(token));
        if (shellReadsStdin(tokens.slice(index + 1, consumerEnd === -1 ? tokens.length : consumerEnd))) {
          const producerTokens = tokens.slice(pipelineStart, index);
          state.shellStdinInputs.push({
            text: producerTokens.map(shellValue).join(" "),
            script: producerTokens.some(isShellControlToken) ? null : getStaticStdinScript(producerTokens),
          });
        }
      } else {
        pipelineStart = index + 1;
      }
      atCommandStart = true;
      continue;
    }

    if (!atCommandStart) continue;
    if (INPUT_REDIRECTION_RE.test(shellToken)) {
      index += 1;
      continue;
    }
    if (isEnvAssignment(shellToken)) continue;
    if (SHELL_PREFIX_TOKENS.has(shellToken)) continue;

    const resolvedIndex = resolveExecutableIndex(tokens, index);
    if (resolvedIndex !== null) {
      const endIndex = tokens.findIndex(
        (candidate, candidateIndex) => candidateIndex > resolvedIndex && isShellControlToken(candidate),
      );
      const invocationTokens = tokens.slice(resolvedIndex, endIndex === -1 ? tokens.length : endIndex);
      // A package-runner specifier keeps its `@<range>` suffix; policies classify the package it resolves to.
      const packageSpec = isPackageRunnerPrefix(tokens, index, resolvedIndex)
        ? shellCommandName(tokens[resolvedIndex])
        : null;
      invocations.push({
        name: packageSpec === null
          ? shellCommandName(tokens[resolvedIndex])
          : /^([^@][^@]*)@[^@]*$/.exec(packageSpec)?.[1] ?? packageSpec,
        tokens: invocationTokens,
        ...(packageSpec === null ? {} : { packageSpec }),
      });

      const invocationNestedCommands = getInvocationNestedShellCommands(invocations[invocations.length - 1]!);
      if (invocationNestedCommands.length > 0) state.hasNestedCommands = true;
      if (depth < 3) {
        for (const nestedCommand of invocationNestedCommands) {
          invocations.push(...getShellCommandInvocations(nestedCommand, depth + 1, undefined, state));
        }
      }
    }

    atCommandStart = false;
  }

  const nestedCommands = getNestedShellCommands(executableText);
  if (nestedCommands.length > 0) state.hasNestedCommands = true;
  if (depth < 3) {
    for (const nestedCommand of nestedCommands) {
      invocations.push(...getShellCommandInvocations(nestedCommand, depth + 1, undefined, state));
    }
  }

  if (!commandIsRawPatchPayload(command)) {
    for (const hereDoc of hereDocs.records) {
      if (!hereDoc.feedsStdin || !shellReadsStdin(hereDoc.receiver)) continue;
      const script = hereDoc.stripTabs ? hereDoc.body.replace(/^\t+/gm, "") : hereDoc.body;
      state.hasNestedCommands = true;
      state.shellStdinInputs.push({ text: script, script });
      if (depth < 3) {
        invocations.push(...getShellCommandInvocations(script, depth + 1, undefined, state));
      }
    }
  }

  return invocations;
}

function invocationWorkingDirectories(
  invocations: readonly ShellInvocation[],
  tokens: readonly string[],
  cwd: string,
  hasNestedCommands: boolean,
): Array<string | null> {
  const hasComplexControlFlow = tokens.some((token) =>
    ["(", ")", "{", "}", ";", "\n", "||", "|", "&", "if", "then", "else", "do"].includes(token));
  const hasEnvChdir = tokens.some((token) => shellCommandName(token) === "env")
    && tokens.some((token) => token.startsWith("-C") || token.startsWith("--chdir"));
  const directories: Array<string | null> = [];
  let workingDirectory = cwd;
  let priorCd = false;
  let invalidCd = false;

  for (const invocation of invocations) {
    directories.push(hasEnvChdir || invalidCd || (priorCd && (hasComplexControlFlow || hasNestedCommands))
      ? null
      : workingDirectory);
    if (invocation.name !== "cd") continue;
    priorCd = true;
    const destination = shellValue(invocation.tokens[1] ?? "");
    if (invocation.tokens.length !== 2 || !destination || destination.startsWith("-") || /[$~`]/.test(destination)) {
      invalidCd = true;
      continue;
    }
    workingDirectory = resolve(workingDirectory, destination);
  }
  return directories;
}

export function analyzeShellCommand(command: string, cwd: string): ShellCommandAnalysis {
  const commandText = command;
  const hereDocs = scanHereDocs(commandText);
  const isRawPatchPayload = commandIsRawPatchPayload(commandText);
  const executableText = isRawPatchPayload ? "" : hereDocs.executableText;
  const tokens = tokenizeShell(executableText);
  const traversalState = { hasNestedCommands: false, shellStdinInputs: [] as Array<{ text: string; script: string | null }> };
  const invocations = getShellCommandInvocations(commandText, 0, tokens, traversalState, hereDocs);
  const hasNestedCommands = traversalState.hasNestedCommands;
  const directories = invocationWorkingDirectories(invocations, tokens, cwd, hasNestedCommands);
  const analyzedInvocations = invocations.map((invocation, index) => Object.freeze({
    ...invocation,
    tokens: Object.freeze([...invocation.tokens]),
    cwd: directories[index] ?? null,
  }));
  return Object.freeze({
    command: commandText,
    cwd,
    executableText,
    hereDocs: Object.freeze(hereDocs.records.map((record) => Object.freeze({
      ...record, receiver: Object.freeze([...record.receiver]),
    }))),
    unresolvedHereDocBody: hereDocs.unresolvedBody,
    tokens: Object.freeze([...tokens]),
    invocations: Object.freeze(analyzedInvocations),
    hasBackgroundSeparator: tokens.some(
      (token, index) => token === "&" && tokens[index - 1] !== ">" && tokens[index - 1] !== ">>" && tokens[index + 1] !== ">",
    ),
    hasNestedCommands,
    hasOpaqueSyntax: OPAQUE_SHELL_CONSTRUCT_RE.some((construct) => construct.test(executableText)),
    hasShellStdin: traversalState.shellStdinInputs.length > 0,
    shellStdinInputs: Object.freeze(traversalState.shellStdinInputs.map((input) => Object.freeze(input))),
    hasXargsShell: tokens.some((token, index) => {
      if (shellCommandName(token) !== "xargs") return false;
      for (let nextIndex = index + 1; nextIndex < tokens.length; nextIndex += 1) {
        const nextToken = tokens[nextIndex];
        if (isShellControlToken(nextToken)) return false;
        if (["sh", "bash", "zsh"].includes(shellCommandName(nextToken))) return true;
      }
      return false;
    }),
    isRawPatchPayload,
  });
}
