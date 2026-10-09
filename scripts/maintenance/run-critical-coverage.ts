#!/usr/bin/env node

import { availableParallelism } from "node:os";
import { getChangedFilesFromGit, parseChangedFilesFromEnv } from "../ci/check-critical-coverage.ts";
import { buildCriticalCoverageArgs } from "../lib/critical-test-files.mts";
import {
  createExecutionUnit,
  createLocalVitestCommand,
  createSpawnCommand,
  runExecutionUnit,
  runSpawnCommand,
} from "../lib/command-runner.mts";

// With a compare ref and no ratchet-all, the checker enforces only touched
// critical sources, so measure only those, as the CI coverage shards do.
// buildCriticalCoverageArgs widens to every enrolled source whenever the
// touched set cannot be isolated (test-file or plumbing changes).
const compareRef = (process.env.CRITICAL_COVERAGE_COMPARE_REF ?? "").trim();
const touchedScope = compareRef !== "" && process.env.CRITICAL_COVERAGE_RATCHET_ALL !== "1";
const explicitChanged = parseChangedFilesFromEnv();
const changedFiles = !touchedScope ? undefined : explicitChanged.length > 0 ? explicitChanged : getChangedFilesFromGit(compareRef);
// CI runners keep the calibrated cap of 4. Workstations use half their cores,
// bounded to 4..8; 8 workers passed repeated same-HEAD runs on a 16-core host.
const maxWorkers = process.env.CI ? undefined : Math.min(8, Math.max(4, Math.floor(availableParallelism() / 2)));

runExecutionUnit(createExecutionUnit([
  createLocalVitestCommand(buildCriticalCoverageArgs(process.argv.slice(2), { changedFiles, baseRef: touchedScope ? compareRef : undefined, maxWorkers })),
  createSpawnCommand(process.execPath, ["--import", "tsx", "scripts/ci/check-critical-coverage.ts"]),
]), {
  reporter: {},
  runCommandImpl: runSpawnCommand,
}).then((result) => {
  process.exit(result.status);
});
