#!/usr/bin/env node

import { createExecutionUnit, runParallelExecutionUnits } from "../lib/command-runner.mjs";
import {
  buildValidatePrebuildCommands,
  normalizeValidatePrebuildSurface,
  parseValidatePrebuildSkipCommands,
  resolveValidatePrebuildTier,
  VALIDATE_PREBUILD_MAX_PARALLEL,
  VALIDATE_PREBUILD_SKIP_COMMANDS_ENV,
  VALIDATE_PREBUILD_SURFACE_ENV,
  VALIDATE_PREBUILD_TIER_ENV,
} from "../lib/validate-contract.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const GENERATED_ARTIFACTS_CHECK_COMMAND = "npm run check:generated-artifacts";

export function buildValidatePrebuildExecutionUnits(surface, tier = "full") {
  return buildValidatePrebuildCommands({ surface, tier }).map((cmd) => createExecutionUnit([cmd]));
}

export function buildValidatePrebuildExecutionUnitsForEnv(surface, tier = "full", env = process.env) {
  return buildValidatePrebuildCommands({
    surface,
    tier,
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

export function formatValidatePrebuildTier(tierState) {
  if (tierState.ciOverride) {
    return `${tierState.effectiveTier} (requested ${tierState.requestedTier} ignored because CI=true)`;
  }
  return tierState.effectiveTier;
}

function readEnvValue(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined;
}

export async function runValidatePrebuild({
  argv = process.argv.slice(2),
  env = process.env,
  log = console.log,
  runExecutionUnits = runParallelExecutionUnits,
} = {}) {
  const surface = normalizeValidatePrebuildSurface(env[VALIDATE_PREBUILD_SURFACE_ENV]);
  const tierState = resolveValidatePrebuildTier(env[VALIDATE_PREBUILD_TIER_ENV], {
    ci: readEnvValue(env, "CI") ?? "",
  });
  const skippedCommands = parseValidatePrebuildSkipCommands(env[VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]);
  const units = buildValidatePrebuildExecutionUnitsForEnv(surface, tierState.effectiveTier, env);
  const tierLabel = formatValidatePrebuildTier(tierState);
  const dryRun = isValidatePrebuildDryRun(argv);

  if (dryRun) {
    log(
      `[validate:prebuild] Surface hint: ${surface}; tier: ${tierLabel}; dry-run plan has ${units.length} prebuild command(s).`,
    );
    if (skippedCommands.length > 0) {
      log(`[validate:prebuild] Skipped by caller: ${skippedCommands.join(", ")}`);
    }
    printValidatePrebuildCommandPlan(units, { log });
    log("[validate:prebuild] Dry run enabled; commands not executed.");
    return { status: 0, failedCmd: null, aborted: false };
  }

  log(`[validate:prebuild] Surface hint: ${surface}; tier: ${tierLabel}; running ${units.length} prebuild command(s).`);
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
    label: "validate:prebuild",
    maxParallel: 1,
  });

  if (leadingResult.status !== 0) {
    return leadingResult;
  }

  return generatedResult;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  await runValidatePrebuild();
}
