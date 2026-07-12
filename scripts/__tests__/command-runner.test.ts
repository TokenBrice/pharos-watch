import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionUnit,
  normalizeCommandResult,
  runCommandBatches,
  runExecutionUnit,
  runShellCommand,
} from "../lib/command-runner.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("command runner", () => {
  it("normalizes command results from legacy number and object return values", () => {
    expect(normalizeCommandResult(0)).toEqual({ status: 0, aborted: false });
    expect(normalizeCommandResult({ status: 7, aborted: true })).toEqual({ status: 7, aborted: true });
    expect(normalizeCommandResult(undefined)).toEqual({ status: 1, aborted: false });
  });

  it("runs commands in order with label logging and per-command env", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const calls: Array<{ cmd: string; env: Record<string, string> }> = [];

    const result = await runExecutionUnit(createExecutionUnit(["first", "coverage"]), {
      getCommandEnv: (cmd): Record<string, string> => (cmd === "coverage" ? { COVERAGE_ONLY: "1" } : {}),
      label: "unit",
      runCommandImpl: (cmd, extraEnv = {}) => {
        calls.push({ cmd, env: extraEnv });
        return 0;
      },
    });

    expect(result).toEqual({ status: 0, failedCmd: null, aborted: false });
    expect(calls).toEqual([
      { cmd: "first", env: {} },
      { cmd: "coverage", env: { COVERAGE_ONLY: "1" } },
    ]);
    expect(logSpy).toHaveBeenNthCalledWith(1, "[unit] Running: first");
    expect(logSpy).toHaveBeenNthCalledWith(2, expect.stringMatching(/^\[unit\] Finished: first \(\d+\.\ds\)$/));
    expect(logSpy).toHaveBeenNthCalledWith(3, "[unit] Running: coverage");
    expect(logSpy).toHaveBeenNthCalledWith(4, expect.stringMatching(/^\[unit\] Finished: coverage \(\d+\.\ds\)$/));
  });

  it("reports serial failures and returns the failed status", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    let exitStatus: number | undefined;

    const result = await runCommandBatches([[createExecutionUnit(["first", "second"])]], {
      exit: (status) => {
        exitStatus = status;
      },
      label: "gate",
      runCommandImpl: (cmd) => {
        calls.push(cmd);
        return { status: cmd === "first" ? 7 : 0, aborted: false };
      },
    });

    expect(result).toEqual({ status: 7, failedCmd: "first", aborted: false });
    expect(exitStatus).toBe(7);
    expect(calls).toEqual(["first"]);
    expect(errorSpy).toHaveBeenCalledWith("[gate] FAILED: first exited with status 7");
  });

  it("aborts pending sibling groups after the first parallel failure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const aborted: string[] = [];
    let exitStatus: number | undefined;

    const result = await runCommandBatches(
      [[createExecutionUnit(["fail", "never"]), createExecutionUnit(["wait-a"]), createExecutionUnit(["wait-b"])]],
      {
        exit: (status) => {
          exitStatus = status;
        },
        label: "parallel",
        runCommandImpl: (cmd, _extraEnv, { signal } = {}) => {
          calls.push(cmd);

          if (cmd === "fail") {
            return Promise.resolve({ status: 5, aborted: false });
          }

          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => {
              aborted.push(cmd);
              resolve({ status: 130, aborted: true });
            });
          });
        },
      },
    );

    expect(result).toEqual({ status: 5, failedCmd: "fail", aborted: false });
    expect(exitStatus).toBe(5);
    expect(calls).toEqual(["fail", "wait-a", "wait-b"]);
    expect(aborted).toEqual(["wait-a", "wait-b"]);
    expect(errorSpy).toHaveBeenCalledWith("[parallel] FAILED: fail exited with status 5");
  });

  it("returns an aborted result without spawning when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(runShellCommand("exit 0", {}, { signal: controller.signal })).resolves.toEqual({
      status: 130,
      aborted: true,
    });
  });

  it("merges extra environment into real shell commands", async () => {
    await expect(
      runShellCommand("node -e 'process.exit(process.env.COMMAND_RUNNER_TEST === \"yes\" ? 0 : 9)'", {
        COMMAND_RUNNER_TEST: "yes",
      }),
    ).resolves.toEqual({ status: 0, aborted: false });
  });

  it("returns real shell command failure statuses", async () => {
    await expect(runShellCommand("node -e 'process.exit(6)'")).resolves.toEqual({ status: 6, aborted: false });
  });
});
