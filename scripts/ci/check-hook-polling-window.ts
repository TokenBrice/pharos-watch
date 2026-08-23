#!/usr/bin/env node
import { reportViolations } from "../lib/report-violations.mts";
import { scanSourceGate } from "../lib/source-gate.mts";
import { runAsCli } from "../lib/source-files.mts";

/**
 * Enforces the AGENTS.md polling rule: cron-backed hooks must derive
 * `staleTime` and `refetchInterval` from `getPollingWindow(cronInterval)`
 * (or call `createPollingQueryOptions(...)`) instead of writing literal
 * cron-derived values inline.
 *
 * Violations: explicit `staleTime: <expr>` / `refetchInterval: <expr>`
 * where <expr> is a numeric literal, an arithmetic expression, or a raw
 * `CRON_*` constant. Allowed forms:
 *   - shorthand destructure (`staleTime,` / `refetchInterval,`)
 *   - `staleTime: Infinity` / `refetchInterval: false` (static queries)
 *   - function references whose names contain `StaleTime` / `RefetchInterval`
 *     (dynamic per-query selectors)
 */

export const DEFAULT_HOOK_POLLING_ROOTS = ["src/hooks"];

export const HOOK_POLLING_WAIVERS = [
  {
    file: "src/hooks/use-api-query.ts",
    reason: "Defines the helpers; the rule is enforced here.",
  },
];

const HOOK_EXTENSIONS = new Set([".ts", ".tsx"]);

const STALE_TIME_RE = /(^|[\s,{])staleTime\s*:\s*([^,\n}]+)/g;
const REFETCH_RE = /(^|[\s,{])refetchInterval\s*:\s*([^,\n}]+)/g;

interface HookPollingWaiver {
  file: string;
  reason: string;
}

interface ScanHookPollingOptions {
  roots?: readonly string[];
  waivers?: readonly HookPollingWaiver[];
  cwd?: string;
}

interface HookPollingViolation {
  file: string;
  reason: string;
}

interface HookPollingReport {
  scannedFiles: string[];
  violations: HookPollingViolation[];
}

type HookPollingScanResult = { ok: true } | { ok: false; reason: string };

function isDestructurePattern(content: string, matchIndex: number): boolean {
  // The `staleTime:` / `refetchInterval:` inside `const { ... } = expr` is a
  // rename pattern, not an option-object property. Walk back to the start of
  // the line and look for an opening brace preceded by `const`/`let`/`var`.
  const lineStart = content.lastIndexOf("\n", matchIndex - 1) + 1;
  const before = content.slice(lineStart, matchIndex);
  return /\b(const|let|var)\s*\{/.test(before);
}

function classifyExpression(expr: string): HookPollingScanResult {
  const trimmed = expr.trim().replace(/[,;]+$/, "").trim();
  if (trimmed.length === 0) return { ok: true };

  // Static-query sentinels.
  if (trimmed === "Infinity" || trimmed === "false") return { ok: true };

  // Per-query selector function refs (TanStack supports `staleTime: (query) => ...`).
  // These are identifiers like `reserveQueryStaleTime` or `reserveQueryRefetchInterval`.
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    if (/StaleTime$|RefetchInterval$/.test(trimmed)) return { ok: true };
    // Plain identifiers without that suffix MUST be the destructured names
    // (`staleTime` / `refetchInterval`). Anything else (e.g. `intervalMs`,
    // `CRON_*`) is a violation.
    if (trimmed === "staleTime" || trimmed === "refetchInterval") return { ok: true };
    if (/^CRON_/.test(trimmed)) return { ok: false, reason: `raw CRON constant: ${trimmed}` };
    return { ok: false, reason: `non-derived identifier: ${trimmed}` };
  }

  // Numeric literals or arithmetic with raw constants → violation.
  if (/^[\d_]+$/.test(trimmed)) return { ok: false, reason: `numeric literal: ${trimmed}` };
  if (/^CRON_/.test(trimmed)) return { ok: false, reason: `raw CRON constant: ${trimmed}` };
  if (/[*+\-/]/.test(trimmed) && /(CRON_|intervalMs|\b\d{2,})/.test(trimmed)) {
    return { ok: false, reason: `derived inline expression: ${trimmed}` };
  }

  // Anything else (e.g. `getPollingWindow(...).staleTime` style — uncommon)
  // is conservatively allowed; downstream review can catch it.
  return { ok: true };
}

export function scanHookPollingWindow({
  roots = DEFAULT_HOOK_POLLING_ROOTS,
  waivers = HOOK_POLLING_WAIVERS,
  cwd = process.cwd(),
}: ScanHookPollingOptions = {}): HookPollingReport {
  const waiverFiles = new Set(waivers.map((w) => w.file));
  return scanSourceGate<HookPollingViolation>({
    roots,
    cwd,
    extensions: HOOK_EXTENSIONS,
    scanFile: ({ relativePath, content }) => {
      if (waiverFiles.has(relativePath)) return [];
      const violations: HookPollingViolation[] = [];
      for (const re of [STALE_TIME_RE, REFETCH_RE]) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(content)) !== null) {
          if (isDestructurePattern(content, match.index)) continue;
          const result = classifyExpression(match[2]);
          if (result.ok) continue;
          const key = re === STALE_TIME_RE ? "staleTime" : "refetchInterval";
          violations.push({
            file: relativePath,
            reason: `${key} set inline (${result.reason}); use getPollingWindow(cronInterval) or createPollingQueryOptions(...)`,
          });
        }
      }
      return violations;
    },
  });
}

export function printHookPollingWindowReport(report: HookPollingReport): number {
  return reportViolations({
    label: "Hook polling window",
    heading: "Hook polling-window violations",
    violations: report.violations.map((violation) => `${violation.file}: ${violation.reason}`),
    hint: "Derive staleTime/refetchInterval from getPollingWindow(cronInterval) or createPollingQueryOptions(...).",
    scannedCount: report.scannedFiles.length,
  });
}

export function main(argv: readonly string[] = process.argv.slice(2), cwd = process.cwd()): number {
  const roots = argv.filter((arg) => !arg.startsWith("-"));
  const report = scanHookPollingWindow({
    roots: roots.length > 0 ? roots : DEFAULT_HOOK_POLLING_ROOTS,
    cwd,
  });
  return printHookPollingWindowReport(report);
}

runAsCli(import.meta.url, main);
