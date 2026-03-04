import { describe, it, expect, vi } from "vitest";

vi.mock("../alerts", () => ({
  sendAlert: vi.fn().mockResolvedValue(undefined),
}));

import { logCronRun } from "../db";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

describe("logCronRun", () => {
  const db = mockD1([
    { match: "cron_runs", rows: [] },
  ]);

  it("passes AbortSignal to the job function", async () => {
    let receivedSignal: AbortSignal | undefined;
    await logCronRun(db, "test-job", async (signal) => {
      receivedSignal = signal;
      return { itemCount: 0 };
    });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal!.aborted).toBe(false);
  });

  it("clears timeout on successful completion (signal not aborted)", async () => {
    let signalRef: AbortSignal | undefined;
    await logCronRun(db, "test-job", async (signal) => {
      signalRef = signal;
      return { itemCount: 42 };
    });
    expect(signalRef!.aborted).toBe(false);
  });

  it("provides AbortSignal for jobs with custom timeouts", async () => {
    // sync-dex-liquidity has a custom override; verify signal is still passed
    let signalRef: AbortSignal | undefined;
    await logCronRun(db, "sync-dex-liquidity", async (signal) => {
      signalRef = signal;
      return { itemCount: 0 };
    });
    expect(signalRef).toBeInstanceOf(AbortSignal);
    expect(signalRef!.aborted).toBe(false);
  });

  it("logs error status when job throws", async () => {
    await expect(
      logCronRun(db, "test-job", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });

  it("logs successful result when job completes", async () => {
    // Should not throw
    await logCronRun(db, "test-job", async () => {
      return { itemCount: 10, metadata: "test" };
    });
  });

  it("persists custom status such as skipped_locked", async () => {
    let insertedStatus: string | null = null;
    const dbWithCapture = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO cron_runs")) {
              insertedStatus = String(args[3] ?? null);
            }
            return { success: true, meta: { changes: 1 } };
          },
          all: async () => ({ results: [], success: true, meta: {} }),
          first: async () => null,
        }),
        run: async () => ({ success: true, meta: { changes: 1 } }),
        all: async () => ({ results: [], success: true, meta: {} }),
        first: async () => null,
      }),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    await logCronRun(dbWithCapture, "test-job", async () => ({
      status: "skipped_locked",
      metadata: "{\"reason\":\"lease-locked\"}",
    }));

    expect(insertedStatus).toBe("skipped_locked");
  });

  it("falls back to safety-valve prune when time-based prune fails", async () => {
    let safetyValvePruneCalled = false;
    const dbWithPruneFallback = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO cron_runs")) {
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("DELETE FROM cron_runs WHERE started_at < ?")) {
              throw new Error("time prune failed");
            }
            return { success: true, meta: { changes: 1 } };
          },
          all: async () => ({ results: [], success: true, meta: {} }),
          first: async () => null,
        }),
        run: async () => {
          if (sql.includes("DELETE FROM cron_runs WHERE rowid NOT IN")) {
            safetyValvePruneCalled = true;
          }
          return { success: true, meta: { changes: 1 } };
        },
        all: async () => ({ results: [], success: true, meta: {} }),
        first: async () => null,
      }),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    await expect(
      logCronRun(dbWithPruneFallback, "test-job", async () => ({ itemCount: 1 }))
    ).resolves.toMatchObject({ itemCount: 1 });

    expect(safetyValvePruneCalled).toBe(true);
  });

  it("logs both prune errors and still completes when safety-valve prune also fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbWithDoublePruneFailure = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO cron_runs")) {
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("DELETE FROM cron_runs WHERE started_at < ?")) {
              throw new Error("time prune failed");
            }
            return { success: true, meta: { changes: 1 } };
          },
          all: async () => ({ results: [], success: true, meta: {} }),
          first: async () => null,
        }),
        run: async () => {
          if (sql.includes("DELETE FROM cron_runs WHERE rowid NOT IN")) {
            throw new Error("safety prune failed");
          }
          return { success: true, meta: { changes: 1 } };
        },
        all: async () => ({ results: [], success: true, meta: {} }),
        first: async () => null,
      }),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    await expect(
      logCronRun(dbWithDoublePruneFailure, "test-job", async () => ({ itemCount: 1 }))
    ).resolves.toMatchObject({ itemCount: 1 });

    expect(errorSpy).toHaveBeenCalledWith(
      "[db] Failed to prune old cron runs:",
      expect.any(Error),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[db] Safety valve prune also failed:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("fails fast with timeout error when job exceeds timeout", async () => {
    vi.useFakeTimers();
    const hangingJob = logCronRun(db, "test-job", async () => new Promise(() => {}));
    const timeoutExpectation = expect(hangingJob).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
    await timeoutExpectation;
    vi.useRealTimers();
  });
});
