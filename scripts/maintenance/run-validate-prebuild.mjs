#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { createExecutionUnit, runParallelExecutionUnits } from "../lib/command-runner.mjs";
import {
  buildValidatePrebuildCommands,
  normalizeValidatePrebuildSurface,
  resolveValidatePrebuildTier,
  VALIDATE_PREBUILD_MAX_PARALLEL,
  VALIDATE_PREBUILD_SURFACE_ENV,
  VALIDATE_PREBUILD_TIER_ENV,
} from "../lib/validate-contract.mjs";

export function buildValidatePrebuildExecutionUnits(surface, tier = "full") {
  return buildValidatePrebuildCommands({ surface, tier }).map((cmd) => createExecutionUnit([cmd]));
}

export function isValidatePrebuildDryRun(argv = process.argv.slice(2)) {
  return argv.includes("--dry-run");
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
  const units = buildValidatePrebuildExecutionUnits(surface, tierState.effectiveTier);
  const tierLabel = formatValidatePrebuildTier(tierState);
  const dryRun = isValidatePrebuildDryRun(argv);

  if (dryRun) {
    log(
      `[validate:prebuild] Surface hint: ${surface}; tier: ${tierLabel}; dry-run plan has ${units.length} prebuild command(s).`,
    );
    printValidatePrebuildCommandPlan(units, { log });
    log("[validate:prebuild] Dry run enabled; commands not executed.");
    return { status: 0, failedCmd: null, aborted: false };
  }

  log(`[validate:prebuild] Surface hint: ${surface}; tier: ${tierLabel}; running ${units.length} prebuild command(s).`);

  return runExecutionUnits(units, {
    continueOnError: env.VALIDATE_PREBUILD_CONTINUE_ON_ERROR === "1",
    label: "validate:prebuild",
    maxParallel: VALIDATE_PREBUILD_MAX_PARALLEL,
  });
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  await runValidatePrebuild();
}
