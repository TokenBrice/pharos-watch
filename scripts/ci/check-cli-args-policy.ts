#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, posix, resolve } from "node:path";
import ts from "typescript";
import { CLI_ARGV_EXEMPTION_CATEGORIES, CLI_ARGV_POLICY } from "../lib/cli-argv-policy.mjs";
import { reportViolations } from "../lib/report-violations.mts";
import { runAsCli } from "../lib/source-files.mts";
import { getScriptKind } from "../lib/ts-ast.mts";

const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

interface CliPolicyPathEntry {
  path?: unknown;
  parserPath?: unknown;
  category?: unknown;
  reason?: unknown;
}

interface CliArgsPolicy {
  strict?: readonly CliPolicyPathEntry[];
  exemptions?: readonly CliPolicyPathEntry[];
}

type SourceReader = (path: string) => string;

function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function sourceUsesProcessArgv(source: string, path = "source.ts"): boolean {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, getScriptKind(path));
  let found = false;

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "argv"
    ) {
      found = true;
      return;
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "argv"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function isCanonicalRepoPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path === normalizeRepoPath(path) &&
    !path.startsWith("/") &&
    posix.normalize(path) === path &&
    !path.startsWith("../")
  );
}

function inspectParserSource(source: string, path: string) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, getScriptKind(path));
  const imports = new Set<string>();
  let importsWrapper = false;
  let callsParser = false;
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(node) && !node.isTypeOnly)
    ) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        if (specifier.text.startsWith(".")) imports.add(specifier.text);
        if (ts.isImportDeclaration(node) && importCandidates(path, specifier.text).includes("scripts/lib/cli-args.mjs")) {
          importsWrapper = true;
        }
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const specifier = node.arguments[0].text;
        if (specifier.startsWith(".")) imports.add(specifier);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "parseStrictCliArgs") callsParser = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { imports, importsWrapper, callsParser };
}

function importCandidates(fromPath: string, specifier: string): string[] {
  const base = posix.normalize(posix.join(dirname(fromPath), specifier));
  const extension = extname(base);
  const candidates = [base];

  if (!extension) {
    for (const suffix of [".mjs", ".js", ".ts", ".tsx", ".mts", ".cts"]) {
      candidates.push(`${base}${suffix}`);
    }
    for (const suffix of ["index.mjs", "index.js", "index.ts", "index.tsx"]) {
      candidates.push(`${base}/${suffix}`);
    }
  } else if (extension === ".js") {
    candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  } else if (extension === ".mjs") {
    candidates.push(`${base.slice(0, -4)}.mts`);
  }

  return candidates;
}

function createSourceReader(readSource: SourceReader): (path: string) => string | null {
  const cache = new Map<string, string | null>();
  return (path: string): string | null => {
    if (cache.has(path)) return cache.get(path) ?? null;
    try {
      const source = readSource(path);
      const normalized = typeof source === "string" ? source : null;
      cache.set(path, normalized);
      return normalized;
    } catch {
      cache.set(path, null);
      return null;
    }
  };
}

function entrypointReachesParser(entrypointPath: string, parserPath: string, readSource: (path: string) => string | null): boolean {
  if (entrypointPath === parserPath) return true;

  const pending = [entrypointPath];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    const source = readSource(current);
    if (source === null) continue;
    for (const specifier of inspectParserSource(source, current).imports) {
      const importedPath = importCandidates(current, specifier).find((candidate) => readSource(candidate) !== null);
      if (!importedPath) continue;
      if (importedPath === parserPath) return true;
      pending.push(importedPath);
    }
  }

  return false;
}

function findDuplicatePaths(records: readonly CliPolicyPathEntry[]): string[] {
  const seen = new Set<unknown>();
  const duplicates = new Set<string>();
  for (const record of records) {
    if (typeof record.path === "string" && seen.has(record.path)) duplicates.add(record.path);
    seen.add(record.path);
  }
  return [...duplicates].sort();
}

function isSorted(paths: readonly unknown[]): boolean {
  return paths.every((path, index) => index === 0 || String(paths[index - 1]).localeCompare(String(path)) <= 0);
}

export function evaluateCliArgsPolicy({
  discoveredPaths,
  policy = CLI_ARGV_POLICY,
  readSource,
}: {
  discoveredPaths: readonly string[];
  policy?: CliArgsPolicy;
  readSource: SourceReader;
}): {
  errors: string[];
  counts: { discovered: number; strict: number; exempt: number };
} {
  const errors: string[] = [];
  const strictEntries = Array.isArray(policy?.strict) ? policy.strict : [];
  const exemptions = Array.isArray(policy?.exemptions) ? policy.exemptions : [];
  const discovered = [...new Set(discoveredPaths)].sort();
  const discoveredSet = new Set(discovered);
  const readCachedSource = createSourceReader(readSource);

  if (!Array.isArray(policy?.strict)) errors.push("Policy field `strict` must be an array.");
  if (!Array.isArray(policy?.exemptions)) errors.push("Policy field `exemptions` must be an array.");

  const strictPaths = strictEntries.map((entry) => entry?.path);
  const exemptionPaths = exemptions.map((entry) => entry?.path);
  if (!isSorted(strictPaths)) errors.push("Strict CLI policy entries must be sorted by path.");
  if (!isSorted(exemptionPaths)) errors.push("CLI exemption entries must be sorted by path.");

  for (const duplicate of findDuplicatePaths(strictEntries)) {
    errors.push(`Duplicate strict CLI policy entry: ${duplicate}`);
  }
  for (const duplicate of findDuplicatePaths(exemptions)) {
    errors.push(`Duplicate CLI exemption: ${duplicate}`);
  }

  const strictPathSet = new Set(strictPaths);
  for (const exemptionPath of exemptionPaths) {
    if (strictPathSet.has(exemptionPath)) {
      errors.push(`CLI path cannot be both strict and exempt: ${exemptionPath}`);
    }
  }

  for (const entry of strictEntries) {
    if (!isCanonicalRepoPath(entry?.path)) {
      errors.push(`Invalid strict CLI path: ${String(entry?.path)}`);
      continue;
    }
    if (!isCanonicalRepoPath(entry?.parserPath)) {
      errors.push(`Invalid strict parser path for ${entry.path}: ${String(entry?.parserPath)}`);
      continue;
    }

    const parserSource = readCachedSource(entry.parserPath);
    if (parserSource === null) {
      errors.push(`Strict parser source is missing: ${entry.parserPath}`);
      continue;
    }
    const parser = inspectParserSource(parserSource, entry.parserPath);
    if (!parser.importsWrapper || !parser.callsParser) {
      errors.push(
        `Strict parser ${entry.parserPath} must import scripts/lib/cli-args.mjs and call parseStrictCliArgs().`,
      );
    }
    if (!entrypointReachesParser(entry.path, entry.parserPath, readCachedSource)) {
      errors.push(`Strict CLI entrypoint ${entry.path} does not import its declared parser ${entry.parserPath}.`);
    }
  }

  for (const entry of exemptions) {
    if (!isCanonicalRepoPath(entry?.path)) {
      errors.push(`Invalid CLI exemption path: ${String(entry?.path)}`);
      continue;
    }
    if (typeof entry?.category !== "string" || !Object.hasOwn(CLI_ARGV_EXEMPTION_CATEGORIES, entry.category)) {
      errors.push(`Invalid CLI exemption category for ${entry.path}: ${String(entry?.category)}`);
    }
    if (typeof entry?.reason !== "string" || entry.reason.trim().length < 20) {
      errors.push(`CLI exemption ${entry.path} must have a specific audit reason.`);
    }
  }

  const declaredSet = new Set([...strictPaths, ...exemptionPaths]);
  for (const path of discovered) {
    if (!declaredSet.has(path)) {
      errors.push(`Unclassified process.argv entrypoint: ${path}`);
    }
  }
  for (const path of declaredSet) {
    if (!discoveredSet.has(path)) {
      errors.push(`Stale CLI policy entry no longer uses process.argv: ${path}`);
    }
  }

  return {
    errors,
    counts: {
      discovered: discovered.length,
      strict: strictEntries.length,
      exempt: exemptions.length,
    },
  };
}

export function collectRepositoryProcessArgvFiles(cwd = process.cwd()): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  return output
    .split("\0")
    .filter(Boolean)
    .map(normalizeRepoPath)
    .filter((path) => SOURCE_EXTENSIONS.has(extname(path)))
    .filter((path) => {
      try {
        return sourceUsesProcessArgv(readFileSync(resolve(cwd, path), "utf8"), path);
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 */
export function checkCliArgsPolicy({
  cwd = process.cwd(),
  policy = CLI_ARGV_POLICY,
  stdout = process.stdout,
  stderr = process.stderr,
}: {
  cwd?: string;
  policy?: CliArgsPolicy;
  stdout?: { write: (chunk: string) => unknown };
  stderr?: { write: (chunk: string) => unknown };
} = {}): number {
  let discoveredPaths: string[];
  try {
    discoveredPaths = collectRepositoryProcessArgvFiles(cwd);
  } catch (error) {
    stderr.write(
      `[cli-args-policy] Unable to list repository files: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const result = evaluateCliArgsPolicy({
    discoveredPaths,
    policy,
    readSource: (path) => readFileSync(resolve(cwd, path), "utf8"),
  });

  const status = reportViolations({
    label: "CLI argument policy",
    heading: "CLI argument policy check failed",
    violations: result.errors,
    stdout,
    stderr,
  });
  if (status !== 0) return status;

  stdout.write(
    `CLI argument policy: OK (${result.counts.discovered} entrypoints; ${result.counts.strict} strict, ${result.counts.exempt} exempt)\n`,
  );
  return 0;
}

runAsCli(import.meta.url, () => checkCliArgsPolicy());
