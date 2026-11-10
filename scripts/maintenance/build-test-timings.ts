#!/usr/bin/env node
/**
 * Merge nightly Vitest JSON reporter outputs into the per-file duration table
 * consumed by `test:pr --timings` for duration-balanced shards.
 *
 * PR tests collect no timing telemetry; this table is built only from the
 * nightly `--reporter=json --outputFile=...` shards. Each value is the sum of
 * that file's assertion durations rounded to 100 ms, and duplicate observations
 * keep the slowest value so repeated inputs cannot double-count.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { argv as processArgv } from "node:process";
import { assertCliUsage, parseStrictCliArgs, requireCliString, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

export const TEST_TIMINGS_VERSION = 1;
const ROUNDING_MS = 100;

interface VitestAssertion {
  duration?: unknown;
}

interface VitestFileResult {
  assertionResults?: VitestAssertion[];
  name?: unknown;
}

interface VitestReport {
  testResults?: VitestFileResult[];
}

export interface TestTimingsFile {
  version: number;
  generatedAt: string;
  files: Record<string, number>;
}

function collectReportPaths(directory: string): string[] {
  const paths: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && extname(entry.name) === ".json") paths.push(path);
    }
  };
  visit(directory);
  return paths.sort();
}

function normalizeReportPath(name: string, cwd: string): string {
  const path = isAbsolute(name) ? relative(cwd, name) : name;
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Sum a file result's assertion durations; Vitest omits `duration` for skipped tests. */
export function assertionDurations(result: VitestFileResult): number {
  return (result.assertionResults ?? []).reduce((sum, test) => {
    const duration = Number(test.duration);
    return Number.isFinite(duration) && duration > 0 ? sum + duration : sum;
  }, 0);
}

/**
 * Merge Vitest JSON reports. Reports without `testResults` (summary files,
 * other tooling output) are skipped and reported, never silently accepted.
 */
export function mergeTestTimings(reportPaths: readonly string[], { cwd = process.cwd(), now = new Date() }: { cwd?: string; now?: Date } = {}): {
  timings: TestTimingsFile;
  skipped: string[];
} {
  const files: Record<string, number> = {};
  const skipped: string[] = [];
  for (const path of reportPaths) {
    let report: VitestReport;
    try {
      report = JSON.parse(readFileSync(path, "utf8")) as VitestReport;
    } catch {
      skipped.push(path);
      continue;
    }
    if (!Array.isArray(report.testResults)) {
      skipped.push(path);
      continue;
    }
    for (const result of report.testResults) {
      if (typeof result.name !== "string" || !result.name) continue;
      const file = normalizeReportPath(result.name, cwd);
      const duration = Math.round(assertionDurations(result) / ROUNDING_MS) * ROUNDING_MS;
      files[file] = Math.max(files[file] ?? 0, duration);
    }
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
  return {
    timings: { version: TEST_TIMINGS_VERSION, generatedAt: now.toISOString(), files: sorted },
    skipped,
  };
}

export function main(argv: readonly string[] = processArgv.slice(2)): number {
  const { values } = parseStrictCliArgs(argv, {
    options: { input: { type: "string" }, output: { type: "string" } },
  });
  if (writeCliHelpIfRequested(values, "Usage: node --import tsx scripts/maintenance/build-test-timings.ts --input <dir> --output <file>")) return 0;
  const input = resolve(requireCliString(values.input, "--input"));
  const output = resolve(requireCliString(values.output, "--output"));
  assertCliUsage(existsSync(input) && statSync(input).isDirectory(), `--input must be an existing directory: ${input}`);
  const reports = collectReportPaths(input);
  assertCliUsage(reports.length > 0, `No Vitest JSON reports found under ${input}`);
  const { timings, skipped } = mergeTestTimings(reports);
  const measured = Object.values(timings.files);
  assertCliUsage(measured.length > 0, `No per-file durations found in ${reports.length} report(s)`);
  for (const path of skipped) process.stderr.write(`[test-timings] skipped non-Vitest JSON: ${path}\n`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(timings, null, 2)}\n`);
  const total = measured.reduce((sum, value) => sum + value, 0);
  process.stdout.write(`[test-timings] ${measured.length} files, ${Math.round(total / 1000)}s summed assertions -> ${output}\n`);
  return 0;
}

runDirectCli(import.meta.url, () => {
  process.exitCode = main();
});
