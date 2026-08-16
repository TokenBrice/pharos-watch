#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { parseChangedFileArgs } from "../lib/changed-files.mts";

function runNpmScript(name, args, env = process.env) {
  const result = spawnSync("npm", ["run", name, "--", ...args], { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function runPrChecks(argv = process.argv.slice(2), env = process.env) {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  runNpmScript("check:pr:static", [`--base=${base}`, `--head=${head}`], env);
  runNpmScript("test:pr", [`--base=${base}`, ...rest], env);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runPrChecks());
}
