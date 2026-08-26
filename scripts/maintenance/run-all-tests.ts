#!/usr/bin/env node

import { createExecutionUnit, createLocalVitestCommand, runExecutionUnit, runSpawnCommand } from "../lib/command-runner.mts";

const result = await runExecutionUnit(createExecutionUnit([
  createLocalVitestCommand(["run", ...process.argv.slice(2)]),
]), {
  reporter: {},
  runCommandImpl: runSpawnCommand,
});
process.exit(result.status);
