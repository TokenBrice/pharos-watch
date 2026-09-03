#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { runCountRatchet } from "../lib/count-ratchet.mts";
import { collectSourceFilesUnderRoot, runAsCli } from "../lib/source-files.mts";

export const DEFAULT_CRON_CONSOLE_ROOTS = ["worker/src/cron", "worker/src/handlers/scheduled.ts"];
export const DEFAULT_STRUCTURED_LOG_ROOTS = [
  "worker/src/api",
  "worker/src/handlers/http",
  "worker/src/lib/api-response.ts",
  "worker/src/lib/idempotency.ts",
  "worker/src/lib/public-health-assessment.ts",
  "worker/src/lib/route-wrappers.ts",
  "worker/src/lib/status",
  "worker/src/lib/structured-log.ts",
  "worker/src/lib/telegram/log.ts",
  "worker/src/router.ts",
];
const DEFAULT_ROOTS = [...new Set([...DEFAULT_CRON_CONSOLE_ROOTS, ...DEFAULT_STRUCTURED_LOG_ROOTS])];
const BASELINE_PATH = "scripts/lib/cron-console-usage-baseline.json";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const EXCLUDED_DIRS = new Set(["__tests__", "__mocks__"]);
const CONSOLE_CALL_PATTERN = /\bconsole\.(?:log|warn|error|info|debug)\s*\(/g;
const STRUCTURED_LOGGER_FILES = new Set(["worker/src/lib/structured-log.ts", "worker/src/lib/telegram/log.ts"]);

interface ConsoleCall {
  line: number;
  text: string;
  args: string | null;
}

interface ConsoleFinding {
  file: string;
  line: number;
  text: string;
  structured: boolean;
}

interface CheckCronConsoleUsageOptions {
  roots?: readonly string[];
  baselinePath?: string;
  cwd?: string;
  updateBaseline?: boolean;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
}

function lineNumberAt(source: string, offset: number): number {
  return source.slice(0, offset).split(/\r?\n/g).length;
}

function lineTextAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset) + 1;
  const lineEnd = source.indexOf("\n", offset);
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
}

function extractCallArguments(source: string, openParenOffset: number): string | null {
  let depth = 1;
  let quote = null;
  let escaped = false;

  for (let index = openParenOffset + 1; index < source.length; index++) {
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

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openParenOffset + 1, index);
      }
    }
  }

  return null;
}

function collectConsoleCalls(source: string): ConsoleCall[] {
  const calls: ConsoleCall[] = [];
  for (const match of source.matchAll(CONSOLE_CALL_PATTERN)) {
    const offset = match.index ?? 0;
    const text = lineTextAt(source, offset);
    if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) {
      continue;
    }
    const openParenOffset = offset + match[0].lastIndexOf("(");
    calls.push({
      line: lineNumberAt(source, offset),
      text,
      args: extractCallArguments(source, openParenOffset),
    });
  }
  return calls;
}

function isStructuredConsoleCall(rel: string, args: string | null): boolean {
  if (!args) return false;
  const normalized = args.trim().replace(/\s+/g, " ");
  if (STRUCTURED_LOGGER_FILES.has(rel) && /^(line|payload)$/.test(normalized)) {
    return true;
  }
  return (
    /^JSON\.stringify\s*\(\s*\{/.test(normalized) && /\bscope\s*:/.test(normalized) && /\bmessage\s*:/.test(normalized)
  );
}

export function collectWorkerConsoleUsage(
  roots: readonly string[] = DEFAULT_ROOTS,
  cwd = process.cwd(),
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const root of roots) {
    for (const file of collectSourceFilesUnderRoot(root, cwd, {
      extensions: SOURCE_EXTENSIONS,
      excludedDirs: EXCLUDED_DIRS,
    })) {
      const rel = relative(cwd, file).replaceAll("\\", "/");
      const source = readFileSync(file, "utf8");
      const count = collectConsoleCalls(source).filter((call) => !isStructuredConsoleCall(rel, call.args)).length;
      if (count > 0) counts[rel] = count;
    }
  }

  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function collectWorkerConsoleFindings(
  roots: readonly string[] = DEFAULT_ROOTS,
  cwd = process.cwd(),
): ConsoleFinding[] {
  const findings: ConsoleFinding[] = [];

  for (const root of roots) {
    for (const file of collectSourceFilesUnderRoot(root, cwd, {
      extensions: SOURCE_EXTENSIONS,
      excludedDirs: EXCLUDED_DIRS,
    })) {
      const rel = relative(cwd, file).replaceAll("\\", "/");
      const source = readFileSync(file, "utf8");
      for (const call of collectConsoleCalls(source)) {
        findings.push({
          file: rel,
          line: call.line,
          text: call.text,
          structured: isStructuredConsoleCall(rel, call.args),
        });
      }
    }
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function checkCronConsoleUsage({
  roots = DEFAULT_ROOTS,
  baselinePath = BASELINE_PATH,
  cwd = process.cwd(),
  updateBaseline = false,
  stdout = process.stdout,
  stderr = process.stderr,
}: CheckCronConsoleUsageOptions = {}): number {
  return runCountRatchet({
    collectCounts: () => collectWorkerConsoleUsage(roots, cwd),
    baselinePath,
    cwd,
    updateBaseline,
    stdout,
    stderr,
    labels: {
      baselineUpdated: "Worker raw console usage baseline updated",
      failedToReadBaseline: "[cron-console] Failed to read baseline",
      missingBaseline: "[cron-console] Missing baseline",
      increased: "Worker raw console usage increased",
      ok: "Worker console usage",
      countNoun: "raw calls",
    },
    remediation: "Use structured logging helpers instead of adding raw console.* calls.",
  });
}

runAsCli(import.meta.url, () => checkCronConsoleUsage({ updateBaseline: process.argv.includes("--update-baseline") }));
