import { relative } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface VitestJsonAssertion {
  duration?: number | null;
}

export interface VitestJsonTestResult {
  assertionResults?: readonly VitestJsonAssertion[];
  endTime?: number;
  name: string;
  startTime?: number;
  status?: string;
  testCount?: number;
}

export interface VitestJsonReport {
  numTotalTests?: number;
  success?: boolean;
  testResults?: readonly VitestJsonTestResult[];
}

export interface ShardFileTiming {
  durationMs: number;
  file: string;
  tests: number;
}

export interface ShardTimingSummary {
  fileCount: number;
  files: ShardFileTiming[];
  shard: number;
  shardCount: number;
  success: boolean;
  summedFileMs: number;
  testCount: number;
  wallMs: number;
}

export interface ShardCoordinates {
  shard: number;
  shardCount: number;
}

export type ShardTimingLane = "plain-test" | "critical-coverage";

/**
 * Reads the Vitest `--shard=<n>/<count>` coordinates a lane was invoked with.
 * Unsharded invocations report the whole run as shard 1 of 1.
 */
export function parseShardCoordinates(args: readonly string[]): ShardCoordinates {
  const inline = args.find((arg) => arg.startsWith("--shard="))?.slice("--shard=".length);
  const separate = args[args.indexOf("--shard") + 1];
  const value = inline ?? (args.includes("--shard") ? separate : undefined);
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return { shard: 1, shardCount: 1 };
  return { shard: Number(match[1]), shardCount: Number(match[2]) };
}

function fileDurationMs(result: VitestJsonTestResult): number {
  const span = Number(result.endTime) - Number(result.startTime);
  if (Number.isFinite(span) && span >= 0) return span;
  return (result.assertionResults ?? []).reduce((total, test) => total + (Number(test.duration) || 0), 0);
}

/**
 * Projects a Vitest JSON report into the per-file durations a shard publishes,
 * ordered slowest first so successive runs stay diff-comparable.
 */
export function summarizeShardTimings(
  report: VitestJsonReport,
  coordinates: ShardCoordinates & { cwd?: string; wallMs: number },
): ShardTimingSummary {
  const cwd = coordinates.cwd ?? process.cwd();
  const files = (report.testResults ?? []).map((result) => ({
    durationMs: Math.round(fileDurationMs(result)),
    file: (relative(cwd, result.name) || result.name).replaceAll("\\", "/"),
    tests: result.testCount ?? result.assertionResults?.length ?? 0,
  })).sort((left, right) => right.durationMs - left.durationMs || left.file.localeCompare(right.file));
  return {
    fileCount: files.length,
    files,
    shard: coordinates.shard,
    shardCount: coordinates.shardCount,
    success: Boolean(report.success),
    summedFileMs: files.reduce((total, file) => total + file.durationMs, 0),
    testCount: report.numTotalTests ?? files.reduce((total, file) => total + file.tests, 0),
    wallMs: coordinates.wallMs,
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Renders the GitHub step-summary table. The uploaded JSON keeps every file;
 * the summary shows only the slowest `topLimit` so the run page stays readable.
 */
export function formatShardTimingSummary(summary: ShardTimingSummary, lane: ShardTimingLane, topLimit = 10): string {
  const title = lane === "critical-coverage" ? "PR critical coverage" : "PR tests";
  const artifact = lane === "critical-coverage" ? "pr-coverage-timings" : "pr-test-timings";
  const lines = [
    `### ${title} shard ${summary.shard}/${summary.shardCount}`,
    "",
    `Vitest wall ${seconds(summary.wallMs)} · ${summary.fileCount} files (summed ${seconds(summary.summedFileMs)}) · ${summary.testCount} tests`,
    "",
    "| Slowest file | Duration | Tests |",
    "| --- | ---: | ---: |",
    ...summary.files.slice(0, topLimit).map((file) => `| \`${file.file}\` | ${seconds(file.durationMs)} | ${file.tests} |`),
  ];
  if (summary.fileCount > topLimit) {
    lines.push("", `_${summary.fileCount - topLimit} further files in the \`${artifact}-${summary.shard}\` run artifact._`);
  }
  return `${lines.join("\n")}\n`;
}

export function rawShardReportPath(timingsFile: string): string {
  return `${timingsFile.replace(/\.json$/, "")}.vitest.json`;
}

/** Reporting does not alter a lane's result if Vitest never produced a report. */
export function publishShardTimings(
  timingsFile: string,
  coordinates: ShardCoordinates,
  wallMs: number,
  env: NodeJS.ProcessEnv,
  lane: ShardTimingLane,
): void {
  const rawReport = rawShardReportPath(timingsFile);
  if (!existsSync(rawReport)) return;
  const report = JSON.parse(readFileSync(rawReport, "utf8")) as VitestJsonReport;
  const summary = summarizeShardTimings(report, { ...coordinates, wallMs });
  mkdirSync(dirname(timingsFile), { recursive: true });
  writeFileSync(timingsFile, `${JSON.stringify(summary, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, formatShardTimingSummary(summary, lane));
}
