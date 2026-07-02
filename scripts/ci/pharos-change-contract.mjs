#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  hasDeployImpact,
  hasPagesDeployImpact,
  hasWorkerDeployImpact,
  normalizeRepoPath,
} from "../lib/deploy-impact.mjs";
import {
  CORE_RULES,
  DEFAULT_BASE_DOCS,
  PATH_FAMILIES,
  PROMPT_ROUTES,
} from "../lib/doc-ownership-registry.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SESSION_STATE_DIR = resolve(REPO_ROOT, ".cache/pharos-agent-hooks");

const RISK_RANK = new Map([
  ["high", 3],
  ["medium", 2],
  ["low", 1],
]);

const HOOK_EVENT_NAMES = new Map([
  ["permission-request", "PermissionRequest"],
  ["post-tool-batch", "PostToolBatch"],
  ["post-tool-use", "PostToolUse"],
  ["pre-tool-use", "PreToolUse"],
  ["session-start", "SessionStart"],
  ["stop", "Stop"],
  ["user-prompt-submit", "UserPromptSubmit"],
]);

const MUTATING_SQL_RE = /\b(alter|create|delete|drop|insert|replace|truncate|update)\b/i;
const UNSAFE_MIGRATION_SQL_RE = /\b(drop\s+table|drop\s+column|alter\s+table[\s\S]{0,160}\bdrop\b|delete\s+from|truncate\b|pragma\s+writable_schema|rename\s+(?:table|column))\b/i;

const PROTECTED_WRITE_RULES = [
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeLocalPath(value) {
  const raw = normalizeRepoPath(String(value ?? "").trim());
  if (!raw) return "";

  const withoutFilePrefix = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
  const repoRoot = normalizeRepoPath(REPO_ROOT);
  const normalized = withoutFilePrefix.startsWith(`${repoRoot}/`)
    ? withoutFilePrefix.slice(repoRoot.length + 1)
    : withoutFilePrefix;

  return normalized.replace(/^\.\//, "");
}

function getFamilyById(id) {
  return PATH_FAMILIES.find((family) => family.id === id) ?? null;
}

function getFamiliesByIds(ids) {
  return unique(ids).map(getFamilyById).filter(Boolean).sort(compareFamilyRisk);
}

function getHookEventName(mode, hookInput = {}) {
  const raw = hookInput.hook_event_name ?? hookInput.hookEventName ?? hookInput.event ?? "";
  const normalizedRaw = String(raw).replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  return HOOK_EVENT_NAMES.get(normalizedRaw) ?? HOOK_EVENT_NAMES.get(mode) ?? "Unknown";
}

function getSessionId(hookInput = {}) {
  const raw = hookInput.session_id
    ?? hookInput.sessionId
    ?? hookInput.conversation_id
    ?? hookInput.conversationId
    ?? hookInput.thread_id
    ?? hookInput.threadId
    ?? process.env.CODEX_SESSION_ID
    ?? process.env.CODEX_THREAD_ID
    ?? process.env.CLAUDE_SESSION_ID
    ?? "default";
  const sanitized = String(raw).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160);
  return sanitized || "default";
}

function getSessionStatePath(hookInput = {}) {
  return resolve(SESSION_STATE_DIR, `${getSessionId(hookInput)}.json`);
}

function hashValue(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value) {
  return hashValue(JSON.stringify(value));
}

function readGitDiffForFile(file, execFile) {
  try {
    return execFile("git", ["diff", "--binary", "HEAD", "--", file], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 24 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function readFileFingerprint(file, execFile) {
  const normalizedFile = normalizeLocalPath(file);
  if (!normalizedFile) return "empty";

  const diff = readGitDiffForFile(normalizedFile, execFile);
  if (diff) {
    return `diff:${hashValue(diff)}`;
  }

  const absolutePath = resolve(REPO_ROOT, normalizedFile);
  if (!absolutePath.startsWith(`${REPO_ROOT}/`) && absolutePath !== REPO_ROOT) {
    return "outside-repo";
  }

  if (!existsSync(absolutePath)) {
    return "absent";
  }

  try {
    return `file:${hashValue(readFileSync(absolutePath))}`;
  } catch {
    return "unreadable";
  }
}

export function buildFileFingerprints(files, { execFile = execFileSync } = {}) {
  return Object.fromEntries(
    normalizeChangedFiles(files).map((file) => [file, readFileFingerprint(file, execFile)]),
  );
}

export function findChangedSinceBaseline(currentFingerprints, baselineFingerprints = {}) {
  return Object.keys(currentFingerprints)
    .filter((file) => currentFingerprints[file] !== baselineFingerprints[file])
    .sort();
}

export function findSessionChangedFiles(currentChangedFiles, baselineFingerprints = {}, {
  buildFingerprints = buildFileFingerprints,
} = {}) {
  const normalizedChangedFiles = normalizeChangedFiles(currentChangedFiles);
  const currentFingerprints = buildFingerprints(normalizedChangedFiles);
  return findChangedSinceBaseline(currentFingerprints, baselineFingerprints);
}

function readSessionState(hookInput = {}) {
  const statePath = getSessionStatePath(hookInput);
  if (!existsSync(statePath)) return null;

  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeSessionState(hookInput = {}, state) {
  mkdirSync(SESSION_STATE_DIR, { recursive: true });
  writeFileSync(getSessionStatePath(hookInput), `${JSON.stringify(state, null, 2)}\n`);
}

function mergeSessionState(hookInput = {}, patch) {
  const previous = readSessionState(hookInput) ?? {};
  const state = {
    ...previous,
    ...patch,
    sessionId: getSessionId(hookInput),
    updatedAt: new Date().toISOString(),
  };
  writeSessionState(hookInput, state);
  return state;
}

export function writeSessionBaseline(hookInput = {}, changedFiles = readChangedFiles()) {
  const normalizedChangedFiles = normalizeChangedFiles(changedFiles);
  const state = {
    baselineChangedFiles: normalizedChangedFiles,
    baselineFingerprints: buildFileFingerprints(normalizedChangedFiles),
    createdAt: new Date().toISOString(),
    lastPostToolReminderHash: null,
    sessionId: getSessionId(hookInput),
  };
  writeSessionState(hookInput, state);
  return state;
}

export function readChangedFilesSinceSessionStart(hookInput = {}, changedFiles = readChangedFiles()) {
  const normalizedChangedFiles = normalizeChangedFiles(changedFiles);
  const state = readSessionState(hookInput);
  if (!state?.baselineFingerprints) {
    return normalizedChangedFiles;
  }

  return findSessionChangedFiles(normalizedChangedFiles, state.baselineFingerprints);
}

function fileMatchesRule(file, rule) {
  if (rule.exactPaths?.includes(file)) return true;
  if (rule.prefixes?.some((prefix) => file.startsWith(prefix))) return true;
  if (rule.regexes?.some((regex) => regex.test(file))) return true;
  return false;
}

function compareFamilyRisk(a, b) {
  const rankDelta = (RISK_RANK.get(b.risk) ?? 0) - (RISK_RANK.get(a.risk) ?? 0);
  if (rankDelta !== 0) return rankDelta;
  return a.label.localeCompare(b.label);
}

export function normalizeChangedFiles(files) {
  return unique(files.map((file) => normalizeRepoPath(file.trim())).filter(Boolean)).sort();
}

export function classifyChangedFiles(files) {
  const changedFiles = normalizeChangedFiles(files);
  const matchedFamilies = PATH_FAMILIES
    .map((family) => ({
      ...family,
      matchedFiles: changedFiles.filter((file) => fileMatchesRule(file, family)),
    }))
    .filter((family) => family.matchedFiles.length > 0)
    .sort(compareFamilyRisk);

  const docsToRead = unique([
    ...DEFAULT_BASE_DOCS,
    ...matchedFamilies.flatMap((family) => family.docsToRead),
  ]);
  const docsLikelyRequired = unique(matchedFamilies.flatMap((family) => family.docsLikelyRequired));
  const checks = unique(matchedFamilies.flatMap((family) => family.checks));
  const hardRules = unique([
    ...CORE_RULES,
    ...matchedFamilies.flatMap((family) => family.hardRules),
  ]);
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

export function classifyUserPrompt(prompt) {
  const promptText = String(prompt ?? "");
  const matched = PROMPT_ROUTES.filter((route) =>
    route.patterns.some((pattern) => pattern.test(promptText)),
  );
  const matchedRoutes = matched.map((route) => route.label);
  const matchedFamilies = getFamiliesByIds(matched.flatMap((route) => route.familyIds));

  return {
    checks: unique(matchedFamilies.flatMap((family) => family.checks)),
    docsLikelyRequired: unique(matchedFamilies.flatMap((family) => family.docsLikelyRequired)),
    docsToRead: unique([
      ...DEFAULT_BASE_DOCS,
      ...matchedFamilies.flatMap((family) => family.docsToRead),
    ]),
    families: matchedFamilies.map((family) => ({
      id: family.id,
      label: family.label,
      matchedFiles: [],
      risk: family.risk,
    })),
    hardRules: unique([
      ...CORE_RULES,
      ...matchedFamilies.flatMap((family) => family.hardRules),
    ]),
    matchedRoutes,
    promptText,
  };
}

function getToolInput(hookInput = {}) {
  return hookInput.tool_input ?? hookInput.toolInput ?? hookInput.input ?? hookInput.arguments ?? {};
}

function getCommandFromHookInput(hookInput = {}) {
  const toolInput = getToolInput(hookInput);
  return String(toolInput.command ?? hookInput.command ?? "");
}

function collectArrayPaths(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    return [
      item.file_path,
      item.filePath,
      item.path,
      item.filename,
    ].filter(Boolean);
  });
}

function extractPatchPaths(patchText) {
  return [...String(patchText ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
    .map((match) => match[1]);
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

function commandIsRawPatchPayload(command) {
  return String(command ?? "").trimStart().startsWith("*** Begin Patch");
}

function commandLooksLikePatchPayload(command) {
  const text = String(command ?? "").trimStart();
  return commandIsRawPatchPayload(text) || /^apply_patch(?:\s|$)/.test(text);
}

function stripHereDocBodies(command) {
  const lines = String(command ?? "").split(/\r?\n/g);
  const kept = [];
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

function getExecutableShellText(command) {
  if (commandIsRawPatchPayload(command)) return "";
  return stripHereDocBodies(command);
}

function tokenizeShell(command) {
  const tokens = [];
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

    if (char === "'" || char === "\"") {
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

function splitShellTokens(command) {
  return tokenizeShell(getExecutableShellText(command))
    .filter((token) => !SHELL_CONTROL_TOKENS.has(token));
}

function shellCommandName(token) {
  return String(token ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\.(?:cmd|exe)$/i, "") ?? "";
}

function isShellControlToken(token) {
  return SHELL_CONTROL_TOKENS.has(token);
}

function isEnvAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(token ?? ""));
}

function skipLeadingOptions(tokens, startIndex, valueOptions = new Set()) {
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

function resolveExecutableIndex(tokens, startIndex, depth = 0) {
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

function getShellEvalArgument(tokens) {
  if (!SHELL_EVAL_COMMANDS.has(shellCommandName(tokens[0]))) return "";

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-c" || token === "--command" || (/^-[A-Za-z]+$/.test(token) && token.includes("c"))) {
      return tokens[index + 1] ?? "";
    }
  }

  return "";
}

function getShellCommandInvocations(command, depth = 0) {
  const tokens = tokenizeShell(getExecutableShellText(command));
  const invocations = [];
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
      const endIndex = tokens.findIndex((candidate, candidateIndex) => (
        candidateIndex > resolvedIndex && isShellControlToken(candidate)
      ));
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

function stripWranglerGlobalOptions(tokens) {
  return tokens.slice(skipLeadingOptions(tokens, 0, WRANGLER_GLOBAL_VALUE_OPTIONS));
}

function invocationHasHelpFlag(tokens) {
  return tokens.includes("--help") || tokens.includes("-h");
}

function extractBashWritePaths(command) {
  const paths = [];
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

function collectToolPaths(hookInput = {}) {
  const toolInput = getToolInput(hookInput);
  const command = getCommandFromHookInput(hookInput);
  return normalizeChangedFiles([
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
  ].filter(Boolean).map(normalizeLocalPath));
}

function collectToolText(hookInput = {}) {
  const toolInput = getToolInput(hookInput);
  const chunks = [
    toolInput.content,
    toolInput.new_string,
    toolInput.newString,
    toolInput.patch,
    toolInput.input,
    getCommandFromHookInput(hookInput),
  ];
  if (Array.isArray(toolInput.edits)) {
    chunks.push(...toolInput.edits.map((edit) => edit?.new_string ?? edit?.newString ?? ""));
  }
  return chunks.filter((chunk) => typeof chunk === "string").join("\n");
}

function extractAddedPatchText(hookInput = {}) {
  const toolInput = getToolInput(hookInput);
  const command = getCommandFromHookInput(hookInput);
  const patchText = String(toolInput.patch ?? toolInput.input ?? (commandLooksLikePatchPayload(command) ? command : ""));
  if (!patchText) return "";
  return patchText
    .split(/\r?\n/g)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function findProtectedWrite(paths) {
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

function gitSubcommandCursor(tokens) {
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

function* gitSubcommandTokens(command, subcommand) {
  for (const invocation of getShellCommandInvocations(command)) {
    if (invocation.name !== "git") continue;
    const { tokens } = invocation;
    const cursor = gitSubcommandCursor(tokens);
    if (tokens[cursor] !== subcommand) continue;
    yield tokens.slice(cursor + 1);
  }
}

function commandInvokesGitCleanForceDelete(command) {
  for (const optionTokens of gitSubcommandTokens(command, "clean")) {
    const optionText = optionTokens.slice(0, 5)
      .filter((token) => token.startsWith("-"))
      .join("");
    if (optionText.includes("f") && optionText.includes("d")) {
      return true;
    }
  }
  return false;
}

function commandInvokesGitResetHard(command) {
  for (const optionTokens of gitSubcommandTokens(command, "reset")) {
    if (optionTokens.slice(0, 7).includes("--hard")) {
      return true;
    }
  }
  return false;
}

function commandInvokesGitPushNoVerify(command) {
  for (const optionTokens of gitSubcommandTokens(command, "push")) {
    if (optionTokens.some((token) => token === "--no-verify" || token.startsWith("--no-verify="))) {
      return true;
    }
  }
  return false;
}

function commandInvokesRemoteD1Mutation(command) {
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

function commandInvokesRawProductionDeploy(command) {
  return getShellCommandInvocations(command).some((invocation) => {
    if (invocationHasHelpFlag(invocation.tokens)) return false;

    if (invocation.name === "npm") {
      return invocation.tokens[1] === "run" && invocation.tokens[2] === "deploy";
    }

    if (invocation.name !== "wrangler") {
      return false;
    }

    const args = stripWranglerGlobalOptions(invocation.tokens.slice(1));
    return args[0] === "deploy"
      || (args[0] === "versions" && args[1] === "deploy")
      || (args[0] === "pages" && args[1] === "deploy");
  });
}

function findUnsafeMigrationSql(paths, hookInput = {}) {
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

function findCommandViolation(command) {
  if (!command) return null;

  if (commandInvokesGitResetHard(command)) {
    return "Destructive `git reset --hard` is blocked. Preserve existing user/worktree changes.";
  }

  if (commandInvokesGitCleanForceDelete(command)) {
    return "Destructive `git clean -fd` style cleanup is blocked. Preserve untracked user/worktree changes.";
  }

  if (commandInvokesGitPushNoVerify(command)) {
    return "`git push --no-verify` is blocked. The tracked pre-push merge gate must run before pushing.";
  }

  if (commandInvokesRawProductionDeploy(command)) {
    return "Raw production deploy commands are blocked. Use the documented Pharos release flow instead.";
  }

  if (commandInvokesRemoteD1Mutation(command)) {
    return "Remote D1 mutation commands are blocked by default. Use dry-runs or the coordinated production runbook.";
  }

  return null;
}

export function findPreToolUseViolation(hookInput = {}) {
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

export function findPermissionRequestViolation(hookInput = {}) {
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

function buildWarnings(changedFiles) {
  const warnings = [];
  if (changedFiles.some((file) => file.startsWith("src/components/ui/"))) {
    warnings.push("src/components/ui contains shadcn primitives; edit only when explicitly required.");
  }
  if (changedFiles.some((file) => file.startsWith("worker/migrations/"))) {
    warnings.push("D1 migrations are applied before the new Worker is live; keep them backward-compatible.");
  }
  if (changedFiles.some((file) => file === "AGENTS.md" || file === "CLAUDE.md")) {
    warnings.push("AGENTS.md and CLAUDE.md must stay synchronized.");
  }
  if (changedFiles.some((file) => file.startsWith("shared/data/stablecoins/"))) {
    warnings.push("Stablecoin data changes must not introduce manual supply overrides.");
  }
  return warnings;
}

function getRepoChangedFiles({ baseRef, execFile = execFileSync, headRef, staged = false } = {}) {
  if (baseRef || headRef) {
    const base = baseRef || "origin/main";
    const head = headRef || "HEAD";
    const raw = execFile("git", ["diff", "--name-only", `${base}...${head}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return raw.split(/\r?\n/g);
  }

  if (staged) {
    const raw = execFile("git", ["diff", "--name-only", "--cached"], { cwd: REPO_ROOT, encoding: "utf8" });
    return raw.split(/\r?\n/g);
  }

  const trackedRaw = execFile("git", ["diff", "--name-only", "HEAD", "--"], { cwd: REPO_ROOT, encoding: "utf8" });
  const untrackedRaw = execFile("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return [
    ...trackedRaw.split(/\r?\n/g),
    ...untrackedRaw.split(/\r?\n/g),
  ];
}

export function readChangedFiles(options = {}) {
  try {
    return normalizeChangedFiles(getRepoChangedFiles(options));
  } catch {
    return [];
  }
}

function formatBullets(values, { limit = 8 } = {}) {
  const shown = values.slice(0, limit);
  const lines = shown.map((value) => `- ${value}`);
  if (values.length > shown.length) {
    lines.push(`- ...and ${values.length - shown.length} more`);
  }
  return lines.join("\n");
}

function formatFamilies(families) {
  if (families.length === 0) return "- No specific task family matched yet.";
  return families
    .map((family) => `- ${family.label} (${family.risk}): ${family.matchedFiles.slice(0, 3).join(", ")}`)
    .join("\n");
}

export function formatContract(contract, { mode = "full" } = {}) {
  const changedSummary = contract.changedFiles.length > 0
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
    sections.push(
      "",
      "Warnings:",
      formatBullets(contract.warnings, { limit: 6 }),
    );
  }

  sections.push(
    "",
    "Core rules:",
    formatBullets(contract.hardRules, { limit: mode === "stop" ? 6 : 10 }),
  );

  if (contract.deploy.deployImpact) {
    sections.push(
      "",
      `Deploy impact: pages=${contract.deploy.pagesImpact ? "yes" : "no"}, worker=${contract.deploy.workerImpact ? "yes" : "no"}.`,
    );
  }

  return sections.join("\n");
}

function formatInlineList(values, { limit = 6 } = {}) {
  if (values.length === 0) return "None";
  const shown = values.slice(0, limit).map((value) => `\`${value}\``);
  if (values.length > shown.length) {
    shown.push(`and ${values.length - shown.length} more`);
  }
  return shown.join(", ");
}

export function formatContractMarkdown(contract) {
  const familyRows = contract.families.length > 0
    ? contract.families
      .map((family) => `| ${family.label} | ${family.risk} | ${formatInlineList(family.matchedFiles, { limit: 4 })} |`)
      .join("\n")
    : "| No specific task family matched | low | No matched files |";
  const deploySummary = contract.deploy.deployImpact
    ? `Pages: **${contract.deploy.pagesImpact ? "yes" : "no"}**, Worker: **${contract.deploy.workerImpact ? "yes" : "no"}**`
    : "No deploy-impacting surface detected by the shared deploy classifier.";

  return [
    "<!-- pharos-change-contract -->",
    "### Pharos Change Contract",
    "",
    deploySummary,
    "",
    "| Task family | Risk | Matched files |",
    "| --- | --- | --- |",
    familyRows,
    "",
    "<details>",
    "<summary>Docs, checks, and guardrails</summary>",
    "",
    "#### Read First",
    formatBullets(contract.docsToRead, { limit: 12 }),
    "",
    "#### Docs Likely Required If Behavior Changed",
    contract.docsLikelyRequired.length > 0 ? formatBullets(contract.docsLikelyRequired, { limit: 12 }) : "- None",
    "",
    "#### Checks To Consider",
    contract.checks.length > 0 ? formatBullets(contract.checks, { limit: 12 }) : "- None",
    "",
    "#### Warnings",
    contract.warnings.length > 0 ? formatBullets(contract.warnings, { limit: 8 }) : "- None",
    "",
    "#### Core Rules",
    formatBullets(contract.hardRules, { limit: 12 }),
    "",
    "</details>",
    "",
    "_Generated by `scripts/ci/pharos-change-contract.mjs`._",
  ].join("\n");
}

export function buildSessionStartContext(contract) {
  if (contract.changedFiles.length === 0) {
    return [
      "Pharos agent context: no current changed files.",
      "Before editing, classify the task using docs/agent-task-router.md and read only the relevant docs.",
    ].join("\n");
  }

  const deploy = contract.deploy.deployImpact
    ? ` — deploy: pages=${contract.deploy.pagesImpact ? "yes" : "no"}, worker=${contract.deploy.workerImpact ? "yes" : "no"}`
    : "";

  const sections = [
    `Pharos change contract${deploy}`,
    "",
    "Matched task families:",
    formatFamilies(contract.families),
  ];

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

export function buildStopContinuationReason(contract) {
  return [
    "Before finalizing this Pharos turn, address the current change contract.",
    "Run the relevant checks/docs updates, or explicitly state why they were not needed or could not be run.",
    "",
    formatContract(contract, { mode: "stop" }),
  ].join("\n");
}

function hasStopObligations(contract) {
  if (contract.changedFiles.length === 0) return false;
  // Only nudge for medium/high-risk families. Low-risk-only changes (e.g.
  // doc-only edits) don't justify a continuation turn or post-tool reminder.
  return contract.families.some((family) => family.risk === "medium" || family.risk === "high");
}

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function buildSessionStartHookOutput(contract) {
  return {
    hookSpecificOutput: {
      additionalContext: buildSessionStartContext(contract),
      hookEventName: "SessionStart",
    },
  };
}

export function buildStopHookOutput(contract, hookInput = {}) {
  if (hookInput.stop_hook_active || !hasStopObligations(contract)) {
    return { continue: true };
  }

  return {
    decision: "block",
    reason: buildStopContinuationReason(contract),
  };
}

function formatPromptRoutingContext(route) {
  if (route.families.length === 0) {
    return "";
  }

  return [
    "Pharos prompt routing:",
    `- Detected: ${route.matchedRoutes.join(", ")}.`,
    "- Before editing, read the relevant docs and keep the checks in mind.",
    "",
    "Task families:",
    formatBullets(route.families.map((family) => `${family.label} (${family.risk})`), { limit: 6 }),
    "",
    "Read first:",
    formatBullets(route.docsToRead, { limit: 10 }),
    "",
    "Checks to consider:",
    route.checks.length > 0 ? formatBullets(route.checks, { limit: 8 }) : "- None beyond focused validation.",
    "",
    "Hard rules:",
    formatBullets(route.hardRules, { limit: 8 }),
  ].join("\n");
}

function getPromptText(hookInput = {}) {
  return String(
    hookInput.prompt
      ?? hookInput.user_prompt
      ?? hookInput.userPrompt
      ?? hookInput.message
      ?? getToolInput(hookInput).prompt
      ?? "",
  );
}

export function buildUserPromptSubmitHookOutput(hookInput = {}) {
  const route = classifyUserPrompt(getPromptText(hookInput));
  const additionalContext = formatPromptRoutingContext(route);
  if (!additionalContext) {
    return { continue: true };
  }

  return {
    hookSpecificOutput: {
      additionalContext,
      hookEventName: "UserPromptSubmit",
    },
  };
}

function buildToolDenyOutput(reason, hookEventName = "PreToolUse") {
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

function buildPermissionRequestDenyOutput(reason) {
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

export function buildPreToolUseHookOutput(hookInput = {}) {
  const violation = findPreToolUseViolation(hookInput);
  if (!violation) {
    return { continue: true };
  }

  return buildToolDenyOutput(violation.reason, "PreToolUse");
}

export function buildPermissionRequestHookOutput(hookInput = {}) {
  const violation = findPermissionRequestViolation(hookInput);
  if (!violation) {
    return { continue: true };
  }

  return buildPermissionRequestDenyOutput(violation.reason);
}

function formatPostToolReminder(contract) {
  if (!hasStopObligations(contract)) {
    return "";
  }

  const families = contract.families
    .map((family) => `${family.label} (${family.risk})`)
    .join(", ");

  return [
    "Pharos change reminder:",
    `- Current session delta: ${families || "no specific task family"}.`,
    "- Keep this light now; do not auto-run heavy checks from the hook.",
    "",
    "Docs likely required if behavior changed:",
    contract.docsLikelyRequired.length > 0 ? formatBullets(contract.docsLikelyRequired, { limit: 5 }) : "- None",
    "",
    "Checks to consider before finalizing:",
    contract.checks.length > 0 ? formatBullets(contract.checks, { limit: 6 }) : "- Focused validation for touched code.",
    "",
    "Warnings:",
    contract.warnings.length > 0 ? formatBullets(contract.warnings, { limit: 4 }) : "- None",
  ].join("\n");
}

export function buildPostToolUseHookOutput(contract, hookInput = {}, { eventName = "PostToolUse", dedupe = true } = {}) {
  const additionalContext = formatPostToolReminder(contract);
  if (!additionalContext) {
    return { continue: true };
  }

  if (dedupe) {
    // Hash excludes eventName so PostToolUse and PostToolBatch dedupe each other
    // when they fire on the same contract state.
    const reminderHash = hashJson({
      checks: contract.checks,
      docsLikelyRequired: contract.docsLikelyRequired,
      families: contract.families.map((family) => family.id),
      warnings: contract.warnings,
    });
    const state = readSessionState(hookInput);
    if (state?.lastPostToolReminderHash === reminderHash) {
      return { continue: true };
    }
    mergeSessionState(hookInput, { lastPostToolReminderHash: reminderHash });
  }

  return {
    hookSpecificOutput: {
      additionalContext,
      hookEventName: eventName,
    },
  };
}

function parseArgs(argv) {
  const options = {
    baseRef: process.env.PHAROS_CHANGE_CONTRACT_BASE_REF,
    format: "text",
    headRef: process.env.PHAROS_CHANGE_CONTRACT_HEAD_REF,
    hook: null,
    staged: false,
  };
  const explicitFiles = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.format = "json";
    } else if (arg === "--markdown") {
      options.format = "markdown";
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

function normalizeHookMode(hook) {
  if (!hook) return null;
  const normalized = String(hook).replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  return normalized;
}

function printHelp() {
  console.log(`Usage: node scripts/ci/pharos-change-contract.mjs [options]

Classify the current Pharos diff into docs, checks, and agent guardrails.

Options:
  --json                  Emit the contract as JSON instead of text
  --markdown              Emit a GitHub-flavored Markdown PR comment body
  --staged                Classify staged files only
  --base-ref <ref>        Classify git diff base...head
  --head-ref <ref>        Classify git diff base...head
  --file <path>           Classify an explicit file path; repeatable
  --hook=session-start    Emit Codex SessionStart hook JSON
  --hook=user-prompt-submit
                          Emit prompt-routing hook JSON
  --hook=pre-tool-use     Emit hard-block hook JSON for unsafe tool calls
  --hook=permission-request
                          Emit production permission-policy hook JSON
  --hook=post-tool-use    Emit post-edit reminder hook JSON
  --hook=post-tool-batch  Emit post-batch reminder hook JSON
  --hook=stop             Emit Codex Stop hook JSON
`);
}

export function runCli(argv = process.argv.slice(2)) {
  const { explicitFiles, options } = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const hookInput = options.hook ? readHookInput() : {};
  const hookMode = normalizeHookMode(options.hook);

  if (hookMode === "user-prompt-submit") {
    console.log(JSON.stringify(buildUserPromptSubmitHookOutput(hookInput)));
    return;
  }

  if (hookMode === "pre-tool-use") {
    console.log(JSON.stringify(buildPreToolUseHookOutput(hookInput)));
    return;
  }

  if (hookMode === "permission-request") {
    console.log(JSON.stringify(buildPermissionRequestHookOutput(hookInput)));
    return;
  }

  const currentChangedFiles = explicitFiles.length > 0
    ? normalizeChangedFiles(explicitFiles)
    : readChangedFiles({
      baseRef: options.baseRef,
      headRef: options.headRef,
      staged: options.staged,
    });
  const changedFiles = hookMode === "stop" || hookMode === "post-tool-use" || hookMode === "post-tool-batch"
    ? (explicitFiles.length > 0 ? currentChangedFiles : readChangedFilesSinceSessionStart(hookInput, currentChangedFiles))
    : currentChangedFiles;
  const contract = classifyChangedFiles(changedFiles);

  if (hookMode === "session-start") {
    writeSessionBaseline(hookInput, currentChangedFiles);
    console.log(JSON.stringify(buildSessionStartHookOutput(contract)));
    return;
  }

  if (hookMode === "post-tool-use" || hookMode === "post-tool-batch") {
    console.log(JSON.stringify(buildPostToolUseHookOutput(contract, hookInput, {
      eventName: getHookEventName(hookMode, hookInput),
    })));
    return;
  }

  if (hookMode === "stop") {
    console.log(JSON.stringify(buildStopHookOutput(contract, hookInput)));
    return;
  }

  if (options.format === "json") {
    console.log(JSON.stringify(contract, null, 2));
    return;
  }

  if (options.format === "markdown") {
    console.log(formatContractMarkdown(contract));
    return;
  }

  console.log(formatContract(contract));
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
