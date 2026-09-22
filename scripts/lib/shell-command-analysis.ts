import { resolve } from "node:path";

export interface ShellInvocation {
  readonly name: string;
  readonly packageSpec?: string;
  readonly tokens: readonly string[];
}

export interface AnalyzedShellInvocation extends ShellInvocation {
  readonly cwd: string | null;
}

export interface ShellCommandAnalysis {
  readonly command: string;
  readonly cwd: string;
  readonly executableText: string;
  readonly hereDocBodies: readonly string[];
  readonly tokens: readonly string[];
  readonly invocations: readonly AnalyzedShellInvocation[];
  readonly hasBackgroundSeparator: boolean;
  readonly hasNestedCommands: boolean;
  readonly hasOpaqueSyntax: boolean;
  readonly hasPipedShell: boolean;
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


interface HereDocScan {
  bodies: string[];
  executableText: string;
}

function scanHereDocs(command: unknown): HereDocScan {
  const lines = String(command ?? "").split(/\r?\n/g);
  const bodies: string[] = [];
  const kept: string[] = [];
  const pending: Array<{ body: string[] | null; marker: string }> = [];

  for (const line of lines) {
    const active = pending[0];
    if (active) {
      if (line.trim() === active.marker) {
        if (active.body) bodies.push(active.body.join("\n"));
        pending.shift();
      } else if (active.body) {
        active.body.push(line);
      }
      continue;
    }

    kept.push(line);
    for (const match of line.matchAll(/<<-?\s*(?:(['"])([A-Za-z0-9_.-]+)\1|([A-Za-z0-9_.-]+))/g)) {
      pending.push({
        body: match[1] ? null : [],
        marker: match[2] ?? match[3],
      });
    }
  }
  const active = pending[0];
  if (active?.body) bodies.push(active.body.join("\n"));

  return { bodies, executableText: kept.join("\n") };
}

function stripHereDocBodies(command: unknown): string {
  return scanHereDocs(command).executableText;
}

function getExecutableShellText(command: unknown): string {
  if (commandIsRawPatchPayload(command)) return "";
  return stripHereDocBodies(command);
}
function tokenizeShell(command: unknown): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let escaping = false;
  let literalToken = false;
  const text = String(command ?? "");

  const pushToken = () => {
    if (token) {
      tokens.push(literalToken && (SHELL_PREFIX_TOKENS.has(token) || SHELL_CONTROL_TOKENS.has(token) || token.startsWith(">"))
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
  const text = String(command ?? "");
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

function getShellCommandInvocations(
  command: unknown,
  depth = 0,
  pretokenized?: readonly string[],
  state: { hasNestedCommands: boolean } = { hasNestedCommands: false },
): ShellInvocation[] {
  const executableText = pretokenized === undefined
    ? getExecutableShellText(command)
    : String(command ?? "");
  const tokens = pretokenized ?? tokenizeShell(executableText);
  const invocations: ShellInvocation[] = [];
  let atCommandStart = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isShellControlToken(token)) {
      atCommandStart = true;
      continue;
    }

    if (!atCommandStart) continue;
    if (isEnvAssignment(token)) continue;
    if (SHELL_PREFIX_TOKENS.has(token)) continue;

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
  const traversalState = { hasNestedCommands: false };
  const invocations = getShellCommandInvocations(executableText, 0, tokens, traversalState);
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
    hereDocBodies: Object.freeze([...hereDocs.bodies]),
    tokens: Object.freeze([...tokens]),
    invocations: Object.freeze(analyzedInvocations),
    hasBackgroundSeparator: tokens.some(
      (token, index) => token === "&" && tokens[index - 1] !== ">" && tokens[index - 1] !== ">>" && tokens[index + 1] !== ">",
    ),
    hasNestedCommands,
    hasOpaqueSyntax: OPAQUE_SHELL_CONSTRUCT_RE.some((construct) => construct.test(executableText)),
    hasPipedShell: tokens.some(
      (token, index) => token === "|" && ["sh", "bash", "zsh"].includes(shellCommandName(tokens[index + 1])),
    ),
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
