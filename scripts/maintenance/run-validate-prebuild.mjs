#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { createExecutionUnit, runParallelExecutionUnits } from "../lib/command-runner.mjs";
import {
  buildValidatePrebuildCommandsForSurface,
  normalizeValidatePrebuildSurface,
  VALIDATE_PREBUILD_MAX_PARALLEL,
  VALIDATE_PREBUILD_SURFACE_ENV,
} from "../lib/validate-contract.mjs";

export function buildValidatePrebuildExecutionUnits(surface) {
  return buildValidatePrebuildCommandsForSurface(surface).map((cmd) => createExecutionUnit([cmd]));
}

export async function runValidatePrebuild({
  env = process.env,
  runExecutionUnits = runParallelExecutionUnits,
} = {}) {
  const surface = normalizeValidatePrebuildSurface(env[VALIDATE_PREBUILD_SURFACE_ENV]);
  const units = buildValidatePrebuildExecutionUnits(surface);

  console.log(`[validate:prebuild] Surface hint: ${surface}; running ${units.length} prebuild command(s).`);

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
