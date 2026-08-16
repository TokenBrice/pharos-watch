import type { execFileSync } from "node:child_process";

export type TestEnv = Record<string, string | undefined>;

export type CommandPlanItem = {
  cmd: string;
  reasons: string[];
};

export type ExecutionUnit = {
  commands: CommandPlanItem[];
};

export type CommandRunResult = number | { status: number; aborted: boolean };
export type CommandRunnerOptions = { signal?: AbortSignal };
export type TestCommandRunner = (
  cmd: string,
  extraEnv?: TestEnv,
  options?: CommandRunnerOptions,
) => CommandRunResult | Promise<CommandRunResult>;

export type TestExecFileSync = (
  cmd: string,
  args: readonly string[],
  options?: {
    encoding?: BufferEncoding;
    stdio?: "ignore" | "inherit" | "pipe" | "overlapped";
  },
) => string | Buffer;

export function testEnv(values: TestEnv = {}): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

export function mockExecFileSync(impl: TestExecFileSync): typeof execFileSync {
  return impl as unknown as typeof execFileSync;
}

export function mockCommandRunner(impl: TestCommandRunner): typeof import("../lib/command-runner.mts").runShellCommand {
  return impl as unknown as typeof import("../lib/command-runner.mts").runShellCommand;
}

export function mockConsole(impl: Partial<Pick<Console, "error" | "log" | "warn">>): Console {
  return { ...console, ...impl };
}

export function mockFsImpl(impl: {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string) => string;
}): typeof import("node:fs") {
  return impl as unknown as typeof import("node:fs");
}

export function captureProcessExit(onExit: (status: number | undefined) => void): typeof process.exit {
  return ((status?: string | number | null) => {
    onExit(typeof status === "number" ? status : undefined);
    return undefined as never;
  }) as typeof process.exit;
}

export function commandTexts(plan: readonly CommandPlanItem[]): string[] {
  return plan.map((item) => item.cmd);
}

export function executionUnitCommandTexts(units: readonly ExecutionUnit[]): string[][] {
  return units.map((unit) => commandTexts(unit.commands));
}

export function executionBatchCommandTexts(batches: readonly (readonly ExecutionUnit[])[]): string[][][] {
  return batches.map((batch) => executionUnitCommandTexts(batch));
}
