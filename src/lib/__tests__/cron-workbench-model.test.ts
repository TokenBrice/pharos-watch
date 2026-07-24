import { describe, expect, it } from "vitest";
import type { BudgetOnlySurfaceStatus, CronStatus } from "@shared/types";
import {
  buildBudgetOnlySurfaceGroups,
  buildCronWorkbenchModel,
  classifyCronWorkbenchState,
  DEFAULT_CRON_WORKBENCH_FILTERS,
  formatCronAttemptState,
  formatCronAttemptStatusClass,
  formatCronDuration,
  formatCronRunStatus,
  formatCronRunTiming,
  type CronWorkbenchFilters,
  type CronWorkbenchGroupInput,
} from "@/lib/cron-workbench-model";

function makeCron(overrides: Partial<CronStatus> = {}): CronStatus {
  return {
    lastRun: { startedAt: 1_700_000_000, durationMs: 1_200, status: "ok" },
    recentRuns: [{ startedAt: 1_700_000_000, durationMs: 1_200, status: "ok" }],
    expectedIntervalSec: 900,
    healthy: true,
    ...overrides,
  };
}

function makeFilters(overrides: Partial<CronWorkbenchFilters> = {}): CronWorkbenchFilters {
  return { ...DEFAULT_CRON_WORKBENCH_FILTERS, state: "all", ...overrides };
}

function makeGroups(): CronWorkbenchGroupInput[] {
  return [
    {
      key: "quarter-hourly",
      title: "15-minute slot",
      badge: "*/15",
      description: "Shared core ingestion.",
      entries: [
        ["snapshot-chain-supply", makeCron()],
        ["sync-stablecoins", makeCron({ healthy: false })],
        ["sync-fx-rates", makeCron({ lastRun: { startedAt: 1_700_000_000, durationMs: 500, status: "degraded" } })],
      ],
    },
    {
      key: "five-minute",
      title: "5-minute slot",
      badge: "~5 min",
      description: "Delivery work.",
      entries: [
        ["dispatch-telegram-alerts", makeCron({ inFlight: { startedAt: 1, updatedAt: 2, stale: false } })],
        ["reserve-recovery", makeCron({ telemetryUnknown: true, lastRun: null, recentRuns: [] })],
      ],
    },
  ];
}

function makeBudgetSurface(overrides: Partial<BudgetOnlySurfaceStatus> = {}): BudgetOnlySurfaceStatus {
  return {
    job: "telegram-registration-reconciliation",
    label: "Telegram registration reconciliation",
    scheduleKey: "fiveMinuteTelegramAlerts",
    schedule: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
    expectedIntervalSec: 300,
    maxAgeSec: 900,
    maxConnections: 1,
    connectionGroup: "five-minute-telegram-chain",
    telemetryStatus: "fresh",
    telemetryUnknown: false,
    checkedAt: 1_700_000_000,
    ageSeconds: 30,
    durationMs: 2_582_400,
    dueCount: 3,
    processedCount: 3,
    outcome: "ok",
    ...overrides,
  };
}

describe("cron workbench model", () => {
  it("preserves trigger-group boundaries and summarizes each complete group", () => {
    const model = buildCronWorkbenchModel(makeGroups(), makeFilters());

    expect(model.groups.map((group) => group.key)).toEqual(["quarter-hourly", "five-minute"]);
    expect(model.groups[0]?.summary).toMatchObject({
      total: 3,
      visible: 3,
      unhealthy: 1,
      degraded: 1,
      healthy: 1,
    });
    expect(model.triggerGroups).toEqual([
      { value: "quarter-hourly", label: "15-minute slot", count: 3 },
      { value: "five-minute", label: "5-minute slot", count: 2 },
    ]);
  });

  it("sorts severity within a group and uses canonical registry order for ties", () => {
    const group = makeGroups()[0]!;
    group.entries = [
      ["snapshot-chain-supply", makeCron({ healthy: false })],
      ["sync-stablecoins", makeCron({ healthy: false })],
      ["sync-fx-rates", makeCron({ healthy: false })],
    ];

    const rows = buildCronWorkbenchModel([group], makeFilters()).groups[0]!.rows;

    expect(rows.map((row) => row.job)).toEqual(["sync-stablecoins", "sync-fx-rates", "snapshot-chain-supply"]);
  });

  it("keeps source order as the final tie breaker for unregistered jobs", () => {
    const group: CronWorkbenchGroupInput = {
      key: "other",
      title: "Other",
      badge: "unmapped",
      description: "Unknown registry jobs.",
      entries: [
        ["custom-second", makeCron({ healthy: false })],
        ["custom-first", makeCron({ healthy: false })],
      ],
    };

    expect(buildCronWorkbenchModel([group], makeFilters()).rows.map((row) => row.job)).toEqual([
      "custom-second",
      "custom-first",
    ]);
  });

  it("combines search, state, impact, group, and running filters", () => {
    const groups = makeGroups();
    const searched = buildCronWorkbenchModel(groups, makeFilters({ search: "stablecoin sync" }));
    expect(searched.rows.map((row) => row.job)).toEqual(["sync-stablecoins"]);

    const attention = buildCronWorkbenchModel(groups, { ...DEFAULT_CRON_WORKBENCH_FILTERS });
    expect(attention.rows.map((row) => row.job)).toEqual(["sync-stablecoins", "sync-fx-rates", "reserve-recovery"]);

    const critical = buildCronWorkbenchModel(groups, makeFilters({ impact: "public-critical" }));
    expect(critical.rows.map((row) => row.job)).toEqual(["sync-stablecoins", "sync-fx-rates", "reserve-recovery"]);

    const group = buildCronWorkbenchModel(groups, makeFilters({ triggerGroup: "five-minute" }));
    expect(group.rows.map((row) => row.job)).toEqual(["reserve-recovery", "dispatch-telegram-alerts"]);

    const running = buildCronWorkbenchModel(groups, makeFilters({ running: "running" }));
    expect(running.rows.map((row) => row.job)).toEqual(["dispatch-telegram-alerts"]);
  });

  it("classifies stale running and telemetry-unknown jobs without treating them as healthy", () => {
    expect(classifyCronWorkbenchState(makeCron({ inFlight: { startedAt: 1, updatedAt: 2, stale: true } }))).toBe(
      "unhealthy",
    );
    expect(classifyCronWorkbenchState(makeCron({ telemetryUnknown: true }))).toBe("unknown");
    expect(classifyCronWorkbenchState(makeCron({ inFlight: { startedAt: 1, updatedAt: 2, stale: false } }))).toBe(
      "running",
    );
  });

  it("keeps a degraded required outcome in attention after a neutral skip", () => {
    const neutralRun = { startedAt: 1_700_000_000, durationMs: 200, status: "skipped_neutral" as const };
    const degradedRun = { startedAt: 1_699_999_000, durationMs: 800, status: "degraded" as const };
    const cron = makeCron({
      lastRun: neutralRun,
      recentRuns: [neutralRun, degradedRun],
      healthy: true,
    });

    expect(classifyCronWorkbenchState(cron)).toBe("degraded");

    const model = buildCronWorkbenchModel(
      [
        {
          key: "weekly",
          title: "Weekly",
          badge: "weekly",
          description: "Weekly maintenance jobs.",
          entries: [["weekly-recap", cron]],
        },
      ],
      { ...DEFAULT_CRON_WORKBENCH_FILTERS },
    );

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({
      job: "weekly-recap",
      state: "degraded",
      rawStatus: "skipped_neutral",
      statusLabel: "Completed with warnings (latest required run)",
    });
  });

  it("keeps a failed required outcome unhealthy after a neutral skip", () => {
    const neutralRun = { startedAt: 1_700_000_000, durationMs: 200, status: "skipped_neutral" as const };
    const failedRun = { startedAt: 1_699_999_000, durationMs: 800, status: "error" as const };
    const cron = makeCron({
      lastRun: neutralRun,
      recentRuns: [neutralRun, failedRun],
      healthy: false,
    });

    expect(classifyCronWorkbenchState(cron)).toBe("unhealthy");

    const model = buildCronWorkbenchModel(
      [
        {
          key: "weekly",
          title: "Weekly",
          badge: "weekly",
          description: "Weekly maintenance jobs.",
          entries: [["weekly-recap", cron]],
        },
      ],
      { ...DEFAULT_CRON_WORKBENCH_FILTERS },
    );

    expect(model.rows[0]).toMatchObject({
      state: "unhealthy",
      rawStatus: "skipped_neutral",
      statusLabel: "Failed (latest required run)",
    });
  });

  it("formats raw run and attempt values into readable labels", () => {
    expect(formatCronRunStatus("skipped_neutral")).toBe("Skipped: no work required");
    expect(formatCronRunStatus("skipped_locked")).toBe("Skipped: lease held");
    expect(formatCronRunStatus(null)).toBe("No runs");
    expect(formatCronAttemptState("skipped_locked")).toBe("Skipped: lease held");
    expect(formatCronAttemptStatusClass("controlled_error")).toBe("Controlled error");
    expect(formatCronAttemptStatusClass(null)).toBe("Pending outcome");
  });

  it("formats long durations readably while retaining exact seconds and milliseconds", () => {
    expect(formatCronDuration(2_582_400)).toEqual({
      label: "43m 2s",
      exactLabel: "2582.4s (2582400ms)",
    });
    expect(formatCronDuration(750)).toEqual({ label: "750ms", exactLabel: "0.75s (750ms)" });
    expect(formatCronDuration(61_000).label).toBe("1m 1s");
  });

  it("separates stale-slot runtime from reconciliation delay and labels downstream jobs not started", () => {
    const abandonedRun = {
      startedAt: 1_000,
      durationMs: 2_580_000,
      status: "error" as const,
      metadata: {
        reason: "stale-slot-reconciled",
        progressUpdatedAt: 1_059,
        reconciledAt: 3_580,
      },
    };
    expect(formatCronRunStatus(abandonedRun.status, abandonedRun.metadata)).toBe("Abandoned");
    expect(formatCronRunTiming(abandonedRun)).toEqual({
      duration: { label: "59s", exactLabel: "59s (59000ms)" },
      unavailableLabel: null,
      note: "Last heartbeat after 59s; reconciled 42m 1s later.",
    });

    const notStartedRun = {
      startedAt: 3_580,
      durationMs: 0,
      status: "error" as const,
      metadata: {
        reason: "stale-slot-reconciled",
        childDisposition: "not_started",
        reconciledAt: 3_580,
      },
    };
    expect(formatCronRunStatus(notStartedRun.status, notStartedRun.metadata)).toBe(
      "Not started: upstream abandoned",
    );
    expect(formatCronRunTiming(notStartedRun)).toEqual({
      duration: null,
      unavailableLabel: "N/A",
      note: "Did not start because the parent slot was abandoned.",
    });

    const prerequisiteIncompleteRun = {
      startedAt: 3_600,
      durationMs: 0,
      status: "degraded" as const,
      metadata: {
        skippedReason: "upstream-incomplete:sync-live-reserves",
        childDisposition: "not_started",
      },
    };
    expect(formatCronRunStatus(prerequisiteIncompleteRun.status, prerequisiteIncompleteRun.metadata)).toBe(
      "Not started: upstream incomplete",
    );
    expect(formatCronRunTiming(prerequisiteIncompleteRun)).toEqual({
      duration: null,
      unavailableLabel: "N/A",
      note: "Did not start because the prerequisite job did not complete.",
    });

    for (const [skippedReason, expectedLabel] of [
      ["upstream-failure:snapshot-safety-grade-history", "Not started: prerequisite failed"],
      ["upstream-blocked:snapshot-supply", "Not started: prerequisite blocked"],
    ] as const) {
      const prerequisiteRun = {
        ...prerequisiteIncompleteRun,
        metadata: { skippedReason, childDisposition: "not_started" },
      };
      expect(formatCronRunStatus(prerequisiteRun.status, prerequisiteRun.metadata)).toBe(expectedLabel);
      expect(formatCronRunTiming(prerequisiteRun).unavailableLabel).toBe("N/A");
    }
  });

  it("retains lease, orphan, and latest-attempt evidence on selected model rows", () => {
    const cron = makeCron({
      staleArtifacts: [
        { kind: "expired-lease", job: "sync-stablecoins", leaseOwner: "owner-a", leaseUntil: 123 },
        {
          kind: "orphaned-progress",
          job: "sync-stablecoins",
          progressStage: "prices",
          progressUpdatedAt: 456,
        },
      ],
      latestAttempt: {
        attemptId: "attempt-1",
        idempotencyKey: "slot-1",
        scheduleKey: "quarterHourly",
        job: "sync-stablecoins",
        slotStartedAt: 100,
        producerPath: "quarterHourly",
        producerKind: "scheduled-job",
        invocationId: "invocation-1",
        workerVersion: "version-1",
        state: "running",
        statusClass: null,
        attemptNo: 2,
        owner: "owner-a",
        leaseUntil: 999,
        queuedAt: 90,
        claimedAt: 95,
        startedAt: 100,
        lastHeartbeatAt: 110,
        finishedAt: null,
        updatedAt: 110,
        durationMs: null,
        itemCount: null,
        stale: true,
        error: null,
      },
    });
    const row = buildCronWorkbenchModel(
      [{ key: "q", title: "Quarter", badge: "q", description: "q", entries: [["sync-stablecoins", cron]] }],
      makeFilters(),
    ).rows[0]!;

    expect(row.cron.staleArtifacts).toEqual(cron.staleArtifacts);
    expect(row.cron.latestAttempt).toEqual(cron.latestAttempt);
  });

  it("projects budget-only surfaces by real schedule key with severity and registry-order ties", () => {
    const groups = buildBudgetOnlySurfaceGroups([
      makeBudgetSurface({ telemetryStatus: "stale", outcome: "degraded" }),
      makeBudgetSurface({
        job: "telegram-digest-outbox-drain",
        label: "Telegram digest outbox drain",
        scheduleKey: "digestTriggerPoll",
        schedule: "*/5 * * * *",
        telemetryStatus: "stale",
        outcome: "degraded",
      }),
      makeBudgetSurface({
        job: "digest-trigger-poll",
        label: "Manual digest trigger poll",
        scheduleKey: "digestTriggerPoll",
        schedule: "*/5 * * * *",
        telemetryStatus: "stale",
        outcome: "degraded",
      }),
    ]);

    expect(groups.map((group) => group.scheduleKey)).toEqual(["fiveMinuteTelegramAlerts", "digestTriggerPoll"]);
    expect(groups[0]?.rows.map((row) => row.job)).toEqual(["telegram-registration-reconciliation"]);
    expect(groups[0]?.summary).toMatchObject({ total: 1, stale: 1, errors: 0 });
    expect(groups[1]?.rows.map((row) => row.job)).toEqual(["telegram-digest-outbox-drain", "digest-trigger-poll"]);
    expect(groups[1]?.summary).toMatchObject({ total: 2, stale: 2, errors: 0 });
  });

  it("returns explicit empty models for missing cron and budget telemetry", () => {
    expect(buildCronWorkbenchModel([], makeFilters())).toMatchObject({
      groups: [],
      rows: [],
      totalCount: 0,
      filteredCount: 0,
    });
    expect(buildBudgetOnlySurfaceGroups([])).toEqual([]);
  });
});
