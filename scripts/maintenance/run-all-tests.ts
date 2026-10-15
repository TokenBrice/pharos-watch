#!/usr/bin/env node

import { createExecutionUnit, createLocalVitestCommand, runExecutionUnit, runSpawnCommand } from "../lib/command-runner.mts";

runExecutionUnit(createExecutionUnit([
  createLocalVitestCommand(["run", ...process.argv.slice(2)]),
]), {
  reporter: {},
  getCommandEnv: () => ({ PHAROS_V9_RESOURCE_LANE: "0" }),
  runCommandImpl: runSpawnCommand,
}).then((result) => {
  process.exit(result.status);
});
