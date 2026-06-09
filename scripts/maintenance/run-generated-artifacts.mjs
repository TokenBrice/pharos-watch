#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { createExecutionUnit, runCommandBatches, runShellCommand } from "../lib/command-runner.mjs";
import { buildGeneratedArtifactCommands } from "../lib/automation-registry.mjs";

export function buildGeneratedArtifactExecutionBatches({ check = false, skip = [] } = {}) {
  return buildGeneratedArtifactCommands({ check, skip }).map((cmd) => [createExecutionUnit([cmd])]);
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

  await runCommandBatches(buildGeneratedArtifactExecutionBatches({ check, skip }), {
    exit,
    label: check ? "generated-artifacts:check" : "generated-artifacts",
    runCommandImpl,
  });
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runGeneratedArtifacts().catch((error) => {
    console.error(`[generated-artifacts] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
