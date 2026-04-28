#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { createExecutionUnit, runCommandBatches, runShellCommand } from "./lib/command-runner.mjs";
import {
  COMMON_VALIDATE_POSTBUILD_COMMANDS,
  PAGES_VALIDATE_COMMANDS,
  WORKER_VALIDATE_COMMANDS,
} from "./lib/validate-contract.mjs";

function parseBooleanArg(argv, name, defaultValue) {
  const prefix = `${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  if (!match) {
    return defaultValue;
  }

  const value = match.slice(prefix.length).toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`Expected ${name}=true|false, received: ${match}`);
}

function parseStringArg(argv, name, defaultValue = "") {
  const prefix = `${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : defaultValue;
}

export function buildPostPrebuildExecutionUnits({ pagesChanged = true, workerChanged = true } = {}) {
  return [
    ...(pagesChanged ? [createExecutionUnit(PAGES_VALIDATE_COMMANDS)] : []),
    ...COMMON_VALIDATE_POSTBUILD_COMMANDS.map((cmd) => createExecutionUnit([cmd])),
    ...(workerChanged ? WORKER_VALIDATE_COMMANDS.map((cmd) => createExecutionUnit([cmd])) : []),
  ];
}

export function getPostPrebuildCommandEnv(cmd, { coverageCompareRef = "" } = {}) {
  if (cmd !== "npm run coverage:critical" || !coverageCompareRef) {
    return {};
  }

  return {
    CRITICAL_COVERAGE_COMPARE_REF: coverageCompareRef,
  };
}

export async function runPostPrebuildValidation(
  { coverageCompareRef = "", env = process.env, pagesChanged = true, workerChanged = true } = {},
  { exit = process.exit, runCommandImpl = runShellCommand } = {},
) {
  const units = buildPostPrebuildExecutionUnits({ pagesChanged, workerChanged });
  if (units.length === 0) {
    console.log("[validate:postbuild] No post-prebuild commands selected.");
    return;
  }

  if (env.VALIDATE_POSTBUILD_SERIAL === "1") {
    console.log("[validate:postbuild] Running post-prebuild commands serially.");
    await runCommandBatches(units.map((unit) => [unit]), {
      exit,
      getCommandEnv: (cmd) => getPostPrebuildCommandEnv(cmd, { coverageCompareRef }),
      label: "validate:postbuild",
      runCommandImpl,
    });
    return;
  }

  await runCommandBatches([units], {
    exit,
    getCommandEnv: (cmd) => getPostPrebuildCommandEnv(cmd, { coverageCompareRef }),
    label: "validate:postbuild",
    runCommandImpl,
  });
}

export function parsePostPrebuildArgs(argv) {
  return {
    coverageCompareRef: parseStringArg(argv, "--coverage-compare-ref", ""),
    pagesChanged: parseBooleanArg(argv, "--pages-changed", true),
    workerChanged: parseBooleanArg(argv, "--worker-changed", true),
  };
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runPostPrebuildValidation(parsePostPrebuildArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[validate:postbuild] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
