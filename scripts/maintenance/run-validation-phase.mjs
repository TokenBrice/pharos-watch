#!/usr/bin/env node

import { normalizeCommandResult, runShellCommand } from "../lib/command-runner.mjs";
import { PAGES_VALIDATE_COMMANDS, WORKER_VALIDATE_COMMANDS } from "../lib/validation-lanes.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const PHASE_COMMANDS = {
  pages: PAGES_VALIDATE_COMMANDS,
  worker: WORKER_VALIDATE_COMMANDS,
};

const VALIDATION_PHASES = Object.keys(PHASE_COMMANDS);

function isHelpRequested(argv) {
  return argv.includes("--help") || argv.includes("-h");
}

function isDryRunRequested(argv) {
  return argv.includes("--dry-run");
}

export function getValidationPhaseCommands(phase) {
  if (!Object.hasOwn(PHASE_COMMANDS, phase)) {
    throw new Error(`Unknown validation phase: ${phase ?? "missing"}. Expected ${VALIDATION_PHASES.join(" or ")}.`);
  }
  return PHASE_COMMANDS[phase];
}

export function printValidationPhaseHelp({ log = console.log } = {}) {
  log("Usage: npm run validate:<phase> -- [--dry-run|--help]");
  log("");
  log(`Supported phases: ${VALIDATION_PHASES.join(", ")}`);
  log("  --dry-run  Print the command plan without executing it.");
  log("  --help     Print this help text.");
}

export function printValidationPhaseCommandPlan(phase, commands, { log = console.log } = {}) {
  log(`[validate:${phase}] Command plan:`);
  for (const [index, command] of commands.entries()) {
    log(`${index + 1}. ${command}`);
  }
}

/**
 * @typedef {object} ValidationPhaseOptions
 * @property {string[]} [argv]
 * @property {(command: string) => Promise<number | { status?: number, aborted?: boolean }> | number | { status?: number, aborted?: boolean }} [runCommand]
 * @property {(line: string) => void} [log]
 * @property {(line: string) => void} [logError]
 */

/**
 * @param {string | undefined} phase
 * @param {ValidationPhaseOptions} [options]
 */
export async function runValidationPhase(
  phase,
  { argv = [], runCommand = runShellCommand, log = console.log, logError = console.error } = {},
) {
  if (isHelpRequested(argv)) {
    printValidationPhaseHelp({ log });
    return { status: 0, failedCmd: null, aborted: false };
  }

  const commands = getValidationPhaseCommands(phase);
  const label = `validate:${phase}`;

  if (isDryRunRequested(argv)) {
    log(`[${label}] Dry run enabled; ${commands.length} command(s) will not execute.`);
    printValidationPhaseCommandPlan(phase, commands, { log });
    return { status: 0, failedCmd: null, aborted: false };
  }

  log(`[${label}] Running ${commands.length} command(s) sequentially.`);

  for (const [index, command] of commands.entries()) {
    log(`[${label}] ${index + 1}/${commands.length}: ${command}`);
    const result = normalizeCommandResult(await runCommand(command));
    if (result.status !== 0) {
      logError(`[${label}] FAILED: ${command} exited with status ${result.status}`);
      return { status: result.status, failedCmd: command, aborted: result.aborted };
    }
  }

  log(`[${label}] Completed ${commands.length} command(s).`);
  return { status: 0, failedCmd: null, aborted: false };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  try {
    const [phase, ...argv] = process.argv.slice(2);
    const result = await runValidationPhase(phase, { argv });
    process.exitCode = result.status;
  } catch (error) {
    console.error(`[validation-phase] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
