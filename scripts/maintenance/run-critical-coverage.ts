#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { buildCriticalCoverageArgs } from "../lib/critical-test-files.mts";
import { localBin } from "../lib/local-bin.mts";
import { withCiVitestArgs } from "../lib/vitest-ci-args.mts";

function run(cmd: string, args: readonly string[]): void {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(localBin("vitest"), withCiVitestArgs(buildCriticalCoverageArgs(process.argv.slice(2))));
run("node", ["--import", "tsx", "scripts/ci/check-critical-coverage.ts"]);
