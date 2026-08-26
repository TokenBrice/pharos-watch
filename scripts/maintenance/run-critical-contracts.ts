#!/usr/bin/env node

import { buildCriticalContractTestArgs } from "../lib/critical-test-files.mts";
import { createExecutionUnit, createLocalVitestCommand, runExecutionUnit, runSpawnCommand } from "../lib/command-runner.mts";

const result = await runExecutionUnit(createExecutionUnit([
  createLocalVitestCommand(buildCriticalContractTestArgs(process.argv.slice(2))),
]), {
  reporter: {},
  runCommandImpl: runSpawnCommand,
});
process.exit(result.status);
