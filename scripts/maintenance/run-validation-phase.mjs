#!/usr/bin/env node

import { normalizeCommandResult, runShellCommand } from "../lib/command-runner.mjs";
import { PAGES_VALIDATE_COMMANDS, WORKER_VALIDATE_COMMANDS } from "../lib/validation-lanes.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const PHASE_COMMANDS = {
  pages: PAGES_VALIDATE_COMMANDS,
  worker: WORKER_VALIDATE_COMMANDS,
};

export function getValidationPhaseCommands(phase) {
  if (!Object.hasOwn(PHASE_COMMANDS, phase)) {
    throw new Error(`Unknown validation phase: ${phase ?? "missing"}. Expected pages or worker.`);
  }
  return PHASE_COMMANDS[phase];
}

export async function runValidationPhase(
  phase,
  { runCommand = runShellCommand, log = console.log, logError = console.error } = {},
) {
  const commands = getValidationPhaseCommands(phase);
  const label = `validate:${phase}`;
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
    const result = await runValidationPhase(process.argv[2]);
    process.exitCode = result.status;
  } catch (error) {
    console.error(`[validation-phase] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
