#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { buildCriticalCoverageMergeArgs } from "../lib/critical-test-files.mts";
import { localBin } from "../lib/local-bin.mts";
import { withCiVitestArgs } from "../lib/vitest-ci-args.mts";
import { collectGitPaths } from "../lib/changed-files.mts";
import { parseCriticalCoverageRefs } from "../lib/critical-coverage-refs.mts";
import { runDirectCli } from "../lib/cli-args.mjs";

function run(cmd: string, args: readonly string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync(cmd, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function mergeCriticalCoverage({
  env = process.env,
  runCommand = run,
}: {
  env?: NodeJS.ProcessEnv;
  runCommand?: typeof run;
} = {}): number {
  const { base, head } = parseCriticalCoverageRefs([], env);
  const baseRef = env.GITHUB_ACTIONS || env.PR_BASE_SHA || env.GITHUB_BASE_SHA || env.CRITICAL_COVERAGE_COMPARE_REF
    ? base : undefined;
  const changedFiles = baseRef ? collectGitPaths({ kind: "range", base: baseRef, head, noRenames: true }) : undefined;
  const coverageEnv = { ...env, ...(baseRef ? { PR_BASE_SHA: baseRef, PR_HEAD_SHA: head, CRITICAL_COVERAGE_COMPARE_REF: baseRef } : {}) };
  const status = runCommand(
    localBin("vitest"),
    withCiVitestArgs(buildCriticalCoverageMergeArgs(".vitest-reports", { changedFiles, baseRef }), coverageEnv),
    coverageEnv,
  );
  if (status !== 0) return status;
  return runCommand("node", ["--import", "tsx", "scripts/ci/check-critical-coverage.ts"], coverageEnv);
}

runDirectCli(import.meta.url, () => {
  process.exitCode = mergeCriticalCoverage();
});
