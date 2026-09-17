import type { CommandResult } from "./command-runner.mts";
import { formatFailureTail, type GateLaneReport, type GateLaneStatus } from "./report-violations.mts";

export interface RunGateLanesOptions<TCommand> {
  command: (command: TCommand) => string;
  failureTail?: (result: CommandResult, command: TCommand) => string;
  id: (command: TCommand) => string;
  now?: () => number;
  onResult?: (result: CommandResult, command: TCommand) => void;
  run: (command: TCommand) => Promise<number | CommandResult> | number | CommandResult;
  status?: (result: CommandResult, command: TCommand) => GateLaneStatus;
}

function normalizeCommandResult(result: number | CommandResult): CommandResult {
  return typeof result === "number" ? { status: result, aborted: false } : result;
}

export async function runGateLanes<TCommand>(
  commands: readonly TCommand[],
  {
    failureTail = (result) => result.status === 0 || result.aborted ? "" : formatFailureTail(result.output),
    command: getCommand,
    onResult,
    run,
    id: getId,
    now = Date.now,
    status = (result) => result.aborted ? "skipped" : result.status === 0 ? "passed" : "failed",
  }: RunGateLanesOptions<TCommand>,
): Promise<GateLaneReport[]> {
  const lanes: GateLaneReport[] = commands.map((command) => ({
    id: getId(command),
    command: getCommand(command),
    status: "skipped",
    durationMs: 0,
    failureTail: "",
  }));

  for (const [index, command] of commands.entries()) {
    const startedAt = now();
    let result: CommandResult;
    try {
      result = normalizeCommandResult(await run(command));
    } catch (error) {
      result = {
        status: 1,
        aborted: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
    onResult?.(result, command);

    lanes[index] = {
      ...lanes[index],
      durationMs: Math.max(0, now() - startedAt),
      failureTail: failureTail(result, command),
      status: status(result, command),
    };
    if (result.status !== 0) break;
  }

  return lanes;
}
