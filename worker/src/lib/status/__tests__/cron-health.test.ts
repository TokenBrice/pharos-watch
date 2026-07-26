import { describe, expect, it } from "vitest";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import { loadCronHealth } from "../cron-health";

interface SeedRun {
  job: string;
  status: "ok" | "error" | "degraded" | "skipped_neutral";
  ageSec: number;
}

function makeCronRow(job: string, status: string, ageSec: number, now: number): Record<string, unknown> {
  return {
    job,
    started_at: now - ageSec,
    duration_ms: 100,
    status,
    error: status === "error" ? "test-error" : null,
    item_count: 1,
    metadata: null,
    schedule_key: null,
  };
}

function seedWithOverrides(now: number, overrides: SeedRun[]): Record<string, unknown>[] {
  const base: Map<string, Record<string, unknown>[]> = new Map();
  for (const job of Object.keys(CRON_INTERVALS)) {
    base.set(job, [makeCronRow(job, "ok", 30, now)]);
  }
  const clearedForOverride = new Set<string>();
  for (const override of overrides) {
    if (!clearedForOverride.has(override.job)) {
      base.set(override.job, []);
      clearedForOverride.add(override.job);
    }
    base.get(override.job)!.push(makeCronRow(override.job, override.status, override.ageSec, now));
  }
  return [...base.values()]
    .flat()
    .sort((a, b) => (b.started_at as number) - (a.started_at as number));
}

function makeDb(_now: number, rows: Record<string, unknown>[]) {
  return mockD1([
    { match: "UNION ALL", rows },
    { match: "FROM cron_leases", rows: [] },
    { match: "FROM cron_run_progress", rows: [] },
  ]);
}

describe("loadCronHealth — availabilityImpactingConsecutiveCronErrors", () => {
  // Fixed epoch-seconds value so test assertions are deterministic and do not
  // drift with wall-clock time. Matches the production `now` argument shape
  // (Math.floor(Date.now() / 1000)).
  const NOW = 1_775_890_000;

  it("reports whether attempt telemetry is enabled, scoped out, or disabled per job", async () => {
    const rows = seedWithOverrides(NOW, []);
    const scoped = await loadCronHealth(makeDb(NOW, rows), NOW, "shadow", ["sync-stablecoins"]);
    const disabled = await loadCronHealth(makeDb(NOW, rows), NOW, "off");

    expect(scoped.crons["sync-stablecoins"]?.attemptTelemetry).toBe("enabled");
    expect(scoped.crons["snapshot-supply"]?.attemptTelemetry).toBe("scoped-out");
    expect(disabled.crons["sync-stablecoins"]?.attemptTelemetry).toBe("disabled");
  });

  it("returns 0 when a critical cron has only one error run followed by ok", async () => {
    // After the base ok row is cleared (because sync-stablecoins appears in
    // overrides), we explicitly seed an earlier ok run so the streak check
    // has a non-error previous entry to compare against.
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "error", ageSec: 30 },
      { job: "sync-stablecoins", status: "ok", ageSec: 900 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingCronErrors).toBe(1);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(0);
  });

  it("returns 1 when exactly one critical cron has 2 consecutive errors", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "error", ageSec: 30 },
      { job: "sync-stablecoins", status: "error", ageSec: 900 },
      { job: "sync-stablecoins", status: "ok", ageSec: 1800 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingCronErrors).toBe(1);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(1);
  });

  it("ignores neutral skips when checking critical error streaks", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "skipped_neutral", ageSec: 30 },
      { job: "sync-stablecoins", status: "error", ageSec: 900 },
      { job: "sync-stablecoins", status: "error", ageSec: 1800 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingCronErrors).toBe(1);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(1);
  });

  it("returns 2 when two critical crons each have 2 consecutive errors", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "error", ageSec: 30 },
      { job: "sync-stablecoins", status: "error", ageSec: 900 },
      { job: "sync-fx-rates", status: "error", ageSec: 30 },
      { job: "sync-fx-rates", status: "error", ageSec: 900 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingCronErrors).toBe(2);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(2);
  });

  it("ignores watch-tier error streaks", async () => {
    // sync-dex-liquidity is watch-tier (not critical)
    const rows = seedWithOverrides(NOW, [
      { job: "sync-dex-liquidity", status: "error", ageSec: 30 },
      { job: "sync-dex-liquidity", status: "error", ageSec: 1800 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(0);
  });

  it("resets the streak when the previous run was not an error", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "error", ageSec: 30 },
      { job: "sync-stablecoins", status: "ok", ageSec: 900 },
      { job: "sync-stablecoins", status: "error", ageSec: 1800 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    // Most recent 2 runs are error/ok → streak is 0
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(0);
  });

  it("treats a fresh neutral skipped run as healthy after a fresh required ok run", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "weekly-recap", status: "skipped_neutral", ageSec: 30 },
      { job: "weekly-recap", status: "ok", ageSec: 86_400 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.crons["weekly-recap"]?.healthy).toBe(true);
    expect(snapshot.watchUnhealthyCrons).toBe(0);
    expect(snapshot.degradedCronRuns).toBe(0);
  });

  it("does not let a neutral weekly skip mask a fresh failed required run", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "weekly-recap", status: "skipped_neutral", ageSec: 30 },
      { job: "weekly-recap", status: "error", ageSec: 86_400 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.crons["weekly-recap"]?.healthy).toBe(false);
    expect(snapshot.watchUnhealthyCrons).toBe(1);
    expect(snapshot.cronErrorCount).toBe(1);
  });

  it("keeps a neutral weekly skip available after a fresh degraded required run", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "weekly-recap", status: "skipped_neutral", ageSec: 30 },
      { job: "weekly-recap", status: "degraded", ageSec: 86_400 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.crons["weekly-recap"]?.healthy).toBe(true);
    expect(snapshot.watchUnhealthyCrons).toBe(0);
    expect(snapshot.degradedCronRuns).toBe(1);
  });

  it("chunks cron history queries below D1's compound SELECT term limit", async () => {
    const rows = seedWithOverrides(NOW, []);
    const db = makeDb(NOW, rows);
    const snapshot = await loadCronHealth(db, NOW);
    const historyQueries = db.getHistory().filter((entry) => entry.sql.includes("UNION ALL"));

    expect(historyQueries.length).toBeGreaterThan(1);
    expect(historyQueries.every((entry) => entry.binds.length <= 5)).toBe(true);
    expect(snapshot.cronHistoryQueryFailed).toBe(false);
    expect(snapshot.crons["sync-stablecoins"]?.telemetryUnknown).toBe(false);
    expect(snapshot.crons["sync-stablecoins"]?.recentRuns.length).toBeGreaterThan(0);
  });

  it("ignores legacy false daily-digest failures synthesized from idle conditional polls", async () => {
    const rows = seedWithOverrides(NOW, []);
    rows.push({
      ...makeCronRow("daily-digest", "error", 10, NOW),
      schedule_key: "digestTriggerPoll",
      metadata: JSON.stringify({
        reason: "stale-slot-reconciled",
        childDisposition: "not_started",
        slotKey: "digestTriggerPoll",
      }),
    });
    rows.sort((left, right) => (right.started_at as number) - (left.started_at as number));
    const db = makeDb(NOW, rows);

    const snapshot = await loadCronHealth(db, NOW);
    const historyQueries = db.getHistory().filter((entry) => entry.sql.includes("UNION ALL"));

    expect(historyQueries.every((entry) =>
      entry.sql.includes("schedule_key = 'digestTriggerPoll'")
      && entry.sql.includes("$.childDisposition"),
    )).toBe(true);
    expect(snapshot.crons["daily-digest"]?.lastRun?.status).toBe("ok");
    expect(snapshot.crons["daily-digest"]?.recentRuns).toHaveLength(1);
    expect(snapshot.crons["daily-digest"]?.healthy).toBe(true);
  });

  it("filters legacy idle-poll failures before the history limit without hiding a real forced run", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare(
        `INSERT INTO cron_runs
           (job, started_at, duration_ms, status, error, item_count, metadata, schedule_key)
         VALUES (?, ?, 100, ?, ?, 1, ?, ?)`,
      );
      for (let offset = 1; offset <= 11; offset++) {
        insert.run(
          "daily-digest",
          NOW - offset,
          "error",
          "scheduled slot abandoned before child job started",
          JSON.stringify({
            reason: "stale-slot-reconciled",
            childDisposition: "not_started",
            slotKey: "digestTriggerPoll",
          }),
          "digestTriggerPoll",
        );
      }
      insert.run(
        "daily-digest",
        NOW - 20,
        "degraded",
        null,
        JSON.stringify({ forced: true, requestId: "request-a" }),
        "digestTriggerPoll",
      );
      insert.run(
        "daily-digest",
        NOW - 19,
        "error",
        "scheduled slot abandoned while daily-digest was running",
        JSON.stringify({
          reason: "stale-slot-reconciled",
          failureCategory: "platform-abandoned",
          progressStage: "generation",
        }),
        "digestTriggerPoll",
      );
      insert.run(
        "daily-digest",
        NOW - 30,
        "ok",
        null,
        JSON.stringify({ edition: "daily" }),
        "daily0805Utc",
      );

      const snapshot = await loadCronHealth(db, NOW);

      expect(snapshot.crons["daily-digest"]?.lastRun?.status).toBe("error");
      expect(snapshot.crons["daily-digest"]?.recentRuns.map((run) => run.status)).toEqual([
        "error",
        "degraded",
        "ok",
      ]);
      expect(snapshot.crons["daily-digest"]?.healthy).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-04-13 status-stability hardening: watch-tier cron bootstrap handling.
// ---------------------------------------------------------------------------
//
// A watch-tier cron with zero historical cron_runs rows is in bootstrap mode,
// not unhealthy. This mirrors the reserveComposition bootstrap pattern and
// eliminates the persistent watch_unhealthy_crons_present info cause driven
// by yield-coverage-audit having no runs on prod (its monthly trigger was
// added on 2026-03-26 but the Apr 1 06:00 UTC window produced no row).
// Critical-tier crons with zero runs still count as unhealthy.
describe("loadCronHealth — watch-tier bootstrap guard", () => {
  const NOW = 1_775_890_000;

  /** Seed every cron with a baseline ok row, except for the jobs named in
   *  `clearedJobs` which are left entirely absent from the cron_runs rows. */
  function seedWithClearedJobs(now: number, clearedJobs: string[]): Record<string, unknown>[] {
    const cleared = new Set(clearedJobs);
    const rows: Record<string, unknown>[] = [];
    for (const job of Object.keys(CRON_INTERVALS)) {
      if (cleared.has(job)) continue;
      rows.push(makeCronRow(job, "ok", 30, now));
    }
    return rows;
  }

  it("does not count a never-ran watch-tier cron as unhealthy", async () => {
    // yield-coverage-audit is a monthly watch-tier cron. On the current prod
    // deploy it has zero rows in cron_runs despite its trigger being
    // registered. Under the bootstrap guard it should not contribute to
    // watchUnhealthyCrons.
    const rows = seedWithClearedJobs(NOW, ["yield-coverage-audit"]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.watchUnhealthyCrons).toBe(0);
    expect(snapshot.availabilityImpactingUnhealthyCrons).toBe(0);
    expect(snapshot.crons["yield-coverage-audit"]?.bootstrap).toBe(true);
    expect(snapshot.crons["yield-coverage-audit"]?.healthy).toBe(true);
    expect(snapshot.crons["yield-coverage-audit"]?.lastRun).toBeNull();
  });

  it("still counts a critical-tier cron with no runs as unhealthy", async () => {
    // sync-stablecoins is critical. Its absence must flag the availability
    // lane — the system cannot credibly claim healthy operation without
    // the critical data feed having ever run.
    const rows = seedWithClearedJobs(NOW, ["sync-stablecoins"]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingUnhealthyCrons).toBeGreaterThanOrEqual(1);
    expect(snapshot.crons["sync-stablecoins"]?.healthy).toBe(false);
    // bootstrap field is not set for critical crons (only watch-tier get the flag)
    expect(snapshot.crons["sync-stablecoins"]?.bootstrap).toBeUndefined();
  });

  it("keeps a watch-tier cron in bootstrap through neutral-only admission history", async () => {
    const rows = seedWithClearedJobs(NOW, [
      "compute-safety-score-v9-shadow",
    ]);
    rows.push(
      makeCronRow(
        "compute-safety-score-v9-shadow",
        "skipped_neutral",
        30,
        NOW,
      ),
    );
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);

    expect(snapshot.crons["compute-safety-score-v9-shadow"]?.bootstrap).toBe(
      true,
    );
    expect(snapshot.crons["compute-safety-score-v9-shadow"]?.healthy).toBe(
      true,
    );
    expect(snapshot.watchUnhealthyCrons).toBe(0);
  });

  it("ends watch-tier bootstrap after repeated neutral-only admissions", async () => {
    const rows = seedWithClearedJobs(NOW, [
      "compute-safety-score-v9-shadow",
    ]);
    rows.push(
      makeCronRow(
        "compute-safety-score-v9-shadow",
        "skipped_neutral",
        30,
        NOW,
      ),
      makeCronRow(
        "compute-safety-score-v9-shadow",
        "skipped_neutral",
        900,
        NOW,
      ),
    );
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);

    expect(
      snapshot.crons["compute-safety-score-v9-shadow"]?.bootstrap,
    ).toBeUndefined();
    expect(snapshot.crons["compute-safety-score-v9-shadow"]?.healthy).toBe(
      false,
    );
    expect(snapshot.watchUnhealthyCrons).toBe(1);
  });

  it("does not set bootstrap for a watch-tier cron that has required history", async () => {
    // If a watch-tier cron has at least one historical run (even very old or
    // failed), it is NOT in bootstrap — regular health rules apply.
    const rows = seedWithClearedJobs(NOW, ["sync-dex-liquidity"]);
    rows.push(makeCronRow("sync-dex-liquidity", "error", 30, NOW));
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.crons["sync-dex-liquidity"]?.bootstrap).toBeUndefined();
  });
});

describe("loadCronHealth — stale cron artifact readout", () => {
  const NOW = 1_775_890_000;

  it("surfaces expired leases and orphaned progress without treating them as in-flight", async () => {
    const rows = seedWithOverrides(NOW, []);
    const db = mockD1([
      { match: "UNION ALL", rows },
      {
        match: "FROM cron_leases",
        rows: [{
          job: "sync-yield-data",
          lease_owner: "yield-owner-a",
          lease_until: NOW - 60,
        }],
      },
      {
        match: "FROM cron_run_progress",
        rows: [{
          job: "sync-yield-data",
          started_at: NOW - 3_600,
          updated_at: NOW - 1_800,
          stage: "evaluation",
          items_done: 10,
          items_total: 20,
          message: "Evaluating",
          lease_owner: "yield-owner-a",
          metadata: null,
          slot_started_at: NOW - 3_600,
        }],
      },
    ]);

    const snapshot = await loadCronHealth(db, NOW);

    expect(snapshot.expiredCronLeases).toBe(1);
    expect(snapshot.orphanedCronProgressRows).toBe(1);
    expect(snapshot.staleCronArtifacts).toBe(2);
    expect(snapshot.crons["sync-yield-data"]?.inFlight).toBeNull();
    expect(snapshot.crons["sync-yield-data"]?.staleArtifacts).toEqual([
      expect.objectContaining({
        kind: "orphaned-progress",
        leaseOwner: "yield-owner-a",
        progressStage: "evaluation",
        slotStartedAt: NOW - 3_600,
      }),
      expect.objectContaining({
        kind: "expired-lease",
        leaseOwner: "yield-owner-a",
        leaseUntil: NOW - 60,
      }),
    ]);
  });

  it("treats progress without a lease owner as orphaned when lease reads succeed", async () => {
    const rows = seedWithOverrides(NOW, []);
    const db = mockD1([
      { match: "UNION ALL", rows },
      { match: "FROM cron_leases", rows: [] },
      {
        match: "FROM cron_run_progress",
        rows: [{
          job: "sync-yield-data",
          started_at: NOW - 3_600,
          updated_at: NOW - 120,
          stage: "started",
          items_done: null,
          items_total: null,
          message: null,
          lease_owner: null,
          metadata: null,
          slot_started_at: NOW - 3_600,
        }],
      },
    ]);

    const snapshot = await loadCronHealth(db, NOW);

    expect(snapshot.orphanedCronProgressRows).toBe(1);
    expect(snapshot.staleCronArtifacts).toBe(1);
    expect(snapshot.crons["sync-yield-data"]?.inFlight).toBeNull();
    expect(snapshot.crons["sync-yield-data"]?.staleArtifacts).toEqual([
      expect.objectContaining({
        kind: "orphaned-progress",
        job: "sync-yield-data",
        progressStage: "started",
        slotStartedAt: NOW - 3_600,
      }),
    ]);
  });
});

describe("loadCronHealth — running scheduled slot telemetry", () => {
  const NOW = 1_775_890_000;

  it("summarizes running and stale candidate scheduled slots", async () => {
    const rows = seedWithOverrides(NOW, []);
    const db = mockD1([
      { match: "UNION ALL", rows },
      { match: "FROM cron_leases", rows: [] },
      { match: "FROM cron_run_progress", rows: [] },
      {
        match: "FROM cron_slot_executions",
        rows: [
          {
            slot_key: "statusSelfCheckOffset",
            slot_started_at: NOW - 600,
            execution_owner: "slot-owner-fresh",
            started_at: NOW - 600,
            updated_at: NOW - 60,
          },
          {
            slot_key: "halfHourlyOffset",
            slot_started_at: NOW - 4_000,
            execution_owner: "slot-owner-stale",
            started_at: NOW - 4_000,
            updated_at: NOW - 2_400,
          },
        ],
      },
    ]);

    const snapshot = await loadCronHealth(db, NOW);

    expect(snapshot.scheduledSlots).toEqual({
      runningSlots: 2,
      staleCandidateSlots: 1,
      oldestRunningAgeSec: 2_400,
      oldestStaleAgeSec: 2_400,
      queryFailed: false,
    });
    expect(snapshot.scheduledSlotEventMarkerQueryFailed).toBe(false);
  });

  it("surfaces running-slot query failures distinctly from event-marker failures", async () => {
    const rows = seedWithOverrides(NOW, []);
    const db = mockD1([
      { match: "UNION ALL", rows },
      { match: "FROM cron_leases", rows: [] },
      { match: "FROM cron_run_progress", rows: [] },
      { match: "FROM cache", rows: [] },
      {
        match: "FROM cron_slot_executions",
        rows: [],
        throwError: new Error("cron_slot_executions unavailable"),
      },
    ]);

    const snapshot = await loadCronHealth(db, NOW);

    expect(snapshot.scheduledSlots).toEqual({
      runningSlots: 0,
      staleCandidateSlots: 0,
      oldestRunningAgeSec: null,
      oldestStaleAgeSec: null,
      queryFailed: true,
    });
    expect(snapshot.scheduledSlotEventMarkerQueryFailed).toBe(false);
  });
});

describe("loadCronHealth — cron event markers", () => {
  const NOW = 1_775_890_000;

  it("surfaces the latest scheduled-slot abandonment marker on child crons", async () => {
    const rows = seedWithOverrides(NOW, []);
    const event = {
      event: "cron_event",
      job: "hourlyYieldSync",
      eventType: "scheduled-slot-abandoned",
      severity: "error",
      message: "Scheduled slot hourlyYieldSync stopped heartbeating and was reconciled as abandoned.",
      metadata: {
        slotKey: "hourlyYieldSync",
        slotStartedAt: NOW - 3600,
        slotOwner: "slot-owner-a",
        staleSlotReconciliation: {
          abandonedJobs: [{
            job: "sync-yield-data",
            progressStage: "evaluation",
            leaseOwner: "yield-owner-a",
          }],
        },
      },
      recordedAt: NOW - 60,
    };
    const db = mockD1([
      { match: "UNION ALL", rows },
      { match: "FROM cron_leases", rows: [] },
      { match: "FROM cron_run_progress", rows: [] },
      {
        match: "FROM cache",
        rows: [{
          key: "cron:event:hourlyyieldsync:scheduled-slot-abandoned",
          value: JSON.stringify(event),
          updated_at: NOW - 60,
        }],
      },
    ]);

    const snapshot = await loadCronHealth(db, NOW);

    expect(snapshot.crons["sync-yield-data"]?.latestEvent).toMatchObject({
      eventType: "scheduled-slot-abandoned",
      severity: "error",
      metadata: {
        slotKey: "hourlyYieldSync",
        slotOwner: "slot-owner-a",
      },
    });
    expect(snapshot.crons["sync-stablecoins"]?.latestEvent).toBeUndefined();
    expect(snapshot.scheduledSlotEventMarkerQueryFailed).toBe(false);
  });

  it("surfaces event-marker query failures distinctly from running-slot failures", async () => {
    const rows = seedWithOverrides(NOW, []);
    const db = mockD1([
      { match: "UNION ALL", rows },
      { match: "FROM cron_leases", rows: [] },
      { match: "FROM cron_run_progress", rows: [] },
      {
        match: "FROM cache",
        rows: [],
        throwError: new Error("cache unavailable"),
      },
      { match: "FROM cron_slot_executions", rows: [] },
    ]);

    const snapshot = await loadCronHealth(db, NOW);

    expect(snapshot.scheduledSlots).toEqual({
      runningSlots: 0,
      staleCandidateSlots: 0,
      oldestRunningAgeSec: null,
      oldestStaleAgeSec: null,
      queryFailed: false,
    });
    expect(snapshot.scheduledSlotEventMarkerQueryFailed).toBe(true);
  });

  it("surfaces both scheduled-slot query failure paths when both reads fail", async () => {
    const rows = seedWithOverrides(NOW, []);
    const db = mockD1([
      { match: "UNION ALL", rows },
      { match: "FROM cron_leases", rows: [] },
      { match: "FROM cron_run_progress", rows: [] },
      {
        match: "FROM cache",
        rows: [],
        throwError: new Error("cache unavailable"),
      },
      {
        match: "FROM cron_slot_executions",
        rows: [],
        throwError: new Error("cron_slot_executions unavailable"),
      },
    ]);

    const snapshot = await loadCronHealth(db, NOW);

    expect(snapshot.scheduledSlots).toEqual({
      runningSlots: 0,
      staleCandidateSlots: 0,
      oldestRunningAgeSec: null,
      oldestStaleAgeSec: null,
      queryFailed: true,
    });
    expect(snapshot.scheduledSlotEventMarkerQueryFailed).toBe(true);
  });
});

describe("loadCronHealth — worker job attempt telemetry", () => {
  const NOW = 1_775_890_000;

  it("surfaces latest attempts and active/stale attempt counters", async () => {
    const rows = seedWithOverrides(NOW, []);
    const db = mockD1([
      { match: "UNION ALL", rows },
      { match: "FROM cron_leases", rows: [] },
      { match: "FROM cron_run_progress", rows: [] },
      {
        match: "ROW_NUMBER() OVER",
        rows: [{
          attempt_id: "attempt-a",
          idempotency_key: "scheduled-slot|hourlyYieldSync|1775890000|sync-yield-data|1",
          schedule_key: "hourlyYieldSync",
          job: "sync-yield-data",
          slot_started_at: NOW - 60,
          producer_kind: "scheduled-slot",
          state: "running",
          status_class: null,
          attempt_no: 1,
          owner: "owner-a",
          queued_at: NOW - 60,
          claimed_at: NOW - 59,
          started_at: NOW - 59,
          last_heartbeat_at: NOW - 10,
          finished_at: null,
          updated_at: NOW - 10,
          duration_ms: null,
          item_count: 12,
          result_metadata_json: JSON.stringify({ progress: { stage: "evaluation" } }),
          error: null,
        }],
      },
      {
        match: "COUNT(*) AS active_count",
        rows: [],
        first: { active_count: 2, stale_count: 1 },
      },
    ]);

    const snapshot = await loadCronHealth(db, NOW, "shadow");

    expect(snapshot.activeJobAttempts).toBe(2);
    expect(snapshot.staleJobAttempts).toBe(1);
    expect(snapshot.jobAttemptQueryFailed).toBe(false);
    expect(snapshot.crons["sync-yield-data"]?.latestAttempt).toMatchObject({
      attemptId: "attempt-a",
      state: "running",
      stale: false,
      itemCount: 12,
      metadata: { progress: { stage: "evaluation" } },
    });
  });

  it("immediately marks a critical producer unhealthy when its latest active attempt is stale", async () => {
    const rows = seedWithOverrides(NOW, []);
    const db = mockD1([
      { match: "UNION ALL", rows },
      { match: "FROM cron_leases", rows: [] },
      { match: "FROM cron_run_progress", rows: [] },
      {
        match: "ROW_NUMBER() OVER",
        rows: [{
          attempt_id: "attempt-stale-critical",
          idempotency_key: "scheduled-slot|quarterHourly|sync-stablecoins|1",
          schedule_key: "quarterHourly",
          job: "sync-stablecoins",
          slot_started_at: NOW - 300,
          producer_path: "quarterHourly",
          producer_kind: "scheduled-slot",
          invocation_id: "invocation-critical",
          worker_version: "version-a",
          state: "running",
          status_class: null,
          attempt_no: 1,
          owner: "owner-critical",
          lease_until: NOW - 1,
          queued_at: NOW - 300,
          claimed_at: NOW - 299,
          started_at: NOW - 299,
          last_heartbeat_at: NOW - 10,
          finished_at: null,
          updated_at: NOW - 10,
          duration_ms: null,
          item_count: null,
          result_metadata_json: null,
          error: null,
        }],
      },
      {
        match: "COUNT(*) AS active_count",
        rows: [],
        first: { active_count: 1, stale_count: 1 },
      },
    ]);

    const snapshot = await loadCronHealth(db, NOW, "shadow");

    expect(snapshot.crons["sync-stablecoins"]?.lastRun?.status).toBe("ok");
    expect(snapshot.crons["sync-stablecoins"]?.latestAttempt?.stale).toBe(true);
    expect(snapshot.crons["sync-stablecoins"]?.healthy).toBe(false);
    expect(snapshot.availabilityImpactingUnhealthyCrons).toBe(1);
    expect(snapshot.watchUnhealthyCrons).toBe(0);
  });

  it("applies watch impact without escalating availability for a stale watch-tier attempt", async () => {
    const rows = seedWithOverrides(NOW, []);
    const db = mockD1([
      { match: "UNION ALL", rows },
      { match: "FROM cron_leases", rows: [] },
      { match: "FROM cron_run_progress", rows: [] },
      {
        match: "ROW_NUMBER() OVER",
        rows: [{
          attempt_id: "attempt-stale-watch",
          idempotency_key: "scheduled-slot|hourlyYieldSync|sync-yield-data|1",
          schedule_key: "hourlyYieldSync",
          job: "sync-yield-data",
          slot_started_at: NOW - 300,
          producer_path: "hourlyYieldSync",
          producer_kind: "scheduled-slot",
          invocation_id: "invocation-watch",
          worker_version: "version-a",
          state: "running",
          status_class: null,
          attempt_no: 1,
          owner: "owner-watch",
          lease_until: NOW + 300,
          queued_at: NOW - 3_000,
          claimed_at: NOW - 2_999,
          started_at: NOW - 2_999,
          last_heartbeat_at: NOW - 2_100,
          finished_at: null,
          updated_at: NOW - 2_100,
          duration_ms: null,
          item_count: null,
          result_metadata_json: null,
          error: null,
        }],
      },
      {
        match: "COUNT(*) AS active_count",
        rows: [],
        first: { active_count: 1, stale_count: 1 },
      },
    ]);

    const snapshot = await loadCronHealth(db, NOW, "shadow");

    expect(snapshot.crons["sync-yield-data"]?.lastRun?.status).toBe("ok");
    expect(snapshot.crons["sync-yield-data"]?.latestAttempt?.stale).toBe(true);
    expect(snapshot.crons["sync-yield-data"]?.healthy).toBe(false);
    expect(snapshot.availabilityImpactingUnhealthyCrons).toBe(0);
    expect(snapshot.watchUnhealthyCrons).toBe(1);
  });

  it("does not let unavailable cron history mask a definite stale critical attempt", async () => {
    const db = mockD1([
      { match: "UNION ALL", rows: [], throwError: new Error("cron history unavailable") },
      { match: "FROM cron_leases", rows: [] },
      { match: "FROM cron_run_progress", rows: [] },
      {
        match: "ROW_NUMBER() OVER",
        rows: [{
          attempt_id: "attempt-stale-with-history-gap",
          idempotency_key: "scheduled-slot|quarterHourly|sync-stablecoins|1",
          schedule_key: "quarterHourly",
          job: "sync-stablecoins",
          slot_started_at: NOW - 300,
          producer_path: "quarterHourly",
          producer_kind: "scheduled-slot",
          invocation_id: "invocation-history-gap",
          worker_version: "version-a",
          state: "running",
          status_class: null,
          attempt_no: 1,
          owner: "owner-history-gap",
          lease_until: NOW - 1,
          queued_at: NOW - 300,
          claimed_at: NOW - 299,
          started_at: NOW - 299,
          last_heartbeat_at: NOW - 10,
          finished_at: null,
          updated_at: NOW - 10,
          duration_ms: null,
          item_count: null,
          result_metadata_json: null,
          error: null,
        }],
      },
      {
        match: "COUNT(*) AS active_count",
        rows: [],
        first: { active_count: 1, stale_count: 1 },
      },
    ]);

    const snapshot = await loadCronHealth(db, NOW, "shadow");

    expect(snapshot.cronHistoryQueryFailed).toBe(true);
    expect(snapshot.crons["sync-stablecoins"]?.telemetryUnknown).toBe(true);
    expect(snapshot.crons["sync-stablecoins"]?.latestAttempt?.stale).toBe(true);
    expect(snapshot.crons["sync-stablecoins"]?.healthy).toBe(false);
    expect(snapshot.availabilityImpactingUnhealthyCrons).toBe(1);
  });
});
