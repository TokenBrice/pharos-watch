#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { buildNoncriticalTestArgs } from "../lib/critical-test-files.mjs";
import { localBin } from "../lib/local-bin.mjs";
import { withCiVitestArgs } from "../lib/vitest-ci-args.mjs";

const result = spawnSync(localBin("vitest"), withCiVitestArgs(buildNoncriticalTestArgs(process.argv.slice(2))), {
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
