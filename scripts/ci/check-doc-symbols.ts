#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import {
  parseStrictCliArgs,
  runDirectCli,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { splitLines } from "../lib/doc-files.mts";
import { reportViolations } from "../lib/report-violations.mts";

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".mjs",
  ".js",
  ".cjs",
  ".json",
  ".sql",
  ".toml",
  ".yml",
  ".yaml",
]);
const SYMBOL_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(\(\))?$/;
const CAMEL_CASE_BOUNDARY = /[a-z][A-Z]/;

// These are reviewed documentation references that are intentionally not
// required to resolve to a current Pharos code/config identifier.
const SYMBOL_EXCLUSIONS = Object.freeze({
  collateralFromLive: "Historical Safety v5.8-v8.17 snapshot field named in live-reserves history; retired from source.",
  WebSearch: "Claude Code tool name in the harness capability table; not a Pharos identifier.",
  WebFetch: "Claude Code tool name in the harness capability table; not a Pharos identifier.",
  ChainCirculating: "API reference response label; source owns ChainCirculatingPoint instead.",
  TokenPoint: "API reference example type; no standalone tracked runtime identifier.",
  DexPriceCheck: "API reference response label; the current response shape is inferred in source.",
  DexPriceSource: "API reference response label; source owns provider-specific DEX source types.",
  CoinFlow: "API reference response label; source owns the MintBurnCoinFlow type.",
  HourlyFlow: "API reference response label; source owns the hourly flow row shape.",
  SearchAction: "JSON-LD vocabulary described as intentionally un-emitted; not a Pharos identifier.",
  exceededMemory: "Cloudflare platform outcome label retained in architecture history.",
  useCoverageMatrixModel: "Planned route hook retained in coverage documentation; not implemented in source.",
  fetchBlacklistEvents: "Superseded pipeline prose retains a historical client helper name.",
  fetchBlacklistSummary: "Superseded pipeline prose retains a historical client helper name.",
  getPoolFee: "External Fluid resolver method named by provider documentation.",
  getProgramAccounts: "External Solana RPC method named by provider documentation.",
  queryBatchSwap: "External Balancer contract method named by provider documentation.",
  useLogos: "Legacy route hook name retained in documentation; no current export.",
  KeyInfoCard: "Retired detail-page component name retained for migration history.",
  RefreshCountdown: "Legacy status component name retained in route documentation.",
  openCircuitGroups: "Status payload field described as a wire-contract key, not a code symbol.",
  evaluateStatusAndPersist: "Historical status-probe helper name retained in operational prose.",
  DetailToken: "API response-shape label; source uses opaque detail-token rows.",
  severityToAccent: "Retired styling helper name retained in historical design notes.",
  hasProjector: "Retired styling flag retained in historical design notes.",
  MenuButtonWebApp: "Telegram Bot API platform type named by the integration contract.",
  operatorReason: "Documented request field, not a standalone tracked code identifier.",
  runBestEffortScheduledJob: "Superseded scheduled-runner helper; source exports the WithOutcome variant.",
  setMyProfilePhoto: "Telegram Bot API method named by the integration contract.",
  ParsedCommand: "Conceptual Telegram parser record; implementation uses command-specific types.",
  providerJson: "Historical provider wrapper name retained in the Worker limits prose.",
  providerTextBounded: "Historical provider wrapper name retained in the Worker limits prose.",
  jobTimeout: "Worker lease prose uses a conceptual timeout field, not a shared identifier.",
} as const);

const USAGE = `Usage: node --import tsx scripts/ci/check-doc-symbols.ts [options]

Options:
  --json       Print machine-readable results
  -h, --help   Show this help`;

interface RecordLike {
  [key: string]: unknown;
}

export interface DocSymbolDocument {
  path: string;
  content: string;
}

export interface DocSymbolSourceFile {
  path: string;
  content: string;
}

export interface DocSymbolOccurrence {
  doc: string;
  line: number;
  token: string;
}

export interface DocSymbolScanResult {
  candidateCount: number;
  documentsScanned: number;
  violations: DocSymbolOccurrence[];
}

interface InlineCodeSpan {
  line: number;
  value: string;
}

interface DocSymbolScanOptions {
  documents: readonly DocSymbolDocument[];
  sourceFiles: readonly DocSymbolSourceFile[];
  exclusions?: Readonly<Record<string, string>>;
}

interface RoutedDocOwnership {
  mappings?: unknown;
  taskFamilies?: unknown;
}

type CodePathLister = (args: readonly string[]) => string;

function isRecord(value: unknown): value is RecordLike {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getStringArray(record: RecordLike, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function canonicalRepoPath(repoRoot: string, candidate: string): string | null {
  if (!candidate.endsWith(".md")) return null;

  const absolutePath = resolve(repoRoot, candidate);
  const repoRelativePath = relative(repoRoot, absolutePath).replaceAll("\\", "/");
  if (
    repoRelativePath.length === 0 ||
    repoRelativePath === ".." ||
    repoRelativePath.startsWith("../") ||
    repoRelativePath.startsWith("/")
  ) {
    return null;
  }

  try {
    return statSync(absolutePath).isFile() ? repoRelativePath : null;
  } catch {
    return null;
  }
}

export function getRoutedDocPaths(
  repoRoot = process.cwd(),
  ownership: RoutedDocOwnership = JSON.parse(
    readFileSync(resolve(repoRoot, "docs/doc-ownership.json"), "utf8"),
  ) as RoutedDocOwnership,
): string[] {
  const candidates: string[] = ["README.md"];
  const pushDocEntries = (owner: Record<string, unknown>, key: string) => {
    const entries = owner[key];
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry === "string") candidates.push(entry);
      else if (isRecord(entry) && typeof entry.path === "string") candidates.push(entry.path);
    }
  };
  if (isRecord(ownership)) pushDocEntries(ownership, "baseDocs");
  for (const family of Array.isArray(ownership.taskFamilies) ? ownership.taskFamilies : []) {
    if (isRecord(family)) candidates.push(...getStringArray(family, "docsToRead"));
  }
  for (const mapping of Array.isArray(ownership.mappings) ? ownership.mappings : []) {
    if (!isRecord(mapping)) continue;
    pushDocEntries(mapping, "docs");
    pushDocEntries(mapping, "background");
    pushDocEntries(mapping, "alsoRead");
  }

  return [...new Set(candidates.map((candidate) => canonicalRepoPath(repoRoot, candidate)).filter((path): path is string => path !== null))].sort();
}

export function iterInlineCodeSpans(content: string): InlineCodeSpan[] {
  const spans: InlineCodeSpan[] = [];
  let inFence = false;

  for (const [lineIndex, line] of splitLines(content).entries()) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const regex = /`([^`\n]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      spans.push({ line: lineIndex + 1, value: match[1] ?? "" });
    }
  }

  return spans;
}

function isCandidateToken(token: string): boolean {
  return (
    token.length >= 6 &&
    !token.includes("/") &&
    !token.includes(".") &&
    !token.includes(":") &&
    !token.includes("-") &&
    !/\s/.test(token) &&
    SYMBOL_PATTERN.test(token) &&
    CAMEL_CASE_BOUNDARY.test(token)
  );
}

export function extractDocSymbolOccurrences(content: string, doc: string): DocSymbolOccurrence[] {
  return iterInlineCodeSpans(content)
    .filter((span) => isCandidateToken(span.value))
    .map((span) => ({ doc, line: span.line, token: span.value }));
}

function searchToken(token: string): string {
  return token.endsWith("()") ? token.slice(0, -2) : token;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectOccurrences(documents: readonly DocSymbolDocument[]): Map<string, DocSymbolOccurrence[]> {
  const occurrences = new Map<string, DocSymbolOccurrence[]>();
  for (const document of documents) {
    for (const occurrence of extractDocSymbolOccurrences(document.content, document.path)) {
      const entries = occurrences.get(occurrence.token) ?? [];
      entries.push(occurrence);
      occurrences.set(occurrence.token, entries);
    }
  }
  return occurrences;
}

export function findSourceHits(
  tokens: readonly string[],
  sourceFiles: readonly DocSymbolSourceFile[],
): Set<string> {
  const hits = new Set<string>();
  for (const token of new Set(tokens)) {
    // eslint-disable-next-line security/detect-non-literal-regexp -- token comes from a repo-controlled doc code span and is escaped
    const pattern = new RegExp(`\\b${escapeRegExp(searchToken(token))}\\b`);
    if (sourceFiles.some((sourceFile) => pattern.test(sourceFile.content))) {
      hits.add(searchToken(token));
    }
  }
  return hits;
}

function buildScanResult(
  documents: readonly DocSymbolDocument[],
  occurrences: Map<string, DocSymbolOccurrence[]>,
  sourceHits: ReadonlySet<string>,
  exclusions: Readonly<Record<string, string>>,
): DocSymbolScanResult {
  const violations: DocSymbolOccurrence[] = [];
  for (const token of [...occurrences.keys()].sort()) {
    const normalizedToken = searchToken(token);
    if (Object.hasOwn(exclusions, token) || Object.hasOwn(exclusions, normalizedToken)) continue;
    if (sourceHits.has(normalizedToken)) continue;
    violations.push(...(occurrences.get(token) ?? []));
  }

  violations.sort((left, right) =>
    left.doc.localeCompare(right.doc) || left.line - right.line || left.token.localeCompare(right.token),
  );
  return {
    candidateCount: occurrences.size,
    documentsScanned: documents.length,
    violations,
  };
}

export function scanDocSymbols({
  documents,
  sourceFiles,
  exclusions = SYMBOL_EXCLUSIONS,
}: DocSymbolScanOptions): DocSymbolScanResult {
  const occurrences = collectOccurrences(documents);
  return buildScanResult(documents, occurrences, findSourceHits([...occurrences.keys()], sourceFiles), exclusions);
}

export function collectCodePaths(
  repoRoot: string,
  listPaths: CodePathLister = (args) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
): string[] {
  const outputs = [
    listPaths(["ls-files", "-z"]),
    listPaths(["ls-files", "--others", "--exclude-standard", "-z"]),
  ];
  return [...new Set(outputs.flatMap((output) => output.split("\0")))]
    .filter(Boolean)
    .filter((filePath) => CODE_EXTENSIONS.has(extname(filePath)))
    // `git ls-files` still lists paths deleted in the working tree; rg cannot read those.
    .filter((filePath) => existsSync(resolve(repoRoot, filePath)));
}

function findTrackedSourceHits(
  tokens: readonly string[],
  sourcePaths: readonly string[],
  repoRoot: string,
): Set<string> {
  const normalizedTokens = [...new Set(tokens.map(searchToken))];
  if (normalizedTokens.length === 0 || sourcePaths.length === 0) return new Set();

  const pattern = `\\b(?:${normalizedTokens
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .map(escapeRegExp)
    .join("|")})\\b`;
  const result = spawnSync(
    "rg",
    [
      "--only-matching",
      "--no-filename",
      "--no-heading",
      "--no-messages",
      "--no-ignore",
      "--hidden",
      "--text",
      "--regexp",
      pattern,
      "--",
      ...sourcePaths,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw new Error(`Unable to search tracked source files with rg: ${result.error.message}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Unable to search tracked source files with rg (exit ${result.status ?? "unknown"})`);
  }

  return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

function loadDocuments(repoRoot: string, paths: readonly string[]): DocSymbolDocument[] {
  return paths.map((path) => ({
    path,
    content: readFileSync(resolve(repoRoot, path), "utf8"),
  }));
}

export interface DocSymbolArgs {
  help: boolean;
  json: boolean;
}

export function parseDocSymbolArgs(argv: readonly string[]): DocSymbolArgs {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      json: { type: "boolean" },
    },
  });
  return { help: values.help === true, json: values.json === true };
}

interface OutputWriter {
  write(chunk: string): unknown;
}

export function runDocSymbolCheck(
  argv: readonly string[] = process.argv.slice(2),
  {
    repoRoot = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
  }: { repoRoot?: string; stdout?: OutputWriter; stderr?: OutputWriter } = {},
): number {
  const args = parseDocSymbolArgs(argv);
  if (writeCliHelpIfRequested(args, USAGE, stdout)) return 0;

  const documents = loadDocuments(repoRoot, getRoutedDocPaths(repoRoot));
  const occurrences = collectOccurrences(documents);
  const sourceHits = findTrackedSourceHits([...occurrences.keys()], collectCodePaths(repoRoot), repoRoot);
  const result = buildScanResult(documents, occurrences, sourceHits, SYMBOL_EXCLUSIONS);

  if (args.json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.violations.length === 0 ? 0 : 1;
  }

  return reportViolations({
    label: "Documentation symbol references",
    heading: "Documentation symbol check failed",
    violations: result.violations.map(({ doc, line, token }) => `${doc}:${line} → ${token}`),
    scannedCount: result.documentsScanned,
    stdout,
    stderr,
  });
}

runDirectCli(
  import.meta.url,
  () => {
    const status = runDocSymbolCheck(process.argv.slice(2));
    if (status !== 0) process.exitCode = status;
  },
  { label: "doc-symbols", usage: USAGE },
);
