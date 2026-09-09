import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { localBin } from "../lib/local-bin.mts";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mts";
import { parseVitestFileList, selectPrTestFiles } from "../lib/pr-test-selection.mts";
import {
  formatShardTimingSummary,
  parseShardCoordinates,
  summarizeShardTimings,
  type VitestJsonReport,
} from "../lib/shard-timings.mts";
import { hasVitestOption, withCiVitestArgs } from "../lib/vitest-ci-args.mts";

interface RunPrTestsOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawnSync;
}

function collectChangedFilePaths(
  base: string,
  head: string,
  env: NodeJS.ProcessEnv,
  spawn: typeof spawnSync,
): string[] {
  return collectChangedFiles({
    base,
    head,
    execFile: (file, args, options) => {
      const result = spawn(file, [...args], { ...options, env });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Git change selection failed: ${String(result.stderr ?? "").trim()}`);
      return String(result.stdout ?? "");
    },
  });
}

function rawReportPath(timingsFile: string): string {
  return `${timingsFile.replace(/\.json$/, "")}.vitest.json`;
}

/**
 * Publishes this shard's Vitest wall time and per-file durations so PR shard
 * imbalance is observable from the run page and comparable across runs.
 * Reporting never changes the lane result: a missing report is skipped.
 */
function publishShardTimings(
  timingsFile: string,
  vitestArgs: readonly string[],
  wallMs: number,
  env: NodeJS.ProcessEnv,
): void {
  const rawReport = rawReportPath(timingsFile);
  if (!existsSync(rawReport)) return;
  const report = JSON.parse(readFileSync(rawReport, "utf8")) as VitestJsonReport;
  const summary = summarizeShardTimings(report, { ...parseShardCoordinates(vitestArgs), wallMs });
  writeFileSync(timingsFile, `${JSON.stringify(summary, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, formatShardTimingSummary(summary));
}

export function runPrTests({
  argv = process.argv.slice(2),
  env = process.env,
  spawn = spawnSync,
}: RunPrTestsOptions = {}): number {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  const vitest = localBin("vitest");
  const listResult = spawn(vitest, ["list", "--changed", base, "--filesOnly"], {
    encoding: "utf8",
    env,
  });
  if (listResult.error) throw listResult.error;
  if (listResult.status !== 0) {
    process.stderr.write(listResult.stderr ?? "");
    throw new Error(`Vitest could not resolve tests changed since ${base}.`);
  }

  const changedFiles = collectChangedFilePaths(base, head, env, spawn);
  const files = selectPrTestFiles(parseVitestFileList(String(listResult.stdout ?? "")), undefined, changedFiles);
  const vitestArgs = withCiVitestArgs(["run", ...files, ...rest], env);
  const timingsFile = env.PR_SHARD_TIMINGS_FILE;
  const reportArgs: string[] = [];
  if (timingsFile) {
    mkdirSync(dirname(rawReportPath(timingsFile)), { recursive: true });
    if (!hasVitestOption(vitestArgs, "--reporter")) reportArgs.push("--reporter=default");
    reportArgs.push("--reporter=json", `--outputFile.json=${rawReportPath(timingsFile)}`);
  }
  const startedAt = Date.now();
  const result = spawn(vitest, [...vitestArgs, ...reportArgs], {
    env,
    stdio: "inherit",
  });
  const wallMs = Date.now() - startedAt;
  if (result.error) throw result.error;
  if (timingsFile) publishShardTimings(timingsFile, vitestArgs, wallMs, env);
  return result.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runPrTests());
}
