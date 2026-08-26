#!/usr/bin/env node

import { buildCriticalCoverageArgs } from "../lib/critical-test-files.mts";
import { createExecutionUnit, createLocalVitestCommand, runExecutionUnit, runSpawnCommand } from "../lib/command-runner.mts";

const result = await runExecutionUnit(createExecutionUnit([
  createLocalVitestCommand(
    buildCriticalCoverageArgs(["--reporter=blob", "--reporter=default", ...process.argv.slice(2)]),
    process.env,
  ),
]), {
  reporter: {},
  runCommandImpl: runSpawnCommand,
});
process.exit(result.status);
