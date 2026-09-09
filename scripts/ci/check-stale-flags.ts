#!/usr/bin/env node
/**
 * Tripwire for stale feature flags.
 *
 * Each entry in `src/lib/feature-flags.ts` carries an `// expiresAt: YYYY-MM-DD`
 * comment immediately above the flag-key assignment. This script:
 *   - Fails (exit 1) when any flag's `expiresAt` is today or earlier.
 *   - Warns to stderr (exit 0) when a flag expires within the next 30 days.
 *   - Reports healthy state to stdout (exit 0) otherwise.
 *
 * Retirement guidance lives in `docs/process/feature-flags.md`.
 *
 * Run directly when reviewing feature-flag lifecycle changes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const FLAGS_PATH = "src/lib/feature-flags.ts";
const WARN_WINDOW_DAYS = 30;
const RETIREMENT_DOC = "docs/process/feature-flags.md";

// Match an `// expiresAt: YYYY-MM-DD [— reason]` comment on a single line.
// Linear, no backtracking — avoids `security/detect-unsafe-regex`.
const COMMENT_LINE_RE = /^\s*\/\/\s*expiresAt:\s*(\d{4}-\d{2}-\d{2})(.*)$/;
// Match an identifier flag-key on the following code line.
const FLAG_KEY_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/;

export interface StaleFlag {
  flag: string;
  expiresAt: string;
  reason: string;
}

export interface ClassifiedStaleFlag extends StaleFlag {
  daysUntil: number;
}

export interface StaleFlagsEvaluation {
  flags: StaleFlag[];
  expired: ClassifiedStaleFlag[];
  approaching: ClassifiedStaleFlag[];
  oldest: ClassifiedStaleFlag | null;
  status: 0 | 1;
  stdout: string;
  stderr: string;
  output: string;
}

export interface StaleFlagsCliDeps {
  cwd?: string;
  source?: string;
  readFile?: (path: string) => string;
  today?: Date;
  now?: () => Date;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export function parseFlags(source: string): StaleFlag[] {
  const lines = source.split(/\r?\n/);
  const flags: StaleFlag[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const commentMatch = COMMENT_LINE_RE.exec(lines[i]);
    if (!commentMatch) continue;
    const keyMatch = FLAG_KEY_LINE_RE.exec(lines[i + 1]);
    if (!keyMatch) continue;
    const [, expiresAt, rest] = commentMatch;
    const [, flag] = keyMatch;
    const reason = rest.replace(/^\s*[—-]\s*/, "").trim();
    flags.push({ flag, expiresAt, reason });
  }
  return flags;
}

function daysBetween(fromDate: Date, toDate: Date): number {
  const ms = toDate.getTime() - fromDate.getTime();
  return Math.floor(ms / 86_400_000);
}

function startOfUtcDay(date: Date): Date {
  const normalized = new Date(date.getTime());
  normalized.setUTCHours(0, 0, 0, 0);
  return normalized;
}

export function evaluateStaleFlags(
  source: string,
  today: Date = new Date(),
): StaleFlagsEvaluation {
  const flags = parseFlags(source);
  if (flags.length === 0) {
    const stderr =
      `check-stale-flags: found no \`// expiresAt: YYYY-MM-DD\` comments in ${FLAGS_PATH}. ` +
      `Either the file moved or the comment convention changed; see ${RETIREMENT_DOC}.\n`;
    return {
      flags,
      expired: [],
      approaching: [],
      oldest: null,
      status: 1,
      stdout: "",
      stderr,
      output: stderr,
    };
  }

  const todayStart = startOfUtcDay(today);
  const expired: ClassifiedStaleFlag[] = [];
  const approaching: ClassifiedStaleFlag[] = [];

  for (const entry of flags) {
    const expiresAt = new Date(`${entry.expiresAt}T00:00:00Z`);
    if (Number.isNaN(expiresAt.getTime())) {
      const stderr = `check-stale-flags: invalid date for flag \`${entry.flag}\`: ${entry.expiresAt}\n`;
      return {
        flags,
        expired,
        approaching,
        oldest: null,
        status: 1,
        stdout: "",
        stderr,
        output: stderr,
      };
    }
    const daysUntil = daysBetween(todayStart, expiresAt);
    if (daysUntil <= 0) {
      expired.push({ ...entry, daysUntil });
    } else if (daysUntil <= WARN_WINDOW_DAYS) {
      approaching.push({ ...entry, daysUntil });
    }
  }

  if (expired.length > 0) {
    let stderr = `check-stale-flags: ${expired.length} feature flag(s) past their expiresAt date.\n`;
    for (const entry of expired) {
      const suffix = entry.reason ? ` — ${entry.reason}` : "";
      stderr += `  ${entry.flag} expired ${entry.expiresAt}${suffix}\n`;
    }
    stderr +=
      `\nRetire (flip on + remove off-path) or extend the expiresAt with a documented rationale. ` +
      `See ${RETIREMENT_DOC}.\n`;
    return {
      flags,
      expired,
      approaching,
      oldest: null,
      status: 1,
      stdout: "",
      stderr,
      output: stderr,
    };
  }

  let stderr = "";
  for (const entry of approaching) {
    const suffix = entry.reason ? ` — ${entry.reason}` : "";
    stderr += `WARN: ${entry.flag} expires in ${entry.daysUntil} day(s) on ${entry.expiresAt}${suffix}\n`;
  }

  const oldest = flags
    .map((entry) => ({
      ...entry,
      daysUntil: daysBetween(todayStart, new Date(`${entry.expiresAt}T00:00:00Z`)),
    }))
    .sort((a, b) => a.daysUntil - b.daysUntil)[0];
  const stdout =
    `check-stale-flags: all ${flags.length} flags healthy ` +
    `(${approaching.length} warning, 0 expired); oldest \`${oldest.flag}\` expires in ${oldest.daysUntil} day(s) on ${oldest.expiresAt}.\n`;
  return {
    flags,
    expired,
    approaching,
    oldest,
    status: 0,
    stdout,
    stderr,
    output: `${stderr}${stdout}`,
  };
}

export function run(
  _argv: readonly string[] = process.argv.slice(2),
  deps: StaleFlagsCliDeps = {},
): StaleFlagsEvaluation {
  const cwd = deps.cwd ?? process.cwd();
  let source = deps.source;
  if (source === undefined) {
    const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    try {
      source = readFile(resolve(cwd, FLAGS_PATH));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stderr = `check-stale-flags: could not read ${FLAGS_PATH}: ${message}\n`;
      return {
        flags: [],
        expired: [],
        approaching: [],
        oldest: null,
        status: 1,
        stdout: "",
        stderr,
        output: stderr,
      };
    }
  }

  return evaluateStaleFlags(source, deps.today ?? deps.now?.() ?? new Date());
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: StaleFlagsCliDeps = {},
): number {
  const result = run(argv, deps);
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  if (result.stderr) err(result.stderr);
  if (result.stdout) out(result.stdout);
  return result.status;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exitCode = main();
}
