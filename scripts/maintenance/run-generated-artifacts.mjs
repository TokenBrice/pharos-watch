#!/usr/bin/env node

import { createExecutionUnit, runParallelExecutionUnits, runShellCommand } from "../lib/command-runner.mjs";
import { buildGeneratedArtifactCommands } from "../lib/automation-registry.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

// Each generator owns a disjoint committed artifact, so they can run
// concurrently. 4-way keeps the browser-rendering OG builders from stacking up
// on constrained runners while cutting the serial tail (~63s) roughly in half.
export const GENERATED_ARTIFACTS_MAX_PARALLEL = 4;

export function buildGeneratedArtifactExecutionUnits({ check = false, skip = [] } = {}) {
  return buildGeneratedArtifactCommands({ check, skip }).map((cmd) => createExecutionUnit([cmd]));
}

function parseSkipFromEnv(env = process.env) {
  return (env.GENERATED_ARTIFACTS_SKIP ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export async function runGeneratedArtifacts({
  argv = process.argv.slice(2),
  exit = process.exit,
  runCommandImpl = runShellCommand,
} = {}) {
  const args = new Set(argv);
  const check = args.has("--check");

  // Never skip in --check mode: the freshness gate must verify every committed artifact.
  const skip = check ? [] : parseSkipFromEnv();
  if (skip.length > 0) {
    console.log(`[generated-artifacts] Skipping (verified separately by check:generated-artifacts): ${skip.join(", ")}`);
  }

  await runParallelExecutionUnits(buildGeneratedArtifactExecutionUnits({ check, skip }), {
    exit,
    label: check ? "generated-artifacts:check" : "generated-artifacts",
    maxParallel: GENERATED_ARTIFACTS_MAX_PARALLEL,
    runCommandImpl,
  });
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runGeneratedArtifacts().catch((error) => {
    console.error(`[generated-artifacts] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
