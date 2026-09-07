import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createExecutionUnit,
  createLocalVitestCommand,
  createNpmScriptCommand,
  createSpawnCommand,
  runCommandBatches,
  runExecutionUnit,
  runParallelExecutionUnits,
  runShellCommand,
  runSpawnCommand,
} from "../lib/command-runner.mts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("command runner", () => {
  it.each(["batches", "parallel"])("settles aborted siblings after a rejecting runner in %s", async (coordinator) => {
    const error = new Error("runner rejected");
    let settled = false;
    const units = [createExecutionUnit(["throw"]), createExecutionUnit(["wait"])];
    const options = {
      reporter: {},
      runCommandImpl: async (cmd: string, _env?: Record<string, string>, { signal }: { signal?: AbortSignal } = {}) => {
        if (cmd === "throw") throw error;
        return new Promise<number>((resolve) => {
          signal?.addEventListener("abort", () => {
            setTimeout(() => { settled = true; resolve(130); }, 10);
          }, { once: true });
        });
      },
    };
    const result = coordinator === "batches"
      ? await runCommandBatches([units], options)
      : await runParallelExecutionUnits(units, options);
    expect(result).toMatchObject({ status: 1, failedCmd: "throw", error });
    expect(settled).toBe(true);
  });

  it.each(["batches", "parallel"])("kills a real sibling before returning a missing-executable failure in %s", async (coordinator) => {
    const root = mkdtempSync(join(tmpdir(), "command-cleanup-"));
    const output = join(root, "late-output");
    const missing = createSpawnCommand(join(root, "missing-executable"), []);
    const sibling = createSpawnCommand(process.execPath, ["-e",
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(output)}, 'late'), 100)`,
    ]);
    try {
      const units = [createExecutionUnit([missing]), createExecutionUnit([sibling])];
      const options = { reporter: {}, runCommandImpl: runSpawnCommand };
      const result = coordinator === "batches"
        ? await runCommandBatches([units], options)
        : await runParallelExecutionUnits(units, options);
      expect(result).toMatchObject({ status: 1, failedCmd: missing.cmd, error: { code: "ENOENT" } });
      await delay(180);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("continues after thrown failures when explicitly requested and removes the outer abort listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const calls: string[] = [];
    const result = await runParallelExecutionUnits([
      createExecutionUnit(["throw"]), createExecutionUnit(["next"]),
    ], {
      reporter: {}, continueOnError: true, maxParallel: 1, signal: controller.signal,
      runCommandImpl: (cmd: string) => { calls.push(cmd); if (cmd === "throw") throw new Error("failure"); return 0; },
    });
    expect(calls).toEqual(["throw", "next"]);
    expect(result.failures).toHaveLength(1);
    expect(result.results.map((entry) => entry.status)).toEqual([1, 0]);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each(["batches", "parallel"])("cleans up even when the failure reporter throws in %s", async (coordinator) => {
    let settled = false;
    const units = [createExecutionUnit(["fail"]), createExecutionUnit(["wait"])];
    const options = {
      reporter: { failure: () => { throw new Error("reporter failed"); } },
      runCommandImpl: (cmd: string, _env?: Record<string, string>, { signal }: { signal?: AbortSignal } = {}) => {
        if (cmd === "fail") return 1;
        return new Promise<number>((resolve) => {
          signal?.addEventListener("abort", () => { settled = true; resolve(130); }, { once: true });
        });
      },
    };
    await expect(coordinator === "batches"
      ? runCommandBatches([units], options)
      : runParallelExecutionUnits(units, options)).rejects.toThrow("reporter failed");
    expect(settled).toBe(true);
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
    const result = await runCommandBatches([[createExecutionUnit(["first", "second"])]], {
      label: "gate",
      runCommandImpl: (cmd) => {
        calls.push(cmd);
        return { status: cmd === "first" ? 7 : 0, aborted: false };
      },
    });

    expect(result).toEqual({ status: 7, failedCmd: "first", aborted: false });
    expect(calls).toEqual(["first"]);
    expect(errorSpy).toHaveBeenCalledWith("[gate] FAILED: first exited with status 7");
  });

  it("aborts pending sibling groups after the first parallel failure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const aborted: string[] = [];
    const result = await runCommandBatches(
      [[createExecutionUnit(["fail", "never"]), createExecutionUnit(["wait-a"]), createExecutionUnit(["wait-b"])]],
      {
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
    expect(calls).toEqual(["fail", "wait-a", "wait-b"]);
    expect(aborted).toEqual(["wait-a", "wait-b"]);
    expect(errorSpy).toHaveBeenCalledWith("[parallel] FAILED: fail exited with status 5");
  });

  it("returns every independent result without terminating after failures", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runParallelExecutionUnits(
      [
        createExecutionUnit(["first"], { id: "first" }),
        createExecutionUnit(["second"], { id: "second" }),
        createExecutionUnit(["third"], { id: "third" }),
      ],
      {
        continueOnError: true,
        label: "aggregate",
        runCommandImpl: (cmd) => ({ status: cmd === "second" ? 6 : 0, aborted: false }),
      },
    );

    expect(result.status).toBe(6);
    expect(result.failures).toHaveLength(1);
    expect(result.results.map((item) => item.unit.id)).toEqual(["first", "second", "third"]);
    expect(result.results.map((item) => item.status)).toEqual([0, 6, 0]);
  });

  it("does not classify aborted parallel siblings as root failures", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runParallelExecutionUnits(
      [createExecutionUnit(["fail"], { id: "fail" }), createExecutionUnit(["wait"], { id: "wait" })],
      {
        label: "abort-classification",
        runCommandImpl: (cmd, _env, { signal } = {}) => {
          if (cmd === "fail") return Promise.resolve({ status: 7, aborted: false });
          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve({ status: 130, aborted: true }));
          });
        },
      },
    );

    expect(result.failures.map((item) => item.unit.id)).toEqual(["fail"]);
    expect(result.results.find((item) => item.unit.id === "wait")).toMatchObject({ aborted: true, status: 130 });
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

  it("builds npm script commands without an argument separator when no args are present", () => {
    expect(createNpmScriptCommand("seo:check")).toMatchObject({
      executable: "npm",
      args: ["run", "seo:check"],
      cmd: "npm run seo:check",
      scriptName: "seo:check",
    });
    expect(createNpmScriptCommand("test:pr", ["--base=main"])).toMatchObject({
      args: ["run", "test:pr", "--", "--base=main"],
      cmd: "npm run test:pr -- --base=main",
    });
  });

  it("builds local Vitest commands with the shared CI argument policy", () => {
    const command = createLocalVitestCommand(["run", "example.test.ts"], {
      CI: "true",
    });
    expect(command.executable).toMatch(/node_modules[/\\]\.bin[/\\]vitest(?:\.cmd)?$/);
    expect(command.args).toEqual(["run", "example.test.ts", "--silent=passed-only"]);
  });

  it("runs structured commands directly and can capture their output", async () => {
    const command = { ...createSpawnCommand(process.execPath, ["-e", "process.stdout.write('ok')"]), captureOutput: true };
    await expect(runSpawnCommand(command)).resolves.toEqual({ status: 0, aborted: false, output: "ok" });
  });
});
