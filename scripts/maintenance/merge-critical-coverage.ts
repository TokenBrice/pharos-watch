#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { buildCriticalCoverageMergeArgs } from "../lib/critical-test-files.mts";
import { localBin } from "../lib/local-bin.mts";
import { withCiVitestArgs } from "../lib/vitest-ci-args.mts";
import { collectGitPaths } from "../lib/changed-files.mts";

function run(cmd: string, args: readonly string[]): void {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const baseRef = process.env.CRITICAL_COVERAGE_COMPARE_REF;
const changedFiles = baseRef ? collectGitPaths({ kind: "range", base: baseRef, head: "HEAD", noRenames: true }) : undefined;

run(
  localBin("vitest"),
  withCiVitestArgs(buildCriticalCoverageMergeArgs(".vitest-reports", { changedFiles, baseRef }), process.env),
);
run("node", ["--import", "tsx", "scripts/ci/check-critical-coverage.ts"]);
