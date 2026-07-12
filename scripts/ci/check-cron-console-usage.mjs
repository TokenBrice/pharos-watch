#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { collectSourceFilesUnderRoot, runAsCli } from "../lib/source-files.mjs";

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
  "worker/src/lib/telegram-log.ts",
  "worker/src/router.ts",
];
const DEFAULT_ROOTS = [...new Set([...DEFAULT_CRON_CONSOLE_ROOTS, ...DEFAULT_STRUCTURED_LOG_ROOTS])];
const BASELINE_PATH = "scripts/lib/cron-console-usage-baseline.json";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const EXCLUDED_DIRS = new Set(["__tests__", "__mocks__"]);
const CONSOLE_CALL_PATTERN = /\bconsole\.(?:log|warn|error|info|debug)\s*\(/g;
const STRUCTURED_LOGGER_FILES = new Set(["worker/src/lib/structured-log.ts", "worker/src/lib/telegram-log.ts"]);

function lineNumberAt(source, offset) {
  return source.slice(0, offset).split(/\r?\n/g).length;
}

function lineTextAt(source, offset) {
  const lineStart = source.lastIndexOf("\n", offset) + 1;
  const lineEnd = source.indexOf("\n", offset);
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
}

function extractCallArguments(source, openParenOffset) {
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

function collectConsoleCalls(source) {
  const calls = [];
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

function isStructuredConsoleCall(rel, args) {
  if (!args) return false;
  const normalized = args.trim().replace(/\s+/g, " ");
  if (STRUCTURED_LOGGER_FILES.has(rel) && /^(line|payload)$/.test(normalized)) {
    return true;
  }
  return (
    /^JSON\.stringify\s*\(\s*\{/.test(normalized) && /\bscope\s*:/.test(normalized) && /\bmessage\s*:/.test(normalized)
  );
}

export function collectWorkerConsoleUsage(roots = DEFAULT_ROOTS, cwd = process.cwd()) {
  const counts = {};

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

export function collectWorkerConsoleFindings(roots = DEFAULT_ROOTS, cwd = process.cwd()) {
  const findings = [];

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

function readBaseline(path, cwd) {
  const absolute = join(cwd, path);
  if (!existsSync(absolute)) return null;
  const parsed = JSON.parse(readFileSync(absolute, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed;
}

function writeBaseline(path, counts, cwd) {
  const absolute = join(cwd, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(counts, null, 2)}\n`);
}

/**
 * @param {{
 *   roots?: string[], baselinePath?: string, cwd?: string, updateBaseline?: boolean,
 *   stdout?: { write(chunk: string): unknown }, stderr?: { write(chunk: string): unknown },
 * }} [options]
 */
export function checkCronConsoleUsage({
  roots = DEFAULT_ROOTS,
  baselinePath = BASELINE_PATH,
  cwd = process.cwd(),
  updateBaseline = false,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const current = collectWorkerConsoleUsage(roots, cwd);

  if (updateBaseline) {
    writeBaseline(baselinePath, current, cwd);
    stdout.write(`Worker raw console usage baseline updated (${Object.keys(current).length} file entries).\n`);
    return 0;
  }

  let baseline;
  try {
    baseline = readBaseline(baselinePath, cwd);
  } catch (error) {
    stderr.write(`[cron-console] Failed to read baseline: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (!baseline) {
    stderr.write(`[cron-console] Missing baseline at ${baselinePath}. Run with --update-baseline.\n`);
    return 1;
  }

  const violations = [];
  for (const [file, count] of Object.entries(current)) {
    const baselineCount = Number(baseline[file] ?? 0);
    if (!Number.isFinite(baselineCount) || count > baselineCount) {
      violations.push({ file, count, baselineCount: Number.isFinite(baselineCount) ? baselineCount : 0 });
    }
  }

  if (violations.length > 0) {
    stderr.write("Worker raw console usage increased:\n\n");
    for (const violation of violations) {
      stderr.write(`  ${violation.file}: ${violation.count} > baseline ${violation.baselineCount}\n`);
    }
    stderr.write("\nUse structured logging helpers instead of adding raw console.* calls.\n");
    return 1;
  }

  const currentTotal = Object.values(current).reduce((sum, count) => sum + count, 0);
  const baselineTotal = Object.values(baseline).reduce((sum, count) => sum + Number(count), 0);
  stdout.write(`Worker console usage: OK (${currentTotal}/${baselineTotal} raw calls at or below baseline)\n`);
  return 0;
}

runAsCli(import.meta.url, () => checkCronConsoleUsage({ updateBaseline: process.argv.includes("--update-baseline") }));
