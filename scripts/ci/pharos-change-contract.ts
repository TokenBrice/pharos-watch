#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  hasDeployImpact,
  hasPagesDeployImpact,
  hasWorkerDeployImpact,
  normalizeRepoPath,
} from "../lib/deploy-impact.mts";
import { splitNullDelimited } from "../lib/changed-files.mts";
import { CORE_RULES, DEFAULT_BASE_DOCS, PATH_FAMILIES } from "../lib/doc-ownership-registry.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

type UnknownRecord = Record<string, unknown>;
type GitExec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; encoding: "utf8" },
) => string;

interface PathFamilyRule {
  checks: string[];
  docsLikelyRequired: string[];
  docsToRead: string[];
  exactPaths?: string[];
  hardRules: string[];
  id: string;
  label: string;
  prefixes?: string[];
  regexes?: RegExp[];
  risk: string;
}

interface MatchedFamily {
  id: string;
  label: string;
  matchedFiles: string[];
  risk: string;
}

interface ChangeContract {
  changedFiles: string[];
  checks: string[];
  deploy: {
    deployImpact: boolean;
    pagesImpact: boolean;
    workerImpact: boolean;
  };
  docsLikelyRequired: string[];
  docsToRead: string[];
  families: MatchedFamily[];
  hardRules: string[];
  warnings: string[];
}

interface HookViolation {
  file?: string;
  reason: string;
}

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
  baseRef?: string;
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

const MUTATING_SQL_RE = /\b(alter|create|delete|drop|insert|replace|truncate|update)\b/i;
const UNSAFE_MIGRATION_SQL_RE =
  /\b(drop\s+table|drop\s+column|alter\s+table[\s\S]{0,160}\bdrop\b|delete\s+from|truncate\b|pragma\s+writable_schema|rename\s+(?:table|column))\b/i;

const PROTECTED_WRITE_RULES: ReadonlyArray<{ label: string; test: (file: string) => boolean }> = [
  {
    label: "environment files",
    test: (file) => /(^|\/)\.env(?:\.|$)/.test(file) || file === ".dev.vars" || file === "worker/.dev.vars",
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

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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
  if (rule.exactPaths?.includes(file)) return true;
  if (rule.prefixes?.some((prefix) => file.startsWith(prefix))) return true;
  if (rule.regexes?.some((regex) => regex.test(file))) return true;
  return false;
}

function compareFamilyRisk(a: PathFamilyRule, b: PathFamilyRule): number {
  const rankDelta = (RISK_RANK.get(b.risk) ?? 0) - (RISK_RANK.get(a.risk) ?? 0);
  if (rankDelta !== 0) return rankDelta;
  return a.label.localeCompare(b.label);
}

export function normalizeChangedFiles(files: readonly string[]): string[] {
  return unique(files.map((file) => normalizeRepoPath(file.trim())).filter(Boolean)).sort();
}

export function classifyChangedFiles(files: readonly string[]): ChangeContract {
  const changedFiles = normalizeChangedFiles(files);
  const matchedFamilies = TYPED_PATH_FAMILIES.map((family) => ({
    ...family,
    matchedFiles: changedFiles.filter((file) => fileMatchesRule(file, family)),
  }))
    .filter((family) => family.matchedFiles.length > 0)
    .sort(compareFamilyRisk);

  const docsToRead = unique([...TYPED_DEFAULT_BASE_DOCS, ...matchedFamilies.flatMap((family) => family.docsToRead)]);
  const docsLikelyRequired = unique(matchedFamilies.flatMap((family) => family.docsLikelyRequired));
  const checks = unique(matchedFamilies.flatMap((family) => family.checks));
  const hardRules = unique([...TYPED_CORE_RULES, ...matchedFamilies.flatMap((family) => family.hardRules)]);
  const warnings = buildWarnings(changedFiles);

  return {
    changedFiles,
    checks,
    deploy: {
      deployImpact: hasDeployImpact(changedFiles),
      pagesImpact: hasPagesDeployImpact(changedFiles),
      workerImpact: hasWorkerDeployImpact(changedFiles),
    },
    docsLikelyRequired,
    docsToRead,
    families: matchedFamilies.map((family) => ({
      id: family.id,
      label: family.label,
      matchedFiles: family.matchedFiles,
      risk: family.risk,
    })),
    hardRules,
    warnings,
  };
}

function getToolInput(hookInput: UnknownRecord = {}): UnknownRecord {
  const candidate = hookInput.tool_input ?? hookInput.toolInput ?? hookInput.input ?? hookInput.arguments;
  return isRecord(candidate) ? candidate : {};
}

function getCommandFromHookInput(hookInput: UnknownRecord = {}): string {
  const toolInput = getToolInput(hookInput);
  return String(toolInput.command ?? hookInput.command ?? "");
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

const SHELL_CONTROL_TOKENS = new Set([";", "&&", "||", "|", "\n"]);
const ENV_VALUE_OPTIONS = new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]);
const NPX_VALUE_OPTIONS = new Set(["-c", "--call", "-p", "--package", "--cache", "--shell", "--userconfig"]);
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

    if (char === "|" || char === ";") {
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

  if (name === "npx") {
    const index = skipLeadingOptions(tokens, startIndex + 1, NPX_VALUE_OPTIONS);
    return index < tokens.length && !isShellControlToken(tokens[index]) ? index : startIndex;
  }

  if (name === "sudo" || name === "command" || name === "exec") {
    const index = skipLeadingOptions(tokens, startIndex + 1);
    return resolveExecutableIndex(tokens, index, depth + 1);
  }

  return startIndex;
}

function getShellEvalArgument(tokens: readonly string[]): string {
  if (!SHELL_EVAL_COMMANDS.has(shellCommandName(tokens[0]))) return "";

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-c" || token === "--command" || (/^-[A-Za-z]+$/.test(token) && token.includes("c"))) {
      return tokens[index + 1] ?? "";
    }
  }

  return "";
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

      const nestedCommand = depth < 3 ? getShellEvalArgument(invocationTokens) : "";
      if (nestedCommand) {
        invocations.push(...getShellCommandInvocations(nestedCommand, depth + 1));
      }
    }

    atCommandStart = false;
  }

  return invocations;
}

function stripWranglerGlobalOptions(tokens: readonly string[]): string[] {
  return tokens.slice(skipLeadingOptions(tokens, 0, WRANGLER_GLOBAL_VALUE_OPTIONS));
}

function invocationHasHelpFlag(tokens: readonly string[]): boolean {
  return tokens.includes("--help") || tokens.includes("-h");
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
        reason: `Direct writes to ${rule.label} are blocked by the Pharos agent hook: ${file}.`,
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
    const optionText = optionTokens
      .slice(0, 5)
      .filter((token) => token.startsWith("-"))
      .join("");
    if (optionText.includes("f") && optionText.includes("d")) {
      return true;
    }
  }
  return false;
}

function commandInvokesGitResetHard(command: unknown): boolean {
  for (const optionTokens of gitSubcommandTokens(command, "reset")) {
    if (optionTokens.slice(0, 7).includes("--hard")) {
      return true;
    }
  }
  return false;
}

function commandInvokesRemoteD1Mutation(command: unknown): boolean {
  return getShellCommandInvocations(command).some((invocation) => {
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

    if (invocation.tokens.some((token) => token === "--file" || token.startsWith("--file="))) {
      return true;
    }

    return MUTATING_SQL_RE.test(args.join(" "));
  });
}

function commandInvokesRawProductionDeploy(command: unknown): boolean {
  return getShellCommandInvocations(command).some((invocation) => {
    if (invocationHasHelpFlag(invocation.tokens)) return false;

    if (invocation.name === "npm") {
      return invocation.tokens[1] === "run" && invocation.tokens[2] === "deploy";
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
    reason: "Obvious destructive migration SQL is blocked. D1 cleanup needs a separate coordinated rollout.",
  };
}

function findCommandViolation(command: unknown): string | null {
  if (!command) return null;

  if (commandInvokesGitResetHard(command)) {
    return "Destructive `git reset --hard` is blocked. Preserve existing user/worktree changes.";
  }

  if (commandInvokesGitCleanForceDelete(command)) {
    return "Destructive `git clean -fd` style cleanup is blocked. Preserve untracked user/worktree changes.";
  }

  if (commandInvokesRawProductionDeploy(command)) {
    return "Raw production deploy commands are blocked. Use the documented Pharos release flow instead.";
  }

  if (commandInvokesRemoteD1Mutation(command)) {
    return "Remote D1 mutation commands are blocked by default. Use dry-runs or the coordinated production runbook.";
  }

  return null;
}

export function findPreToolUseViolation(hookInput: UnknownRecord = {}): HookViolation | null {
  const command = getCommandFromHookInput(hookInput);
  const commandViolation = findCommandViolation(command);
  if (commandViolation) {
    return { reason: commandViolation };
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
  const command = getCommandFromHookInput(hookInput);
  if (commandInvokesRawProductionDeploy(command)) {
    return {
      reason: "Production deploy permission is denied by the Pharos hook. Use the documented release workflow.",
    };
  }
  if (commandInvokesRemoteD1Mutation(command)) {
    return {
      reason: "Remote D1 mutation permission is denied by the Pharos hook. Use a dry-run or coordinated runbook.",
    };
  }
  return null;
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

function getRepoChangedFiles({
  baseRef,
  execFile = execFileSync as GitExec,
  headRef,
  staged = false,
}: ChangedFileOptions = {}): string[] {
  if (baseRef || headRef) {
    const base = baseRef || "origin/main";
    const head = headRef || "HEAD";
    const raw = execFile("git", ["diff", "--name-only", "-z", `${base}...${head}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return splitNullDelimited(raw);
  }

  if (staged) {
    const raw = execFile("git", ["diff", "--name-only", "--cached", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
    return splitNullDelimited(raw);
  }

  const trackedRaw = execFile("git", ["diff", "--name-only", "-z", "HEAD", "--"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const untrackedRaw = execFile("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return [...splitNullDelimited(trackedRaw), ...splitNullDelimited(untrackedRaw)];
}

export function readChangedFiles(options: ChangedFileOptions = {}): string[] {
  try {
    return normalizeChangedFiles(getRepoChangedFiles(options));
  } catch {
    return [];
  }
}

function formatBullets(values: readonly string[], { limit = 8 }: { limit?: number } = {}): string {
  const shown = values.slice(0, limit);
  const lines = shown.map((value) => `- ${value}`);
  if (values.length > shown.length) {
    lines.push(`- ...and ${values.length - shown.length} more`);
  }
  return lines.join("\n");
}

function formatFamilies(families: readonly MatchedFamily[]): string {
  if (families.length === 0) return "- No specific task family matched yet.";
  return families
    .map((family) => `- ${family.label} (${family.risk}): ${family.matchedFiles.slice(0, 3).join(", ")}`)
    .join("\n");
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
    "",
    "Matched task families:",
    formatFamilies(contract.families),
    "",
    "Changed files:",
    changedSummary,
    "",
    "Read first:",
    formatBullets(contract.docsToRead, { limit: mode === "stop" ? 8 : 12 }),
  ];

  if (contract.docsLikelyRequired.length > 0) {
    sections.push(
      "",
      "Docs likely required if behavior changed:",
      formatBullets(contract.docsLikelyRequired, { limit: mode === "stop" ? 6 : 10 }),
    );
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

  return sections.join("\n");
}

export function buildSessionStartContext(contract: ChangeContract): string {
  if (contract.changedFiles.length === 0) {
    return [
      "Pharos agent context: no current changed files.",
      "Before editing, classify the task using docs/agent-task-router.md and read only the relevant docs.",
    ].join("\n");
  }

  const deploy = contract.deploy.deployImpact
    ? ` — deploy: pages=${contract.deploy.pagesImpact ? "yes" : "no"}, worker=${contract.deploy.workerImpact ? "yes" : "no"}`
    : "";

  const sections = [`Pharos change contract${deploy}`, "", "Matched task families:", formatFamilies(contract.families)];

  if (contract.docsToRead.length > 0) {
    sections.push("", "Read first:", formatBullets(contract.docsToRead, { limit: 4 }));
  }

  if (contract.checks.length > 0) {
    sections.push("", "Checks before finalizing:", formatBullets(contract.checks, { limit: 4 }));
  }

  if (contract.warnings.length > 0) {
    sections.push("", "Warnings:", formatBullets(contract.warnings, { limit: 4 }));
  }

  return sections.join("\n");
}

function readHookInput(): UnknownRecord {
  try {
    const raw = readFileSync(0, "utf8").trim();
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
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
    return { continue: true };
  }

  return buildToolDenyOutput(violation.reason, "PreToolUse");
}

export function buildPermissionRequestHookOutput(hookInput: UnknownRecord = {}) {
  const violation = findPermissionRequestViolation(hookInput);
  if (!violation) {
    return { continue: true };
  }

  return buildPermissionRequestDenyOutput(violation.reason);
}

function parseArgs(argv: readonly string[]): { explicitFiles: string[]; options: CliOptions } {
  const options: CliOptions = {
    baseRef: process.env.PHAROS_CHANGE_CONTRACT_BASE_REF,
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
  --staged                Classify staged files only
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

  const hookInput = options.hook ? readHookInput() : {};
  const hookMode = normalizeHookMode(options.hook);

  if (hookMode === "pre-tool-use") {
    console.log(JSON.stringify(buildPreToolUseHookOutput(hookInput)));
    return;
  }

  if (hookMode === "permission-request") {
    console.log(JSON.stringify(buildPermissionRequestHookOutput(hookInput)));
    return;
  }

  const changedFiles =
    explicitFiles.length > 0
      ? normalizeChangedFiles(explicitFiles)
      : readChangedFiles({
          baseRef: options.baseRef,
          headRef: options.headRef,
          staged: options.staged,
        });
  const contract = classifyChangedFiles(changedFiles);

  if (hookMode === "session-start") {
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
