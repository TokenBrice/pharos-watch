#!/usr/bin/env node

import { createExecutionUnit, runParallelExecutionUnits, runShellCommand } from "../lib/command-runner.mjs";
import { buildGeneratedArtifactPhases } from "../lib/automation-registry.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

// Each phase is a dependency barrier. Four-way concurrency keeps the
// browser-rendering OG builders from stacking up on constrained runners.
export const GENERATED_ARTIFACTS_MAX_PARALLEL = 4;

/** @param {{ bootstrap?: boolean, check?: boolean, skip?: string[] }} [options] */
export function buildGeneratedArtifactExecutionUnits({ bootstrap = false, check = false, skip = [] } = {}) {
  return buildGeneratedArtifactExecutionPhases({ bootstrap, check, skip }).flatMap(({ units }) => units);
}

/** @param {{ bootstrap?: boolean, check?: boolean, skip?: string[] }} [options] */
export function buildGeneratedArtifactExecutionPhases({ bootstrap = false, check = false, skip = [] } = {}) {
  return buildGeneratedArtifactPhases({ bootstrap, check, skip }).map(({ phase, artifacts }) => ({
    phase,
    units: artifacts.map((artifact) => createExecutionUnit([artifact.command])),
  }));
}

export function parseGeneratedArtifactsSkip(env = process.env) {
  return (env.GENERATED_ARTIFACTS_SKIP ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function resolveGeneratedArtifactsSkip({ check = false, env = process.env } = {}) {
  // Freshness validation must inspect the full artifact registry.
  return check ? [] : parseGeneratedArtifactsSkip(env);
}

export async function runGeneratedArtifacts({
  argv = process.argv.slice(2),
  env = process.env,
  exit = process.exit,
  runCommandImpl = runShellCommand,
} = {}) {
  const args = new Set(argv);
  const check = args.has("--check");
  // Check mode is intentionally authoritative: it cannot be narrowed by a
  // bootstrap request or an environment skip list.
  const bootstrap = !check && args.has("--bootstrap");

  const skip = resolveGeneratedArtifactsSkip({ check, env });
  if (skip.length > 0) {
    console.log(
      `[generated-artifacts] Skipping (verified separately by check:generated-artifacts): ${skip.join(", ")}`,
    );
  }

  const label = check
    ? "generated-artifacts:check"
    : bootstrap
      ? "generated-artifacts:bootstrap"
      : "generated-artifacts";
  for (const { phase, units } of buildGeneratedArtifactExecutionPhases({ bootstrap, check, skip })) {
    const result = await runParallelExecutionUnits(units, {
      exit,
      label: `${label}:phase-${phase}`,
      maxParallel: GENERATED_ARTIFACTS_MAX_PARALLEL,
      runCommandImpl,
    });
    if (result.status !== 0) return result;
  }

  return { status: 0, failedCmd: null, aborted: false };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runGeneratedArtifacts().catch((error) => {
    console.error(`[generated-artifacts] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
