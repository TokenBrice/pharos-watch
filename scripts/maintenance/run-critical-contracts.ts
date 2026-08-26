#!/usr/bin/env node

import { buildCriticalContractTestArgs } from "../lib/critical-test-files.mts";
import { createExecutionUnit, createLocalVitestCommand, runExecutionUnit, runSpawnCommand } from "../lib/command-runner.mts";

runExecutionUnit(createExecutionUnit([
  createLocalVitestCommand(buildCriticalContractTestArgs(process.argv.slice(2))),
]), {
  reporter: {},
  runCommandImpl: runSpawnCommand,
}).then((result) => {
  process.exit(result.status);
});
