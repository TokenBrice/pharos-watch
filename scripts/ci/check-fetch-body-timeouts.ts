#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { collectSourceFiles, runAsCli } from "../lib/source-files.mts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const DEFAULT_ROOTS = ["worker/src/api", "worker/src/cron", "worker/src/lib"];
const EXCLUDED_DIRS = new Set(["__tests__", "__mocks__", "test-helpers"]);

const KNOWN_FETCH_BODY_TIMEOUT_DEBT = new Set<string>();

interface FetchBodyTimeoutViolation {
  file: string;
  fetchLine: number;
  bodyLine: number;
  variable: string;
  method: string;
  assignmentText: string;
  bodyReadText: string;
}

interface TrackedFetchAssignment {
  name: string;
  line: number;
  assignmentText: string;
}

interface ArrayItem {
  text: string;
  start: number;
}

interface FetchBodyTimeoutReport {
  violations: FetchBodyTimeoutViolation[];
  unexpected: FetchBodyTimeoutViolation[];
  staleDebt: string[];
}

function normalizeRelPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function collectScanFiles(cwd: string, roots: readonly string[]): string[] {
  const files: string[] = [];
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

export function makeViolationKey(violation: FetchBodyTimeoutViolation): string {
  return `${violation.file}::${violation.assignmentText}::${violation.bodyReadText}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectFetchWithRetryCallees(lines: readonly string[]): Set<string> {
  const callees = new Set(["fetchWithRetry"]);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const directAlias = trimmed.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*fetchWithRetry\s*;/);
    if (directAlias) {
      callees.add(directAlias[1]);
      continue;
    }

    const destructuredAlias = trimmed.match(/\b(?:const|let|var)\s*\{[^}]*\bfetchWithRetry\s*:\s*([A-Za-z_$][\w$]*)[^}]*\}/);
    if (destructuredAlias) {
      callees.add(destructuredAlias[1]);
    }
  }
  return callees;
}

function fetchWithRetryCalleePattern(callees: ReadonlySet<string>): RegExp {
  const names = [...callees].map(escapeRegExp).join("|");
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`(?:^|[^\\w$])(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*(?:${names})\\s*\\(`);
}

function assignmentPattern(callees: ReadonlySet<string>, declaration: boolean): RegExp {
  const names = [...callees].map(escapeRegExp).join("|");
  const prefix = declaration
    ? "\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+"
    : "^([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+";
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`${prefix}(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*(?:${names})\\s*\\(`);
}

function lineForOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high + 1;
}

function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function findMatchingBracket(source: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "[") depth++;
    if (char === "]") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevelArrayItems(source: string, openIndex: number, closeIndex: number): ArrayItem[] {
  const items: ArrayItem[] = [];
  let itemStart = openIndex + 1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = openIndex + 1; index < closeIndex; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") parenDepth++;
    if (char === ")") parenDepth--;
    if (char === "[") bracketDepth++;
    if (char === "]") bracketDepth--;
    if (char === "{") braceDepth++;
    if (char === "}") braceDepth--;

    if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      items.push({ text: source.slice(itemStart, index), start: itemStart });
      itemStart = index + 1;
    }
  }

  items.push({ text: source.slice(itemStart, closeIndex), start: itemStart });
  return items;
}

function trackDestructuredPromiseAllAssignments(
  source: string,
  lineStarts: readonly number[],
  callees: ReadonlySet<string>,
): TrackedFetchAssignment[] {
  const tracked: TrackedFetchAssignment[] = [];
  const fetchCallPattern = fetchWithRetryCalleePattern(callees);
  const promiseAllPattern = /\b(?:const|let|var)\s*\[([^\]]+)]\s*=\s*await\s+Promise\.all\s*\(\s*\[/g;
  let match;

  while ((match = promiseAllPattern.exec(source)) !== null) {
    const fullMatch = match[0];
    const declarationLine = lineForOffset(lineStarts, match.index);
    const declarationText = source
      .slice(lineStarts[declarationLine - 1], source.indexOf("\n", lineStarts[declarationLine - 1]) === -1
        ? source.length
        : source.indexOf("\n", lineStarts[declarationLine - 1]))
      .trim();
    const names = match[1]
      .split(",")
      .map((name) => name.trim())
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
    const arrayOpenIndex = match.index + fullMatch.lastIndexOf("[");
    const arrayCloseIndex = findMatchingBracket(source, arrayOpenIndex);
    if (arrayCloseIndex === -1) continue;

    const items = splitTopLevelArrayItems(source, arrayOpenIndex, arrayCloseIndex);
    for (let itemIndex = 0; itemIndex < Math.min(items.length, names.length); itemIndex++) {
      const item = items[itemIndex];
      if (!fetchCallPattern.test(item.text)) continue;
      tracked.push({
        name: names[itemIndex],
        line: lineForOffset(lineStarts, item.start),
        assignmentText: declarationText,
      });
    }
    promiseAllPattern.lastIndex = arrayCloseIndex + 1;
  }

  return tracked;
}

export function findFetchBodyTimeoutViolations(
  source: string,
  file = "<source>",
): FetchBodyTimeoutViolation[] {
  const lines = source.split(/\r?\n/g);
  const lineStarts = computeLineStarts(source);
  const callees = collectFetchWithRetryCallees(lines);
  const declarationPattern = assignmentPattern(callees, true);
  const reassignmentPattern = assignmentPattern(callees, false);
  const tracked = trackDestructuredPromiseAllAssignments(source, lineStarts, callees);
  const violations: FetchBodyTimeoutViolation[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const declarationMatch = trimmed.match(declarationPattern);
    const assignmentMatch = declarationMatch
      ? null
      : trimmed.match(reassignmentPattern);
    const assignedName = declarationMatch?.[1] ?? assignmentMatch?.[1] ?? null;
    if (assignedName) {
      tracked.push({
        name: assignedName,
        line: index + 1,
        assignmentText: trimmed,
      });
    }

    const bodyReadMatches = [...trimmed.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(json|text)\s*\(/g)];
    if (bodyReadMatches.length === 0) continue;

    for (const candidate of tracked) {
      if (index + 1 <= candidate.line) continue;
      if (index + 1 - candidate.line > 80) continue;
      for (const bodyReadMatch of bodyReadMatches) {
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
  }

  return violations;
}

export function scanFetchBodyTimeouts({
  cwd = process.cwd(),
  roots = DEFAULT_ROOTS,
  knownDebt = KNOWN_FETCH_BODY_TIMEOUT_DEBT,
}: {
  cwd?: string;
  roots?: readonly string[];
  knownDebt?: ReadonlySet<string>;
} = {}): FetchBodyTimeoutReport {
  const violations: FetchBodyTimeoutViolation[] = [];
  for (const file of collectScanFiles(cwd, roots)) {
    const source = readFileSync(resolve(cwd, file), "utf8");
    violations.push(...findFetchBodyTimeoutViolations(source, file));
  }

  const seenKeys = new Set(violations.map(makeViolationKey));
  const unexpected = violations.filter((violation) => !knownDebt.has(makeViolationKey(violation)));
  const staleDebt = [...knownDebt].filter((key) => !seenKeys.has(key));
  return { violations, unexpected, staleDebt };
}

export function main(): number {
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
