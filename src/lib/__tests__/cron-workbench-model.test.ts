import { describe, expect, it } from "vitest";
import type { BudgetOnlySurfaceStatus, CronStatus } from "@shared/types";
import {
  buildBudgetOnlySurfaceGroups,
  buildCronWorkbenchModel,
  classifyCronWorkbenchState,
  DEFAULT_CRON_WORKBENCH_FILTERS,
  deriveCronVerdict,
  getCronNextExpected,
  getCronNextRunAt,
  getCronRunbooks,
  formatCronRunStatus,
  formatCronRunTiming,
  type CronWorkbenchFilters,
  type CronWorkbenchGroupInput,
} from "@/lib/cron-workbench-model";

function makeCron(overrides: Partial<CronStatus> = {}): CronStatus {
  return {
    runs: [{ startedAt: 1_700_000_000, durationMs: 1_200, status: "ok" }],
    confirmedOutputAt: null,
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
        ["sync-fx-rates", makeCron({ runs: [{ startedAt: 1_700_000_000, durationMs: 500, status: "degraded" }] })],
      ],
    },
    {
      key: "five-minute",
      title: "5-minute slot",
      badge: "~5 min",
      description: "Delivery work.",
      entries: [
        ["dispatch-telegram-alerts", makeCron({ inFlight: { startedAt: 1, updatedAt: 2, stale: false } })],
        ["reserve-recovery", makeCron({ telemetryUnknown: true, runs: [] })],
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
  it.each(["dispatch-telegram-alerts", "telegram-degradation-watchdog"])(
    "routes %s to the consolidated delivery runbook with a filename-derived label",
    (job) => {
      const group = makeGroups()[1]!;
      group.entries = [[job, makeCron()]];
      const model = buildCronWorkbenchModel([group], makeFilters(), 1_700_000_100);

      expect(getCronRunbooks(model.rows[0]!)).toEqual([
        {
          href: expect.stringContaining("/docs/runbooks/telegram-delivery.md"),
          label: "Telegram delivery runbook",
        },
      ]);
    },
  );

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
      runs: [{ startedAt: 1_700_000_000, durationMs: 500, status: "ok", qualityReasons: ["probe-plane-degraded"] }],
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
    expect(formatCronRunStatus("ok", { qualityReasons: ["producer-output-stale"] })).toBe("Succeeded with findings");
  });

  it("inherits findings behind neutral skips only while the required observation is fresh", () => {
    const run = { startedAt: 1_700_000_000, durationMs: 500, status: "ok" as const, qualityReasons: ["producer-output-stale"] };
    const skip = { startedAt: 1_700_000_100, durationMs: 0, status: "skipped_neutral" as const };
    const groups = makeGroups();
    groups[0]!.entries = [["cron-sentinel", makeCron({ runs: [skip, run] })]];
    const fresh = buildCronWorkbenchModel([groups[0]!], makeFilters(), run.startedAt + 1_800);
    expect(fresh.rows[0]).toMatchObject({ state: "skipped", qualityReasons: ["producer-output-stale"], verdictReason: { code: "findings" } });
    expect(buildCronWorkbenchModel([groups[0]!], makeFilters(), run.startedAt + 1_801).rows[0]?.qualityReasons).toEqual([]);
  });

  it.each(["sync-dex-liquidity", "sync-dex-liquidity-stage"])("keeps fresh %s findings in attention without changing execution or public impact", (job) => {
    const run = {
      startedAt: 1_700_000_000, durationMs: 500, status: "ok" as const,
      qualityReasons: ["source-failed:uniswap-v4-subgraph:ethereum"],
    };
    const skip = { startedAt: run.startedAt + 100, durationMs: 0, status: "skipped_neutral" as const };
    const group = makeGroups()[0]!;
    for (const latestRun of [run, skip]) {
      group.entries = [[job, makeCron({ runs: latestRun === run ? [run] : [skip, run] })]];
      const model = buildCronWorkbenchModel([group], DEFAULT_CRON_WORKBENCH_FILTERS, run.startedAt + 200);
      expect(model.rows).toHaveLength(1);
      expect(model.rows[0]).toMatchObject({
        state: latestRun === run ? "healthy" : "skipped",
        verdict: "watch",
        impactClass: "admin-watch",
        statusLabel: latestRun === run ? "Succeeded" : "Skipped: no work required",
        qualityReasons: ["source-failed:uniswap-v4-subgraph:ethereum"],
        verdictReason: { code: "findings" },
      });
    }
    group.entries = [[job, makeCron({ healthy: false, runs: [skip, run] })]];
    const expired = buildCronWorkbenchModel([group], DEFAULT_CRON_WORKBENCH_FILTERS, run.startedAt + 1_801);
    expect(expired.rows[0]).toMatchObject({ qualityReasons: [], verdictReason: { code: "no-fresh-run" } });
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
      runs: [neutralRun],
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
      runs: [neutralRun],
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
      expectedLabel: "Skipped: no work required",
    },
    {
      name: "keeps a failed required outcome unhealthy after a neutral skip",
      requiredStatus: "error",
      cronHealthy: false,
      expectedState: "unhealthy",
      expectedLabel: "Skipped: no work required",
    },
  ] as const)("$name", ({ requiredStatus, cronHealthy, expectedState, expectedLabel }) => {
    const neutralRun = { startedAt: 1_700_000_000, durationMs: 200, status: "skipped_neutral" as const };
    const requiredRun = { startedAt: 1_699_999_000, durationMs: 800, status: requiredStatus };
    const cron = makeCron({
      runs: [neutralRun, requiredRun],
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
      reason: "same_day_snapshot_exists",
    };
    const errorRun = { startedAt: 1_699_999_000, durationMs: 1_600, status: "error" as const };
    const cron = makeCron({
      runs: [neutralRun, errorRun],
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
      reason: "before_daily_slot",
    };
    const provenRun = {
      startedAt: provenStartedAt,
      durationMs: 200,
      status: "skipped_neutral" as const,
      reason: "same_day_snapshot_exists",
    };
    const errorRun = { startedAt: errorStartedAt, durationMs: 0, status: "error" as const };
    const cron = makeCron({
      runs: [neutralRun, ...[provenRun, errorRun].sort((a, b) => b.startedAt - a.startedAt)],
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
      reason: "before_daily_slot",
    };
    const errorRun = { startedAt: 1_699_999_000, durationMs: 1_600, status: "error" as const };
    const cron = makeCron({
      runs: [neutralRun, errorRun],
      healthy: false,
    });

    expect(classifyCronWorkbenchState(cron, 1_700_000_600)).toBe("unhealthy");
  });

  it("separates stale-slot runtime from reconciliation delay and labels downstream jobs not started", () => {
    const abandonedRun = {
      startedAt: 1_000,
      durationMs: 2_580_000,
      status: "error" as const,
      reason: "stale-slot-reconciled",
      progressUpdatedAt: 1_059,
      reconciledAt: 3_580,
    };
    expect(formatCronRunStatus(abandonedRun.status, abandonedRun)).toBe("Abandoned");
    expect(formatCronRunTiming(abandonedRun)).toEqual({
      duration: { label: "59s", exactLabel: "59s (59000ms)" },
      unavailableLabel: null,
      note: "Last heartbeat after 59s; reconciled 42m 1s later.",
    });

    const notStartedRun = {
      startedAt: 3_580,
      durationMs: 0,
      status: "error" as const,
      reason: "stale-slot-reconciled",
      childDisposition: "not_started",
      reconciledAt: 3_580,
    };
    expect(formatCronRunStatus(notStartedRun.status, notStartedRun)).toBe(
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
      skippedReason: "upstream-incomplete:sync-live-reserves",
      childDisposition: "not_started",
    };
    expect(formatCronRunStatus(prerequisiteIncompleteRun.status, prerequisiteIncompleteRun)).toBe(
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
        skippedReason, childDisposition: "not_started",
      };
      expect(formatCronRunStatus(prerequisiteRun.status, prerequisiteRun)).toBe(expectedLabel);
      expect(formatCronRunTiming(prerequisiteRun).unavailableLabel).toBe("N/A");
    }
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

  it("does not turn old required errors behind fresh neutral polls into repeated failures", () => {
    const skip = { startedAt: 10_000, durationMs: 1, status: "skipped_neutral" as const };
    const cron = makeCron({ healthy: false, runs: [skip, error(1), error(0)] });
    expect(deriveCronVerdict(cron, "admin-watch", classifyCronWorkbenchState(cron, 10_010), [], 10_010))
      .toMatchObject({ verdict: "watch", code: "no-fresh-run" });
  });

  it.each([
    { cron: makeCron({ runs: [], bootstrap: true }), code: "bootstrap", verdict: "ok" },
    { cron: makeCron({ runs: [] }), code: "no-runs", verdict: "unavailable" },
    { cron: makeCron({ runs: [{ startedAt: 100, durationMs: 1, status: "skipped_locked" }] }), code: "skipped", verdict: "ok" },
  ] as const)("describes $code without claiming a successful run", ({ cron, code, verdict }) => {
    const result = deriveCronVerdict(cron, "admin-watch", classifyCronWorkbenchState(cron), [], 100);
    expect(result).toMatchObject({ code, verdict });
    expect(result.sentence).not.toContain("succeeded");
  });

  it.each([
    ["snapshot-psi", "2026-10-14T07:17:00Z", "2026-10-14T08:00:00Z"],
    ["snapshot-public-dataset", "2026-10-14T08:17:00Z", "2026-10-15T08:00:00Z"],
    ["snapshot-chain-supply", "2026-10-14T07:17:00Z", "2026-10-14T07:30:00Z"],
    ["weekly-recap", "2026-10-14T07:17:00Z", "2026-10-14T08:10:00Z"],
    ["sync-v9-supply-attribution", "2026-10-14T07:17:00Z", "2026-10-14T07:23:00Z"],
    ["sync-cl-exit-depth", "2026-10-14T07:01:00Z", "2026-10-14T07:05:00Z"],
    ["sync-cl-exit-depth", "2026-10-14T07:05:00Z", "2026-10-14T07:35:00Z"],
    ["prune-cron-history", "2026-10-14T03:01:00Z", "2026-10-14T03:03:00Z"],
    ["yield-coverage-audit", "2026-10-14T07:17:00Z", "2026-11-01T06:00:00Z"],
    ["yield-coverage-audit", "2026-02-01T06:00:00Z", "2026-03-01T06:00:00Z"],
  ])("uses primary trigger opportunities for %s", (job, now, expected) => {
    const nowSeconds = Date.parse(now) / 1000;
    expect(getCronNextRunAt(job, nowSeconds)).toBe(Date.parse(expected) / 1000);
    expect(getCronNextExpected(makeCron(), nowSeconds, job).budget).toContain("Next primary trigger opportunity");
  });

  it("does not let a daily neutral admission reset the next daily opportunity", () => {
    const now = Date.parse("2026-10-14T07:17:00Z") / 1000;
    const cron = makeCron({ expectedIntervalSec: 86_400, runs: [{ startedAt: now - 1, durationMs: 1, status: "skipped_neutral" }] });
    expect(getCronNextExpected(cron, now, "snapshot-psi")).toMatchObject({ kind: "scheduled", label: "in 43m" });
  });

  it.each([
    { name: "public-critical job without a usable run", cron: makeCron({ healthy: false }), impact: "public-critical", verdict: "act", code: "no-fresh-run" },
    { name: "watch job without a usable run", cron: makeCron({ healthy: false }), impact: "admin-watch", verdict: "watch", code: "no-fresh-run" },
    {
      name: "watch job failing twice in a row",
      cron: makeCron({ healthy: false, runs: [error(2), { startedAt: 1, durationMs: 0, status: "skipped_neutral" as const }, error(0)] }),
      impact: "admin-watch",
      verdict: "act",
      code: "repeated-failures",
    },
    { name: "single failure on a watch job", cron: makeCron({ healthy: false, runs: [error(2)] }), impact: "admin-watch", verdict: "watch", code: "latest-run-failed" },
    {
      name: "run warnings",
      cron: makeCron({ runs: [{ startedAt: 1, durationMs: 1, status: "degraded" as const }] }),
      impact: "public-critical",
      verdict: "watch",
      code: "run-warnings",
    },
    { name: "telemetry unknown", cron: makeCron({ telemetryUnknown: true, telemetryUnknownReason: "cron-history-read-failed" }), impact: "public-critical", verdict: "unavailable", code: "cron-history-read-failed" },
    {
      name: "a fresh in-flight retry after an abandoned failure",
      cron: makeCron({
        healthy: false,
        runs: [{ ...error(1), reason: "stale-slot-reconciled" }, error(0)],
        inFlight: { startedAt: 10, updatedAt: 20, stale: false },
      }),
      impact: "public-critical",
      verdict: "running",
      code: "in-flight",
    },
    { name: "stale heartbeat on a critical job", cron: makeCron({ inFlight: { startedAt: 1, updatedAt: 2, stale: true } }), impact: "public-critical", verdict: "act", code: "stale-heartbeat" },
    {
      name: "findings on a critical job",
      cron: makeCron({ runs: [{ startedAt: 1, durationMs: 1, status: "ok" as const, qualityReasons: ["x"] }] }),
      impact: "public-critical",
      verdict: "watch",
      code: "findings",
    },
    { name: "healthy job", cron: makeCron(), impact: "public-critical", verdict: "ok", code: "ok" },
  ] as const)("$name -> $verdict", ({ cron, impact, verdict, code }) => {
    const state = classifyCronWorkbenchState(cron);
    const quality = cron.runs[0]?.qualityReasons ?? [];
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
    expect(getCronNextExpected(makeCron({ runs: [], telemetryUnknown: true }), start).label).toBe("Unknown");
  });

});
