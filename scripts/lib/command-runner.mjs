import { spawn } from "node:child_process";

/** @typedef {string | { cmd: string }} RunnerCommand */
/** @typedef {{ status: number, aborted: boolean }} CommandResult */
/** @typedef {(cmd: string, extraEnv?: Record<string, string>, options?: { signal?: AbortSignal }) => number | CommandResult | Promise<number | CommandResult>} CommandImplementation */

/** @template T @param {T[]} commands @param {Record<string, unknown>} [metadata] */
export function createExecutionUnit(commands, metadata = {}) {
  return { ...metadata, commands };
}

function getCommandText(command) {
  if (typeof command === "string") {
    return command;
  }
  if (command && typeof command.cmd === "string") {
    return command.cmd;
  }

  throw new Error("Expected command string or object with a cmd string.");
}

function normalizeCommandResult(result) {
  if (typeof result === "number") {
    return { status: result, aborted: false };
  }
  return {
    status: result?.status ?? 1,
    aborted: result?.aborted === true,
  };
}

function killProcessGroup(child, signal) {
  if (!child.pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    // The process may already have exited between failure detection and abort.
  }
}

export function runShellCommand(cmd, extraEnv = {}, { signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ status: 130, aborted: true });
      return;
    }

    const child = spawn("bash", ["-lc", cmd], {
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: "inherit",
    });

    let aborted = false;
    let killTimer;
    const abort = () => {
      aborted = true;
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 2000);
      killTimer.unref?.();
    };
    signal?.addEventListener("abort", abort, { once: true });

    child.on("error", () => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve({ status: aborted ? 130 : 1, aborted });
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve({ status: aborted ? 130 : (code ?? 1), aborted });
    });
  });
}

/**
 * @param {{ commands: RunnerCommand[] }} unit
 * @param {{
 *   getCommandEnv?: (command: RunnerCommand) => Record<string, string>,
 *   getCommandText?: (command: RunnerCommand) => string,
 *   label?: string,
 *   runCommandImpl?: CommandImplementation,
 *   signal?: AbortSignal,
 * }} [options]
 */
export async function runExecutionUnit(
  unit,
  {
    getCommandEnv = () => ({}),
    getCommandText: getUnitCommandText = getCommandText,
    label,
    runCommandImpl = runShellCommand,
    signal,
  } = {},
) {
  for (const command of unit.commands) {
    const cmd = getUnitCommandText(command);
    if (signal?.aborted) {
      return { status: 130, failedCmd: cmd, aborted: true };
    }

    console.log(`[${label}] Running: ${cmd}`);
    const startedAt = Date.now();
    const result = normalizeCommandResult(await runCommandImpl(cmd, getCommandEnv(command), { signal }));
    if (result.status !== 0) {
      return { status: result.status, failedCmd: cmd, aborted: result.aborted };
    }
    console.log(`[${label}] Finished: ${cmd} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
  }

  return { status: 0, failedCmd: null, aborted: false };
}

function reportFailedCommand(result, label) {
  if (result.aborted) {
    return;
  }
  console.error(`[${label}] FAILED: ${result.failedCmd} exited with status ${result.status}`);
}

/**
 * @param {Array<Array<{ commands: RunnerCommand[] }>>} batches
 * @param {{
 *   getCommandEnv?: (command: RunnerCommand) => Record<string, string>,
 *   getCommandText?: (command: RunnerCommand) => string,
 *   label?: string,
 *   runCommandImpl?: CommandImplementation,
 * }} [options]
 */
export async function runCommandBatches(
  batches,
  {
    getCommandEnv = () => ({}),
    getCommandText: getBatchCommandText = getCommandText,
    label,
    runCommandImpl = runShellCommand,
  } = {},
) {
  for (const batch of batches) {
    if (batch.length === 1) {
      const result = await runExecutionUnit(batch[0], {
        getCommandEnv,
        getCommandText: getBatchCommandText,
        label,
        runCommandImpl,
      });
      if (result.status !== 0) {
        reportFailedCommand(result, label);
        return result;
      }
      continue;
    }

    console.log(`[${label}] Running ${batch.length} independent command groups in parallel.`);
    const controllers = batch.map(() => new AbortController());
    const pending = new Map(
      batch.map((unit, index) => [
        index,
        runExecutionUnit(unit, {
          getCommandEnv,
          getCommandText: getBatchCommandText,
          label,
          runCommandImpl,
          signal: controllers[index].signal,
        }).then((result) => ({ index, result })),
      ]),
    );

    while (pending.size > 0) {
      const settled = await Promise.race(pending.values());
      pending.delete(settled.index);

      if (settled.result.status !== 0) {
        reportFailedCommand(settled.result, label);
        for (const [index] of pending) {
          controllers[index].abort();
        }
        await Promise.allSettled(pending.values());
        return settled.result;
      }
    }
  }

  return { status: 0, failedCmd: null, aborted: false };
}

/**
 * @param {Array<{ commands: RunnerCommand[], [key: string]: unknown }>} units
 * @param {{
 *   continueOnError?: boolean,
 *   getCommandEnv?: (command: RunnerCommand) => Record<string, string>,
 *   getCommandText?: (command: RunnerCommand) => string,
 *   label?: string,
 *   maxParallel?: number,
 *   runCommandImpl?: CommandImplementation,
 * }} [options]
 */
export async function runParallelExecutionUnits(
  units,
  {
    continueOnError = false,
    getCommandEnv = () => ({}),
    getCommandText: getUnitCommandText = getCommandText,
    label,
    maxParallel = units.length,
    runCommandImpl = runShellCommand,
  } = {},
) {
  if (units.length === 0) {
    return { status: 0, failedCmd: null, aborted: false, failures: [], results: [] };
  }

  const concurrency = Math.max(1, Math.min(maxParallel, units.length));
  const controllers = new Set();
  const failures = [];
  const results = new Array(units.length);
  let nextIndex = 0;
  let aborting = false;

  async function runNext() {
    while (nextIndex < units.length && (continueOnError || !aborting)) {
      const index = nextIndex;
      const unit = units[index];
      nextIndex += 1;
      const controller = new AbortController();
      controllers.add(controller);
      const startedAt = Date.now();
      const result = await runExecutionUnit(unit, {
        getCommandEnv,
        getCommandText: getUnitCommandText,
        label,
        runCommandImpl,
        signal: controller.signal,
      });
      controllers.delete(controller);
      const unitResult = {
        ...result,
        durationMs: Date.now() - startedAt,
        index,
        unit,
      };
      results[index] = unitResult;

      if (result.status !== 0) {
        if (!result.aborted) {
          failures.push(unitResult);
        }
        reportFailedCommand(result, label);
        if (!continueOnError) {
          aborting = true;
          for (const activeController of controllers) {
            activeController.abort();
          }
          break;
        }
      }
    }
  }

  console.log(`[${label}] Running ${units.length} command groups with max parallel ${concurrency}.`);
  await Promise.all(Array.from({ length: concurrency }, () => runNext()));

  if (failures.length > 0) {
    const first = failures[0];
    return {
      status: first.status,
      failedCmd: first.failedCmd,
      aborted: false,
      failures,
      results: results.filter(Boolean),
    };
  }

  const firstAborted = results.find((result) => result?.aborted);
  return {
    status: firstAborted?.status ?? 0,
    failedCmd: firstAborted?.failedCmd ?? null,
    aborted: firstAborted?.aborted ?? false,
    failures,
    results: results.filter(Boolean),
  };
}
