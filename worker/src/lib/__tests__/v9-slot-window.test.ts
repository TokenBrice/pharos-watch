import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { V9_PUBLIC_MATERIALIZATION_CACHE_KEY, V9_PUBLIC_REPRESENTATION_VERSION } from "@shared/types/report-cards-v9-materialization";

const leaseMocks = vi.hoisted(() => ({
  runCronWithLease: vi.fn(),
}));

vi.mock("../cron-lease-primitives", () => ({
  runCronWithLease: leaseMocks.runCronWithLease,
}));

vi.mock("../d1-overload-retry", () => ({
  runWithOverloadRetry: (
    run: () => Promise<unknown>,
  ) => run(),
}));

import {
  runV9AfterCoreWithinWindow,
  V9_MEMORY_LANE_LEASE_KEY,
  V9_EXECUTION_WINDOW_POLICY,
  V9_PUBLICATION_HEALTH_CACHE_KEY,
  getV9ExecutionDeadlineMs,
  waitForV9MemoryLaneRelease,
  loadV9PublicationHourAcceptedAtSec,
  type V9ExecutionWindow,
} from "../v9-slot-window";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../safety-score-v9/publication-health";

interface CoreSlotFixture {
  state: string;
  result_status: string | null;
  worker_version: string | null;
}

function dbWithCoreSlot(
  row: CoreSlotFixture | null,
  stablecoinsPublication: { published_at: number } | null = null,
) {
  const first = vi.fn().mockResolvedValueOnce(row);
  first.mockResolvedValueOnce(stablecoinsPublication);
  first.mockResolvedValue(null);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn((_sql?: string) => ({ bind }));
  return {
    db: makeNoopD1({ prepare }),
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
      leaseOptions?: { abortSignal?: AbortSignal },
    ) => ({
      status: "ok",
      result: await run({
        signal:
          leaseOptions?.abortSignal ??
          new AbortController().signal,
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
    const run = vi.fn(async (signal: AbortSignal, _window: V9ExecutionWindow) => ({
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
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      slotStartedAtSec: scheduledTimeMs / 1_000,
      deadlineMs: scheduledTimeMs + 30_000,
      minimumRemainingMs: 10_000,
    });
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

  describe("publication priority over supply attribution", () => {
    const attributionOptions = (db: D1Database, scheduledTimeMs: number) => ({
      ...options(db, scheduledTimeMs, V9_EXECUTION_WINDOW_POLICY.supplyAttribution),
      lane: "sync-v9-supply-attribution",
      currentSlotKey: "v9SupplyAttributionOffset",
      yieldToV9Publication: true,
    });
    const okCore = { state: "finished", result_status: "ok", worker_version: "worker-v2" };

    function dbWithPublicationSlot(publication: { state: string } | null) {
      const first = vi.fn()
        .mockResolvedValueOnce(publication)
        .mockResolvedValueOnce(okCore)
        .mockResolvedValue(null);
      const bind = vi.fn(() => ({ first }));
      return { db: makeNoopD1({ prepare: vi.fn(() => ({ bind })) }), bind };
    }

    it.each([null, { state: "running" }])("yields to a late :22 publication that has not finished (%o)", async (publication) => {
      // 2026-10-23 09:53 incident (then a :52 publication): a late publication
      // trigger can arrive after attribution's next start claimed the shared
      // memory lane. Publication is now hourly at :22, shared with :23.
      const scheduledTimeMs = Date.parse("2026-10-23T09:23:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(scheduledTimeMs + 1_000);
      const fixture = dbWithPublicationSlot(publication);
      const run = vi.fn(async () => ({ status: "ok" as const, itemCount: 1 }));

      const result = await runV9AfterCoreWithinWindow(attributionOptions(fixture.db, scheduledTimeMs), run);

      expect(result).toMatchObject({ status: "skipped_neutral", productivity: { reason: "v9-publication-priority" } });
      expect(JSON.parse(result.metadata!)).toMatchObject({
        publicationSlotStartedAt: Date.parse("2026-10-23T09:22:00Z") / 1_000,
        publicationSlotState: publication?.state ?? null,
        publicationDeadlineMs: Date.parse("2026-10-23T09:25:00Z"),
      });
      expect(fixture.bind).toHaveBeenCalledWith(Date.parse("2026-10-23T09:22:00Z") / 1_000);
      expect(leaseMocks.runCronWithLease).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it("lets the late publisher claim the lane at the same instant", async () => {
      const publicationScheduledMs = Date.parse("2026-10-23T09:22:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse("2026-10-23T09:23:01Z"));
      const attribution = dbWithPublicationSlot(null);
      const publisher = dbWithCoreSlot(okCore);
      // Exclusive lane: whichever caller claims first holds it until it returns.
      let held = false;
      leaseMocks.runCronWithLease.mockImplementation(async (
        _db: D1Database, _job: string, run: (input: { signal: AbortSignal }) => Promise<unknown>,
      ) => {
        if (held) return { status: "skipped_locked" };
        held = true;
        try {
          return { status: "ok", result: await run({ signal: new AbortController().signal }) };
        } finally {
          held = false;
        }
      });
      const attributionRun = vi.fn(async () => ({ status: "ok" as const, itemCount: 1 }));
      const publisherRun = vi.fn(async () => ({ status: "ok" as const, itemCount: 1 }));

      const [attributionResult, publisherResult] = await Promise.all([
        runV9AfterCoreWithinWindow(attributionOptions(attribution.db, Date.parse("2026-10-23T09:23:00Z")), attributionRun),
        runV9AfterCoreWithinWindow(
          options(publisher.db, publicationScheduledMs, V9_EXECUTION_WINDOW_POLICY.publication),
          publisherRun,
        ),
      ]);

      expect(attributionResult.productivity?.reason).toBe("v9-publication-priority");
      expect(publisherResult.status).toBe("ok");
      expect(publisherRun).toHaveBeenCalledOnce();
      expect(attributionRun).not.toHaveBeenCalled();
    });

    it("runs once this window's publication slot has finished", async () => {
      const scheduledTimeMs = Date.parse("2026-10-23T09:23:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(scheduledTimeMs + 1_000);
      const fixture = dbWithPublicationSlot({ state: "finished" });
      const run = vi.fn(async () => ({ status: "ok" as const, itemCount: 1 }));

      const result = await runV9AfterCoreWithinWindow(attributionOptions(fixture.db, scheduledTimeMs), run);

      expect(result.status).toBe("ok");
      expect(run).toHaveBeenCalledOnce();
    });

    it("runs after the publication window closed or when no publication shares the core window", async () => {
      for (const [scheduled, now] of [
        ["2026-10-23T09:23:00Z", "2026-10-23T09:25:00Z"],
        ["2026-10-23T09:38:00Z", "2026-10-23T09:38:01Z"],
        ["2026-10-23T09:53:00Z", "2026-10-23T09:55:00Z"],
      ] as const) {
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse(now));
        const fixture = dbWithCoreSlot(okCore);
        const run = vi.fn(async () => ({ status: "ok" as const, itemCount: 1 }));

        const result = await runV9AfterCoreWithinWindow(attributionOptions(fixture.db, Date.parse(scheduled)), run);

        expect(result.status).toBe("ok");
        expect(fixture.bind).not.toHaveBeenCalledWith(Date.parse("2026-10-23T09:52:00Z") / 1_000);
        expect(fixture.bind).not.toHaveBeenCalledWith(Date.parse("2026-10-23T09:22:00Z") / 1_000);
      }
    });

    it("yields at :53 to the :52 second chance only while its hour has no accepted publication", async () => {
      const scheduledTimeMs = Date.parse("2026-10-23T09:53:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(scheduledTimeMs + 1_000);
      const lastHour = { accepted_at: Date.parse("2026-10-23T08:46:00Z") / 1_000 };
      const first = vi.fn().mockResolvedValueOnce(lastHour).mockResolvedValueOnce(null).mockResolvedValue(null);
      const bind = vi.fn(() => ({ first }));
      const db = makeNoopD1({ prepare: vi.fn(() => ({ bind })) });
      const run = vi.fn(async () => ({ status: "ok" as const, itemCount: 1 }));

      const result = await runV9AfterCoreWithinWindow(attributionOptions(db, scheduledTimeMs), run);

      expect(result).toMatchObject({ status: "skipped_neutral", productivity: { reason: "v9-publication-priority" } });
      expect(JSON.parse(result.metadata!)).toMatchObject({
        publicationSlotStartedAt: Date.parse("2026-10-23T09:52:00Z") / 1_000,
        publicationDeadlineMs: Date.parse("2026-10-23T09:55:00Z"),
      });
      expect(run).not.toHaveBeenCalled();

      // Once :22 was accepted the :52 run will skip, so attribution keeps its slot.
      const accepted = vi.fn()
        .mockResolvedValueOnce({ accepted_at: Date.parse("2026-10-23T09:16:30Z") / 1_000 })
        .mockResolvedValueOnce(okCore)
        .mockResolvedValue(null);
      const acceptedBind = vi.fn(() => ({ first: accepted }));
      const acceptedResult = await runV9AfterCoreWithinWindow(
        attributionOptions(makeNoopD1({ prepare: vi.fn(() => ({ bind: acceptedBind })) }), scheduledTimeMs), run,
      );
      expect(acceptedResult.status).toBe("ok");
      expect(acceptedBind).not.toHaveBeenCalledWith(Date.parse("2026-10-23T09:52:00Z") / 1_000);
    });

    it("fails closed without suppressing publication when the slot ledger is unreadable", async () => {
      const scheduledTimeMs = Date.parse("2026-10-23T09:23:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(scheduledTimeMs + 1_000);
      const first = vi.fn().mockRejectedValueOnce(new Error("D1 unavailable"));
      const db = makeNoopD1({ prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) });

      const result = await runV9AfterCoreWithinWindow(attributionOptions(db, scheduledTimeMs), vi.fn());

      expect(result).toMatchObject({ status: "degraded", productivity: { reason: "v9-publication-priority-unknown" } });
      expect(leaseMocks.runCronWithLease).not.toHaveBeenCalled();
    });
  });

  describe(":52 second chance", () => {
    const secondChanceMs = Date.parse("2026-10-23T16:52:00Z");
    const secondChanceOptions = (db: D1Database) => ({
      ...options(db, secondChanceMs, V9_EXECUTION_WINDOW_POLICY.publication),
      v9PublicationSecondChance: true,
    });
    const okCore = { state: "finished", result_status: "ok", worker_version: "worker-v2" };

    function dbWithHealth(health: { accepted_at: number | null } | null | Error) {
      const first = vi.fn();
      if (health instanceof Error) first.mockRejectedValueOnce(health);
      else first.mockResolvedValueOnce(health);
      first.mockResolvedValueOnce(okCore).mockResolvedValue(null);
      const bind = vi.fn(() => ({ first }));
      return { db: makeNoopD1({ prepare: vi.fn(() => ({ bind })) }), bind };
    }

    it("reads the publication-health cache identity", () => {
      expect(V9_PUBLICATION_HEALTH_CACHE_KEY).toBe(SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth);
    });

    it("skips neutrally once the hour's :22 publication was accepted", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(secondChanceMs + 1_000);
      const acceptedAtSec = Date.parse("2026-10-23T16:16:40Z") / 1_000;
      const fixture = dbWithHealth({ accepted_at: acceptedAtSec });
      const run = vi.fn(async () => ({ status: "ok" as const, itemCount: 1 }));

      const result = await runV9AfterCoreWithinWindow(secondChanceOptions(fixture.db), run);

      expect(result).toMatchObject({
        status: "skipped_neutral",
        productivity: { productive: false, reason: "v9-publication-hourly-already-accepted" },
      });
      expect(JSON.parse(result.metadata!)).toMatchObject({ acceptedAtSec });
      expect(fixture.bind).toHaveBeenCalledWith(V9_PUBLIC_REPRESENTATION_VERSION, SAFETY_SCORE_V9_CACHE_KEYS.publication,
        V9_PUBLIC_MATERIALIZATION_CACHE_KEY, V9_PUBLICATION_HEALTH_CACHE_KEY);
      expect(leaseMocks.runCronWithLease).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it.each([
      // 2026-10-23: Cloudflare never delivered 16:22; the last acceptance was 14:19.
      ["missed or failed", { accepted_at: Date.parse("2026-10-23T14:19:00Z") / 1_000 }],
      ["held with no acceptance yet", { accepted_at: null }],
      ["never recorded", null],
    ] as const)("publishes when the :22 slot was %s", async (_label, health) => {
      vi.useFakeTimers();
      vi.setSystemTime(secondChanceMs + 1_000);
      const fixture = dbWithHealth(health);
      const run = vi.fn(async () => ({ status: "ok" as const, itemCount: 1 }));

      const result = await runV9AfterCoreWithinWindow(secondChanceOptions(fixture.db), run);

      expect(result.status).toBe("ok");
      expect(run).toHaveBeenCalledOnce();
      expect(fixture.bind).toHaveBeenCalledWith(Date.parse("2026-10-23T16:45:00Z") / 1_000);
    });

    it("keeps :52 eligible until the accepted generation's current representation is selected", async () => {
      const { sqlite, db } = createLatestSchemaSqlite();
      const acceptedAtSec = Date.parse("2026-10-23T16:16:40Z") / 1_000;
      const insert = sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
      try {
        insert.run(SAFETY_SCORE_V9_CACHE_KEYS.publication, JSON.stringify({ identity: { publicationGenerationId: "accepted" }, payloadSha256: "sha" }), acceptedAtSec);
        insert.run(V9_PUBLICATION_HEALTH_CACHE_KEY, JSON.stringify({ acceptedAtSec, acceptedPublicationGenerationId: "accepted" }), acceptedAtSec);
        expect(await loadV9PublicationHourAcceptedAtSec(db, secondChanceMs / 1000)).toBeNull();
        for (const marker of [
          { publicationGenerationId: "older", projectionVersion: V9_PUBLIC_REPRESENTATION_VERSION, payloadSha256: "sha" },
          { publicationGenerationId: "accepted", projectionVersion: V9_PUBLIC_REPRESENTATION_VERSION - 1, payloadSha256: "sha" },
          { publicationGenerationId: "accepted", projectionVersion: V9_PUBLIC_REPRESENTATION_VERSION, payloadSha256: "other" },
        ]) {
          insert.run(V9_PUBLIC_MATERIALIZATION_CACHE_KEY, JSON.stringify(marker), acceptedAtSec);
          expect(await loadV9PublicationHourAcceptedAtSec(db, secondChanceMs / 1000)).toBeNull();
        }
        insert.run(V9_PUBLIC_MATERIALIZATION_CACHE_KEY, JSON.stringify({
          publicationGenerationId: "accepted", projectionVersion: V9_PUBLIC_REPRESENTATION_VERSION, payloadSha256: "sha",
        }), acceptedAtSec);
        expect(await loadV9PublicationHourAcceptedAtSec(db, secondChanceMs / 1000)).toBe(acceptedAtSec);
      } finally { sqlite.close(); }
    });

    it("degrades without publishing when acceptance evidence is unreadable", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(secondChanceMs + 1_000);
      const fixture = dbWithHealth(new Error("D1 unavailable"));
      const run = vi.fn();

      const result = await runV9AfterCoreWithinWindow(secondChanceOptions(fixture.db), run);

      expect(result).toMatchObject({ status: "degraded", productivity: { reason: "v9-publication-second-chance-unknown" } });
      expect(leaseMocks.runCronWithLease).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });
  });

  it("retains the :25 publication boundary and lease tail ahead of :28 DDR", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:22:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot({ state: "finished", result_status: "ok", worker_version: "worker-v2" });
    const run = vi.fn(async (_signal: AbortSignal, _window: V9ExecutionWindow) => ({ status: "ok" as const }));
    await runV9AfterCoreWithinWindow(options(fixture.db, scheduledTimeMs, V9_EXECUTION_WINDOW_POLICY.publication), run);
    expect(V9_EXECUTION_WINDOW_POLICY.publication).toEqual({ deadlineOffsetMs: 180_000, minimumRemainingMs: 25_000 });
    expect(V9_EXECUTION_WINDOW_POLICY.supplyAttribution.minimumRemainingMs).toBe(60_000);
    expect(run.mock.calls[0]![1].deadlineMs).toBe(Date.parse("2026-07-26T12:25:00Z"));
    const leaseOptions = leaseMocks.runCronWithLease.mock.calls[0]![3];
    expect(leaseOptions).toMatchObject({ ttlSec: 210, heartbeatSec: 15 });
    const finalHeartbeatMs = Date.parse("2026-07-26T12:23:45Z");
    const ddrStartsAtMs = Date.parse("2026-07-26T12:28:00Z");
    expect(finalHeartbeatMs + leaseOptions.ttlSec * 1_000).toBeLessThan(ddrStartsAtMs);
    // A 240s window renews a 270s lease: this same abandoned owner would
    // newly suppress the DDR attempt, which shares the lease and does not wait.
    expect(finalHeartbeatMs + (leaseOptions.ttlSec + 60) * 1_000).toBeGreaterThan(ddrStartsAtMs);
    expect(getV9ExecutionDeadlineMs(scheduledTimeMs, 240_000)).toBe(Date.parse("2026-07-26T12:26:00Z"));
    expect(getV9ExecutionDeadlineMs(Date.parse("2026-07-26T12:29:00Z"), 240_000)).toBe(Date.parse("2026-07-26T12:30:00Z"));
  });

  it("skips a late publication neutrally when floor plus settlement reserve cannot fit", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:22:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 160_000);
    const fixture = dbWithCoreSlot({ state: "finished", result_status: "ok", worker_version: "worker-v2" });
    const run = vi.fn();
    const result = await runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs, V9_EXECUTION_WINDOW_POLICY.publication), run,
    );
    expect(result).toMatchObject({ status: "skipped_neutral" });
    expect(JSON.parse(result.metadata!)).toMatchObject({
      reason: "v9-slot-window-too-short", remainingMs: 20_000, minimumRemainingMs: 25_000,
    });
    expect(leaseMocks.runCronWithLease).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("allows a compiler run longer than the former 60-second window", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:22:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot({
      state: "finished",
      result_status: "ok",
      worker_version: "worker-v2",
    });
    const run = vi.fn(async (signal: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 70_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
      return {
        status: "ok" as const,
        itemCount: 337,
      };
    });

    const pending = runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs, {
        deadlineOffsetMs: 3 * 60_000,
      }),
      run,
    );
    await vi.advanceTimersByTimeAsync(70_000);

    await expect(pending).resolves.toMatchObject({
      status: "ok",
      itemCount: 337,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("clamps a longer requested window to the next quarter boundary", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:14:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot({
      state: "finished",
      result_status: "ok",
      worker_version: "worker-v2",
    });
    const run = vi.fn(async (signal: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 70_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
      return {
        status: "ok" as const,
        itemCount: 1,
      };
    });

    const pending = runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs, {
        deadlineOffsetMs: 3 * 60_000,
      }),
      run,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
      message:
        "compute-safety-score-v9 exceeded its pre-quarter execution window",
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await rejected;
    expect(leaseMocks.runCronWithLease).toHaveBeenCalledWith(
      fixture.db,
      V9_MEMORY_LANE_LEASE_KEY,
      expect.any(Function),
      expect.objectContaining({
        ttlSec: 90,
        heartbeatSec: 15,
      }),
    );
  });

  it("admits V9 after a degraded same-version core slot with a current stablecoin publication", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:23:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot(
      {
        state: "finished",
        result_status: "degraded",
        worker_version: "worker-v2",
      },
      {
        published_at: Math.floor(
          Date.parse("2026-07-26T12:15:30Z") / 1_000,
        ),
      },
    );
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
    expect(fixture.bind).toHaveBeenNthCalledWith(
      2,
      Math.floor(Date.parse("2026-07-26T12:15:00Z") / 1_000),
      Math.floor(Date.parse("2026-07-26T12:30:00Z") / 1_000),
      Math.floor(Date.parse("2026-07-26T12:15:00Z") / 1_000),
      Math.floor(Date.parse("2026-07-26T12:30:00Z") / 1_000),
    );
  });

  it("admits V9 from publication evidence when the parent core slot is not terminal", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:23:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot(
      {
        state: "running",
        result_status: null,
        worker_version: "worker-v2",
      },
      {
        published_at: Math.floor(
          Date.parse("2026-07-26T12:15:30Z") / 1_000,
        ),
      },
    );
    const run = vi.fn(async () => ({
      status: "ok" as const,
      itemCount: 337,
    }));

    const result = await runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs),
      run,
    );

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(337);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("skips V9 after a degraded core slot without a matching stablecoin publication", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:23:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot({
      state: "finished",
      result_status: "degraded",
      worker_version: "worker-v2",
    });
    const run = vi.fn();

    const result = await runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs),
      run,
    );

    expect(result.status).toBe("skipped_neutral");
    expect(result.productivity?.reason).toBe("v9-core-slot-not-ready");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      coreResultStatus: "degraded",
      degradedCorePublicationMatched: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("proves absent-core Heavy admission is neutral before the producer callback", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:08:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot(null);
    const run = vi.fn();
    const result = await runV9AfterCoreWithinWindow({
      ...options(fixture.db, scheduledTimeMs),
      deadlineOffsetMs: 180_000,
      minimumRemainingMs: 60_000,
      lane: "sync-v9-supply-attribution",
      currentSlotKey: "v9SupplyAttributionOffset",
    }, run);
    expect(result).toMatchObject({
      status: "skipped_neutral", itemCount: 0,
      productivity: { productive: false, reason: "v9-core-slot-not-ready" },
    });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "v9-core-slot-not-ready", coreState: null, coreResultStatus: null,
      coreWorkerVersion: null, expectedWorkerVersion: "worker-v2",
      coreStablecoinsPublicationMatched: false, degradedCorePublicationMatched: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("skips neutrally when the core slot never reached a terminal state", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:23:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot({
      state: "running",
      result_status: null,
      worker_version: "worker-v2",
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

  it.each(["worker-v1", "public-script-version"])("admits heavy V9 from current publication evidence despite core UUID %s", async (coreVersion) => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:23:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    // Public quarter-hour publication and heavy V9 execution have different
    // script UUIDs; the publication ledger/time join remains the authority.
    const fixture = dbWithCoreSlot(
      {
        state: "finished",
        result_status: "ok",
        worker_version: coreVersion,
      },
      {
        published_at: Math.floor(
          Date.parse("2026-07-26T12:15:30Z") / 1_000,
        ),
      },
    );
    const run = vi.fn(async () => ({
      status: "ok" as const,
      itemCount: 337,
    }));

    const result = await runV9AfterCoreWithinWindow(
      options(fixture.db, scheduledTimeMs, { workerVersion: "heavy-script-version" }),
      run,
    );

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(337);
    expect(run).toHaveBeenCalledTimes(1);
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
    expect(fixture.prepare).toHaveBeenCalledTimes(3);
    expect(fixture.prepare.mock.calls[2]?.[0]).toContain(
      "WHERE slot_key = ?",
    );
    expect(fixture.bind).toHaveBeenLastCalledWith(
      "v9PublicationOffset",
      Math.floor(scheduledTimeMs / 1_000),
      Math.floor(Date.parse("2026-07-26T12:00:00Z") / 1_000) -
        6 * 60,
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
      .mockResolvedValueOnce(null)
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
        6 * 60,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { lane: "compute-safety-score-v9", currentSlotKey: "v9PublicationOffset", minute: "22" },
    { lane: "sync-v9-supply-attribution", currentSlotKey: "v9SupplyAttributionOffset", minute: "23" },
  ])("skips $lane immediately without waiting when publication holds the memory lane", async ({ lane, currentSlotKey, minute }) => {
    const scheduledTimeMs = Date.parse(`2026-10-16T12:${minute}:00Z`);
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
      {
        ...options(fixture.db, scheduledTimeMs, {
          deadlineOffsetMs: 180_000,
          minimumRemainingMs: 60_000,
        }),
        lane,
        currentSlotKey,
      },
      run,
    );

    expect(result.status).toBe("skipped_neutral");
    expect(result.productivity?.reason).toBe(
      "v9-memory-lane-active",
    );
    expect(leaseMocks.runCronWithLease).toHaveBeenCalledTimes(1);
    expect(leaseMocks.runCronWithLease.mock.calls[0]?.[3]).not.toHaveProperty("acquisitionWait");
    expect(Date.now()).toBe(scheduledTimeMs + 1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("fails loudly when a completed memory-lane lease has no result", async () => {
    const scheduledTimeMs = Date.parse("2026-07-26T12:14:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(scheduledTimeMs + 1_000);
    const fixture = dbWithCoreSlot({
      state: "finished",
      result_status: "ok",
      worker_version: "worker-v2",
    });
    leaseMocks.runCronWithLease.mockResolvedValueOnce({
      status: "ok",
    });

    await expect(
      runV9AfterCoreWithinWindow(
        options(fixture.db, scheduledTimeMs),
        vi.fn(),
      ),
    ).rejects.toThrow(
      "compute-safety-score-v9 lease completed without a result",
    );
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
    const pending = waitForV9MemoryLaneRelease(makeNoopD1({
      prepare,
    }));

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
