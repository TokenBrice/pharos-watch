#!/usr/bin/env node

import { createExecutionUnit, runParallelExecutionUnits } from "./lib/command-runner.mjs";
import {
  VALIDATE_PREBUILD_COMMANDS,
  VALIDATE_PREBUILD_MAX_PARALLEL,
} from "./lib/validate-contract.mjs";

await runParallelExecutionUnits(
  VALIDATE_PREBUILD_COMMANDS.map((cmd) => createExecutionUnit([cmd])),
  {
    continueOnError: process.env.VALIDATE_PREBUILD_CONTINUE_ON_ERROR === "1",
    label: "validate:prebuild",
    maxParallel: VALIDATE_PREBUILD_MAX_PARALLEL,
  },
);
