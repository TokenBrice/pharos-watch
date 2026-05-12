#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { createExecutionUnit, runCommandBatches, runShellCommand } from "./lib/command-runner.mjs";
import { buildGeneratedArtifactCommands } from "./lib/automation-registry.mjs";

export function buildGeneratedArtifactExecutionBatches({ check = false } = {}) {
  return buildGeneratedArtifactCommands({ check }).map((cmd) => [createExecutionUnit([cmd])]);
}

export async function runGeneratedArtifacts({
  argv = process.argv.slice(2),
  exit = process.exit,
  runCommandImpl = runShellCommand,
} = {}) {
  const args = new Set(argv);
  const check = args.has("--check");

  await runCommandBatches(buildGeneratedArtifactExecutionBatches({ check }), {
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
