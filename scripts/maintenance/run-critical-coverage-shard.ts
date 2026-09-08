#!/usr/bin/env node

import { collectGitPaths, parseChangedFileArgs } from "../lib/changed-files.mts";
import { buildCriticalCoverageArgs } from "../lib/critical-test-files.mts";
import { createExecutionUnit, createLocalVitestCommand, runExecutionUnit, runSpawnCommand } from "../lib/command-runner.mts";

const { base, head, rest } = parseChangedFileArgs(process.argv.slice(2), process.env);
const explicitChanged = (process.env.CRITICAL_COVERAGE_CHANGED_FILES ?? "")
  .split(/\r?\n|,/g)
  .map((file) => file.trim())
  .filter(Boolean);
const changedFiles = explicitChanged.length > 0
  ? explicitChanged
  : process.env.CI
    ? collectGitPaths({ kind: "range", base, head, noRenames: true })
    : undefined;

runExecutionUnit(createExecutionUnit([
  createLocalVitestCommand(
    buildCriticalCoverageArgs(
      ["--reporter=blob", "--reporter=default", ...rest],
      { changedFiles, baseRef: base },
    ),
    process.env,
  ),
]), {
  reporter: {},
  runCommandImpl: runSpawnCommand,
}).then((result) => {
  process.exit(result.status);
});
