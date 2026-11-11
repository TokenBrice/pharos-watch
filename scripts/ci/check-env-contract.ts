#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import ts from "typescript";
import { collectSourceFiles, collectSourceFilesUnderRoot } from "../lib/source-files.mts";
import { splitLines } from "../lib/doc-files.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { parseSourceFile } from "../lib/ts-ast.mts";
import { parseAssignments, unquote } from "../lib/wrangler-toml.mjs";
import { findDocContractDrift } from "../lib/doc-sync/contract-blocks";
import {
  getAllEnvBindingKeys,
  renderEnvExample,
  renderOperatorOriginAccessEnvBlock,
  renderWorkerInfrastructureEnvBlock,
} from "@shared/lib/env-contract";
import { SITE_API_ORIGIN } from "@shared/lib/runtime-origins";
import { ENV_BINDINGS } from "@shared/lib/env-contract/registry";
import type { EnvBindingDefinition, EnvRuntimeName } from "@shared/lib/env-contract/types";

const repoRoot = process.cwd();
const envExamplePath = resolve(repoRoot, ".env.example");
const wranglerConfigPath = resolve(repoRoot, "worker/wrangler.toml");

const DOC_SCAN_FILES = [
  resolve(repoRoot, "README.md"),
  resolve(repoRoot, "docs/deployment-process.md"),
  resolve(repoRoot, "docs/operator-origin-access.md"),
  resolve(repoRoot, "docs/scripts.md"),
];

const GENERATED_DOC_BLOCKS = [
  {
    filePath: resolve(repoRoot, "docs/operator-origin-access.md"),
    marker: "ENV-CONTRACT:OPERATOR-ORIGIN-ACCESS",
    render: renderOperatorOriginAccessEnvBlock,
  },
  {
    filePath: resolve(repoRoot, "docs/process/worker-infrastructure-appendix.md"),
    marker: "ENV-CONTRACT:WORKER-INFRASTRUCTURE",
    render: renderWorkerInfrastructureEnvBlock,
  },
];

const SOURCE_SCAN_ROOTS = [
  resolve(repoRoot, ".github/workflows"),
  resolve(repoRoot, "functions"),
  resolve(repoRoot, "scripts"),
  resolve(repoRoot, "src"),
  resolve(repoRoot, "worker"),
];

const SOURCE_SCAN_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
  ".sh",
]);

/** Runtime code reads env through a binding object (`env.X`, `env["X"]`,
 * `const { X } = env`, `runtime.env.X`) or, for the static frontend, through
 * inlined `process.env.NEXT_PUBLIC_*`. Both must be declared in the manifest;
 * the manifest renders `.env.example`. `process.env` is excluded: those are
 * Node/build variables, not bindings.
 *
 * The reads are collected from the TypeScript AST, not from text: a comment
 * (`// env.FOO is optional`) or a string literal (`"env.FOO"`) is not a read,
 * and demanding a registry declaration for one would fail an ordinary PR. */
const RUNTIME_ENV_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts"]);
const TEST_SOURCE_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|test-helpers)(?:\/|$)|\.test\.[cm]?[jt]sx?$|[-.]test-support\.[cm]?[jt]sx?$/;
const PROCESS_OBJECT_NAME = "process";
const FRONTEND_PUBLIC_ENV_PREFIX = "NEXT_PUBLIC_";

const DOC_NON_ENV_TOKENS = new Set([
  "WORKER_RESERVED_ENV_KEYS",
  "WORKER_ACTIVE_ENV_KEYS",
  "DATA_SOURCE_GROUPS",
  "ENV_BINDINGS",
]);

const WRANGLER_BINDING_SECTIONS = new Map([
  ["d1_databases", { property: "binding", type: "D1Database" }],
  ["version_metadata", { property: "binding", type: "WorkerVersionMetadata" }],
  ["r2_buckets", { property: "binding", type: "R2Bucket" }],
  ["services", { property: "binding", type: "Fetcher" }],
  ["queues.producers", { property: "binding", type: "Queue<ReserveContinuationMessage>" }],
]);

interface WranglerBinding {
  source: string;
  type: string;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function collectFiles(rootDir: string): string[] {
  // Explicit empty excludedDirs: this scan intentionally recurses into __tests__
  // (the shared default excludes it, which would change behavior here).
  return collectSourceFiles(rootDir, {
    extensions: SOURCE_SCAN_EXTENSIONS,
    excludedDirs: new Set(),
  });
}

function parseEnvExampleAssignments(text: string) {
  const keys = new Set<string>();
  const duplicates = new Set<string>();
  const values = new Map<string, string>();

  for (const rawLine of splitLines(text)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = line.slice(0, equalsIndex).trim();
    if (!isEnvKeyCandidate(key)) continue;

    if (keys.has(key)) duplicates.add(key);
    keys.add(key);
    const rawValue = line.slice(equalsIndex + 1).trim();
    values.set(key, unquote(rawValue) ?? rawValue);
  }

  return { duplicates, keys, values };
}

function parseEnvExampleKeys(filePath: string) {
  return parseEnvExampleAssignments(readFileSync(filePath, "utf8"));
}

/**
 * Keys the example must never advertise: the site reads stablecoin data through
 * Pages Functions instead of a direct database binding, and the Telegram
 * adoption salt was replaced by the selector-snapshot salt.
 */
const FORBIDDEN_ENV_EXAMPLE_KEYS = ["DB", "TELEGRAM_ADOPTION_IP_HASH_SECRET"] as const;
const FORBIDDEN_ENV_EXAMPLE_KEY_PREFIXES = ["VAULTS_FYI_"] as const;
// Keep these operator examples required even if their manifest example metadata is removed.
const REQUIRED_ENV_EXAMPLE_KEYS = [
  "NEXT_PUBLIC_API_BASE",
  "SELECTOR_SNAPSHOT_IP_HASH_SECRET",
  "SITE_API_SHARED_SECRET",
] as const;
/** The example must show the canonical origin, not a placeholder that a copied
 * `.env.local` could turn into a silent upstream. */
const REQUIRED_ENV_EXAMPLE_VALUES: Readonly<Record<string, string>> = {
  SITE_API_ORIGIN,
};

export function findEnvExamplePolicyErrors(text: string): string[] {
  const { keys, values } = parseEnvExampleAssignments(text);
  const errors: string[] = [];

  for (const key of FORBIDDEN_ENV_EXAMPLE_KEYS) {
    if (keys.has(key)) errors.push(`.env.example must not document ${key}`);
  }
  for (const key of keys) {
    const prefix = FORBIDDEN_ENV_EXAMPLE_KEY_PREFIXES.find((candidate) => key.startsWith(candidate));
    if (prefix) errors.push(`.env.example must not document retired ${prefix}* keys (found ${key})`);
  }
  for (const key of REQUIRED_ENV_EXAMPLE_KEYS) {
    if (!keys.has(key)) errors.push(`.env.example must document ${key}`);
  }
  for (const [key, expected] of Object.entries(REQUIRED_ENV_EXAMPLE_VALUES)) {
    const actual = values.get(key);
    if (actual !== expected) {
      errors.push(
        `.env.example must document ${key}=${expected} (found ${actual === undefined ? "no entry" : JSON.stringify(actual)})`,
      );
    }
  }

  return errors;
}

export function getWorkerEnvBindings() {
  return new Map(ENV_BINDINGS.flatMap((binding) => {
    const usage = binding.runtimes.worker;
    return usage ? [[binding.key, {
      optional: usage.status !== "required" || usage.optionalAtIngress === true,
      type: binding.valueType,
    }] as const] : [];
  }));
}

function addWranglerBinding(
  bindings: Map<string, WranglerBinding>,
  duplicates: Set<string>,
  key: string,
  binding: WranglerBinding,
): void {
  if (bindings.has(key)) {
    duplicates.add(key);
  }
  bindings.set(key, binding);
}

export function parseWranglerWorkerConfigBindings(source: string) {
  const bindings = new Map<string, WranglerBinding>();
  const duplicates = new Set<string>();
  const unsupported: { key: string; source: string }[] = [];

  for (const assignment of parseAssignments(source)) {
    const { key, section, value } = assignment;
    const sourceLabel = section === "vars" ? "[vars]" : `[[${section}]]`;
    if (section === "vars") {
      if (isEnvKeyCandidate(key)) {
        addWranglerBinding(bindings, duplicates, key, {
          source: sourceLabel,
          type: "string",
        });
      }
      continue;
    }

    const bindingSpec = WRANGLER_BINDING_SECTIONS.get(section);
    if (!bindingSpec || key !== bindingSpec.property) continue;

    const bindingKey = unquote(value);
    if (!bindingKey) continue;
    if (!isEnvKeyCandidate(bindingKey)) {
      unsupported.push({ key: bindingKey, source: sourceLabel });
      continue;
    }
    addWranglerBinding(bindings, duplicates, bindingKey, {
      source: sourceLabel,
      type: bindingSpec.type,
    });
  }

  return { bindings, duplicates, unsupported };
}

export function findWranglerBindingContractErrors(source: string): string[] {
  const config = parseWranglerWorkerConfigBindings(source);
  const workerBindings = getWorkerEnvBindings();
  const errors: string[] = [];
  if (config.duplicates.size > 0) {
    errors.push(`worker/wrangler.toml declares duplicate Worker binding keys: ${[...config.duplicates].sort().join(", ")}`);
  }
  if (config.unsupported.length > 0) {
    errors.push(`worker/wrangler.toml declares unsupported Worker binding keys: ${
      config.unsupported.map((binding) => `${binding.key} (${binding.source})`).sort().join(", ")
    }`);
  }
  const missing = [...config.bindings]
    .filter(([key]) => !workerBindings.has(key))
    .map(([key, binding]) => `${key} (${binding.source})`)
    .sort();
  if (missing.length > 0) {
    errors.push(`worker/wrangler.toml declares bindings missing from the shared Worker env manifest: ${missing.join(", ")}`);
  }
  const mismatches = [...config.bindings].flatMap(([key, binding]) => {
    const expected = workerBindings.get(key);
    return expected && expected.type !== binding.type
      ? [`${key} (${binding.source}) is ${binding.type}, manifest declares ${expected.type}`]
      : [];
  }).sort();
  if (mismatches.length > 0) {
    errors.push(`worker/wrangler.toml binding types drift from the shared Worker env manifest: ${mismatches.join("; ")}`);
  }
  return errors;
}

function addRegexMatches(
  set: Set<string>,
  source: string,
  pattern: RegExp,
  captureIndex = 1,
): void {
  for (const match of source.matchAll(pattern)) {
    const key = match[captureIndex];
    if (key && isEnvKeyCandidate(key)) {
      set.add(key);
    }
  }
}

function collectShellEnvKeys(source: string): Set<string> {
  const keys = new Set<string>();

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "$") continue;

    let cursor = index + 1;
    if (source[cursor] === "{") {
      cursor += 1;
    }

    let key = "";
    while (cursor < source.length) {
      const char = source[cursor];
      const isUpper = char >= "A" && char <= "Z";
      const isDigit = char >= "0" && char <= "9";
      if (!isUpper && !isDigit && char !== "_") {
        break;
      }
      key += char;
      cursor += 1;
    }

    if (isEnvKeyCandidate(key)) {
      keys.add(key);
    }
  }

  return keys;
}

export function collectSourceEnvKeys(filePaths: readonly string[]): Set<string> {
  const keys = new Set<string>();

  for (const filePath of filePaths) {
    const source = readFileSync(filePath, "utf8");
    addRegexMatches(keys, source, /process\.env\.([A-Z][A-Z0-9_]+)/g);
    addRegexMatches(keys, source, /(?:^|[^A-Za-z0-9_])env\.([A-Z][A-Z0-9_]+)/g);
    addRegexMatches(keys, source, /\b(?:secrets|vars)\.([A-Z][A-Z0-9_]+)/g);
    addRegexMatches(keys, source, /\bread[A-Za-z0-9]*Env\(\s*"([A-Z][A-Z0-9_]+)"/g);
    addRegexMatches(keys, source, /\brequireEnv\(\s*"([A-Z][A-Z0-9_]+)"/g);
    addRegexMatches(keys, source, /\breadEnvFirst\(\s*"([A-Z][A-Z0-9_]+)"/g);
    for (const match of source.matchAll(/\breadEnvFirst\(\s*\[([^\]]*)\]/g)) {
      addRegexMatches(keys, match[1], /"([A-Z][A-Z0-9_]+)"/g);
    }
    for (const match of source.matchAll(/\benvNames\s*:\s*\[([^\]]*)\]/g)) {
      addRegexMatches(keys, match[1], /"([A-Z][A-Z0-9_]+)"/g);
    }
    for (const match of source.matchAll(/\bapiFetchHeaders\(\s*\[([^\]]*)\]/g)) {
      addRegexMatches(keys, match[1], /"([A-Z][A-Z0-9_]+)"/g);
    }
    for (const match of source.matchAll(/\b[A-Z][A-Z0-9_]*_ENV_NAMES\s*=\s*\[([^\]]*)\]/g)) {
      addRegexMatches(keys, match[1], /"([A-Z][A-Z0-9_]+)"/g);
    }
    addRegexMatches(keys, source, /\bapiKeyEnv\s*:\s*"([A-Z][A-Z0-9_]+)"/g);

    if (extname(filePath) === ".sh") {
      for (const key of collectShellEnvKeys(source)) {
        keys.add(key);
      }
    }
  }

  return keys;
}

export interface RuntimeEnvReadInventory {
  worker: ReadonlySet<string>;
  pages: ReadonlySet<string>;
  frontend: ReadonlySet<string>;
}

function walkAst(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walkAst(child, visit));
}

/**
 * `env`, `runtime.env` and `context.env` name a binding object; `process.env`
 * does not (it is a Node/build variable, and the frontend's public copy has its
 * own collector below).
 */
function isEnvObjectExpression(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === "env";
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "env") return false;
  return !(ts.isIdentifier(node.expression) && node.expression.text === PROCESS_OBJECT_NAME);
}

function elementName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
}

/** `env.KEY`, `env["KEY"]`, `runtime.env.KEY` and `const { KEY } = env` binding reads. */
export function collectRuntimeEnvObjectKeys(sourceFile: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  walkAst(sourceFile, (node) => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isEnvObjectExpression(node.expression)) {
      const name = elementName(node);
      if (name !== null) keys.add(name);
      return;
    }
    if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name) || node.initializer === undefined) return;
    if (!isEnvObjectExpression(node.initializer)) return;
    for (const element of node.name.elements) {
      if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
      const property = element.propertyName ?? element.name;
      if (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) keys.add(property.text);
    }
  });
  return keys;
}

/** Inlined `process.env.NEXT_PUBLIC_*` reads of the static frontend. */
export function collectFrontendPublicEnvKeys(sourceFile: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  walkAst(sourceFile, (node) => {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
    const receiver = node.expression;
    if (!ts.isPropertyAccessExpression(receiver) || receiver.name.text !== "env") return;
    if (!ts.isIdentifier(receiver.expression) || receiver.expression.text !== PROCESS_OBJECT_NAME) return;
    const name = elementName(node);
    if (name !== null && name.startsWith(FRONTEND_PUBLIC_ENV_PREFIX)) keys.add(name);
  });
  return keys;
}

function collectRuntimeEnvReadKeys(
  filePaths: readonly string[],
  collect: (sourceFile: ts.SourceFile) => Iterable<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const filePath of filePaths) {
    for (const key of collect(parseSourceFile(filePath).sourceFile)) {
      if (isEnvKeyCandidate(key)) keys.add(key);
    }
  }
  return keys;
}

/** Runtime env reads must be declared in the manifest that also renders
 * `.env.example`; a hand-added key otherwise works in Cloudflare and silently
 * disappears from the operator contract. Non-binding globals (`ASSETS`,
 * `SITE_API`) and CI/build variables are not env candidates, so they stay out. */
export function findUndeclaredRuntimeEnvKeys(
  reads: RuntimeEnvReadInventory,
  bindings: readonly EnvBindingDefinition[] = ENV_BINDINGS,
): string[] {
  const errors: string[] = [];
  const check = (keys: ReadonlySet<string>, runtimes: readonly EnvRuntimeName[], label: string) => {
    for (const key of [...keys].sort()) {
      const declared = bindings.some((binding) =>
        binding.key === key && runtimes.some((runtime) => binding.runtimes[runtime]));
      if (!declared) {
        errors.push(
          `${label} reads undeclared env key ${key}; declare it in shared/lib/env-contract/registry.ts ` +
            `with the ${runtimes.join("/")} runtime`,
        );
      }
    }
  };
  check(reads.worker, ["worker"], "Worker runtime");
  check(reads.pages, ["pagesOps", "pagesSiteData"], "Pages Functions runtime");
  check(reads.frontend, ["frontend"], "Frontend build");
  return errors;
}

export function collectRuntimeEnvReads(root = repoRoot): RuntimeEnvReadInventory {
  const sourceFiles = (rootDir: string) => collectSourceFilesUnderRoot(rootDir, root, {
    extensions: RUNTIME_ENV_SOURCE_EXTENSIONS,
  }).filter((filePath) => !TEST_SOURCE_PATH.test(relative(root, filePath).replaceAll("\\", "/")));

  return {
    worker: collectRuntimeEnvReadKeys(sourceFiles("worker/src"), collectRuntimeEnvObjectKeys),
    pages: collectRuntimeEnvReadKeys(sourceFiles("functions"), collectRuntimeEnvObjectKeys),
    frontend: collectRuntimeEnvReadKeys(sourceFiles("src"), collectFrontendPublicEnvKeys),
  };
}

function extractInlineCodeTokens(line: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < line.length) {
    const start = line.indexOf("`", index);
    if (start < 0) break;
    const end = line.indexOf("`", start + 1);
    if (end < 0) break;

    const token = line.slice(start + 1, end).trim();
    if (token.length > 0) {
      tokens.push(token);
    }
    index = end + 1;
  }

  return tokens;
}

function isEnvKeyCandidate(token: string): boolean {
  if (token !== "DB" && !token.includes("_")) return false;
  if (!/[A-Z]/.test(token[0])) return false;

  for (const char of token) {
    const isUpper = char >= "A" && char <= "Z";
    const isDigit = char >= "0" && char <= "9";
    if (!isUpper && !isDigit && char !== "_") {
      return false;
    }
  }

  return true;
}

function collectDocumentedEnvKeys(filePaths: readonly string[]): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>();

  for (const filePath of filePaths) {
    let inFence = false;

    for (const line of splitLines(readFileSync(filePath, "utf8"))) {
      if (line.trim().startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      for (const token of extractInlineCodeTokens(line)) {
        if (!isEnvKeyCandidate(token) || DOC_NON_ENV_TOKENS.has(token)) {
          continue;
        }

        const files = seen.get(token) ?? new Set();
        files.add(filePath);
        seen.set(token, files);
      }
    }
  }

  return seen;
}

function formatFileList(filePaths: Iterable<string>): string {
  return [...filePaths].map((filePath) => relative(repoRoot, filePath)).sort().join(", ");
}

function findFirstDifferenceLine(expected: string, actual: string) {
  const expectedLines = splitLines(expected);
  const actualLines = splitLines(actual);
  const maxLines = Math.max(expectedLines.length, actualLines.length);

  for (let index = 0; index < maxLines; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return {
        actual: actualLines[index] ?? "<missing>",
        expected: expectedLines[index] ?? "<missing>",
        line: index + 1,
      };
    }
  }

  return null;
}

function buildGeneratedBlock(marker: string, content: string): string {
  return `<!-- ${marker}:BEGIN -->\n${content}\n<!-- ${marker}:END -->`;
}

function assertFileMatchesExpected(filePath: string, expected: string, errors: string[]): void {
  const actual = normalizeText(readFileSync(filePath, "utf8"));
  if (actual === expected) {
    return;
  }

  const diff = findFirstDifferenceLine(expected, actual);
  if (!diff) {
    errors.push(`${relative(repoRoot, filePath)} does not match the manifest-derived output.`);
    return;
  }

  errors.push(
    `${relative(repoRoot, filePath)} drifts from the manifest-derived output at line ${diff.line}: expected ${JSON.stringify(diff.expected)} but found ${JSON.stringify(diff.actual)}`,
  );
}

function assertGeneratedBlockMatches(
  filePath: string,
  marker: string,
  expectedContent: string,
  errors: string[],
): void {
  const drift = findDocContractDrift(
    (file) => normalizeText(readFileSync(file, "utf8")),
    [{
      file: filePath,
      id: marker,
      startMarker: `<!-- ${marker}:BEGIN -->`,
      endMarker: `<!-- ${marker}:END -->`,
      expected: buildGeneratedBlock(marker, expectedContent),
    }],
  )[0];
  if (!drift) return;
  if (drift.found === null) {
    errors.push(`${relative(repoRoot, filePath)} is missing or has duplicate generated block markers for ${marker}.`);
    return;
  }

  const diff = findFirstDifferenceLine(drift.expected, drift.found)!;
  errors.push(
    `${relative(repoRoot, filePath)} has a stale generated block for ${marker} at line ${diff.line}: expected ${JSON.stringify(diff.expected)} but found ${JSON.stringify(diff.actual)}`,
  );
}

export function runEnvContractCheck({
  consoleImpl = console,
  exit = process.exit,
}: {
  consoleImpl?: Pick<Console, "error" | "log">;
  exit?: (code?: number) => unknown;
} = {}): boolean {
  const envExample = parseEnvExampleKeys(envExamplePath);
  const manifestEnvKeys = new Set(getAllEnvBindingKeys());
  const sourceEnvKeys = collectSourceEnvKeys(SOURCE_SCAN_ROOTS.flatMap(collectFiles));
  const documentedEnvKeys = collectDocumentedEnvKeys(DOC_SCAN_FILES);
  const knownEnvKeys = new Set([
    ...manifestEnvKeys,
    ...sourceEnvKeys,
  ]);

  const errors: string[] = [];

  if (envExample.duplicates.size > 0) {
    errors.push(`.env.example defines duplicate keys: ${[...envExample.duplicates].sort().join(", ")}`);
  }

  errors.push(...findEnvExamplePolicyErrors(readFileSync(envExamplePath, "utf8")));

  errors.push(...findUndeclaredRuntimeEnvKeys(collectRuntimeEnvReads()));

  assertFileMatchesExpected(envExamplePath, renderEnvExample(), errors);

  for (const block of GENERATED_DOC_BLOCKS) {
    assertGeneratedBlockMatches(block.filePath, block.marker, block.render(), errors);
  }

  errors.push(...findWranglerBindingContractErrors(readFileSync(wranglerConfigPath, "utf8")));

  for (const [key, filePaths] of documentedEnvKeys) {
    if (knownEnvKeys.has(key)) continue;
    errors.push(`Verified env docs reference unknown env key ${key} in ${formatFileList(filePaths)}`);
  }

  if (errors.length > 0) {
    consoleImpl.error("Environment contract check failed:");
    for (const error of errors) {
      consoleImpl.error(`  ${error}`);
    }
    exit(1);
    return false;
  }

  consoleImpl.log(
    "Environment contract is in sync with Wrangler bindings, the shared manifest, runtime env reads, generated docs blocks, and referenced env names.",
  );
  return true;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runEnvContractCheck();
}
