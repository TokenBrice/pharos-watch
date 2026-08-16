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
const STRICT_PARSER_CALL_PATTERN = /\bparseStrictCliArgs\s*\(/;
const STRICT_WRAPPER_IMPORT_PATTERN = /\bfrom\s+["'][^"']*cli-args\.mjs["']/;
const RELATIVE_IMPORT_PATTERNS = [
  /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g,
  /\bimport\s+["'](\.{1,2}\/[^"']+)["']/g,
  /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
];

function normalizeRepoPath(path) {
  return path.replaceAll("\\", "/");
}

export function sourceUsesProcessArgv(source, path = "source.ts") {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, getScriptKind(path));
  let found = false;

  function visit(node) {
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

function isCanonicalRepoPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path === normalizeRepoPath(path) &&
    !path.startsWith("/") &&
    posix.normalize(path) === path &&
    !path.startsWith("../")
  );
}

function collectRelativeImportSpecifiers(source) {
  const imports = new Set();
  for (const pattern of RELATIVE_IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier?.startsWith(".")) imports.add(specifier);
    }
  }
  return [...imports];
}

function importCandidates(fromPath, specifier) {
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

function createSourceReader(readSource) {
  const cache = new Map();
  return (path) => {
    if (cache.has(path)) return cache.get(path);
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

function entrypointReachesParser(entrypointPath, parserPath, readSource) {
  if (entrypointPath === parserPath) return true;

  const pending = [entrypointPath];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    const source = readSource(current);
    if (source === null) continue;
    for (const specifier of collectRelativeImportSpecifiers(source)) {
      const importedPath = importCandidates(current, specifier).find((candidate) => readSource(candidate) !== null);
      if (!importedPath) continue;
      if (importedPath === parserPath) return true;
      pending.push(importedPath);
    }
  }

  return false;
}

function findDuplicatePaths(records) {
  const seen = new Set();
  const duplicates = new Set();
  for (const record of records) {
    if (seen.has(record.path)) duplicates.add(record.path);
    seen.add(record.path);
  }
  return [...duplicates].sort();
}

function isSorted(paths) {
  return paths.every((path, index) => index === 0 || String(paths[index - 1]).localeCompare(String(path)) <= 0);
}

export function evaluateCliArgsPolicy({ discoveredPaths, policy = CLI_ARGV_POLICY, readSource }) {
  const errors = [];
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
    if (!STRICT_WRAPPER_IMPORT_PATTERN.test(parserSource) || !STRICT_PARSER_CALL_PATTERN.test(parserSource)) {
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
    if (!Object.hasOwn(CLI_ARGV_EXEMPTION_CATEGORIES, entry?.category)) {
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

export function collectRepositoryProcessArgvFiles(cwd = process.cwd()) {
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
 * @param {{
 *   cwd?: string,
 *   policy?: typeof CLI_ARGV_POLICY,
 *   stdout?: { write: (chunk: string) => unknown },
 *   stderr?: { write: (chunk: string) => unknown },
 * }} [options]
 */
export function checkCliArgsPolicy({
  cwd = process.cwd(),
  policy = CLI_ARGV_POLICY,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let discoveredPaths;
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
