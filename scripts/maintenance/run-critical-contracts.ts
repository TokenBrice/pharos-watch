#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { buildCriticalContractTestArgs } from "../lib/critical-test-files.mts";
import { localBin } from "../lib/local-bin.mts";
import { withCiVitestArgs } from "../lib/vitest-ci-args.mts";

const result = spawnSync(localBin("vitest"), withCiVitestArgs(buildCriticalContractTestArgs(process.argv.slice(2))), {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
