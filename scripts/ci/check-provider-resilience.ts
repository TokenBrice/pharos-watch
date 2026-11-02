#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { reportViolations } from "../lib/report-violations.mts";
import { collectSourceFilesUnderRoots, normalizeRelPath } from "../lib/source-files.mts";
import { runDirectCli } from "../lib/cli-args.mjs";
import {
  PROVIDER_RESILIENCE_REGISTRY,
  REQUIRED_PROVIDER_SURFACE_FAMILIES,
} from "../lib/provider-resilience-registry.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const DEFAULT_DIRECT_FETCH_ROOTS = ["worker/src"];
const EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "test-helpers"]);
// A bare fetch finding needs the `fetch` identifier (or a unicode escape that
// can spell it). Files without either token cannot produce a call, so the scan
// skips their parse and checker work.
const FETCH_TOKEN = /\bfetch\b/;
const UNICODE_ESCAPE = /\\u(?:[0-9a-f]{4}|\{[0-9a-f]{1,6}\})/i;

interface ProviderResilienceEntry {
  id?: string;
  description?: string;
  family?: string;
  files?: readonly string[];
  tests?: readonly string[];
  requiredMarkers?: readonly string[];
  allowBareFetch?: boolean;
  directFetchJustification?: string;
  resilience?: {
    transport?: string;
    timeout?: string;
    body?: string;
    circuitSources?: readonly string[];
  };
}

interface ProviderViolation {
  kind: string;
  message: string;
  file?: string;
  line?: number;
  text?: string;
  id?: string;
  marker?: string;
  circuitSource?: string;
  family?: string;
}

interface FetchCall {
  file: string;
  line: number;
  text: string;
}


function mayContainBareFetch(source: string): boolean {
  return FETCH_TOKEN.test(source) || UNICODE_ESCAPE.test(source);
}

/** Bind the supplied source files in one program so the scan pays one checker
 * build instead of one per file. Script files stay out of the shared bind
 * (their top-level declarations are global) and get their own checker. */
function createSourceChecker(sourceFiles: readonly ts.SourceFile[]): ts.TypeChecker {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true };
  const host = ts.createCompilerHost(options);
  const sourcesByName = new Map(sourceFiles.map((sourceFile) => [sourceFile.fileName, sourceFile]));
  host.getSourceFile = (name) => sourcesByName.get(name);
  host.fileExists = (name) => sourcesByName.has(name);
  return ts.createProgram(sourceFiles.map((sourceFile) => sourceFile.fileName), options, host).getTypeChecker();
}

/** True when the declaration makes the name a global: an ambient (`declare`)
 * declaration, a `declare global { … }` augmentation, or — handled by the
 * caller — a declaration in another file. A single shared program resolves
 * `fetch` in every module to such a symbol, so symbol presence alone cannot
 * mean "shadowed locally". */
function isAmbientDeclaration(declaration: ts.Declaration): boolean {
  for (let node: ts.Node | undefined = declaration; node && !ts.isSourceFile(node); node = node.parent) {
    if (ts.isModuleDeclaration(node) && (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0) return true;
    if (ts.canHaveModifiers(node)
      && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
      return true;
    }
  }
  return false;
}

function isGlobalFetchSymbol(symbol: ts.Symbol, sourceFile: ts.SourceFile): boolean {
  if (symbol.getName() !== "fetch") return false;
  const declarations = symbol.getDeclarations() ?? [];
  if (declarations.length === 0) return true;
  return declarations.some((declaration) =>
    declaration.getSourceFile() !== sourceFile || isAmbientDeclaration(declaration));
}

function collectBareFetchCalls(
  sourceFile: ts.SourceFile,
  source: string,
  checker: ts.TypeChecker,
  file: string,
): FetchCall[] {
  const aliases = new Set<ts.Symbol>();
  const calls: FetchCall[] = [];
  const lines = source.split("\n");

  function isGlobalFetch(expression: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(expression)) return isGlobalFetch(expression.expression);
    if (!ts.isIdentifier(expression)) return false;
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol) return expression.text === "fetch";
    return aliases.has(symbol) || isGlobalFetchSymbol(symbol, sourceFile);
  }

  function assign(name: ts.Identifier, value: ts.Expression | undefined): void {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol) return;
    const isFetch = value !== undefined && isGlobalFetch(value);
    if (isFetch) aliases.add(symbol);
    else aliases.delete(symbol);
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer) visit(node.initializer);
      assign(node.name, node.initializer);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) {
      visit(node.right);
      assign(node.left, node.right);
      return;
    }
    if (ts.isCallExpression(node) && isGlobalFetch(node.expression)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      calls.push({ file, line: line + 1, text: lines[line]!.trim() });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return calls;
}

export function findBareFetchCalls(source: string, file = "<source>"): FetchCall[] {
  const scanFile = file === "<source>" ? "scan.ts" : file;
  const sourceFile = ts.createSourceFile(scanFile, source, ts.ScriptTarget.Latest, true);
  return collectBareFetchCalls(sourceFile, source, createSourceChecker([sourceFile]), file);
}

function readRelFile(cwd: string, relPath: string): string {
  return readFileSync(resolve(cwd, relPath), "utf8");
}


function addViolation(
  violations: ProviderViolation[],
  kind: string,
  message: string,
  details: Omit<ProviderViolation, "kind" | "message"> = {},
): void {
  violations.push({ kind, message, ...details });
}

function validateRegistryEntryShape(entry: ProviderResilienceEntry | undefined, violations: ProviderViolation[]): void {
  if (!entry || typeof entry !== "object") {
    addViolation(violations, "invalid-entry", "Registry entry must be an object.");
    return;
  }
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    addViolation(violations, "invalid-entry-id", "Registry entry is missing a non-empty id.");
  }
  if (typeof entry.family !== "string" || entry.family.length === 0) {
    addViolation(violations, "invalid-entry-family", `${entry.id ?? "<unknown>"} is missing a non-empty family.`);
  }
  if (!Array.isArray(entry.files) || entry.files.length === 0) {
    addViolation(violations, "missing-files", `${entry.id ?? "<unknown>"} must list source files.`);
  }
  if (!Array.isArray(entry.tests) || entry.tests.length === 0) {
    addViolation(violations, "missing-tests", `${entry.id ?? "<unknown>"} must list regression tests.`);
  }
  if (!Array.isArray(entry.requiredMarkers) || entry.requiredMarkers.length === 0) {
    addViolation(violations, "missing-required-markers", `${entry.id ?? "<unknown>"} must list source markers.`);
  }
  if (entry.allowBareFetch && (typeof entry.directFetchJustification !== "string" || entry.directFetchJustification.length < 20)) {
    addViolation(violations, "missing-direct-fetch-justification", `${entry.id ?? "<unknown>"} allows bare fetch without a durable justification.`);
  }
  if (!entry.resilience || typeof entry.resilience !== "object") {
    addViolation(violations, "missing-resilience", `${entry.id ?? "<unknown>"} must describe resilience posture.`);
    return;
  }
  for (const key of ["transport", "timeout", "body"] as const) {
    if (typeof entry.resilience[key] !== "string" || entry.resilience[key].length === 0) {
      addViolation(violations, "missing-resilience-field", `${entry.id ?? "<unknown>"} is missing resilience.${key}.`);
    }
  }
  if (!Array.isArray(entry.resilience.circuitSources)) {
    addViolation(violations, "missing-circuit-source-list", `${entry.id ?? "<unknown>"} must set resilience.circuitSources, even when empty.`);
  }
}

export function scanProviderResilience({
  cwd = process.cwd(),
  registry = PROVIDER_RESILIENCE_REGISTRY,
  requiredFamilies = REQUIRED_PROVIDER_SURFACE_FAMILIES,
  directFetchRoots = DEFAULT_DIRECT_FETCH_ROOTS,
}: {
  cwd?: string;
  registry?: readonly ProviderResilienceEntry[];
  requiredFamilies?: readonly string[];
  directFetchRoots?: readonly string[];
} = {}): { entries: number; registeredFiles: number; violations: ProviderViolation[] } {
  const violations: ProviderViolation[] = [];
  const seenIds = new Set<string>();
  const entriesByFile = new Map<string, ProviderResilienceEntry[]>();

  for (const entry of registry) {
    validateRegistryEntryShape(entry, violations);
    if (!entry?.id) continue;

    if (seenIds.has(entry.id)) {
      addViolation(violations, "duplicate-id", `Duplicate provider resilience registry id: ${entry.id}`, { id: entry.id });
    }
    seenIds.add(entry.id);

    let combinedSource = "";
    for (const relPath of entry.files ?? []) {
      const normalized = normalizeRelPath(relPath);
      if (!existsSync(resolve(cwd, normalized))) {
        addViolation(violations, "missing-source-file", `${entry.id} references missing source file ${normalized}`, {
          id: entry.id,
          file: normalized,
        });
        continue;
      }
      combinedSource += `\n/* ${normalized} */\n${readRelFile(cwd, normalized)}`;
      const entries = entriesByFile.get(normalized) ?? [];
      entries.push(entry);
      entriesByFile.set(normalized, entries);
    }

    for (const relPath of entry.tests ?? []) {
      const normalized = normalizeRelPath(relPath);
      if (!existsSync(resolve(cwd, normalized))) {
        addViolation(violations, "missing-test-file", `${entry.id} references missing test file ${normalized}`, {
          id: entry.id,
          file: normalized,
        });
      }
    }

    for (const marker of entry.requiredMarkers ?? []) {
      if (typeof marker !== "string" || marker.length === 0) {
        addViolation(violations, "invalid-marker", `${entry.id} has an empty required marker.`, { id: entry.id });
        continue;
      }
      if (!combinedSource.includes(marker)) {
        addViolation(violations, "missing-marker", `${entry.id} is missing required marker: ${marker}`, {
          id: entry.id,
          marker,
        });
      }
    }

    for (const circuitSource of entry.resilience?.circuitSources ?? []) {
      if (typeof circuitSource !== "string" || circuitSource.length === 0) {
        addViolation(violations, "invalid-circuit-source", `${entry.id} has an empty circuit source.`, { id: entry.id });
        continue;
      }
      if (circuitSource.startsWith("CIRCUIT_SOURCE.") && !combinedSource.includes(circuitSource)) {
        addViolation(violations, "missing-circuit-source-marker", `${entry.id} is missing circuit source marker ${circuitSource}`, {
          id: entry.id,
          circuitSource,
        });
      }
    }
  }

  for (const family of requiredFamilies) {
    if (!registry.some((entry) => entry.family === family)) {
      addViolation(violations, "missing-required-family", `Registry is missing required provider surface family: ${family}`, {
        family,
      });
    }
  }

  const candidates: Array<{ relPath: string; source: string; sourceFile: ts.SourceFile }> = [];
  for (const relPath of collectSourceFilesUnderRoots(directFetchRoots, cwd, {
    extensions: SOURCE_EXTENSIONS,
    excludedDirs: EXCLUDED_DIRS,
  })) {
    const source = readRelFile(cwd, relPath);
    if (!mayContainBareFetch(source)) continue;
    candidates.push({
      relPath,
      source,
      sourceFile: ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true),
    });
  }
  const moduleCandidates = candidates.filter((candidate) => ts.isExternalModule(candidate.sourceFile));
  const scriptCandidates = candidates.filter((candidate) => !ts.isExternalModule(candidate.sourceFile));
  const moduleChecker = moduleCandidates.length > 0
    ? createSourceChecker(moduleCandidates.map((candidate) => candidate.sourceFile))
    : undefined;
  const callsByFile = new Map<string, FetchCall[]>();
  for (const candidate of moduleCandidates) {
    callsByFile.set(
      candidate.relPath,
      collectBareFetchCalls(candidate.sourceFile, candidate.source, moduleChecker!, candidate.relPath),
    );
  }
  for (const candidate of scriptCandidates) {
    callsByFile.set(
      candidate.relPath,
      collectBareFetchCalls(
        candidate.sourceFile,
        candidate.source,
        createSourceChecker([candidate.sourceFile]),
        candidate.relPath,
      ),
    );
  }

  for (const { relPath } of candidates) {
    const calls = callsByFile.get(relPath) ?? [];
    if (calls.length === 0) continue;

    const entries = entriesByFile.get(relPath) ?? [];
    if (entries.length === 0) {
      for (const call of calls) {
        addViolation(violations, "unregistered-direct-fetch", `${call.file}:${call.line} bare fetch is not covered by the provider resilience registry.`, call);
      }
      continue;
    }

    if (!entries.some((entry) => entry.allowBareFetch === true)) {
      for (const call of calls) {
        addViolation(violations, "direct-fetch-not-allowed", `${call.file}:${call.line} bare fetch is not allowed by its provider resilience registry entry.`, call);
      }
    }
  }

  return {
    entries: registry.length,
    registeredFiles: entriesByFile.size,
    violations,
  };
}

export function main(cwd = process.cwd()): number {
  const report = scanProviderResilience({ cwd });
  const status = reportViolations({
    label: "Provider resilience registry",
    violations: report.violations.map((violation) => `[${violation.kind}] ${violation.message}`),
    hint: "Fix: register the provider surface with timeout/body/circuit/test coverage, or route outbound HTTP through an existing resilient helper.",
  });
  if (status !== 0) return status;

  process.stdout.write(
    `Provider resilience registry: OK (${report.entries} surfaces, ${report.registeredFiles} files registered)\n`,
  );
  return 0;
}

runDirectCli(import.meta.url, () => {
  process.exitCode = main();
});
