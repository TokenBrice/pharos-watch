import { describe, it, expect, vi } from "vitest";

vi.mock("../alerts", () => ({
  sendAlert: vi.fn().mockResolvedValue(undefined),
}));

import { logCronRun } from "../cron-logger";
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

  it("writes and clears cron_run_progress when the job reports progress", async () => {
    const operations: string[] = [];
    const dbWithProgressCapture = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO cron_run_progress")) operations.push("progress-upsert");
            if (sql.includes("DELETE FROM cron_run_progress")) operations.push("progress-clear");
            if (sql.includes("INSERT INTO cron_runs")) operations.push("cron-run");
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

    await logCronRun(dbWithProgressCapture, "test-job", async (_signal, reportProgress) => {
      await reportProgress({
        stage: "scan",
        itemsDone: 1,
        itemsTotal: 3,
        message: "Scanning config 1/3",
      });
      return { itemCount: 1 };
    });

    expect(operations).toContain("progress-upsert");
    expect(operations).toContain("progress-clear");
    expect(operations).toContain("cron-run");
  });

  it("persists slot_started_at into cron_runs and cron_run_progress when provided", async () => {
    let runSlotStartedAt: number | null = null;
    let progressSlotStartedAt: number | null = null;
    const dbWithSlotCapture = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO cron_run_progress")) {
              progressSlotStartedAt = Number(args[2] ?? null);
            }
            if (sql.includes("INSERT INTO cron_runs")) {
              runSlotStartedAt = Number(args[6] ?? null);
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

    await logCronRun(
      dbWithSlotCapture,
      "test-job",
      async (_signal, reportProgress) => {
        await reportProgress({ stage: "started" });
        return { itemCount: 1 };
      },
      undefined,
      { slotStartedAt: 1_772_495_700 },
    );

    expect(runSlotStartedAt).toBe(1_772_495_700);
    expect(progressSlotStartedAt).toBe(1_772_495_700);
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
