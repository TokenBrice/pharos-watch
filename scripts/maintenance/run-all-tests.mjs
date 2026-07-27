#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { localBin } from "../lib/local-bin.mjs";
import { withCiVitestArgs } from "../lib/vitest-ci-args.mjs";

const result = spawnSync(localBin("vitest"), withCiVitestArgs(["run", ...process.argv.slice(2)]), {
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
