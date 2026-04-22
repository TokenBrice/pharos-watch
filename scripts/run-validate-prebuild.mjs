#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { VALIDATE_PREBUILD_COMMANDS } from "./lib/validate-contract.mjs";

const taskNames = VALIDATE_PREBUILD_COMMANDS.map((cmd) => {
  const prefix = "npm run ";
  if (!cmd.startsWith(prefix)) {
    throw new Error(`validate:prebuild only supports npm-script commands. Received: ${cmd}`);
  }
  return cmd.slice(prefix.length);
});

const result = spawnSync("npx", ["--no-install", "run-p", "-l", "--aggregate-output", ...taskNames], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
