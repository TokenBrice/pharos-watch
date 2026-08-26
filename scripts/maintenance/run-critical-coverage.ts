#!/usr/bin/env node

import { buildCriticalCoverageArgs } from "../lib/critical-test-files.mts";
import {
  createExecutionUnit,
  createLocalVitestCommand,
  createSpawnCommand,
  runExecutionUnit,
  runSpawnCommand,
} from "../lib/command-runner.mts";

runExecutionUnit(createExecutionUnit([
  createLocalVitestCommand(buildCriticalCoverageArgs(process.argv.slice(2))),
  createSpawnCommand(process.execPath, ["--import", "tsx", "scripts/ci/check-critical-coverage.ts"]),
]), {
  reporter: {},
  runCommandImpl: runSpawnCommand,
}).then((result) => {
  process.exit(result.status);
});
