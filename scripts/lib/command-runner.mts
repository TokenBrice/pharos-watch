import { spawn, type ChildProcess } from "node:child_process";
import { localBin } from "./local-bin.mts";
import { withCiVitestArgs } from "./vitest-ci-args.mts";

export interface SpawnCommand {
  args: readonly string[];
  captureOutput?: boolean;
  cmd: string;
  executable: string;
}

export interface NpmScriptCommand extends SpawnCommand {
  scriptName: string;
}

export interface VitestCommand extends SpawnCommand {
  executable: string;
}

export type RunnerCommand = string | { cmd: string };

export interface CommandResult {
  status: number;
  aborted: boolean;
  error?: Error;
  signal?: NodeJS.Signals;
  output?: string;
}

export interface ExecutionResult extends CommandResult {
  failedCmd: string | null;
}

export type CommandImplementation<TCommand extends RunnerCommand = string> = (
  command: TCommand,
  extraEnv?: Record<string, string>,
  options?: { signal?: AbortSignal },
) => number | CommandResult | Promise<number | CommandResult>;

interface ExecutionOptions<TCommand extends RunnerCommand> {
  getCommandEnv?: (command: TCommand) => Record<string, string>;
  getCommandText?: (command: TCommand) => string;
  label?: string;
  reporter?: CommandReporter;
  runCommandImpl?: CommandImplementation<TCommand>;
  signal?: AbortSignal;
}

interface ParallelExecutionOptions<TCommand extends RunnerCommand> extends ExecutionOptions<TCommand> {
  continueOnError?: boolean;
  maxParallel?: number;
}

export interface CommandReporter {
  failure?: (result: ExecutionResult) => void;
  start?: (cmd: string) => void;
  success?: (cmd: string, durationMs: number) => void;
}

type ExecutionUnit<TCommand extends RunnerCommand = RunnerCommand> = {
  commands: TCommand[];
};

type ExecutionUnitResult<TUnit extends ExecutionUnit> = ExecutionResult & {
  durationMs: number;
  index: number;
  unit: TUnit;
};

interface ParallelExecutionResult<TUnit extends ExecutionUnit> extends ExecutionResult {
  failures: Array<ExecutionUnitResult<TUnit>>;
  results: Array<ExecutionUnitResult<TUnit>>;
}

export function createExecutionUnit<
  TCommand extends RunnerCommand,
  TMetadata extends Record<string, unknown> = Record<string, never>,
>(commands: TCommand[], metadata = {} as TMetadata): TMetadata & ExecutionUnit<TCommand> {
  return { ...metadata, commands };
}

function getCommandText(command: RunnerCommand): string {
  if (typeof command === "string") {
    return command;
  }
  if (command && typeof command.cmd === "string") {
    return command.cmd;
  }

  throw new Error("Expected command string or object with a cmd string.");
}

function normalizeCommandResult(result: number | CommandResult): CommandResult {
  if (typeof result === "number") {
    return { status: result, aborted: false };
  }
  return {
    status: result?.status ?? 1,
    aborted: result?.aborted === true,
    ...(result?.error ? { error: result.error } : {}),
    ...(result?.signal ? { signal: result.signal } : {}),
    ...(result?.output != null ? { output: result.output } : {}),
  };
}


function formatCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].join(" ");
}

export function createSpawnCommand(executable: string, args: readonly string[]): SpawnCommand {
  return { executable, args: [...args], cmd: formatCommand(executable, args) };
}

export function createNpmScriptCommand(name: string, args: readonly string[] = []): NpmScriptCommand {
  const npmArgs = ["run", name, ...(args.length > 0 ? ["--", ...args] : [])];
  return { ...createSpawnCommand("npm", npmArgs), scriptName: name };
}

export function createLocalVitestCommand(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): VitestCommand {
  const vitestArgs = withCiVitestArgs(args, env);
  return createSpawnCommand(localBin("vitest"), vitestArgs);
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
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

function runChildProcess(
  executable: string,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
  { captureOutput = false, signal }: { captureOutput?: boolean; signal?: AbortSignal } = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    if (signal?.aborted) {
      resolve({ status: 130, aborted: true });
      return;
    }

    const child = spawn(executable, [...args], {
      detached: process.platform !== "win32",
      env: { ...process.env, ...extraEnv },
      stdio: captureOutput ? ["inherit", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      aborted = true;
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 2000);
      killTimer.unref?.();
    };
    signal?.addEventListener("abort", abort, { once: true });

    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status: aborted ? 130 : 1,
        aborted,
        error,
        ...(captureOutput ? { output } : {}),
      });
    });
    child.once("close", (code, closeSignal) => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status: aborted ? 130 : (code ?? 1),
        aborted,
        ...(closeSignal ? { signal: closeSignal } : {}),
        ...(captureOutput ? { output } : {}),
      });
    });
  });
}

export async function runShellCommand(
  cmd: string,
  extraEnv: Record<string, string> = {},
  { signal }: { signal?: AbortSignal } = {},
): Promise<CommandResult> {
  const { error: _error, ...result } = await runChildProcess("bash", ["-lc", cmd], extraEnv, { signal });
  return result;
}

export function runSpawnCommand(
  command: SpawnCommand,
  extraEnv: Record<string, string> = {},
  { signal }: { signal?: AbortSignal } = {},
): Promise<CommandResult> {
  return runChildProcess(command.executable, command.args, extraEnv, {
    captureOutput: command.captureOutput,
    signal,
  });
}

export async function runExecutionUnit<TCommand extends RunnerCommand>(
  unit: ExecutionUnit<TCommand>,
  {
    getCommandEnv = () => ({}),
    getCommandText: getUnitCommandText = getCommandText,
    label,
    reporter,
    runCommandImpl,
    signal,
  }: ExecutionOptions<TCommand> = {},
): Promise<ExecutionResult> {
  const run = runCommandImpl ?? (runShellCommand as CommandImplementation<TCommand>);
  for (const command of unit.commands) {
    const cmd = getUnitCommandText(command);
    if (signal?.aborted) {
      return { status: 130, failedCmd: cmd, aborted: true };
    }

    if (reporter) reporter.start?.(cmd);
    else console.log(`[${label}] Running: ${cmd}`);
    const startedAt = Date.now();
    const result = normalizeCommandResult(await run(command, getCommandEnv(command), { signal }));
    if (result.error) throw result.error;
    if (result.status !== 0) {
      return {
        status: result.status,
        failedCmd: cmd,
        aborted: result.aborted,
        ...(result.signal ? { signal: result.signal } : {}),
      };
    }
    const durationMs = Date.now() - startedAt;
    if (reporter) reporter.success?.(cmd, durationMs);
    else console.log(`[${label}] Finished: ${cmd} (${(durationMs / 1000).toFixed(1)}s)`);
  }

  return { status: 0, failedCmd: null, aborted: false };
}

function reportFailedCommand(result: ExecutionResult, label?: string, reporter?: CommandReporter): void {
  if (result.aborted) {
    return;
  }
  if (reporter) reporter.failure?.(result);
  else console.error(`[${label}] FAILED: ${result.failedCmd} exited with status ${result.status}`);
}

export async function runCommandBatches<TCommand extends RunnerCommand>(
  batches: Array<Array<ExecutionUnit<TCommand>>>,
  {
    getCommandEnv = () => ({}),
    getCommandText: getBatchCommandText = getCommandText,
    label,
    reporter,
    runCommandImpl,
  }: Omit<ExecutionOptions<TCommand>, "signal"> = {},
): Promise<ExecutionResult> {
  for (const batch of batches) {
    if (batch.length === 1) {
      const result = await runExecutionUnit(batch[0], {
        getCommandEnv,
        getCommandText: getBatchCommandText,
        label,
        reporter,
        runCommandImpl,
      });
      if (result.status !== 0) {
        reportFailedCommand(result, label, reporter);
        return result;
      }
      continue;
    }

    if (!reporter) console.log(`[${label}] Running ${batch.length} independent command groups in parallel.`);
    const controllers = batch.map(() => new AbortController());
    const pending = new Map(
      batch.map((unit, index) => [
        index,
        runExecutionUnit(unit, {
          getCommandEnv,
          getCommandText: getBatchCommandText,
          label,
          reporter,
          runCommandImpl,
          signal: controllers[index].signal,
        }).then((result) => ({ index, result })),
      ]),
    );

    while (pending.size > 0) {
      const settled = await Promise.race(pending.values());
      pending.delete(settled.index);

      if (settled.result.status !== 0) {
        reportFailedCommand(settled.result, label, reporter);
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

export async function runParallelExecutionUnits<
  TCommand extends RunnerCommand,
  TUnit extends ExecutionUnit<TCommand>,
>(
  units: TUnit[],
  {
    continueOnError = false,
    getCommandEnv = () => ({}),
    getCommandText: getUnitCommandText = getCommandText,
    label,
    maxParallel = units.length,
    reporter,
    runCommandImpl,
    signal,
  }: ParallelExecutionOptions<TCommand> = {},
): Promise<ParallelExecutionResult<TUnit>> {
  if (units.length === 0) {
    return { status: 0, failedCmd: null, aborted: false, failures: [], results: [] };
  }

  const concurrency = Math.max(1, Math.min(maxParallel, units.length));
  const controllers = new Set<AbortController>();
  const failures: Array<ExecutionUnitResult<TUnit>> = [];
  const results: Array<ExecutionUnitResult<TUnit> | undefined> = new Array(units.length);
  let nextIndex = 0;
  let aborting = false;
  const abortActive = () => {
    aborting = true;
    for (const activeController of controllers) activeController.abort();
  };
  signal?.addEventListener("abort", abortActive, { once: true });

  async function runNext(): Promise<void> {
    while (nextIndex < units.length && !signal?.aborted && (continueOnError || !aborting)) {
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
        reporter,
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
        reportFailedCommand(result, label, reporter);
        if (!continueOnError) {
          abortActive();
          break;
        }
      }
    }
  }

  if (!reporter) console.log(`[${label}] Running ${units.length} command groups with max parallel ${concurrency}.`);
  await Promise.all(Array.from({ length: concurrency }, () => runNext()));
  signal?.removeEventListener("abort", abortActive);

  if (failures.length > 0) {
    const first = failures[0];
    return {
      status: first.status,
      failedCmd: first.failedCmd,
      aborted: false,
      failures,
      results: results.filter((result): result is ExecutionUnitResult<TUnit> => result != null),
    };
  }

  const firstAborted = results.find((result) => result?.aborted);
  return {
    status: firstAborted?.status ?? 0,
    failedCmd: firstAborted?.failedCmd ?? null,
    aborted: firstAborted?.aborted ?? false,
    failures,
    results: results.filter((result): result is ExecutionUnitResult<TUnit> => result != null),
  };
}
