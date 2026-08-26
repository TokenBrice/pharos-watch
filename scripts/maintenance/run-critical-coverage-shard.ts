#!/usr/bin/env node

import { buildCriticalCoverageArgs } from "../lib/critical-test-files.mts";
import { createExecutionUnit, createLocalVitestCommand, runExecutionUnit, runSpawnCommand } from "../lib/command-runner.mts";

runExecutionUnit(createExecutionUnit([
  createLocalVitestCommand(
    buildCriticalCoverageArgs(["--reporter=blob", "--reporter=default", ...process.argv.slice(2)]),
    process.env,
  ),
]), {
  reporter: {},
  runCommandImpl: runSpawnCommand,
}).then((result) => {
  process.exit(result.status);
});
