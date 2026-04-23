#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { localBin } from "./lib/local-bin.mjs";
import { buildValidatePrebuildRunnerArgs } from "./lib/validate-contract.mjs";

const result = spawnSync(localBin("run-p"), buildValidatePrebuildRunnerArgs({
  continueOnError: process.env.VALIDATE_PREBUILD_CONTINUE_ON_ERROR === "1",
}), {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
