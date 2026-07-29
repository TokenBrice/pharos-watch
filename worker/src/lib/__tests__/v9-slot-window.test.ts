import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const leaseMocks = vi.hoisted(() => ({
  runCronWithLease: vi.fn(),
}));

vi.mock("../cron-lease", () => ({
  runCronWithLease: leaseMocks.runCronWithLease,
  runWithOverloadRetry: (
    run: () => Promise<unknown>,
  ) => run(),
}));

import {
  runV9AfterCoreWithinWindow,
  V9_MEMORY_LANE_LEASE_KEY,
  waitForV9MemoryLaneRelease,
} from "../v9-slot-window";

interface CoreSlotFixture {
  state: string;
  result_status: string | null;
  worker_version: string | null;
}

function dbWithCoreSlot(row: CoreSlotFixture | null) {
  const first = vi
    .fn()
    .mockResolvedValueOnce(row)
    .mockResolvedValue(null);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn((_sql?: string) => ({ bind }));
  return {
    db: { prepare } as unknown as D1Database,
    prepare,
    bind,
    first,
  };
}

function options(
  db: D1Database,
  scheduledTimeMs: number,
  overrides: Partial<{
    workerVersion: string | null;
    deadlineOffsetMs: number;
    minimumRemainingMs: number;
  }> = {},
) {
  return {
    db,
    scheduledTimeMs,
    slotStartedAt: Math.floor(scheduledTimeMs / 1_000),
    workerVersion: "worker-v2",
    deadlineOffsetMs: 30_000,
    minimumRemainingMs: 10_000,
    lane: "compute-safety-score-v9",
    currentSlotKey: "v9PublicationOffset",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runV9AfterCoreWithinWindow", () => {
  beforeEach(() => {
    leaseMocks.runCronWithLease.mockReset().mockImplementation(async (
      _db: D1Database,
      _job: string,
      run: (input: { signal: AbortSignal }) => Promise<unknown>,
    ) => ({
      status: "ok",
      result: await run({
        signal: new AbortController().signal,
      }),
    }));
  });

  it("runs after the matching quarter-hour core slot completed on the current Worker", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:14:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 2_000);
    const fixture = dbWithCoreSlot({
      state: "finished",
      result_status: "ok",
      worker_version: "worker-v2",
    });
    const run = vi.fn(async (signal: AbortSignal) => ({
      status: signal.aborted
        ? ("error" as const)
        : ("ok" as const),
      itemCount: 1,
    }));

    const result = await runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs),
      run,
    );

    expect(result.status).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(fixture.bind).toHaveBeenCalledWith(
      Math.floor(Date.parse("2026-07-26T12:00:00Z") / 1_000),
    );
    expect(leaseMocks.runCronWithLease).toHaveBeenCalledWith(
      fixture.db,
      V9_MEMORY_LANE_LEASE_KEY,
      expect.any(Function),
      expect.objectContaining({
        ttlSec: 60,
        heartbeatSec: 15,
      }),
    );
  });

  it("admits V9 after a degraded same-version core slot", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:23:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot({
      state: "finished",
      result_status: "degraded",
      worker_version: "worker-v2",
    });
    const run = vi.fn(async () => ({
      status: "ok" as const,
      itemCount: 335,
    }));

    const result = await runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs),
      run,
    );

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(335);
    expect(run).toHaveBeenCalledTimes(1);
    expect(fixture.bind).toHaveBeenCalledWith(
      Math.floor(Date.parse("2026-07-26T12:15:00Z") / 1_000),
    );
  });

  it("skips neutrally when the core slot is incomplete or from another Worker version", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:23:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot({
      state: "finished",
      result_status: "ok",
      worker_version: "worker-v1",
    });
    const run = vi.fn();

    const result = await runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs),
      run,
    );

    expect(result.status).toBe("skipped_neutral");
    expect(result.productivity?.reason).toBe("v9-core-slot-not-ready");
    expect(run).not.toHaveBeenCalled();
    expect(fixture.bind).toHaveBeenCalledWith(
      Math.floor(Date.parse("2026-07-26T12:15:00Z") / 1_000),
    );
  });

  it.each([
    "twoHourlyDexDiscovery",
    "halfHourlyChartsOffset",
    "halfHourlyMintBurnExtended",
  ])("does not query the unrelated %s lane as a V9 blocker", async (unrelatedSlotKey) => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:14:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot({
      state: "finished",
      result_status: "ok",
      worker_version: "worker-v2",
    });
    const run = vi.fn(async () => ({
      status: "ok" as const,
      itemCount: 1,
    }));

    const result = await runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs),
      run,
    );

    expect(result.status).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    expect(fixture.prepare.mock.calls[1]?.[0]).toContain(
      "WHERE slot_key = ?",
    );
    expect(fixture.bind).toHaveBeenLastCalledWith(
      "v9PublicationOffset",
      Math.floor(scheduledTimeMs / 1_000),
      Math.floor(Date.parse("2026-07-26T12:00:00Z") / 1_000) -
        35 * 60,
    );
    expect(fixture.bind).not.toHaveBeenCalledWith(
      unrelatedSlotKey,
      expect.anything(),
      expect.anything(),
    );
  });

  it("blocks a prior active invocation of the same V9 schedule lane", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:14:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot({
      state: "finished",
      result_status: "ok",
      worker_version: "worker-v2",
    });
    fixture.first
      .mockReset()
      .mockResolvedValueOnce({
        state: "finished",
        result_status: "ok",
        worker_version: "worker-v2",
      })
      .mockResolvedValueOnce({
        slot_key: "v9PublicationOffset",
        slot_started_at: Math.floor(
          Date.parse("2026-07-26T11:59:00Z") / 1_000,
        ),
        state: "running",
        updated_at: Math.floor(
          Date.parse("2026-07-26T12:13:30Z") / 1_000,
        ),
      });
    const run = vi.fn();

    const result = await runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs),
      run,
    );

    expect(result.status).toBe("skipped_neutral");
    expect(result.productivity?.reason).toBe(
      "v9-competing-slot-active",
    );
    expect(fixture.bind).toHaveBeenLastCalledWith(
      "v9PublicationOffset",
      Math.floor(scheduledTimeMs / 1_000),
      Math.floor(Date.parse("2026-07-26T12:00:00Z") / 1_000) -
        35 * 60,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("skips neutrally when another V9 invocation already owns the memory lane", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:14:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot({
      state: "finished",
      result_status: "ok",
      worker_version: "worker-v2",
    });
    leaseMocks.runCronWithLease.mockResolvedValueOnce({
      status: "skipped_locked",
    });
    const run = vi.fn();

    const result = await runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs),
      run,
    );

    expect(result.status).toBe("skipped_neutral");
    expect(result.productivity?.reason).toBe(
      "v9-memory-lane-active",
    );
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("skips delayed delivery before reading D1 when the pre-quarter window is too short", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:14:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 25_000);
    const fixture = dbWithCoreSlot({
      state: "finished",
      result_status: "ok",
      worker_version: "worker-v2",
    });
    const run = vi.fn();

    const result = await runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs),
      run,
    );

    expect(result.status).toBe("skipped_neutral");
    expect(result.productivity?.reason).toBe(
      "v9-slot-window-too-short",
    );
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed before reading D1 when current Worker version metadata is unavailable", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:14:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot({
      state: "finished",
      result_status: "ok",
      worker_version: "worker-v2",
    });
    const run = vi.fn();

    const result = await runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs, {
        workerVersion: null,
      }),
      run,
    );

    expect(result.status).toBe("degraded");
    expect(result.productivity?.reason).toBe(
      "v9-worker-version-unavailable",
    );
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("waitForV9MemoryLaneRelease", () => {
  it("waits without loading scheduled work until the V9 lane is released", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-07-26T12:09:00Z"));
    const first = vi
      .fn()
      .mockResolvedValueOnce({
        lease_until: Math.floor(
          Date.parse("2026-07-26T12:10:00Z") / 1_000,
        ),
      })
      .mockResolvedValueOnce(null);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const pending = waitForV9MemoryLaneRelease({
      prepare,
    } as unknown as D1Database);

    await vi.advanceTimersByTimeAsync(999);
    expect(first).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(first).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenCalledWith(
      V9_MEMORY_LANE_LEASE_KEY,
      Math.floor(Date.parse("2026-07-26T12:09:00Z") / 1_000),
    );
  });
});
