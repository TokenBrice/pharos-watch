#!/usr/bin/env node

import { parseChangedFileArgs } from "../lib/changed-files.mts";
import { createExecutionUnit, createNpmScriptCommand, runExecutionUnit, runSpawnCommand } from "../lib/command-runner.mts";

export async function runPrChecks(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  const result = await runExecutionUnit(createExecutionUnit([
    createNpmScriptCommand("check:pr:static", [`--base=${base}`, `--head=${head}`]),
    createNpmScriptCommand("test:pr", [`--base=${base}`, ...rest]),
  ]), {
    getCommandEnv: () => env as Record<string, string>,
    reporter: {},
    runCommandImpl: runSpawnCommand,
  });
  return result.status;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPrChecks().then((status) => {
    process.exit(status);
  });
}
