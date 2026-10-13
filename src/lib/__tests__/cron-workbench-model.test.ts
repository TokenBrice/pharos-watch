import { describe, expect, it } from "vitest";
import type { BudgetOnlySurfaceStatus, CronStatus } from "@shared/types";
import {
  buildBudgetOnlySurfaceGroups,
  buildCronWorkbenchModel,
  classifyCronWorkbenchState,
  DEFAULT_CRON_WORKBENCH_FILTERS,
  deriveCronVerdict,
  formatCronGroupSummary,
  getCronNextExpected,
  getCronRunbooks,
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
  return { ...DEFAULT_CRON_WORKBENCH_FILTERS, verdict: "all", ...overrides };
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
    // sync-stablecoins is public critical and unhealthy; sync-fx-rates ran with warnings.
    expect(model.groups[0]?.summary).toEqual({ total: 3, visible: 3, act: 1, watch: 1, ok: 1, running: 0, unavailable: 0 });
    expect(model.verdictCounts).toEqual({ act: 1, watch: 1, ok: 1, running: 1, unavailable: 1 });
    expect(model.triggerGroups).toEqual([
      { value: "quarter-hourly", label: "15-minute slot", count: 3 },
      { value: "five-minute", label: "5-minute slot", count: 2 },
    ]);
  });

  it("shows findings on a successful watch-tier run as OK with a findings chip, not a warning", () => {
    const groups = makeGroups();
    groups[0]!.entries = [["status-self-check", makeCron({
      lastRun: { startedAt: 1_700_000_000, durationMs: 500, status: "ok", metadata: { quality: { reason: "probe-plane-degraded" } } },
    })]];
    const model = buildCronWorkbenchModel([groups[0]!], makeFilters(), 1_700_000_100);
    expect(model.rows[0]).toMatchObject({
      state: "healthy",
      verdict: "ok",
      statusLabel: "Succeeded",
      qualityReasons: ["probe-plane-degraded"],
      verdictReason: { code: "findings" },
    });
    expect(buildCronWorkbenchModel([groups[0]!], DEFAULT_CRON_WORKBENCH_FILTERS, 1_700_000_100).rows).toHaveLength(0);
    expect(formatCronRunStatus("ok", { quality: { reason: "producer-output-stale" } })).toBe("Succeeded with findings");
  });

  it("inherits findings behind neutral skips only while the required observation is fresh", () => {
    const run = { startedAt: 1_700_000_000, durationMs: 500, status: "ok" as const, metadata: { quality: { reasons: ["producer-output-stale"] } } };
    const skip = { startedAt: 1_700_000_100, durationMs: 0, status: "skipped_neutral" as const };
    const groups = makeGroups();
    groups[0]!.entries = [["cron-sentinel", makeCron({ lastRun: skip, recentRuns: [skip, run] })]];
    const fresh = buildCronWorkbenchModel([groups[0]!], makeFilters(), run.startedAt + 1_800);
    expect(fresh.rows[0]).toMatchObject({ state: "skipped", qualityReasons: ["producer-output-stale"], verdictReason: { code: "findings" } });
    expect(buildCronWorkbenchModel([groups[0]!], makeFilters(), run.startedAt + 1_801).rows[0]?.qualityReasons).toEqual([]);
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

  it("combines search, verdict, impact, and group filters", () => {
    const groups = makeGroups();
    const searched = buildCronWorkbenchModel(groups, makeFilters({ search: "stablecoin sync" }));
    expect(searched.rows.map((row) => row.job)).toEqual(["sync-stablecoins"]);

    const attention = buildCronWorkbenchModel(groups, { ...DEFAULT_CRON_WORKBENCH_FILTERS });
    expect(attention.rows.map((row) => row.job)).toEqual([
      "sync-stablecoins",
      "sync-fx-rates",
      "reserve-recovery",
      "dispatch-telegram-alerts",
    ]);

    const critical = buildCronWorkbenchModel(groups, makeFilters({ impact: "public-critical" }));
    expect(critical.rows.map((row) => row.job)).toEqual(["sync-stablecoins", "sync-fx-rates", "reserve-recovery"]);

    const group = buildCronWorkbenchModel(groups, makeFilters({ triggerGroup: "five-minute" }));
    expect(group.rows.map((row) => row.job)).toEqual(["reserve-recovery", "dispatch-telegram-alerts"]);

    const running = buildCronWorkbenchModel(groups, makeFilters({ verdict: "running" }));
    expect(running.rows.map((row) => row.job)).toEqual(["dispatch-telegram-alerts"]);

    const act = buildCronWorkbenchModel(groups, makeFilters({ verdict: "act" }));
    expect(act.rows.map((row) => row.job)).toEqual(["sync-stablecoins"]);
  });

  it("keeps a deep-linked job visible whatever the filters say", () => {
    const model = buildCronWorkbenchModel(makeGroups(), { ...DEFAULT_CRON_WORKBENCH_FILTERS }, undefined, "snapshot-chain-supply");
    expect(model.rows.map((row) => row.job)).toContain("snapshot-chain-supply");
    expect(model.groups[0]?.summary).toMatchObject({ total: 3, visible: 3, ok: 1 });
  });

  it("intersects all filters and drops any row failing a single predicate", () => {
    const groups: CronWorkbenchGroupInput[] = [
      {
        key: "five-minute",
        title: "Delivery",
        badge: "~5 min",
        description: "Delivery work.",
        entries: [
          ["sync-stablecoins", makeCron({ healthy: false })],
          ["reserve-recovery", makeCron()],
          ["custom-side-job", makeCron({ healthy: false })],
          ["sync-blacklist", makeCron({ healthy: false, inFlight: { startedAt: 1, updatedAt: 2, stale: false } })],
        ],
      },
      {
        key: "quarter-hourly",
        title: "Delivery",
        badge: "*/15",
        description: "Shared core ingestion.",
        entries: [["sync-stablecoins", makeCron({ healthy: false })]],
      },
    ];

    const model = buildCronWorkbenchModel(
      groups,
      makeFilters({
        search: "delivery",
        verdict: "act",
        impact: "public-critical",
        triggerGroup: "five-minute",
      }),
    );

    expect(model.rows.map((row) => row.job)).toEqual(["sync-stablecoins"]);
    expect(model.filteredCount).toBe(1);
    expect(model.groups.map((group) => group.key)).toEqual(["five-minute"]);
  });

  it("sorts rows by verdict, then state severity, before registry and source order", () => {
    const neutralRun = { startedAt: 1_700_000_000, durationMs: 200, status: "skipped_neutral" as const };
    const group: CronWorkbenchGroupInput = {
      key: "mixed",
      title: "Mixed",
      badge: "mixed",
      description: "Mixed severities.",
      entries: [
        ["custom-a-healthy", makeCron()],
        ["custom-b-running", makeCron({ inFlight: { startedAt: 1, updatedAt: 2, stale: false } })],
        ["custom-c-skipped", makeCron({ lastRun: neutralRun, recentRuns: [neutralRun], healthy: false })],
        ["custom-d-unknown", makeCron({ telemetryUnknown: true })],
        [
          "custom-e-degraded",
          makeCron({ lastRun: { startedAt: 1_700_000_000, durationMs: 500, status: "degraded" } }),
        ],
        ["custom-f-unhealthy", makeCron({ healthy: false })],
      ],
    };

    const rows = buildCronWorkbenchModel([group], makeFilters(), 1_700_000_600).rows;

    expect(rows.map((row) => row.job)).toEqual([
      "custom-f-unhealthy",
      "custom-e-degraded",
      "custom-c-skipped",
      "custom-d-unknown",
      "custom-b-running",
      "custom-a-healthy",
    ]);
  });

  it("scopes group verdict counts to visible rows while keeping the group total", () => {
    const model = buildCronWorkbenchModel(makeGroups(), makeFilters({ verdict: "running" }));

    expect(model.groups.map((group) => group.key)).toEqual(["five-minute"]);
    expect(model.groups[0]?.summary).toEqual({ total: 2, visible: 1, running: 1, act: 0, watch: 0, ok: 0, unavailable: 0 });
    expect(formatCronGroupSummary(model.groups[0]!.summary)).toBe("1 of 2 shown · 1 running");
    expect(model.totalCount).toBe(5);
    expect(model.filteredCount).toBe(1);
    expect(model.rows.map((row) => row.job)).toEqual(["dispatch-telegram-alerts"]);
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

  it("shows a fresh expected no-op as skipped without hiding missing availability evidence", () => {
    const neutralRun = { startedAt: 1_700_000_000, durationMs: 200, status: "skipped_neutral" as const };
    const cron = makeCron({
      lastRun: neutralRun,
      recentRuns: [neutralRun],
      healthy: false,
    });

    expect(classifyCronWorkbenchState(cron, 1_700_000_600)).toBe("skipped");

    const model = buildCronWorkbenchModel(
      [
        {
          key: "quarter-hourly",
          title: "15-minute slot",
          badge: "*/15",
          description: "Shared core ingestion.",
          entries: [["compute-safety-score-v9", cron]],
        },
      ],
      { ...DEFAULT_CRON_WORKBENCH_FILTERS },
      1_700_000_600,
    );

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({
      job: "compute-safety-score-v9",
      state: "skipped",
      rawStatus: "skipped_neutral",
      statusLabel: "Skipped: no work required",
    });
    // Backend availability still lacks success evidence, so the watch job stays in view.
    expect(model.rows[0]).toMatchObject({ verdict: "watch", verdictReason: { code: "no-fresh-run" } });
  });

  it("keeps a stale neutral skip unhealthy", () => {
    const neutralRun = { startedAt: 1_700_000_000, durationMs: 200, status: "skipped_neutral" as const };
    const cron = makeCron({
      lastRun: neutralRun,
      recentRuns: [neutralRun],
      healthy: false,
    });

    expect(classifyCronWorkbenchState(cron, 1_700_002_000)).toBe("unhealthy");
  });

  it.each([
    {
      name: "keeps a degraded required outcome in attention after a neutral skip",
      requiredStatus: "degraded",
      cronHealthy: true,
      expectedState: "degraded",
      expectedLabel: "Completed with warnings (latest required run)",
    },
    {
      name: "keeps a failed required outcome unhealthy after a neutral skip",
      requiredStatus: "error",
      cronHealthy: false,
      expectedState: "unhealthy",
      expectedLabel: "Failed (latest required run)",
    },
  ] as const)("$name", ({ requiredStatus, cronHealthy, expectedState, expectedLabel }) => {
    const neutralRun = { startedAt: 1_700_000_000, durationMs: 200, status: "skipped_neutral" as const };
    const requiredRun = { startedAt: 1_699_999_000, durationMs: 800, status: requiredStatus };
    const cron = makeCron({
      lastRun: neutralRun,
      recentRuns: [neutralRun, requiredRun],
      healthy: cronHealthy,
    });

    expect(classifyCronWorkbenchState(cron)).toBe(expectedState);

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
      state: expectedState,
      rawStatus: "skipped_neutral",
      statusLabel: expectedLabel,
    });
  });

  it("clears an inherited failure when the fresh skip proves the period's artifact exists", () => {
    // Backend parity for the 2026-09-23 snapshot-public-dataset incident: a
    // transient precheck error followed by `same_day_snapshot_exists` skips.
    // The lane must resolve to Skipped, not stay Unavailable until the next
    // day's real run.
    const neutralRun = {
      startedAt: 1_700_000_000,
      durationMs: 200,
      status: "skipped_neutral" as const,
      metadata: { reason: "same_day_snapshot_exists", snapshotDate: "2026-09-23" },
    };
    const errorRun = { startedAt: 1_699_999_000, durationMs: 1_600, status: "error" as const };
    const cron = makeCron({
      lastRun: neutralRun,
      recentRuns: [neutralRun, errorRun],
      expectedIntervalSec: 86_400,
      healthy: true,
    });

    expect(classifyCronWorkbenchState(cron, 1_700_000_600)).toBe("skipped");

    const model = buildCronWorkbenchModel(
      [
        {
          key: "daily",
          title: "Daily slot",
          badge: "daily",
          description: "Daily snapshot jobs.",
          entries: [["snapshot-public-dataset", cron]],
        },
      ],
      makeFilters(),
      1_700_000_600,
    );

    expect(model.rows[0]).toMatchObject({
      job: "snapshot-public-dataset",
      state: "skipped",
    });
    expect(model.rows[0]).toMatchObject({ verdict: "ok", verdictReason: { code: "skipped" } });
  });

  it.each([
    { order: "readback newer than the error", provenStartedAt: 1_699_999_500, errorStartedAt: 1_699_999_000, expected: "skipped" },
    { order: "error newer than the readback", provenStartedAt: 1_699_999_000, errorStartedAt: 1_699_999_500, expected: "unhealthy" },
  ] as const)("resolves an inherited failure against a proven skip behind generic admissions: $order", ({ provenStartedAt, errorStartedAt, expected }) => {
    // Backend parity for the 2026-09-29 snapshot-psi row: post-midnight
    // `before_daily_slot` skips sit in front of the evening readback that
    // superseded the abandoned slot's synthetic error.
    const neutralRun = {
      startedAt: 1_700_000_000,
      durationMs: 200,
      status: "skipped_neutral" as const,
      metadata: { reason: "before_daily_slot" },
    };
    const provenRun = {
      startedAt: provenStartedAt,
      durationMs: 200,
      status: "skipped_neutral" as const,
      metadata: { reason: "same_day_snapshot_exists" },
    };
    const errorRun = { startedAt: errorStartedAt, durationMs: 0, status: "error" as const };
    const cron = makeCron({
      lastRun: neutralRun,
      recentRuns: [neutralRun, ...[provenRun, errorRun].sort((a, b) => b.startedAt - a.startedAt)],
      expectedIntervalSec: 86_400,
      healthy: expected === "skipped",
    });

    expect(classifyCronWorkbenchState(cron, 1_700_000_600)).toBe(expected);
  });

  it("keeps an inherited failure unhealthy when the skip reason proves nothing", () => {
    const neutralRun = {
      startedAt: 1_700_000_000,
      durationMs: 200,
      status: "skipped_neutral" as const,
      metadata: { reason: "before_daily_slot" },
    };
    const errorRun = { startedAt: 1_699_999_000, durationMs: 1_600, status: "error" as const };
    const cron = makeCron({
      lastRun: neutralRun,
      recentRuns: [neutralRun, errorRun],
      healthy: false,
    });

    expect(classifyCronWorkbenchState(cron, 1_700_000_600)).toBe("unhealthy");
  });

  it("formats raw run values into readable labels", () => {
    expect(formatCronRunStatus("skipped_neutral")).toBe("Skipped: no work required");
    expect(
      formatCronRunStatus("skipped_neutral", { reason: "v9-competing-slot-active" }),
    ).toBe("Skipped: competing slot active");
    expect(formatCronRunStatus("skipped_locked")).toBe("Skipped: lease held");
    expect(formatCronRunStatus(null)).toBe("No runs");
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

  it("surfaces stale-artifact lease and progress evidence through row search", () => {
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
    });
    const groups: CronWorkbenchGroupInput[] = [
      {
        key: "q",
        title: "Quarter",
        badge: "q",
        description: "q",
        entries: [
          ["sync-stablecoins", cron],
          ["snapshot-chain-supply", makeCron()],
        ],
      },
    ];

    expect(buildCronWorkbenchModel(groups, makeFilters({ search: "owner-a" })).rows.map((row) => row.job)).toEqual([
      "sync-stablecoins",
    ]);
    expect(buildCronWorkbenchModel(groups, makeFilters({ search: "prices" })).rows.map((row) => row.job)).toEqual([
      "sync-stablecoins",
    ]);
    expect(
      buildCronWorkbenchModel(groups, makeFilters({ search: "owner-zzz" })).rows.map((row) => row.job),
    ).toEqual([]);
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

  it("orders mixed budget surfaces by severity and summarizes error and missing evidence", () => {
    const groups = buildBudgetOnlySurfaceGroups([
      makeBudgetSurface({ job: "custom-error", label: "Custom error", telemetryStatus: "fresh", outcome: "error" }),
      makeBudgetSurface({
        job: "custom-missing",
        label: "Custom missing",
        telemetryStatus: "missing",
        outcome: "unknown",
      }),
      makeBudgetSurface({
        job: "custom-unreadable",
        label: "Custom unreadable",
        telemetryStatus: "unreadable",
        outcome: "unknown",
      }),
      makeBudgetSurface({ job: "custom-stale", label: "Custom stale", telemetryStatus: "stale", outcome: "ok" }),
      makeBudgetSurface({ job: "custom-degraded", label: "Custom degraded", outcome: "degraded" }),
      makeBudgetSurface({ job: "custom-unknown", label: "Custom unknown", outcome: "unknown" }),
      makeBudgetSurface({ job: "custom-fresh", label: "Custom fresh" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows.map((row) => row.job)).toEqual([
      "custom-error",
      "custom-missing",
      "custom-unreadable",
      "custom-stale",
      "custom-degraded",
      "custom-unknown",
      "custom-fresh",
    ]);
    expect(groups[0]?.summary).toEqual({ total: 7, fresh: 4, stale: 1, missing: 1, unreadable: 1, errors: 1 });
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

describe("cron operator verdict", () => {
  const error = (startedAt: number) => ({ startedAt, durationMs: 100, status: "error" as const });

  it.each([
    { name: "public-critical job without a usable run", cron: makeCron({ healthy: false }), impact: "public-critical", verdict: "act", code: "no-fresh-run" },
    { name: "watch job without a usable run", cron: makeCron({ healthy: false }), impact: "admin-watch", verdict: "watch", code: "no-fresh-run" },
    {
      name: "watch job failing twice in a row",
      cron: makeCron({ healthy: false, lastRun: error(2), recentRuns: [error(2), { startedAt: 1, durationMs: 0, status: "skipped_neutral" as const }, error(0)] }),
      impact: "admin-watch",
      verdict: "act",
      code: "repeated-failures",
    },
    { name: "single failure on a watch job", cron: makeCron({ healthy: false, lastRun: error(2), recentRuns: [error(2)] }), impact: "admin-watch", verdict: "watch", code: "latest-run-failed" },
    {
      name: "run warnings",
      cron: makeCron({ lastRun: { startedAt: 1, durationMs: 1, status: "degraded" as const } }),
      impact: "public-critical",
      verdict: "watch",
      code: "run-warnings",
    },
    { name: "telemetry unknown", cron: makeCron({ telemetryUnknown: true, telemetryUnknownReason: "cron-history-read-failed" }), impact: "public-critical", verdict: "unavailable", code: "cron-history-read-failed" },
    {
      name: "a fresh in-flight retry after an abandoned failure",
      cron: makeCron({
        healthy: false,
        lastRun: { ...error(1), metadata: { reason: "stale-slot-reconciled" } },
        recentRuns: [{ ...error(1), metadata: { reason: "stale-slot-reconciled" } }, error(0)],
        inFlight: { startedAt: 10, updatedAt: 20, stale: false },
      }),
      impact: "public-critical",
      verdict: "running",
      code: "in-flight",
    },
    { name: "stale heartbeat on a critical job", cron: makeCron({ inFlight: { startedAt: 1, updatedAt: 2, stale: true } }), impact: "public-critical", verdict: "act", code: "stale-heartbeat" },
    {
      name: "findings on a critical job",
      cron: makeCron({ lastRun: { startedAt: 1, durationMs: 1, status: "ok" as const, metadata: { quality: { reason: "x" } } } }),
      impact: "public-critical",
      verdict: "watch",
      code: "findings",
    },
    { name: "healthy job", cron: makeCron(), impact: "public-critical", verdict: "ok", code: "ok" },
  ] as const)("$name -> $verdict", ({ cron, impact, verdict, code }) => {
    const state = classifyCronWorkbenchState(cron);
    const quality = cron.lastRun?.metadata?.quality ? ["x"] : [];
    expect(deriveCronVerdict(cron, impact, state, quality, 100)).toMatchObject({ verdict, code });
  });

  it("estimates the next run from the last start and cadence, naming the stale budget", () => {
    const cron = makeCron({ expectedIntervalSec: 900 });
    const start = 1_700_000_000;
    expect(getCronNextExpected(cron, start + 300)).toMatchObject({ kind: "scheduled", label: "in 10m" });
    expect(getCronNextExpected(cron, start + 1_200)).toMatchObject({ kind: "due", label: "Due 5m ago" });
    expect(getCronNextExpected(cron, start + 2_700)).toMatchObject({ kind: "overdue", label: "Overdue by 30m" });
    expect(getCronNextExpected(cron, start).budget).toBe("Expected every 15m, stale after 30m without a usable run.");
    expect(getCronNextExpected(makeCron({ inFlight: { startedAt: 1, updatedAt: 2, stale: false } }), start).kind).toBe("running");
    expect(getCronNextExpected(makeCron({ lastRun: null, recentRuns: [], telemetryUnknown: true }), start).label).toBe("Unknown");
  });

  it("formats group headers with scope and only non-zero counts", () => {
    expect(formatCronGroupSummary({ total: 6, visible: 6, act: 0, watch: 0, running: 0, unavailable: 0, ok: 6 })).toBe("6 jobs · 6 OK");
    expect(formatCronGroupSummary({ total: 6, visible: 1, act: 0, watch: 1, running: 0, unavailable: 0, ok: 0 })).toBe("1 of 6 shown · 1 watch");
  });

  it("orders runbooks from a naming status cause, then failure mode, then the job's own", () => {
    const [row] = buildCronWorkbenchModel(
      [{ key: "q", title: "Q", badge: "q", description: "q", entries: [["sync-stablecoins", makeCron({ healthy: false, inFlight: { startedAt: 1, updatedAt: 2, stale: true } })]] }],
      makeFilters(),
    ).rows;
    const links = getCronRunbooks(row!, [
      { layer: "availability", code: "x", severity: "warning", message: "m", subjects: ["sync-stablecoins"], runbookUrl: "https://example.test/x.md" },
      { layer: "availability", code: "y", severity: "warning", message: "m", subjects: ["other-job"], runbookUrl: "https://example.test/y.md" },
    ]);
    expect(links.map((link) => link.href.split("/").pop())).toEqual(["x.md", "lease-and-breaker-recovery.md", "stablecoins-cache.md"]);
    expect(links[1]?.label).toBe("Lease and breaker recovery runbook");
  });
});
