#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { collectSourceFiles, runAsCli } from "../lib/source-files.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const DEFAULT_ROOTS = ["worker/src/cron", "worker/src/lib"];
const EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "test-helpers"]);

/** @type {Set<string>} */
const KNOWN_FETCH_BODY_TIMEOUT_DEBT = new Set();

function normalizeRelPath(path) {
  return path.replaceAll("\\", "/");
}

function collectScanFiles(cwd, roots) {
  const files = [];
  for (const root of roots) {
    const absoluteRoot = resolve(cwd, root);
    if (!existsSync(absoluteRoot)) continue;
    files.push(...collectSourceFiles(absoluteRoot, { extensions: SOURCE_EXTENSIONS, excludedDirs: EXCLUDED_DIRS }));
  }
  return files
    .filter((file) => SOURCE_EXTENSIONS.has(extname(file)))
    .map((file) => normalizeRelPath(relative(cwd, file)))
    .sort();
}

export function makeViolationKey(violation) {
  return `${violation.file}::${violation.assignmentText}::${violation.bodyReadText}`;
}

export function findFetchBodyTimeoutViolations(source, file = "<source>") {
  const lines = source.split(/\r?\n/g);
  const tracked = [];
  const violations = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const declarationMatch = trimmed.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+fetchWithRetry\s*\(/);
    const assignmentMatch = declarationMatch
      ? null
      : trimmed.match(/^([A-Za-z_$][\w$]*)\s*=\s*await\s+fetchWithRetry\s*\(/);
    const assignedName = declarationMatch?.[1] ?? assignmentMatch?.[1] ?? null;
    if (assignedName) {
      tracked.push({
        name: assignedName,
        line: index + 1,
        assignmentText: trimmed,
      });
    }

    const bodyReadMatch = trimmed.match(/\b([A-Za-z_$][\w$]*)\s*\.\s*(json|text)\s*\(/);
    if (!bodyReadMatch) continue;

    for (const candidate of tracked) {
      if (index + 1 <= candidate.line) continue;
      if (index + 1 - candidate.line > 80) continue;
      if (bodyReadMatch[1] !== candidate.name) continue;
      violations.push({
        file,
        fetchLine: candidate.line,
        bodyLine: index + 1,
        variable: candidate.name,
        method: bodyReadMatch[2],
        assignmentText: candidate.assignmentText,
        bodyReadText: trimmed,
      });
    }
  }

  return violations;
}

export function scanFetchBodyTimeouts({
  cwd = process.cwd(),
  roots = DEFAULT_ROOTS,
  knownDebt = KNOWN_FETCH_BODY_TIMEOUT_DEBT,
} = {}) {
  const violations = [];
  for (const file of collectScanFiles(cwd, roots)) {
    const source = readFileSync(resolve(cwd, file), "utf8");
    violations.push(...findFetchBodyTimeoutViolations(source, file));
  }

  const seenKeys = new Set(violations.map(makeViolationKey));
  const unexpected = violations.filter((violation) => !knownDebt.has(makeViolationKey(violation)));
  const staleDebt = [...knownDebt].filter((key) => !seenKeys.has(key));
  return { violations, unexpected, staleDebt };
}

export function main() {
  const report = scanFetchBodyTimeouts();
  if (process.argv.includes("--print-baseline")) {
    for (const violation of report.violations) {
      console.log(JSON.stringify(makeViolationKey(violation)) + ",");
    }
    return 0;
  }

  if (report.unexpected.length === 0 && report.staleDebt.length === 0) {
    console.log(`Fetch body timeout check passed (${report.violations.length} known raw body-read debt item${report.violations.length === 1 ? "" : "s"} tracked).`);
    return 0;
  }

  if (report.unexpected.length > 0) {
    console.error("New fetchWithRetry raw body reads found. Use fetchJsonWithRetry/fetchTextWithRetry or add an intentional baseline entry:");
    for (const violation of report.unexpected) {
      console.error(
        `  - ${violation.file}:${violation.bodyLine} ${violation.variable}.${violation.method}() after fetchWithRetry at line ${violation.fetchLine}`,
      );
    }
  }
  if (report.staleDebt.length > 0) {
    console.error("Stale fetch body timeout debt baseline entries should be removed:");
    for (const key of report.staleDebt) {
      console.error(`  - ${key}`);
    }
  }
  return 1;
}

runAsCli(import.meta.url, main);
