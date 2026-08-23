import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runScheduledSlotWithFence,
  sweepStaleScheduledSlotExecutions,
} from "../scheduled-slot-fence";
import {
  makeLeaseDb,
  setSlotUpdatedAt,
} from "./cron-leases.test-support";

describe("runScheduledSlotWithFence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves both the primary failure and a terminal slot-write failure", async () => {
    const db = makeLeaseDb({ failSlotFinishRuns: 1 });
    const primaryError = new Error("slot work failed");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const run = runScheduledSlotWithFence(
        db,
        "quarterHourly",
        async () => {
          throw primaryError;
        },
        {
          slotStartedAt: Math.floor(Date.now() / 1000),
          owner: "slot-owner",
          preSweepStale: false,
        },
      );

      await expect(run).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AggregateError &&
          error.errors[0] === primaryError &&
          error.errors[1] instanceof Error &&
          error.errors[1].message === "slot terminal write failed",
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("skips a slot that already finished", async () => {
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "quarterHourly",
          slot_started_at: 1_772_495_700,
          state: "finished",
          result_status: "ok",
          execution_owner: "owner-a",
          started_at: 1_772_495_700,
          finished_at: 1_772_495_760,
          updated_at: 1_772_495_760,
          metadata: null,
        },
      ],
    });
    const fn = vi.fn(async () => undefined);

    const result = await runScheduledSlotWithFence(db, "quarterHourly", fn, {
      slotStartedAt: 1_772_495_700,
      owner: "owner-b",
    });

    expect(result.status).toBe("skipped_duplicate");
    expect(fn).not.toHaveBeenCalled();
  });

  it("skips a slot that is still marked running", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "halfHourlyOffset",
          slot_started_at: now - 60,
          state: "running",
          result_status: null,
          execution_owner: "owner-a",
          started_at: now - 60,
          finished_at: null,
          updated_at: now - 10,
          metadata: null,
        },
      ],
    });

    const result = await runScheduledSlotWithFence(db, "halfHourlyOffset", async () => undefined, {
      slotStartedAt: now - 60,
      owner: "owner-b",
    });

    expect(result.status).toBe("skipped_running");
  });

  it("takes over a stale running row for the requested slot", async () => {
    const now = Math.floor(Date.now() / 1000);
    const slotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "halfHourlyOffset",
          slot_started_at: slotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "owner-a",
          started_at: slotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
    });
    const fn = vi.fn(async () => ({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 }));

    const result = await runScheduledSlotWithFence(db, "halfHourlyOffset", fn, {
      slotStartedAt,
      owner: "owner-b",
      staleAfterSec: 1200,
    });

    expect(result.status).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    const slot = db.getSlot("halfHourlyOffset", slotStartedAt);
    expect(slot?.execution_owner).toBe("owner-b");
    expect(slot?.result_status).toBe("ok");
    expect(slot?.metadata ? JSON.parse(slot.metadata) : null).toMatchObject({
      jobsErrored: 0,
      jobsDegraded: 0,
      jobsSkipped: 0,
      staleSlotTakeover: {
        previousOwner: "owner-a",
        previousStartedAt: slotStartedAt,
        previousUpdatedAt: now - 1800,
        reconciliation: {
          syntheticCronRuns: 1,
          notStartedCronRuns: 1,
          progressRowsCleared: 0,
          leasesCleared: 0,
        },
      },
    });
  });

  it("reconciles child evidence after winning same-slot stale takeover", async () => {
    const now = Math.floor(Date.now() / 1000);
    const slotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "hourlyYieldSync",
          slot_started_at: slotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "slot-owner-a",
          started_at: slotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
      leases: [
        {
          job: "sync-yield-data",
          lease_owner: "yield-owner-a",
          lease_until: now - 60,
          heartbeat_at: now - 1800,
          updated_at: now - 1800,
        },
      ],
      progress: [
        {
          job: "sync-yield-data",
          started_at: slotStartedAt + 20,
          updated_at: now - 1800,
          stage: "publication",
          lease_owner: "yield-owner-a",
          slot_started_at: slotStartedAt,
        },
      ],
    });
    const fn = vi.fn(async () => ({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 }));

    const result = await runScheduledSlotWithFence(db, "hourlyYieldSync", fn, {
      slotStartedAt,
      owner: "slot-owner-b",
      staleAfterSec: 1200,
    });

    expect(result.status).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(db.getRuns()).toEqual([
      expect.objectContaining({
        job: "sync-yield-data",
        status: "error",
        slot_started_at: slotStartedAt,
        error: "scheduled slot heartbeat stale; child job progress abandoned",
      }),
    ]);
    expect(db.getProgress("sync-yield-data")).toBeUndefined();
    expect(db.getLease("sync-yield-data")).toBeUndefined();
    const slot = db.getSlot("hourlyYieldSync", slotStartedAt);
    expect(slot?.execution_owner).toBe("slot-owner-b");
    expect(slot?.result_status).toBe("ok");
    expect(slot?.metadata ? JSON.parse(slot.metadata) : null).toMatchObject({
      jobsErrored: 0,
      jobsDegraded: 0,
      jobsSkipped: 0,
      staleSlotTakeover: {
        previousOwner: "slot-owner-a",
        previousStartedAt: slotStartedAt,
        previousUpdatedAt: now - 1800,
        reconciliation: {
          syntheticCronRuns: 1,
          progressRowsCleared: 1,
          leasesCleared: 1,
          abandonedJobs: [
            {
              job: "sync-yield-data",
              progressStage: "publication",
              leaseOwner: "yield-owner-a",
              leaseUntil: now - 60,
            },
          ],
        },
      },
    });
    expect(db.getCache("cron:event:hourlyyieldsync:scheduled-slot-abandoned")).toBeDefined();
  });

  it("does not reconcile stale child evidence when a same-slot takeover loses the heartbeat race", async () => {
    const now = Math.floor(Date.now() / 1000);
    const slotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "hourlyYieldSync",
          slot_started_at: slotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "slot-owner-a",
          started_at: slotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
      leases: [
        {
          job: "sync-yield-data",
          lease_owner: "yield-owner-a",
          lease_until: now - 60,
          heartbeat_at: now - 1800,
          updated_at: now - 1800,
        },
      ],
      progress: [
        {
          job: "sync-yield-data",
          started_at: slotStartedAt + 20,
          updated_at: now - 1800,
          stage: "publication",
          lease_owner: "yield-owner-a",
          slot_started_at: slotStartedAt,
        },
      ],
      beforeSlotTakeover: (sqlite) => {
        setSlotUpdatedAt(sqlite, "hourlyYieldSync", slotStartedAt, now);
      },
    });
    const fn = vi.fn(async () => ({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 }));

    const result = await runScheduledSlotWithFence(db, "hourlyYieldSync", fn, {
      slotStartedAt,
      owner: "slot-owner-b",
      staleAfterSec: 1200,
    });

    expect(result.status).toBe("skipped_running");
    expect(fn).not.toHaveBeenCalled();
    expect(db.getRuns()).toEqual([]);
    expect(db.getProgress("sync-yield-data")).toBeDefined();
    expect(db.getLease("sync-yield-data")).toBeDefined();
    expect(db.getCache("cron:event:hourlyyieldsync:scheduled-slot-abandoned")).toBeUndefined();
    const slot = db.getSlot("hourlyYieldSync", slotStartedAt);
    expect(slot?.execution_owner).toBe("slot-owner-a");
    expect(slot?.updated_at).toBe(now);
  });

  it("does not reconcile a stale sweep candidate that heartbeats before the reconciliation claim", async () => {
    const now = Math.floor(Date.now() / 1000);
    const slotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "hourlyYieldSync",
          slot_started_at: slotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "slot-owner-a",
          execution_generation: 1,
          started_at: slotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
      leases: [
        {
          job: "sync-yield-data",
          lease_owner: "yield-owner-a",
          lease_until: now - 60,
          heartbeat_at: now - 1800,
          updated_at: now - 1800,
        },
      ],
      progress: [
        {
          job: "sync-yield-data",
          started_at: slotStartedAt + 20,
          updated_at: now - 1800,
          stage: "publication",
          lease_owner: "yield-owner-a",
          slot_started_at: slotStartedAt,
        },
      ],
      beforeSlotReconciliationClaim: (sqlite) => {
        setSlotUpdatedAt(sqlite, "hourlyYieldSync", slotStartedAt, now);
      },
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 1200 });

    expect(summary).toMatchObject({ candidateSlots: 1, slotsReconciled: 0 });
    expect(db.getRuns()).toEqual([]);
    expect(db.getProgress("sync-yield-data")).toBeDefined();
    expect(db.getLease("sync-yield-data")).toBeDefined();
    expect(db.getSlot("hourlyYieldSync", slotStartedAt)).toMatchObject({
      state: "running",
      execution_owner: "slot-owner-a",
      execution_generation: 1,
      updated_at: now,
    });
  });

  it("uses a five-minute default scheduled-slot stale window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sixMinutesAgo = now - 10 * 60;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "fourHourlyReserveSync",
          slot_started_at: sixMinutesAgo,
          state: "running",
          result_status: null,
          execution_owner: "owner-a",
          started_at: sixMinutesAgo,
          finished_at: null,
          updated_at: sixMinutesAgo,
          metadata: null,
        },
      ],
    });
    const fn = vi.fn(async () => undefined);

    const result = await runScheduledSlotWithFence(db, "fourHourlyReserveSync", fn, {
      slotStartedAt: sixMinutesAgo,
      owner: "owner-b",
    });

    expect(result.status).not.toBe("skipped_running");
    expect(fn).toHaveBeenCalled();
  });

  it("keeps a freshly heartbeating slot exclusive under the default stale window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const slotStartedAt = now - 6 * 60;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "fourHourlyReserveSync",
          slot_started_at: slotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "owner-a",
          started_at: slotStartedAt,
          finished_at: null,
          updated_at: now - 60,
          metadata: null,
        },
      ],
    });
    const fn = vi.fn(async () => undefined);

    const result = await runScheduledSlotWithFence(db, "fourHourlyReserveSync", fn, {
      slotStartedAt,
      owner: "owner-b",
    });

    expect(result.status).toBe("skipped_running");
    expect(fn).not.toHaveBeenCalled();
  });

  it("expires a provably dead slot past the invocation wall clock even with a fresh heartbeat row", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 1_000;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "hourlyYieldSync",
          slot_started_at: staleSlotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "owner-a",
          started_at: staleSlotStartedAt,
          finished_at: null,
          updated_at: now - 30,
          metadata: null,
        },
      ],
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 300 });

    expect(summary).toMatchObject({ candidateSlots: 1, slotsReconciled: 1 });
    expect(db.getSlot("hourlyYieldSync", staleSlotStartedAt)).toMatchObject({
      state: "finished",
      result_status: "error",
    });
  });

  it("claims a new slot after sweeping stale previous slots for the same schedule key", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const currentSlotStartedAt = now;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "halfHourlyOffset",
          slot_started_at: staleSlotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "owner-a",
          started_at: staleSlotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
    });
    const fn = vi.fn(async () => undefined);

    const result = await runScheduledSlotWithFence(db, "halfHourlyOffset", fn, {
      slotStartedAt: currentSlotStartedAt,
      owner: "owner-b",
      staleAfterSec: 1200,
    });

    expect(result.status).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.metadata).toMatchObject({
      staleSlotPreSweep: {
        candidateSlots: 1,
        slotsReconciled: 1,
      },
    });

    const staleSlot = db.getSlot("halfHourlyOffset", staleSlotStartedAt);
    expect(staleSlot?.state).toBe("finished");
    expect(staleSlot?.result_status).toBe("error");
  });

  it("reconciles stale slot progress into a synthetic child cron run and clears expired ownership", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const currentSlotStartedAt = now;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "hourlyYieldSync",
          slot_started_at: staleSlotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "slot-owner-a",
          started_at: staleSlotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
      leases: [
        {
          job: "sync-yield-data",
          lease_owner: "yield-owner-a",
          lease_until: now - 60,
          heartbeat_at: now - 1800,
          updated_at: now - 1800,
        },
      ],
      progress: [
        {
          job: "sync-yield-data",
          started_at: staleSlotStartedAt + 20,
          updated_at: now - 1800,
          stage: "evaluation",
          lease_owner: "yield-owner-a",
          slot_started_at: staleSlotStartedAt,
        },
      ],
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: currentSlotStartedAt, staleAfterSec: 1200 });

    expect(summary.slotsReconciled).toBe(1);
    expect(db.getRuns()).toEqual([
      expect.objectContaining({
        job: "sync-yield-data",
        status: "error",
        slot_started_at: staleSlotStartedAt,
        error: "scheduled slot heartbeat stale; child job progress abandoned",
        duration_ms: 1_780_000,
      }),
    ]);
    expect(JSON.parse(db.getRuns()[0]?.metadata ?? "{}")).toMatchObject({
      failureCategory: "platform-abandoned",
      activeDurationMs: 1_780_000,
      reconciliationDelayMs: 1_800_000,
    });
    expect(db.getProgress("sync-yield-data")).toBeUndefined();
    expect(db.getLease("sync-yield-data")).toBeUndefined();
    const staleSlot = db.getSlot("hourlyYieldSync", staleSlotStartedAt);
    expect(staleSlot?.result_status).toBe("error");
    expect(staleSlot?.metadata ? JSON.parse(staleSlot.metadata) : null).toMatchObject({
      error: "scheduled slot heartbeat stale; marked expired by later invocation",
      staleSlotReconciliation: {
        syntheticCronRuns: 1,
        progressRowsCleared: 1,
        leasesCleared: 1,
        abandonedJobs: [
          {
            job: "sync-yield-data",
            progressStage: "evaluation",
            leaseOwner: "yield-owner-a",
            leaseUntil: now - 60,
          },
        ],
      },
    });
    const eventMarker = db.getCache("cron:event:hourlyyieldsync:scheduled-slot-abandoned");
    expect(eventMarker).toBeDefined();
    expect(eventMarker?.value ? JSON.parse(eventMarker.value) : null).toMatchObject({
      event: "cron_event",
      job: "hourlyYieldSync",
      eventType: "scheduled-slot-abandoned",
      severity: "error",
      metadata: {
        slotKey: "hourlyYieldSync",
        slotOwner: "slot-owner-a",
        staleSlotReconciliation: {
          abandonedJobs: [
            {
              job: "sync-yield-data",
              progressStage: "evaluation",
              leaseOwner: "yield-owner-a",
            },
          ],
        },
      },
    });
  });

  it("reclaims a stale reconciliation claim after the claiming process crashes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "hourlyYieldSync",
          slot_started_at: staleSlotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "slot-owner-a",
          execution_generation: 1,
          started_at: staleSlotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
      failSlotProgressReads: 1,
    });

    await expect(sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 1200 })).rejects.toThrow(
      "simulated reconciliation crash",
    );

    expect(db.getSlot("hourlyYieldSync", staleSlotStartedAt)).toMatchObject({
      state: "reconciling",
      execution_generation: 2,
      updated_at: now,
    });

    const tooEarly = await sweepStaleScheduledSlotExecutions(db, {
      nowSec: now + 600,
      staleAfterSec: 1200,
    });
    expect(tooEarly).toMatchObject({ candidateSlots: 0, slotsReconciled: 0 });

    const recovered = await sweepStaleScheduledSlotExecutions(db, {
      nowSec: now + 1201,
      staleAfterSec: 1200,
    });
    expect(recovered).toMatchObject({ candidateSlots: 1, slotsReconciled: 1 });
    expect(db.getSlot("hourlyYieldSync", staleSlotStartedAt)).toMatchObject({
      state: "finished",
      result_status: "error",
      execution_generation: 3,
      finished_at: now + 1201,
    });
  });

  it("synthesizes an error cron run for a stale slot whose job never wrote progress", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "hourlyYieldSync",
          slot_started_at: staleSlotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "slot-owner-a",
          started_at: staleSlotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 1200 });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      syntheticCronRuns: 1,
      notStartedCronRuns: 1,
      progressRowsCleared: 0,
      leasesCleared: 0,
    });
    expect(db.getRuns()).toEqual([
      expect.objectContaining({
        job: "sync-yield-data",
        status: "error",
        slot_started_at: staleSlotStartedAt,
      }),
    ]);
    const staleSlot = db.getSlot("hourlyYieldSync", staleSlotStartedAt);
    expect(staleSlot?.metadata ? JSON.parse(staleSlot.metadata) : null).toMatchObject({
      staleSlotReconciliation: {
        notStartedCronRuns: 1,
        abandonedJobs: [],
      },
    });
  });

  it("clears ownerless stale slot progress without synthesizing a cron run", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "hourlyYieldSync",
          slot_started_at: staleSlotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "slot-owner-a",
          started_at: staleSlotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
      progress: [
        {
          job: "sync-yield-data",
          started_at: staleSlotStartedAt + 5,
          updated_at: now - 1790,
          stage: "started",
          lease_owner: null,
          slot_started_at: staleSlotStartedAt,
        },
      ],
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 1200 });

    expect(summary).toMatchObject({
      slotsReconciled: 1,
      syntheticCronRuns: 0,
      notStartedCronRuns: 0,
      progressRowsCleared: 1,
      leasesCleared: 0,
    });
    expect(db.getProgress("sync-yield-data")).toBeUndefined();
    expect(db.getRuns()).toEqual([]);
    const staleSlot = db.getSlot("hourlyYieldSync", staleSlotStartedAt);
    expect(staleSlot?.metadata ? JSON.parse(staleSlot.metadata) : null).toMatchObject({
      staleSlotReconciliation: {
        progressRowsCleared: 1,
        abandonedJobs: [
          {
            job: "sync-yield-data",
            progressStage: "started",
            leaseOwner: null,
            leaseUntil: null,
          },
        ],
      },
    });
  });

  it("sweeps stale slot progress across schedule keys before the next same slot runs", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "hourlyYieldSync",
          slot_started_at: staleSlotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "slot-owner-a",
          started_at: staleSlotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
      leases: [
        {
          job: "sync-yield-data",
          lease_owner: "yield-owner-a",
          lease_until: now - 60,
          heartbeat_at: now - 1800,
          updated_at: now - 1800,
        },
      ],
      progress: [
        {
          job: "sync-yield-data",
          started_at: staleSlotStartedAt + 20,
          updated_at: now - 1800,
          stage: "publication",
          lease_owner: "yield-owner-a",
          slot_started_at: staleSlotStartedAt,
        },
      ],
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 1200 });

    expect(summary).toMatchObject({
      candidateSlots: 1,
      slotsReconciled: 1,
      syntheticCronRuns: 1,
      progressRowsCleared: 1,
      leasesCleared: 1,
    });
    expect(summary.abandonedSlots).toEqual([
      expect.objectContaining({
        slotKey: "hourlyYieldSync",
        slotStartedAt: staleSlotStartedAt,
        abandonedJobs: [
          expect.objectContaining({
            job: "sync-yield-data",
            progressStage: "publication",
            leaseOwner: "yield-owner-a",
          }),
        ],
      }),
    ]);
    expect(db.getRuns()).toEqual([
      expect.objectContaining({
        job: "sync-yield-data",
        status: "error",
        slot_started_at: staleSlotStartedAt,
      }),
    ]);
    expect(db.getProgress("sync-yield-data")).toBeUndefined();
    expect(db.getLease("sync-yield-data")).toBeUndefined();
    expect(db.getSlot("hourlyYieldSync", staleSlotStartedAt)?.result_status).toBe("error");
    expect(db.getCache("cron:event:hourlyyieldsync:scheduled-slot-abandoned")).toBeDefined();
  });

  // Regression guard: `finishStaleScheduledSlotExecution`'s survivor check is scoped to the
  // slot's own child jobs. `slot_started_at` is an aligned wall-clock timestamp shared across
  // schedules, so a foreign schedule's live progress row must neither be reconciled away nor
  // block the finish UPDATE (which would park the slot in 'reconciling' and abort the sweep).
  it("does not reconcile child progress from a different schedule with a colliding slot timestamp", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "quarterHourly",
          slot_started_at: staleSlotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "slot-owner-a",
          started_at: staleSlotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
      leases: [
        {
          job: "daily-digest",
          lease_owner: "digest-owner-a",
          lease_until: now - 60,
          heartbeat_at: now - 1800,
          updated_at: now - 1800,
        },
      ],
      progress: [
        {
          job: "daily-digest",
          started_at: staleSlotStartedAt + 20,
          updated_at: now - 1800,
          stage: "digest-trigger-poll",
          lease_owner: "digest-owner-a",
          slot_started_at: staleSlotStartedAt,
        },
      ],
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 1200 });

    expect(summary).toMatchObject({
      candidateSlots: 1,
      slotsReconciled: 1,
      syntheticCronRuns: 4,
      notStartedCronRuns: 4,
      progressRowsCleared: 0,
      leasesCleared: 0,
    });
    expect(summary.abandonedSlots).toEqual([
      expect.objectContaining({
        slotKey: "quarterHourly",
        slotStartedAt: staleSlotStartedAt,
        abandonedJobs: [],
      }),
    ]);
    expect(db.getRuns()).toHaveLength(4);
    expect(db.getRuns().every((run) => run.slot_started_at === staleSlotStartedAt)).toBe(true);
    expect(db.getProgress("daily-digest")).toBeDefined();
    expect(db.getLease("daily-digest")).toBeDefined();
    expect(db.getSlot("quarterHourly", staleSlotStartedAt)?.result_status).toBe("error");
  });

  it("refuses to finish a stale slot whose own child progress survived reconciliation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "hourlyYieldSync",
          slot_started_at: staleSlotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "slot-owner-a",
          started_at: staleSlotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
      // No cron_leases row for sync-yield-data: reconciliation cannot prove the child is dead,
      // so it leaves the progress row in place and the terminal UPDATE must refuse to fire.
      progress: [
        {
          job: "sync-yield-data",
          started_at: staleSlotStartedAt + 20,
          updated_at: now - 1800,
          stage: "publication",
          lease_owner: "yield-owner-a",
          slot_started_at: staleSlotStartedAt,
        },
      ],
    });

    await expect(sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 1200 })).rejects.toThrow(
      "scheduled slot ownership lost",
    );

    expect(db.getProgress("sync-yield-data")).toBeDefined();
    expect(db.getSlot("hourlyYieldSync", staleSlotStartedAt)).toMatchObject({ state: "reconciling" });
  });

  it("does not synthesize a stale child cron run while the matching child lease is still active", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "hourlyYieldSync",
          slot_started_at: staleSlotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "slot-owner-a",
          started_at: staleSlotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
      leases: [
        {
          job: "sync-yield-data",
          lease_owner: "yield-owner-a",
          lease_until: now + 300,
          heartbeat_at: now - 60,
          updated_at: now - 60,
        },
      ],
      progress: [
        {
          job: "sync-yield-data",
          started_at: staleSlotStartedAt + 20,
          updated_at: now - 60,
          stage: "evaluation",
          lease_owner: "yield-owner-a",
          slot_started_at: staleSlotStartedAt,
        },
      ],
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 1200 });

    expect(summary).toMatchObject({ candidateSlots: 1, slotsReconciled: 0 });
    expect(db.getRuns()).toEqual([]);
    expect(db.getProgress("sync-yield-data")).toBeDefined();
    expect(db.getLease("sync-yield-data")).toBeDefined();
    const staleSlot = db.getSlot("hourlyYieldSync", staleSlotStartedAt);
    expect(staleSlot).toMatchObject({ state: "running", execution_owner: "slot-owner-a" });
  });

  it("reconciles past a child lease whose heartbeat went silent even while the lease TTL is unexpired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleSlotStartedAt = now - 3600;
    const db = makeLeaseDb({
      slots: [
        {
          slot_key: "hourlyYieldSync",
          slot_started_at: staleSlotStartedAt,
          state: "running",
          result_status: null,
          execution_owner: "slot-owner-a",
          started_at: staleSlotStartedAt,
          finished_at: null,
          updated_at: now - 1800,
          metadata: null,
        },
      ],
      leases: [
        {
          job: "sync-yield-data",
          lease_owner: "yield-owner-a",
          lease_until: now + 300,
          heartbeat_at: now - 400,
          updated_at: now - 400,
        },
      ],
      progress: [
        {
          job: "sync-yield-data",
          started_at: staleSlotStartedAt + 20,
          updated_at: now - 400,
          stage: "evaluation",
          lease_owner: "yield-owner-a",
          slot_started_at: staleSlotStartedAt,
        },
      ],
    });

    const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec: now, staleAfterSec: 1200 });

    expect(summary).toMatchObject({ candidateSlots: 1, slotsReconciled: 1 });
    expect(db.getSlot("hourlyYieldSync", staleSlotStartedAt)).toMatchObject({
      state: "finished",
      result_status: "error",
    });
  });

  it("stores child job summaries and degraded slot status", async () => {
    const slotStartedAt = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb();

    const summary = {
      jobsRun: 1,
      jobsSkipped: 1,
      jobsDegraded: 1,
      jobsErrored: 0,
      budgetOnlyJobs: 0,
      jobs: [
        { job: "ok-job", outcome: "ok" },
        { job: "skipped-job", outcome: "skipped", reason: "lease-locked" },
        { job: "degraded-job", outcome: "degraded", status: "degraded" },
      ],
    };

    const result = await runScheduledSlotWithFence(db, "daily0800Utc", async () => summary, {
      slotStartedAt,
      owner: "owner-summary",
    });

    expect(result.status).toBe("ok");
    expect(result.resultStatus).toBe("degraded");
    expect(result.metadata).toEqual(summary);
    const slot = db.getSlot("daily0800Utc", slotStartedAt);
    expect(slot?.result_status).toBe("degraded");
    expect(slot?.metadata ? JSON.parse(slot.metadata) : null).toEqual(summary);
  });

  it("uses a three-minute default scheduled-slot heartbeat cadence", async () => {
    const slotStartedAt = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb();
    let finish: ((value: { jobsErrored: number; jobsDegraded: number; jobsSkipped: number }) => void) | undefined;
    const fn = vi.fn(
      () =>
        new Promise<{ jobsErrored: number; jobsDegraded: number; jobsSkipped: number }>((resolve) => {
          finish = resolve;
        }),
    );

    const runPromise = runScheduledSlotWithFence(db, "daily0800Utc", fn, {
      slotStartedAt,
      owner: "owner-default-heartbeat",
    });

    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    expect(db.getSlot("daily0800Utc", slotStartedAt)?.updated_at).toBe(slotStartedAt);

    await vi.advanceTimersByTimeAsync(179_000);
    expect(db.getSlot("daily0800Utc", slotStartedAt)?.updated_at).toBe(slotStartedAt);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(db.getSlot("daily0800Utc", slotStartedAt)?.updated_at).toBe(slotStartedAt + 180);

    finish?.({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 });
    await runPromise;
  });

  it("aborts the slot signal at the configured controlled deadline", async () => {
    const slotStartedAt = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb();
    let abortReason: unknown;
    const fn = vi.fn(
      (signal: AbortSignal) =>
        new Promise<{ jobsErrored: number; jobsDegraded: number; jobsSkipped: number }>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              abortReason = signal.reason;
              resolve({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 });
            },
            { once: true },
          );
        }),
    );

    const runPromise = runScheduledSlotWithFence(db, "daily0800Utc", fn, {
      slotStartedAt,
      owner: "owner-deadline",
      deadlineMs: Date.now() + 1_000,
    });

    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(runPromise).resolves.toMatchObject({ status: "ok" });
    expect(abortReason).toBeInstanceOf(Error);
    expect(String(abortReason)).toContain("exceeded controlled deadline");
  });

  it("finishes the slot at the controlled deadline when work ignores abort", async () => {
    const slotStartedAt = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb();
    const fn = vi.fn(
      () =>
        new Promise<{ jobsErrored: number; jobsDegraded: number; jobsSkipped: number }>(() => {}),
    );

    const runPromise = runScheduledSlotWithFence(db, "daily0800Utc", fn, {
      slotStartedAt,
      owner: "owner-deadline-race",
      deadlineMs: Date.now() + 1_000,
    });

    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    const expectation = expect(runPromise).rejects.toThrow("exceeded controlled deadline");
    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;

    const slot = db.getSlot("daily0800Utc", slotStartedAt);
    expect(slot).toMatchObject({
      state: "finished",
      result_status: "error",
      finished_at: slotStartedAt + 1,
    });
    expect(slot?.metadata ? JSON.parse(slot.metadata) : null).toMatchObject({
      error: `scheduled slot daily0800Utc@${slotStartedAt} exceeded controlled deadline`,
    });
  });

  it("records slot heartbeat failures in final slot metadata", async () => {
    const slotStartedAt = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb({ failSlotHeartbeatRuns: 1 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let finish: ((value: { jobsErrored: number; jobsDegraded: number; jobsSkipped: number }) => void) | undefined;
    const fn = vi.fn(
      () =>
        new Promise<{ jobsErrored: number; jobsDegraded: number; jobsSkipped: number }>((resolve) => {
          finish = resolve;
        }),
    );

    const runPromise = runScheduledSlotWithFence(db, "daily0800Utc", fn, {
      slotStartedAt,
      owner: "owner-heartbeat-failure",
      heartbeatSec: 15,
    });

    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[cron-slot] Failed to heartbeat slot daily0800Utc@${slotStartedAt}:`),
      ),
    );

    finish?.({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 });
    const result = await runPromise;

    expect(result.metadata).toMatchObject({
      jobsErrored: 0,
      jobsDegraded: 0,
      jobsSkipped: 0,
      slotHeartbeatFailures: 1,
    });
    const slot = db.getSlot("daily0800Utc", slotStartedAt);
    expect(slot?.metadata ? JSON.parse(slot.metadata) : null).toMatchObject({
      slotHeartbeatFailures: 1,
    });
    warnSpy.mockRestore();
  });

  it("aborts work and rejects a late finalizer after heartbeat ownership is lost", async () => {
    const slotStartedAt = Math.floor(Date.now() / 1000);
    const db = makeLeaseDb();
    let observedAbort: unknown;
    const fn = vi.fn(
      (signal: AbortSignal) =>
        new Promise<{ jobsErrored: number; jobsDegraded: number; jobsSkipped: number }>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = signal.reason;
              resolve({ jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 });
            },
            { once: true },
          );
        }),
    );

    const runPromise = runScheduledSlotWithFence(db, "daily0800Utc", fn, {
      slotStartedAt,
      owner: "owner-original",
      heartbeatSec: 15,
    });
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));

    expect(db.getSlot("daily0800Utc", slotStartedAt)).toBeDefined();
    db.sqlite
      .prepare(
        `UPDATE cron_slot_executions SET execution_owner = ?, execution_generation = ?
          WHERE slot_key = ? AND slot_started_at = ?`,
      )
      .run("owner-takeover", 2, "daily0800Utc", slotStartedAt);

    const expectation = expect(runPromise).rejects.toThrow("scheduled slot ownership lost");
    await vi.advanceTimersByTimeAsync(15_000);
    await expectation;
    expect(observedAbort).toBeInstanceOf(Error);
    expect(db.getSlot("daily0800Utc", slotStartedAt)).toMatchObject({
      state: "running",
      execution_owner: "owner-takeover",
      execution_generation: 2,
      result_status: null,
    });
  });
});
