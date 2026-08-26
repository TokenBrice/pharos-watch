#!/usr/bin/env node

import { createExecutionUnit, createLocalVitestCommand, runExecutionUnit, runSpawnCommand } from "../lib/command-runner.mts";

runExecutionUnit(createExecutionUnit([
  createLocalVitestCommand(["run", ...process.argv.slice(2)]),
]), {
  reporter: {},
  runCommandImpl: runSpawnCommand,
}).then((result) => {
  process.exit(result.status);
});
