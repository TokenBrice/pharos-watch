#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  hasDeployImpact,
  hasPagesDeployImpact,
  hasWorkerDeployImpact,
  normalizeRepoPath,
} from "../lib/deploy-impact.mts";
import { collectGitPaths } from "../lib/changed-files.mts";
import {
  CORE_RULES,
  DEFAULT_BASE_DOCS,
  PATH_FAMILIES,
  matchesOwnershipGlob,
  type DocReference,
} from "../lib/doc-ownership-registry.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

type UnknownRecord = Record<string, unknown>;
type GitExec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; encoding: "utf8" },
) => string;

interface PathFamilyRule {
  background: DocReference[];
  checks: string[];
  docs: DocReference[];
  hardRules: string[];
  hints: string[];
  id: string;
  label: string;
  risk: string;
  scopedContext: string[];
  sourceGlobs: string[];
  tier: "specific" | "fallback";
}

interface MatchedMapping {
  id: string;
  label: string;
  matchedFiles: string[];
  risk: string;
  tier: "specific" | "fallback";
}

interface ChangeContract {
  background: DocReference[];
  changedFiles: string[];
  checks: string[];
  deploy: {
    deployImpact: boolean;
    pagesImpact: boolean;
    workerImpact: boolean;
  };
  docs: DocReference[];
  hardRules: string[];
  hints: string[];
  mappings: MatchedMapping[];
  scopedContext: string[];
  source: ChangeSource;
  warnings: string[];
}

type ChangeSource = "explicit files" | "staged index" | "base/head range" | "working tree";

interface HookViolation {
  file?: string;
  reason: string;
  rule: HookRuleId;
}

type HookRuleId =
  | "deploy"
  | "d1-remote-mutation"
  | "git-destructive"
  | "migration-sql"
  | "opaque-shell"
  | "protected-write"
  | "shell-indirection";

interface ShellInvocation {
  name: string;
  tokens: string[];
}

interface ChangedFileOptions {
  baseRef?: string;
  execFile?: GitExec;
  headRef?: string;
  staged?: boolean;
}

interface CliOptions {
  allowMissing: boolean;
  baseRef?: string;
  diagnostics: boolean;
  format: "json" | "text";
  headRef?: string;
  help: boolean;
  hook: string | null;
  staged: boolean;
}

const REPO_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RISK_RANK: ReadonlyMap<string, number> = new Map([
  ["high", 3],
  ["medium", 2],
  ["low", 1],
]);
const MAX_SINGLE_PATH_READ_FIRST_DOCS = 6;

const SQL_MUTATING_KEYWORDS = new Set([
  "alter",
  "create",
  "delete",
  "drop",
  "insert",
  "replace",
  "truncate",
  "update",
]);
const UNSAFE_MIGRATION_SQL_RE =
  /\b(drop\s+table|drop\s+column|alter\s+table[\s\S]{0,160}\bdrop\b|delete\s+from|truncate\b|pragma\s+writable_schema|rename\s+(?:table|column))\b/i;

const PROTECTED_WRITE_RULES: ReadonlyArray<{ label: string; test: (file: string) => boolean }> = [
  {
    label: "environment files",
    test: (file) => /(^|\/)\.env[^/]*(?:\/|$)/.test(file) || file === ".dev.vars" || file === "worker/.dev.vars",
  },
  {
    label: "Git internals",
    test: (file) => file === ".git" || file.startsWith(".git/"),
  },
  {
    label: "build outputs",
    test: (file) => /^(?:out|\.next|build|coverage|dist)(?:\/|$)/.test(file),
  },
  {
    label: "Worker build outputs",
    test: (file) => /^(?:worker\/(?:\.next|dist|build|coverage))(?:\/|$)/.test(file),
  },
];

const TYPED_PATH_FAMILIES = PATH_FAMILIES as PathFamilyRule[];
const TYPED_DEFAULT_BASE_DOCS = DEFAULT_BASE_DOCS as string[];
const TYPED_CORE_RULES = CORE_RULES as string[];

class ExplicitPathError extends Error {}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueDocs(values: readonly DocReference[]): DocReference[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.path}#${value.anchor ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeLocalPath(value: unknown): string {
  const raw = normalizeRepoPath(String(value ?? "").trim());
  if (!raw) return "";

  const withoutFilePrefix = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
  const repoRoot = normalizeRepoPath(REPO_ROOT);
  const normalized = withoutFilePrefix.startsWith(`${repoRoot}/`)
    ? withoutFilePrefix.slice(repoRoot.length + 1)
    : withoutFilePrefix;

  return normalized.replace(/^\.\//, "");
}

function fileMatchesRule(file: string, rule: PathFamilyRule): boolean {
  return rule.sourceGlobs.some((glob) => matchesOwnershipGlob(file, glob));
}

function compareFamilyRisk(a: PathFamilyRule, b: PathFamilyRule): number {
  if (a.tier !== b.tier) return a.tier === "specific" ? -1 : 1;
  const rankDelta = (RISK_RANK.get(b.risk) ?? 0) - (RISK_RANK.get(a.risk) ?? 0);
  if (rankDelta !== 0) return rankDelta;
  return a.label.localeCompare(b.label);
}

function discoverScopedContext(files: readonly string[]): string[] {
  const discovered: string[] = [];
  for (const file of files) {
    let directory = dirname(file);
    while (directory !== "." && directory !== "/") {
      const candidate = `${normalizeRepoPath(directory)}/AGENTS.md`;
      if (existsSync(resolve(REPO_ROOT, candidate))) discovered.push(candidate);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return unique(discovered);
}

export function normalizeChangedFiles(files: readonly string[]): string[] {
  return unique(files.map((file) => normalizeRepoPath(file.trim())).filter(Boolean)).sort();
}

interface ExplicitPathResolution {
  existencePaths: string[];
  rawPath: string;
  repoPath: string;
}

const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

function isWindowsDriveAbsolutePath(value: string): boolean {
  return WINDOWS_DRIVE_ABSOLUTE_PATH.test(value);
}

function isAbsoluteRepoPath(value: string): boolean {
  return isAbsolute(value) || isWindowsDriveAbsolutePath(value);
}

function getRelativeRepoPath(absolutePath: string, root: string): string | null {
  const relativePath = normalizeRepoPath(relative(resolve(root), absolutePath));
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    isAbsoluteRepoPath(relativePath)
  ) {
    return null;
  }
  return relativePath.replace(/^(?:\.\/)+/, "");
}

function getCurrentWorktreeRoot(execFile: GitExec = execFileSync as GitExec): string {
  try {
    const output = execFile("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    return output ? resolve(normalizeRepoPath(output)) : REPO_ROOT;
  } catch {
    return REPO_ROOT;
  }
}

function validateExistingExplicitPath(
  { existencePaths, rawPath }: ExplicitPathResolution,
  roots: readonly string[],
): void {
  const existingPaths = existencePaths.filter((path) => existsSync(path));
  if (existingPaths.length === 0) return;

  const realRoots = roots.map((root) => realpathSync(root));
  for (const existingPath of existingPaths) {
    let realPath: string;
    try {
      realPath = realpathSync(existingPath);
    } catch {
      throw new ExplicitPathError(`explicit path resolves outside repository: ${rawPath}`);
    }

    if (!realRoots.some((root) => getRelativeRepoPath(realPath, root) !== null)) {
      throw new ExplicitPathError(`explicit path resolves outside repository: ${rawPath}`);
    }
  }
}

function resolveExplicitPath(
  value: unknown,
  currentWorktreeRoot: string,
): ExplicitPathResolution | null {
  const rawPath = normalizeRepoPath(String(value ?? "").trim());
  if (!rawPath) return null;

  const withoutFilePrefix = rawPath.startsWith("file://") ? rawPath.slice("file://".length) : rawPath;
  const repoRoot = resolve(REPO_ROOT);
  const currentRoot = resolve(currentWorktreeRoot);

  if (isWindowsDriveAbsolutePath(withoutFilePrefix) && !isAbsolute(withoutFilePrefix)) {
    throw new ExplicitPathError(`explicit path resolves outside repository: ${rawPath}`);
  }

  if (isAbsoluteRepoPath(withoutFilePrefix)) {
    const absolutePath = resolve(withoutFilePrefix);
    const roots = currentRoot === repoRoot ? [repoRoot] : [currentRoot, repoRoot];
    for (const root of roots) {
      const repoPath = getRelativeRepoPath(absolutePath, root);
      if (repoPath !== null) {
        return {
          existencePaths: unique([absolutePath, resolve(repoRoot, repoPath)]),
          rawPath,
          repoPath,
        };
      }
    }

    throw new ExplicitPathError(`explicit path resolves outside repository: ${rawPath}`);
  }

  const relativeInput = withoutFilePrefix.replace(/^(?:\.\/)+/, "");
  const absolutePath = resolve(repoRoot, relativeInput);
  const repoPath = getRelativeRepoPath(absolutePath, repoRoot);
  if (repoPath === null) {
    throw new ExplicitPathError(`explicit path resolves outside repository: ${rawPath}`);
  }

  return {
    existencePaths: unique([
      absolutePath,
      ...(currentRoot === repoRoot ? [] : [resolve(currentRoot, repoPath)]),
    ]),
    rawPath,
    repoPath,
  };
}

export function normalizeExplicitFiles(
  files: readonly string[],
  { allowMissing = false, execFile = execFileSync as GitExec }: { allowMissing?: boolean; execFile?: GitExec } = {},
): string[] {
  const currentWorktreeRoot = getCurrentWorktreeRoot(execFile);
  const missingWarnings = new Set<string>();
  const resolvedFiles = files
    .map((file) => resolveExplicitPath(file, currentWorktreeRoot))
    .filter((file): file is ExplicitPathResolution => file !== null)
    .map((resolution) => {
      validateExistingExplicitPath(resolution, [REPO_ROOT, currentWorktreeRoot]);
      const { existencePaths, repoPath } = resolution;
      if (!allowMissing && !existencePaths.some((path) => existsSync(path)) && !missingWarnings.has(repoPath)) {
        console.error(`warning: ${repoPath} does not exist (routing as a planned new file)`);
        missingWarnings.add(repoPath);
      }
      return repoPath;
    });

  return normalizeChangedFiles(resolvedFiles);
}

export function classifyChangedFiles(files: readonly string[]): ChangeContract {
  return classifyChangedFilesWithSource(files, "explicit files");
}

function classifyChangedFilesWithSource(files: readonly string[], source: ChangeSource): ChangeContract {
  const changedFiles = normalizeChangedFiles(files);
  const matchedFamilies = TYPED_PATH_FAMILIES.map((family) => ({
    ...family,
    matchedFiles: changedFiles.filter((file) => fileMatchesRule(file, family)),
  }))
    .filter((family) => family.matchedFiles.length > 0)
    .sort(compareFamilyRisk);

  const specificFamilies = matchedFamilies.filter((family) => family.tier === "specific");
  const fallbackFamilies = matchedFamilies.filter((family) => family.tier === "fallback");
  const rankedDocs = uniqueDocs([
    ...specificFamilies.flatMap((family) => family.docs),
    ...TYPED_DEFAULT_BASE_DOCS.map((path) => ({ path })),
    ...fallbackFamilies.flatMap((family) => family.docs),
  ]);
  const docs = changedFiles.length === 1
    ? rankedDocs.slice(0, MAX_SINGLE_PATH_READ_FIRST_DOCS)
    : rankedDocs;
  const readFirstDocKeys = new Set(docs.map((doc) => `${doc.path}#${doc.anchor ?? ""}`));
  const background = uniqueDocs([
    ...rankedDocs.slice(docs.length),
    ...matchedFamilies.flatMap((family) => family.background),
  ]).filter((doc) => !readFirstDocKeys.has(`${doc.path}#${doc.anchor ?? ""}`));
  const scopedContext = unique([
    ...discoverScopedContext(changedFiles),
    ...matchedFamilies.flatMap((family) => family.scopedContext),
  ]);
  const checks = unique(matchedFamilies.flatMap((family) => family.checks));
  const hardRules = unique([...TYPED_CORE_RULES, ...matchedFamilies.flatMap((family) => family.hardRules)]);
  const hints = unique(matchedFamilies.flatMap((family) => family.hints));
  const warnings = buildWarnings(changedFiles);

  return {
    background,
    changedFiles,
    checks,
    deploy: {
      deployImpact: hasDeployImpact(changedFiles),
      pagesImpact: hasPagesDeployImpact(changedFiles),
      workerImpact: hasWorkerDeployImpact(changedFiles),
    },
    docs,
    hardRules,
    hints,
    mappings: matchedFamilies.map((family) => ({
      id: family.id,
      label: family.label,
      matchedFiles: family.matchedFiles,
      risk: family.risk,
      tier: family.tier,
    })),
    scopedContext,
    source,
    warnings,
  };
}

function getToolInput(hookInput: UnknownRecord = {}): UnknownRecord {
  const candidate = hookInput.tool_input ?? hookInput.toolInput ?? hookInput.input ?? hookInput.arguments;
  return isRecord(candidate) ? candidate : {};
}

function getCommandFromHookInput(hookInput: UnknownRecord = {}): string {
  const toolInput = getToolInput(hookInput);
  return String(toolInput.command ?? toolInput.cmd ?? hookInput.command ?? hookInput.cmd ?? "");
}

function collectArrayPaths(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!isRecord(item)) return [];
    return [item.file_path, item.filePath, item.path, item.filename].filter(Boolean);
  });
}

function extractPatchPaths(patchText: unknown): string[] {
  return [...String(patchText ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]);
}

const SHELL_CONTROL_TOKENS = new Set([";", "&&", "||", "|", "&", "\n"]);
const ENV_VALUE_OPTIONS = new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]);
const NPX_VALUE_OPTIONS = new Set(["-c", "--call", "-p", "--package", "--cache", "--shell", "--userconfig"]);
const PACKAGE_MANAGER_NAMES = new Set(["bun", "npm", "pnpm", "yarn"]);
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
const GIT_GLOBAL_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);
const GIT_GLOBAL_VALUE_OPTION_PREFIXES = [...GIT_GLOBAL_VALUE_OPTIONS].map((option) => `${option}=`);
const GIT_GLOBAL_FLAG_OPTIONS = new Set([
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
const WRANGLER_GLOBAL_VALUE_OPTIONS = new Set(["-c", "--config", "-e", "--env", "--cwd"]);
const OPAQUE_SHELL_VIOLATION_REASON = "opaque shell construct around a guarded command; run it directly";
const UNRESOLVED_SHELL_INDIRECTION_VIOLATION_REASON =
  "unresolved shell indirection around a guarded command";
const OPAQUE_SHELL_CONSTRUCT_RE = [
  /\$\(/,
  /`/,
  /\beval\b/i,
  /\b(?:sh|bash|zsh)\s+(?:-[^\s;&|]*c[^\s;&|]*|--command)(?=\s|$)/i,
];
const GUARDED_SHELL_KEYWORD_RE = [
  /\breset\s+--hard\b/i,
  /\bclean\s+-[^\s;&|]*f[^\s;&|]*\b/i,
  /\bdeploy\b/i,
  /\.env/i,
  /migrations\//i,
];
// eslint-disable-next-line security/detect-unsafe-regex -- bounded shell-keyword recognizer
const D1_EXECUTE_KEYWORD_RE = /\b(?:wrangler\s+)?d1\s+execute\b/i;
const REMOTE_FLAG_RE = /--remote(?:[=;\s&|]|$)/i;

function commandIsRawPatchPayload(command: unknown): boolean {
  return String(command ?? "")
    .trimStart()
    .startsWith("*** Begin Patch");
}

function commandLooksLikePatchPayload(command: unknown): boolean {
  const text = String(command ?? "").trimStart();
  return commandIsRawPatchPayload(text) || /^apply_patch(?:\s|$)/.test(text);
}

function stripHereDocBodies(command: unknown): string {
  const lines = String(command ?? "").split(/\r?\n/g);
  const kept: string[] = [];
  let marker = "";

  for (const line of lines) {
    if (marker) {
      if (line.trim() === marker) {
        marker = "";
      }
      continue;
    }

    kept.push(line);
    const match = line.match(/<<-?\s*['"]?([A-Za-z0-9_.-]+)['"]?/);
    if (match) {
      marker = match[1];
    }
  }

  return kept.join("\n");
}

function getExecutableShellText(command: unknown): string {
  if (commandIsRawPatchPayload(command)) return "";
  return stripHereDocBodies(command);
}

function commandHasBackgroundSeparator(command: unknown): boolean {
  const tokens = tokenizeShell(getExecutableShellText(command));
  return tokens.some(
    (token, index) =>
      token === "&" && tokens[index - 1] !== ">" && tokens[index - 1] !== ">>" && tokens[index + 1] !== ">",
  );
}

function commandHasOpaqueGuardedConstruct(command: unknown): boolean {
  const text = getExecutableShellText(command);
  const hasOpaqueConstruct =
    OPAQUE_SHELL_CONSTRUCT_RE.some((construct) => construct.test(text)) ||
    commandHasPipedShell(command) ||
    commandHasXargsShell(command) ||
    commandHasBackgroundSeparator(command);

  return hasOpaqueConstruct && getShellCommandInvocations(command).some(isGuardedShellInvocation);
}

function tokenizeShell(command: unknown): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let escaping = false;
  const text = String(command ?? "");

  const pushToken = () => {
    if (token) {
      tokens.push(token);
      token = "";
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

    if (char === "&" || char === "|" || char === ";") {
      pushToken();
      tokens.push(char);
      continue;
    }

    if (char === ">") {
      pushToken();
      if (text[i + 1] === ">") {
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

function commandHasPipedShell(command: unknown): boolean {
  const tokens = tokenizeShell(getExecutableShellText(command));
  return tokens.some(
    (token, index) => token === "|" && ["sh", "bash", "zsh"].includes(shellCommandName(tokens[index + 1])),
  );
}

function commandHasXargsShell(command: unknown): boolean {
  const tokens = tokenizeShell(getExecutableShellText(command));
  return tokens.some((token, index) => {
    if (shellCommandName(token) !== "xargs") return false;
    for (let nextIndex = index + 1; nextIndex < tokens.length; nextIndex += 1) {
      const nextToken = tokens[nextIndex];
      if (isShellControlToken(nextToken)) return false;
      if (["sh", "bash", "zsh"].includes(shellCommandName(nextToken))) return true;
    }
    return false;
  });
}

function splitShellTokens(command: unknown): string[] {
  return tokenizeShell(getExecutableShellText(command)).filter((token) => !SHELL_CONTROL_TOKENS.has(token));
}

function shellCommandName(token: unknown): string {
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

function skipLeadingOptions(
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

function packageManagerScriptIndex(tokens: readonly string[], name: string): number | null {
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

function isVariableExpandedExecutable(token: unknown): boolean {
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

function getShellCommandInvocations(command: unknown, depth = 0): ShellInvocation[] {
  const tokens = tokenizeShell(getExecutableShellText(command));
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

    const resolvedIndex = resolveExecutableIndex(tokens, index);
    if (resolvedIndex !== null) {
      const endIndex = tokens.findIndex(
        (candidate, candidateIndex) => candidateIndex > resolvedIndex && isShellControlToken(candidate),
      );
      const invocationTokens = tokens.slice(resolvedIndex, endIndex === -1 ? tokens.length : endIndex);
      invocations.push({
        name: shellCommandName(tokens[resolvedIndex]),
        tokens: invocationTokens,
      });

      if (depth < 3) {
        for (const nestedCommand of getInvocationNestedShellCommands(invocations[invocations.length - 1]!)) {
          invocations.push(...getShellCommandInvocations(nestedCommand, depth + 1));
        }
      }
    }

    atCommandStart = false;
  }

  if (depth < 3) {
    for (const nestedCommand of getNestedShellCommands(getExecutableShellText(command))) {
      invocations.push(...getShellCommandInvocations(nestedCommand, depth + 1));
    }
  }

  return invocations;
}

function packageManagerInvokesDeploy(tokens: readonly string[], name: string): boolean {
  const scriptIndex = packageManagerScriptIndex(tokens, name);
  if (scriptIndex === null) return false;
  return tokens[scriptIndex] === "deploy";
}

function invocationHasProtectedExecutablePath(invocation: ShellInvocation): boolean {
  const normalizedExecutable = normalizeLocalPath(invocation.tokens[0]);
  if (normalizedExecutable && PROTECTED_WRITE_RULES.some((rule) => rule.test(normalizedExecutable))) return true;
  if (normalizedExecutable.includes("migrations/")) return true;

  if (["node", "python", "python3"].includes(invocation.name)) {
    const scriptPath = normalizeLocalPath(invocation.tokens[1]);
    return Boolean(scriptPath && (scriptPath.includes("migrations/") || PROTECTED_WRITE_RULES.some((rule) => rule.test(scriptPath))));
  }

  return false;
}

function isGuardedShellInvocation(invocation: ShellInvocation): boolean {
  const { name, tokens } = invocation;
  if (invocationHasProtectedExecutablePath(invocation)) return true;

  if (name === "git") {
    const cursor = gitSubcommandCursor(tokens);
    const subcommand = tokens[cursor];
    const optionTokens = tokens.slice(cursor + 1);
    if (subcommand === "reset" && optionTokens.slice(0, 7).includes("--hard")) return true;
    if (
      subcommand === "clean" &&
      !optionTokens.some((token) => token === "--dry-run" || token === "--help" || token === "-h") &&
      !optionTokens.some((token) => /^-[^-]*n/.test(token)) &&
      optionTokens.slice(0, 5).some((token) => token.startsWith("-") && token.includes("f"))
    ) {
      return true;
    }
  }

  if (name === "wrangler") {
    if (invocationHasHelpFlag(tokens) || invocationHasDryRunFlag(tokens)) return false;
    const args = stripWranglerGlobalOptions(tokens.slice(1));
    if (
      args[0] === "deploy" ||
      (args[0] === "versions" && args[1] === "deploy") ||
      (args[0] === "pages" && args[1] === "deploy")
    ) {
      return true;
    }
    if (
      args[0] === "d1" &&
      ((args[1] === "execute" && tokens.some((token) => token === "--remote" || token.startsWith("--remote="))) ||
        (args[1] === "migrations" && args[2] === "apply"))
    ) {
      return true;
    }
  }

  if (PACKAGE_MANAGER_NAMES.has(name) && packageManagerInvokesDeploy(tokens, name)) return true;
  if (name === "deploy") return true;

  return false;
}

function commandHasGuardedKeyword(command: unknown): boolean {
  const text = getExecutableShellText(command);
  const hasRemoteD1Execute = D1_EXECUTE_KEYWORD_RE.test(text) && REMOTE_FLAG_RE.test(text);
  return (
    GUARDED_SHELL_KEYWORD_RE.some((keyword) => keyword.test(text)) ||
    hasRemoteD1Execute ||
    Boolean(findProtectedLiteralPath(text))
  );
}

function commandHasUnresolvedShellIndirection(command: unknown): boolean {
  return (
    commandHasGuardedKeyword(command) &&
    getShellCommandInvocations(command).some((invocation) => isVariableExpandedExecutable(invocation.name))
  );
}

function stripWranglerGlobalOptions(tokens: readonly string[]): string[] {
  return tokens.slice(skipLeadingOptions(tokens, 0, WRANGLER_GLOBAL_VALUE_OPTIONS));
}

function invocationHasHelpFlag(tokens: readonly string[]): boolean {
  return tokens.includes("--help") || tokens.includes("-h");
}

function invocationHasDryRunFlag(tokens: readonly string[]): boolean {
  return tokens.includes("--dry-run");
}

function extractBashWritePaths(command: unknown): string[] {
  const paths: string[] = [];
  const tokens = splitShellTokens(command);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === ">" || token === ">>") {
      paths.push(tokens[i + 1] ?? "");
    } else if (token.startsWith(">>") && token.length > 2) {
      paths.push(token.slice(2));
    } else if (token.startsWith(">") && token.length > 1) {
      paths.push(token.slice(1));
    } else if (token.startsWith("tee") && token.length === 3) {
      let nextIndex = i + 1;
      while (tokens[nextIndex]?.startsWith("-")) {
        nextIndex += 1;
      }
      paths.push(tokens[nextIndex] ?? "");
    }
  }
  return paths;
}

interface CommandOptionValue {
  found: boolean;
  value: string | null;
}

function findCommandOptionValue(tokens: readonly string[], optionName: string): CommandOptionValue {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    // eslint-disable-next-line security/detect-possible-timing-attacks -- compares a policy option token, never a secret
    if (token === optionName) {
      return { found: true, value: tokens[index + 1] ?? null };
    }
    if (token?.startsWith(`${optionName}=`)) {
      return { found: true, value: token.slice(optionName.length + 1) };
    }
  }
  return { found: false, value: null };
}

function getCommandOperands(
  tokens: readonly string[],
  valueOptions: ReadonlySet<string> = new Set<string>(),
): string[] {
  const operands: string[] = [];
  let optionsEnded = false;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token?.startsWith("-")) {
      const option = token.split("=", 1)[0];
      if (!token.includes("=") && valueOptions.has(option)) {
        index += 1;
      }
      continue;
    }
    operands.push(token);
  }

  return operands;
}

function hasInPlaceFlag(tokens: readonly string[]): boolean {
  return tokens.slice(1).some(
    (token) => token === "--in-place" || token?.startsWith("--in-place=") || /^-[^-]*i/.test(token ?? ""),
  );
}

function extractCommandWritePaths(command: unknown): string[] {
  const paths: string[] = [];
  const truncateValueOptions = new Set(["-s", "--size"]);

  for (const invocation of getShellCommandInvocations(command)) {
    const { name, tokens } = invocation;
    if (name === "rm" || name === "mv" || name === "touch") {
      paths.push(...getCommandOperands(tokens));
    } else if (name === "cp") {
      const operands = getCommandOperands(tokens);
      if (operands.length > 0) paths.push(operands[operands.length - 1]!);
    } else if ((name === "sed" || name === "perl") && hasInPlaceFlag(tokens)) {
      paths.push(...getCommandOperands(tokens));
    } else if (name === "truncate") {
      paths.push(...getCommandOperands(tokens, truncateValueOptions));
    }
  }

  return paths;
}

const PROTECTED_LITERAL_PATH_RE =
  /(?:^|[\s"'`(=,/:])([A-Za-z0-9._-]+)(?=$|[\s"'`),;/:])/gi;

function findProtectedLiteralPath(text: string): string | null {
  for (const match of text.matchAll(PROTECTED_LITERAL_PATH_RE)) {
    const path = normalizeLocalPath(match[1]);
    if (path && PROTECTED_WRITE_RULES.some((rule) => rule.test(path))) {
      return path;
    }
  }
  return null;
}

function isInlineScriptInvocation(invocation: ShellInvocation): boolean {
  if (!new Set(["node", "python", "python3"]).has(invocation.name)) return false;
  return invocation.tokens.slice(1).some(
    (token) => token === "-c" || token === "--command" || token === "-e" || token === "--eval",
  );
}

function extractInlineScriptWritePaths(command: unknown): string[] {
  const text = String(command ?? "");
  if (!getShellCommandInvocations(command).some(isInlineScriptInvocation)) return [];

  const hasPythonOpenWrite = /\bopen\s*\([^)]*(?:,\s*|\bmode\s*=\s*)["'][^"']*w[^"']*["']/i.test(text);
  const hasNodeWrite = /\bwriteFile(?:Sync)?\s*\(/.test(text);
  if (!hasPythonOpenWrite && !hasNodeWrite) return [];

  const path = findProtectedLiteralPath(text);
  return path ? [path] : [];
}

function withHookRule(rule: HookRuleId, reason: string): string {
  return `[rule:${rule}] ${reason}`;
}

function collectToolPaths(hookInput: UnknownRecord = {}): string[] {
  const toolInput = getToolInput(hookInput);
  const command = getCommandFromHookInput(hookInput);
  return normalizeChangedFiles(
    [
      toolInput.file_path,
      toolInput.filePath,
      toolInput.path,
      toolInput.filename,
      ...collectArrayPaths(toolInput.files),
      ...collectArrayPaths(toolInput.edits),
      ...extractPatchPaths(toolInput.patch),
      ...extractPatchPaths(String(toolInput.input ?? "")),
      ...extractPatchPaths(command),
      ...extractBashWritePaths(command),
      ...extractCommandWritePaths(command),
      ...extractInlineScriptWritePaths(command),
    ]
      .filter(Boolean)
      .map(normalizeLocalPath),
  );
}

function collectToolText(hookInput: UnknownRecord = {}): string {
  const toolInput = getToolInput(hookInput);
  const chunks: unknown[] = [
    toolInput.content,
    toolInput.new_string,
    toolInput.newString,
    toolInput.patch,
    toolInput.input,
    getCommandFromHookInput(hookInput),
  ];
  if (Array.isArray(toolInput.edits)) {
    chunks.push(
      ...toolInput.edits.map((edit) =>
        isRecord(edit) ? edit.new_string ?? edit.newString ?? "" : "",
      ),
    );
  }
  return chunks.filter((chunk) => typeof chunk === "string").join("\n");
}

function extractAddedPatchText(hookInput: UnknownRecord = {}): string {
  const toolInput = getToolInput(hookInput);
  const command = getCommandFromHookInput(hookInput);
  const patchText = String(
    toolInput.patch ?? toolInput.input ?? (commandLooksLikePatchPayload(command) ? command : ""),
  );
  if (!patchText) return "";
  return patchText
    .split(/\r?\n/g)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function findProtectedWrite(paths: readonly string[]): HookViolation | null {
  for (const path of paths) {
    const file = normalizeLocalPath(path);
    const rule = PROTECTED_WRITE_RULES.find((candidate) => candidate.test(file));
    if (rule) {
      return {
        file,
        reason: withHookRule(
          "protected-write",
          `Direct writes to ${rule.label} are blocked by the Pharos agent hook: ${file}.`,
        ),
        rule: "protected-write",
      };
    }
  }
  return null;
}

function gitSubcommandCursor(tokens: readonly string[]): number {
  let cursor = 1;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (!token) break;

    if (GIT_GLOBAL_VALUE_OPTIONS.has(token)) {
      cursor += 2;
      continue;
    }

    if (GIT_GLOBAL_VALUE_OPTION_PREFIXES.some((option) => token.startsWith(option))) {
      cursor += 1;
      continue;
    }

    if (GIT_GLOBAL_FLAG_OPTIONS.has(token)) {
      cursor += 1;
      continue;
    }

    break;
  }
  return cursor;
}

function* gitSubcommandTokens(command: unknown, subcommand: string): Generator<string[]> {
  for (const invocation of getShellCommandInvocations(command)) {
    if (invocation.name !== "git") continue;
    const { tokens } = invocation;
    const cursor = gitSubcommandCursor(tokens);
    if (tokens[cursor] !== subcommand) continue;
    yield tokens.slice(cursor + 1);
  }
}

function commandInvokesGitCleanForceDelete(command: unknown): boolean {
  for (const optionTokens of gitSubcommandTokens(command, "clean")) {
    if (
      optionTokens.some((token) => token === "--dry-run" || token === "--help" || token === "-h") ||
      optionTokens.some((token) => /^-[^-]*n/.test(token))
    ) {
      continue;
    }

    const optionText = optionTokens
      .slice(0, 5)
      .filter((token) => token.startsWith("-"))
      .join("");
    if (optionText.includes("f")) {
      return true;
    }
  }
  return false;
}

function commandInvokesGitResetHard(command: unknown): boolean {
  for (const optionTokens of gitSubcommandTokens(command, "reset")) {
    if (optionTokens.includes("--help") || optionTokens.includes("-h")) continue;
    if (optionTokens.slice(0, 7).includes("--hard")) {
      return true;
    }
  }
  return false;
}

function stripSqlCommentsAndStrings(sql: string): string {
  let output = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "-" && next === "-") {
      output += "  ";
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < sql.length) {
        if (sql[index] === "*" && sql[index + 1] === "/") {
          output += "  ";
          index += 2;
          break;
        }
        output += sql[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      output += " ";
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            output += "  ";
            index += 2;
            continue;
          }
          output += " ";
          index += 1;
          break;
        }
        output += sql[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function withQueryKeyword(statement: string): string | null {
  let depth = 0;
  let closedCte = false;

  for (let index = 4; index < statement.length;) {
    const char = statement[index];
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      if (depth > 0) depth -= 1;
      if (depth === 0) closedCte = true;
      index += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z]/.test(char)) {
      let end = index + 1;
      while (end < statement.length && /[A-Za-z]/.test(statement[end])) end += 1;
      const word = statement.slice(index, end).toLowerCase();
      if (closedCte && (word === "select" || SQL_MUTATING_KEYWORDS.has(word))) return word;
      index = end;
      continue;
    }
    index += 1;
  }

  return null;
}

function isReadOnlySql(sql: string): boolean {
  const sanitized = stripSqlCommentsAndStrings(sql);
  const statements = sanitized
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length === 0) return false;

  return statements.every((statement) => {
    const keyword = statement.match(/^([A-Za-z]+)/)?.[1]?.toLowerCase();
    if (!keyword) return false;
    if (SQL_MUTATING_KEYWORDS.has(keyword)) return false;
    if (keyword === "pragma") {
      const isTableInfo =
        /^pragma\s+table_info\b/i.test(statement) || /^pragma\s+[A-Za-z_][A-Za-z0-9_]*\.table_info\b/i.test(statement);
      return isTableInfo && !/=/.test(statement);
    }
    if (keyword === "select" || keyword === "explain") return true;
    if (keyword === "with") return withQueryKeyword(statement) === "select";
    return false;
  });
}

function readReferencedSqlFile(filePath: string, additionalRoots: readonly string[] = []): string | null {
  const rawPath = filePath.startsWith("file://") ? filePath.slice("file://".length) : filePath;
  const candidatePaths = isAbsolute(rawPath)
    ? [resolve(rawPath)]
    : unique([
        ...additionalRoots.map((root) => resolve(root, rawPath)),
        resolve(REPO_ROOT, rawPath),
        resolve(process.cwd(), rawPath),
      ]);

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) continue;
    try {
      return readFileSync(candidatePath, "utf8");
    } catch {
      return null;
    }
  }

  return null;
}

function getShellWorkingDirectory(invocations: readonly ShellInvocation[], targetIndex: number): string {
  let workingDirectory = process.cwd();
  for (let index = 0; index < targetIndex; index += 1) {
    const invocation = invocations[index];
    if (invocation?.name !== "cd") continue;
    const destination = invocation.tokens[1];
    if (!destination || destination.startsWith("-")) continue;
    workingDirectory = resolve(workingDirectory, destination);
  }
  return workingDirectory;
}

function inspectRemoteD1ExecuteSql(tokens: readonly string[], additionalRoots: readonly string[] = []): boolean {
  const fileOption = findCommandOptionValue(tokens, "--file");
  if (fileOption.found) {
    return fileOption.value === null || !isReadOnlySql(readReferencedSqlFile(fileOption.value, additionalRoots) ?? "");
  }

  const commandOption = findCommandOptionValue(tokens, "--command");
  if (!commandOption.found || commandOption.value === null) return true;
  return !isReadOnlySql(commandOption.value);
}

function commandInvokesRemoteD1Mutation(command: unknown): boolean {
  const invocations = getShellCommandInvocations(command);
  return invocations.some((invocation, invocationIndex) => {
    if (invocation.name !== "wrangler" || invocationHasHelpFlag(invocation.tokens)) return false;

    const args = stripWranglerGlobalOptions(invocation.tokens.slice(1));
    if (args[0] !== "d1" || !invocation.tokens.some((token) => token === "--remote" || token.startsWith("--remote="))) {
      return false;
    }

    if (args[1] === "migrations" && args[2] === "apply") {
      return true;
    }

    if (args[1] !== "execute") {
      return false;
    }

    return inspectRemoteD1ExecuteSql(invocation.tokens, [getShellWorkingDirectory(invocations, invocationIndex)]);
  });
}

function commandInvokesRawProductionDeploy(command: unknown): boolean {
  return getShellCommandInvocations(command).some((invocation) => {
    if (invocationHasHelpFlag(invocation.tokens)) return false;
    if (invocation.name === "wrangler" && invocationHasDryRunFlag(invocation.tokens)) return false;

    if (PACKAGE_MANAGER_NAMES.has(invocation.name)) {
      return packageManagerInvokesDeploy(invocation.tokens, invocation.name);
    }

    if (invocation.name !== "wrangler") {
      return false;
    }

    const args = stripWranglerGlobalOptions(invocation.tokens.slice(1));
    return (
      args[0] === "deploy" ||
      (args[0] === "versions" && args[1] === "deploy") ||
      (args[0] === "pages" && args[1] === "deploy")
    );
  });
}

function findUnsafeMigrationSql(paths: readonly string[], hookInput: UnknownRecord = {}): HookViolation | null {
  if (!paths.some((path) => /^worker\/migrations\/.*\.sql$/i.test(path))) {
    return null;
  }

  const text = extractAddedPatchText(hookInput) || collectToolText(hookInput);
  if (!UNSAFE_MIGRATION_SQL_RE.test(text)) {
    return null;
  }

  return {
    reason: withHookRule(
      "migration-sql",
      "Obvious destructive migration SQL is blocked. D1 cleanup needs a separate coordinated rollout.",
    ),
    rule: "migration-sql",
  };
}

function findCommandViolation(command: unknown): HookViolation | null {
  if (!command) return null;

  if (commandHasUnresolvedShellIndirection(command)) {
    return {
      reason: withHookRule("shell-indirection", UNRESOLVED_SHELL_INDIRECTION_VIOLATION_REASON),
      rule: "shell-indirection",
    };
  }

  if (commandHasOpaqueGuardedConstruct(command)) {
    return {
      reason: withHookRule("opaque-shell", OPAQUE_SHELL_VIOLATION_REASON),
      rule: "opaque-shell",
    };
  }

  if (commandInvokesGitResetHard(command)) {
    return {
      reason: withHookRule(
        "git-destructive",
        "Destructive `git reset --hard` is blocked. Preserve existing user/worktree changes.",
      ),
      rule: "git-destructive",
    };
  }

  if (commandInvokesGitCleanForceDelete(command)) {
    return {
      reason: withHookRule(
        "git-destructive",
        "Destructive `git clean -f`/`-fd` style cleanup is blocked. Preserve untracked user/worktree changes.",
      ),
      rule: "git-destructive",
    };
  }

  if (commandInvokesRawProductionDeploy(command)) {
    return {
      reason: withHookRule(
        "deploy",
        "Raw production deploy commands are blocked. Use the documented Pharos release flow instead.",
      ),
      rule: "deploy",
    };
  }

  if (commandInvokesRemoteD1Mutation(command)) {
    return {
      reason: withHookRule(
        "d1-remote-mutation",
        "Remote D1 mutation commands are blocked by default. Use dry-runs or the coordinated production runbook.",
      ),
      rule: "d1-remote-mutation",
    };
  }

  return null;
}

export function findPreToolUseViolation(hookInput: UnknownRecord = {}): HookViolation | null {
  const command = getCommandFromHookInput(hookInput);
  const commandViolation = findCommandViolation(command);
  if (commandViolation) {
    return commandViolation;
  }

  const paths = collectToolPaths(hookInput);
  const protectedWrite = findProtectedWrite(paths);
  if (protectedWrite) {
    return protectedWrite;
  }

  const unsafeMigration = findUnsafeMigrationSql(paths, hookInput);
  if (unsafeMigration) {
    return unsafeMigration;
  }

  return null;
}

export function findPermissionRequestViolation(hookInput: UnknownRecord = {}): HookViolation | null {
  const violation = findPreToolUseViolation(hookInput);
  if (!violation) return null;

  const command = getCommandFromHookInput(hookInput);
  if (!commandHasOpaqueGuardedConstruct(command) && commandInvokesRawProductionDeploy(command)) {
    return {
      reason: withHookRule(
        "deploy",
        "Production deploy permission is denied by the Pharos hook. Use the documented release workflow.",
      ),
      rule: "deploy",
    };
  }
  if (!commandHasOpaqueGuardedConstruct(command) && commandInvokesRemoteD1Mutation(command)) {
    return {
      reason: withHookRule(
        "d1-remote-mutation",
        "Remote D1 mutation permission is denied by the Pharos hook. Use a dry-run or coordinated runbook.",
      ),
      rule: "d1-remote-mutation",
    };
  }
  return violation;
}

function buildWarnings(changedFiles: readonly string[]): string[] {
  const warnings: string[] = [];
  if (changedFiles.some((file) => file.startsWith("src/components/ui/"))) {
    warnings.push("src/components/ui contains shadcn primitives; edit only when explicitly required.");
  }
  if (changedFiles.some((file) => file.startsWith("worker/migrations/"))) {
    warnings.push("D1 migrations are applied before the new Worker is live; keep them backward-compatible.");
  }
  if (changedFiles.some((file) => file === "AGENTS.md" || file === "CLAUDE.md")) {
    warnings.push("AGENTS.md is generated from CLAUDE.md; edit CLAUDE.md and run node --import tsx scripts/maintenance/generate-agents-doc.ts.");
  }
  if (changedFiles.some((file) => file.startsWith("shared/data/stablecoins/"))) {
    warnings.push("Stablecoin data changes must not introduce manual supply overrides.");
  }
  return warnings;
}

export function readChangedFiles({
  baseRef,
  execFile = execFileSync as GitExec,
  headRef,
  staged = false,
}: ChangedFileOptions = {}): string[] {
  const mode = staged
    ? { kind: "staged" as const }
    : baseRef || headRef
      ? { kind: "range" as const, base: baseRef || "origin/main", head: headRef || "HEAD" }
      : { kind: "working" as const, includeUntracked: true };
  return normalizeChangedFiles(collectGitPaths(mode, { cwd: REPO_ROOT, failure: "empty", execFile }));
}

function formatBullets(values: readonly string[], { limit = 8 }: { limit?: number } = {}): string {
  const shown = values.slice(0, limit);
  const lines = shown.map((value) => `- ${value}`);
  if (values.length > shown.length) {
    lines.push(`- ...and ${values.length - shown.length} more`);
  }
  return lines.join("\n");
}

function formatMappings(mappings: readonly MatchedMapping[]): string {
  if (mappings.length === 0) return "- No specific ownership mapping matched yet.";
  return mappings
    .map((mapping) => `- ${mapping.label} (${mapping.risk}): ${mapping.matchedFiles.slice(0, 3).join(", ")}`)
    .join("\n");
}

function formatDocReference(doc: DocReference): string {
  return doc.anchor ? `${doc.path}#${doc.anchor}` : doc.path;
}

export function formatContract(
  contract: ChangeContract,
  { mode = "full" }: { mode?: "full" | "stop" } = {},
): string {
  const changedSummary =
    contract.changedFiles.length > 0
      ? formatBullets(contract.changedFiles, { limit: mode === "stop" ? 6 : 12 })
      : "- No current changed files detected.";
  const sections = [
    "Pharos change contract:",
    `Source: ${contract.source}`,
    "",
    "Matched mappings:",
    formatMappings(contract.mappings),
    "",
    "Changed files:",
    changedSummary,
    "",
    "Read first:",
    formatBullets(contract.docs.map(formatDocReference), { limit: mode === "stop" ? 8 : 12 }),
  ];

  if (contract.scopedContext.length > 0) {
    sections.push("", "Scoped context:", formatBullets(contract.scopedContext, { limit: mode === "stop" ? 6 : 12 }));
  }

  if (contract.background.length > 0) {
    sections.push("", "Also relevant:", formatBullets(contract.background.map(formatDocReference), { limit: mode === "stop" ? 6 : 12 }));
  }

  if (contract.hints.length > 0) {
    sections.push("", "Hints:", formatBullets(contract.hints, { limit: mode === "stop" ? 4 : 8 }));
  }

  if (contract.checks.length > 0) {
    sections.push(
      "",
      "Checks to consider before finalizing:",
      formatBullets(contract.checks, { limit: mode === "stop" ? 8 : 12 }),
    );
  }

  if (contract.warnings.length > 0) {
    sections.push("", "Warnings:", formatBullets(contract.warnings, { limit: 6 }));
  }

  sections.push("", "Core rules:", formatBullets(contract.hardRules, { limit: mode === "stop" ? 6 : 10 }));

  if (contract.deploy.deployImpact) {
    sections.push(
      "",
      `Deploy impact: pages=${contract.deploy.pagesImpact ? "yes" : "no"}, worker=${contract.deploy.workerImpact ? "yes" : "no"}.`,
    );
  }

  if (contract.source === "working tree") {
    sections.push("", "Next: npm run agent:route -- --file <path> for planned files");
  }

  return sections.join("\n");
}

export function buildSessionStartContext(contract: ChangeContract): string {
  const header = `Pharos change contract — ${contract.source} (${contract.changedFiles.length} files) — deploy: pages=${contract.deploy.pagesImpact ? "y" : "n"}, worker=${contract.deploy.workerImpact ? "y" : "n"}`;
  const readFirst = contract.docs
    .slice(0, 4)
    .map(formatDocReference)
    .join(", ");
  const scopedContext = contract.scopedContext
    .slice(0, 3)
    .join(", ");

  if (contract.changedFiles.length === 0) {
    return [header, "Route a planned path: npm run agent:route -- --file <path>"].join("\n");
  }

  const sections = [header, `Read first: ${readFirst}`];

  if (scopedContext) {
    sections.push(`Scoped context: ${scopedContext}`);
  }

  if (contract.checks.length > 0) {
    sections.push(`Focused checks: ${contract.checks.slice(0, 4).join(", ")}`);
  }

  sections.push("Route a planned path: npm run agent:route -- --file <path>");
  return sections.join("\n");
}

interface HookInputResult {
  input: UnknownRecord;
  malformed: boolean;
}

type HookMode = "pre-tool-use" | "permission-request" | "session-start";

function hookEventName(hookMode: HookMode): "PreToolUse" | "PermissionRequest" | "SessionStart" {
  if (hookMode === "pre-tool-use") return "PreToolUse";
  if (hookMode === "permission-request") return "PermissionRequest";
  return "SessionStart";
}

export function getHookHarness(hookInput: UnknownRecord): "claude" | "codex" | "unknown" {
  const claudeEvent = hookInput.hook_event_name;
  if (
    typeof claudeEvent === "string" &&
    /^[A-Z][A-Za-z0-9]*$/.test(claudeEvent) &&
    typeof hookInput.tool_name === "string"
  ) {
    return "claude";
  }

  const codexFields = [
    "hookEventName",
    "toolName",
    "toolInput",
    "sessionId",
    "source",
    "model",
    "turn_id",
    "permission_mode",
    "event",
    "tool",
    "arguments",
  ];
  if (codexFields.some((field) => Object.prototype.hasOwnProperty.call(hookInput, field))) return "codex";
  return "unknown";
}

function getDiagnosticTool(hookInput: UnknownRecord): string | null {
  const tool = hookInput.tool_name ?? hookInput.toolName;
  return typeof tool === "string" ? tool : null;
}

function sha256Prefix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function countProtectedPaths(hookInput: UnknownRecord): number {
  return collectToolPaths(hookInput).filter(
    (path) =>
      PROTECTED_WRITE_RULES.some((rule) => rule.test(path)) || /^worker\/migrations\/.*\.sql$/i.test(path),
  ).length;
}

function appendHookDiagnostic(
  hookMode: HookMode,
  hookInput: UnknownRecord,
  violation: HookViolation | null,
  malformed: boolean,
): void {
  try {
    const configuredPath = process.env.PHAROS_HOOK_DIAGNOSTICS_FILE || "agents/hook-diagnostics.jsonl";
    const diagnosticPath = isAbsolute(configuredPath) ? configuredPath : resolve(REPO_ROOT, configuredPath);
    const command = getCommandFromHookInput(hookInput);
    const record = {
      ts: new Date().toISOString(),
      harness: getHookHarness(hookInput),
      event: hookEventName(hookMode),
      tool: getDiagnosticTool(hookInput),
      decision: malformed || hookMode === "session-start" ? "none" : violation ? "deny" : "allow",
      rule: violation?.rule ?? null,
      commandDigest: sha256Prefix(command),
      pathsProtected: countProtectedPaths(hookInput),
    };
    mkdirSync(dirname(diagnosticPath), { recursive: true });
    appendFileSync(diagnosticPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Diagnostics are best-effort and must never affect hook policy or status.
  }
}

function readHookInput(): HookInputResult {
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (!raw) return { input: {}, malformed: true };
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? { input: parsed, malformed: false } : { input: {}, malformed: true };
  } catch {
    return { input: {}, malformed: true };
  }
}

export function buildSessionStartHookOutput(contract: ChangeContract) {
  return {
    hookSpecificOutput: {
      additionalContext: buildSessionStartContext(contract),
      hookEventName: "SessionStart",
    },
  };
}

function buildToolDenyOutput(reason: string, hookEventName = "PreToolUse") {
  return {
    decision: "block",
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
    reason,
  };
}

function buildPermissionRequestDenyOutput(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: reason,
      },
    },
  };
}

export function buildPreToolUseHookOutput(hookInput: UnknownRecord = {}) {
  const violation = findPreToolUseViolation(hookInput);
  if (!violation) {
    return {};
  }

  return buildToolDenyOutput(violation.reason, "PreToolUse");
}

export function buildPermissionRequestHookOutput(hookInput: UnknownRecord = {}) {
  const violation = findPermissionRequestViolation(hookInput);
  if (!violation) {
    return {};
  }

  return buildPermissionRequestDenyOutput(violation.reason);
}

function parseArgs(argv: readonly string[]): { explicitFiles: string[]; options: CliOptions } {
  const options: CliOptions = {
    allowMissing: false,
    baseRef: process.env.PHAROS_CHANGE_CONTRACT_BASE_REF,
    diagnostics: false,
    format: "text",
    headRef: process.env.PHAROS_CHANGE_CONTRACT_HEAD_REF,
    help: false,
    hook: null,
    staged: false,
  };
  const explicitFiles: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.format = "json";
    } else if (arg === "--diagnostics") {
      options.diagnostics = true;
    } else if (arg === "--new-file") {
      options.allowMissing = true;
    } else if (arg === "--staged") {
      options.staged = true;
    } else if (arg === "--hook") {
      options.hook = argv[++i] ?? null;
    } else if (arg.startsWith("--hook=")) {
      options.hook = arg.slice("--hook=".length);
    } else if (arg === "--base-ref") {
      options.baseRef = argv[++i];
    } else if (arg.startsWith("--base-ref=")) {
      options.baseRef = arg.slice("--base-ref=".length);
    } else if (arg === "--head-ref") {
      options.headRef = argv[++i];
    } else if (arg.startsWith("--head-ref=")) {
      options.headRef = arg.slice("--head-ref=".length);
    } else if (arg === "--file") {
      explicitFiles.push(argv[++i] ?? "");
    } else if (arg.startsWith("--file=")) {
      explicitFiles.push(arg.slice("--file=".length));
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }

  return { explicitFiles, options };
}

function normalizeHookMode(hook: string | null): string | null {
  if (!hook) return null;
  const normalized = String(hook)
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
  return normalized;
}

function printHelp(): void {
  console.log(`Usage: node --import tsx scripts/ci/pharos-change-contract.ts [options]

Classify the current Pharos diff into docs, checks, and agent guardrails.

Options:
  --json                  Emit the contract as JSON instead of text
  --diagnostics            Append safe per-hook diagnostics when a hook is selected
  --staged                Classify staged files only
  --new-file              Suppress missing explicit-file warnings (repeatable)
  --base-ref <ref>        Classify git diff base...head
  --head-ref <ref>        Classify git diff base...head
  --file <path>           Classify an explicit file path; repeatable
  --hook=session-start    Emit compact SessionStart hook JSON
  --hook=pre-tool-use     Emit hard-block hook JSON for unsafe tool calls
  --hook=permission-request
                          Emit production permission-policy hook JSON
`);
}

export function runCli(argv: readonly string[] = process.argv.slice(2)): void {
  const { explicitFiles, options } = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const hookRead = options.hook ? readHookInput() : { input: {}, malformed: false };
  const hookMode = normalizeHookMode(options.hook);

  if (options.hook && hookRead.malformed) {
    if (options.diagnostics || process.env.PHAROS_HOOK_DIAGNOSTICS === "1") {
      appendHookDiagnostic(normalizeHookMode(options.hook) as HookMode, {}, null, true);
    }
    console.error("pharos-change-contract: empty or malformed hook payload; no policy applied");
    console.log(JSON.stringify({}));
    return;
  }

  const hookInput = hookRead.input;

  if (hookMode === "pre-tool-use") {
    const violation = findPreToolUseViolation(hookInput);
    if (options.diagnostics || process.env.PHAROS_HOOK_DIAGNOSTICS === "1") {
      appendHookDiagnostic(hookMode, hookInput, violation, false);
    }
    console.log(JSON.stringify(buildPreToolUseHookOutput(hookInput)));
    return;
  }

  if (hookMode === "permission-request") {
    const violation = findPermissionRequestViolation(hookInput);
    if (options.diagnostics || process.env.PHAROS_HOOK_DIAGNOSTICS === "1") {
      appendHookDiagnostic(hookMode, hookInput, violation, false);
    }
    console.log(JSON.stringify(buildPermissionRequestHookOutput(hookInput)));
    return;
  }

  let changedFiles: string[];
  let source: ChangeSource;
  try {
    if (explicitFiles.length > 0) {
      source = "explicit files";
      changedFiles = normalizeExplicitFiles(explicitFiles, { allowMissing: options.allowMissing });
    } else if (options.staged) {
      source = "staged index";
      changedFiles = readChangedFiles({
        baseRef: options.baseRef,
        headRef: options.headRef,
        staged: true,
      });
    } else if (options.baseRef || options.headRef) {
      source = "base/head range";
      changedFiles = readChangedFiles({
        baseRef: options.baseRef,
        headRef: options.headRef,
        staged: false,
      });
    } else {
      source = "working tree";
      changedFiles = readChangedFiles({ staged: false });
    }
  } catch (error) {
    if (error instanceof ExplicitPathError) {
      console.error(`error: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const contract = classifyChangedFilesWithSource(changedFiles, source);

  if (hookMode === "session-start") {
    if (options.diagnostics || process.env.PHAROS_HOOK_DIAGNOSTICS === "1") {
      appendHookDiagnostic(hookMode, hookInput, null, false);
    }
    console.log(JSON.stringify(buildSessionStartHookOutput(contract)));
    return;
  }

  if (options.format === "json") {
    console.log(JSON.stringify(contract, null, 2));
    return;
  }

  console.log(formatContract(contract));
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
