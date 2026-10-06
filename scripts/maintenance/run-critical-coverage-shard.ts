#!/usr/bin/env node

import { collectGitPaths, parseChangedFileArgs } from "../lib/changed-files.mts";
import { buildCriticalCoverageArgs } from "../lib/critical-test-files.mts";
import { createExecutionUnit, createLocalVitestCommand, runExecutionUnit, runSpawnCommand, type CommandImplementation, type SpawnCommand } from "../lib/command-runner.mts";
import { parseShardCoordinates, publishShardTimings } from "../lib/shard-timings.mts";
import { takeTestShard } from "../lib/pr-test-plan.mts";
import { hasVitestOption } from "../lib/vitest-ci-args.mts";
import { runDirectCli } from "../lib/cli-args.mjs";

export async function runCriticalCoverageShard({
  argv = process.argv.slice(2),
  env = process.env,
  runCommand = runSpawnCommand,
}: {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  runCommand?: CommandImplementation<SpawnCommand>;
} = {}): Promise<number> {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  const explicitChanged = (env.CRITICAL_COVERAGE_CHANGED_FILES ?? "")
    .split(/\r?\n|,/g)
    .map((file) => file.trim())
    .filter(Boolean);
  const changedFiles = explicitChanged.length > 0
    ? explicitChanged
    : env.CI
      ? collectGitPaths({ kind: "range", base, head, noRenames: true })
      : undefined;
  const timingsFile = env.PR_SHARD_TIMINGS_FILE;
  const timingReporter = timingsFile ? ["--reporter=./scripts/lib/shard-timing-reporter.mts"] : [];
  const { shard } = takeTestShard(rest);
  const blobOutput = shard && !hasVitestOption(rest, "--outputFile") && !hasVitestOption(rest, "--outputFile.blob")
    ? [`--outputFile.blob=.vitest-reports/blob-${shard.shard}-${shard.shardCount}.json`]
    : [];
  const startedAt = Date.now();

  const result = await runExecutionUnit(createExecutionUnit([
    createLocalVitestCommand(
      buildCriticalCoverageArgs(
        ["--reporter=blob", "--reporter=default", ...timingReporter, ...blobOutput, ...rest],
        { changedFiles, baseRef: base },
      ),
      env,
    ),
  ]), { reporter: {}, runCommandImpl: runCommand });
  if (timingsFile) publishShardTimings(timingsFile, parseShardCoordinates(rest), Date.now() - startedAt, env);
  return result.status;
}

runDirectCli(import.meta.url, async () => {
  process.exitCode = await runCriticalCoverageShard();
});
