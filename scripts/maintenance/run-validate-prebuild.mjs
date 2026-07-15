#!/usr/bin/env node

import { createExecutionUnit, runParallelExecutionUnits } from "../lib/command-runner.mjs";
import {
  buildValidatePrebuildCommands,
  normalizeValidatePrebuildSurface,
  parseValidatePrebuildSkipCommands,
  shouldIncludeAdvisoryPrebuildChecks,
  VALIDATE_PREBUILD_INCLUDE_ADVISORY_ENV,
  VALIDATE_PREBUILD_MAX_PARALLEL,
  VALIDATE_PREBUILD_SKIP_COMMANDS_ENV,
  VALIDATE_PREBUILD_SURFACE_ENV,
} from "../lib/validation-lanes.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const GENERATED_ARTIFACTS_CHECK_COMMAND = "npm run check:generated-artifacts";

export function buildValidatePrebuildExecutionUnits(surface) {
  return buildValidatePrebuildCommands({ surface }).map((cmd) => createExecutionUnit([cmd]));
}

export function buildValidatePrebuildExecutionUnitsForEnv(surface, env = process.env) {
  return buildValidatePrebuildCommands({
    surface,
    includeAdvisory: shouldIncludeAdvisoryPrebuildChecks(env[VALIDATE_PREBUILD_INCLUDE_ADVISORY_ENV]),
    skipCommands: parseValidatePrebuildSkipCommands(env[VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]),
  }).map((cmd) => createExecutionUnit([cmd]));
}

export function isValidatePrebuildDryRun(argv = process.argv.slice(2)) {
  return argv.includes("--dry-run");
}

export function splitGeneratedArtifactsCheckExecutionUnits(units) {
  const leadingUnits = [];
  const generatedArtifactUnits = [];

  for (const unit of units) {
    if (unit.commands.includes(GENERATED_ARTIFACTS_CHECK_COMMAND)) {
      generatedArtifactUnits.push(unit);
    } else {
      leadingUnits.push(unit);
    }
  }

  return { leadingUnits, generatedArtifactUnits };
}

export function printValidatePrebuildCommandPlan(units, { log = console.log } = {}) {
  log("[validate:prebuild] Command plan:");
  let index = 1;
  for (const unit of units) {
    for (const command of unit.commands) {
      log(`${index}. ${command}`);
      index += 1;
    }
  }
}

/**
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   log?: (message: string) => unknown,
 *   runExecutionUnits?: (units: any[], options?: Record<string, any>) => Promise<any>,
 * }} [options]
 */
export async function runValidatePrebuild({
  argv = process.argv.slice(2),
  env = process.env,
  log = console.log,
  runExecutionUnits = runParallelExecutionUnits,
} = {}) {
  const surface = normalizeValidatePrebuildSurface(env[VALIDATE_PREBUILD_SURFACE_ENV]);
  const includeAdvisory = shouldIncludeAdvisoryPrebuildChecks(env[VALIDATE_PREBUILD_INCLUDE_ADVISORY_ENV]);
  const skippedCommands = parseValidatePrebuildSkipCommands(env[VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]);
  const units = buildValidatePrebuildExecutionUnitsForEnv(surface, env);
  const dryRun = isValidatePrebuildDryRun(argv);

  if (dryRun) {
    log(
      `[validate:prebuild] Surface hint: ${surface}; advisory checks: ${
        includeAdvisory ? "included" : "skipped"
      }; dry-run plan has ${units.length} prebuild command(s).`,
    );
    if (skippedCommands.length > 0) {
      log(`[validate:prebuild] Skipped by caller: ${skippedCommands.join(", ")}`);
    }
    printValidatePrebuildCommandPlan(units, { log });
    log("[validate:prebuild] Dry run enabled; commands not executed.");
    return { status: 0, failedCmd: null, aborted: false };
  }

  log(
    `[validate:prebuild] Surface hint: ${surface}; advisory checks: ${
      includeAdvisory ? "included" : "skipped"
    }; running ${units.length} prebuild command(s).`,
  );
  if (skippedCommands.length > 0) {
    log(`[validate:prebuild] Skipped by caller: ${skippedCommands.join(", ")}`);
  }

  const { leadingUnits, generatedArtifactUnits } = splitGeneratedArtifactsCheckExecutionUnits(units);
  const leadingResult =
    leadingUnits.length > 0
      ? await runExecutionUnits(leadingUnits, {
          continueOnError: env.VALIDATE_PREBUILD_CONTINUE_ON_ERROR === "1",
          label: "validate:prebuild",
          maxParallel: VALIDATE_PREBUILD_MAX_PARALLEL,
        })
      : { status: 0, failedCmd: null, aborted: false };

  if (leadingResult.status !== 0 && env.VALIDATE_PREBUILD_CONTINUE_ON_ERROR !== "1") {
    return leadingResult;
  }

  if (generatedArtifactUnits.length === 0) {
    return leadingResult;
  }

  const generatedResult = await runExecutionUnits(generatedArtifactUnits, {
    continueOnError: env.VALIDATE_PREBUILD_CONTINUE_ON_ERROR === "1",
    getCommandEnv: () =>
      env.VALIDATE_PREBUILD_CONTINUE_ON_ERROR === "1" ? { GENERATED_ARTIFACTS_CONTINUE_ON_ERROR: "1" } : {},
    label: "validate:prebuild",
    maxParallel: 1,
  });

  const results = [...(leadingResult.results ?? []), ...(generatedResult.results ?? [])];
  const failures = [...(leadingResult.failures ?? []), ...(generatedResult.failures ?? [])];
  const firstFailure = leadingResult.status !== 0 ? leadingResult : generatedResult;
  return {
    status: firstFailure.status,
    failedCmd: firstFailure.failedCmd,
    aborted: firstFailure.aborted,
    ...(results.length > 0 ? { results } : {}),
    ...(failures.length > 0 ? { failures } : {}),
  };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  try {
    const result = await runValidatePrebuild();
    process.exitCode = result.status;
  } catch (error) {
    console.error(`[validate:prebuild] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
