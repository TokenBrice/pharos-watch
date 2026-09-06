import { describe, expect, it } from "vitest";

import {
  collectTelegramAdoptionReport,
  renderTelegramAdoptionBlock,
  type TelegramAdoptionReport,
} from "../maintenance/report-telegram-adoption";

const NOW_SEC = 1_700_000_000;
const DAY_SEC = 24 * 60 * 60;
const CAPTURE_SEC = 14 * DAY_SEC;

type FixtureCronRow = {
  job: string;
  started_at: number;
  slot_started_at: number;
  duration_ms?: number;
  metadata: string;
};

type FixtureLatencyRow = {
  source_event_id: string;
  detected_at: number;
  first_enqueued_at: number | null;
};

interface FixtureOptions {
  cronRows: FixtureCronRow[];
  latencyRows?: FixtureLatencyRow[];
}

function dispatchRun(
  startedAtSec: number,
  metadata: Record<string, unknown>,
): FixtureCronRow {
  return {
    job: "dispatch-telegram-alerts",
    started_at: startedAtSec,
    slot_started_at: startedAtSec,
    metadata: JSON.stringify(metadata),
  };
}

function laneRun(job: string, startedAtSec: number, metadata: Record<string, unknown>): FixtureCronRow {
  return {
    job,
    started_at: startedAtSec,
    slot_started_at: startedAtSec,
    metadata: JSON.stringify(metadata),
  };
}

/**
 * A full 14-day five-minute-lane capture: dispatch runs at both edges of the
 * window plus one other lane job, all carrying rows-written counters.
 */
function completeCaptureFixture(options: {
  dispatchPlanningRows: number[];
  otherLaneRows: Array<{ job: string; d1RowsWritten: number }>;
  latencyRows: FixtureLatencyRow[];
}): FixtureOptions {
  const dispatchRows = [
    dispatchRun(NOW_SEC - CAPTURE_SEC, {
      planningRowsWritten: options.dispatchPlanningRows[0] ?? 0,
      d1RowsWritten: 40,
      noWorkRun: false,
    }),
    dispatchRun(NOW_SEC - CAPTURE_SEC + 300, {
      planningRowsWritten: options.dispatchPlanningRows[1] ?? 0,
      d1RowsWritten: 40,
      noWorkRun: true,
    }),
    dispatchRun(NOW_SEC - 300, {
      planningRowsWritten: options.dispatchPlanningRows[2] ?? 0,
      d1RowsWritten: 40,
      noWorkRun: false,
    }),
  ];
  const otherRows = options.otherLaneRows.map((row, index) =>
    laneRun(row.job, NOW_SEC - 240 - index * 60, { d1RowsWritten: row.d1RowsWritten }),
  );
  return { cronRows: [...dispatchRows, ...otherRows], latencyRows: options.latencyRows };
}

function fixtureClient(options: FixtureOptions) {
  const latencyRows = options.latencyRows ?? [];
  return {
    query<T>(sql: string): T[] {
      if (sql.includes("FROM telegram_subscribers")) {
        return [{ subscriber_count: 855, active_watchers_7d: 11 }] as T[];
      }
      if (sql.includes("FROM telegram_watcher_lifecycle_daily")) {
        return [
          { day: "2023-11-13", active_watchers: 12 },
          { day: "2023-11-14", active_watchers: 14 },
        ] as T[];
      }
      if (sql.includes("FROM telegram_usage_daily")) {
        return [
          { day: "2023-11-13", event_type: "daily_active", outcome: "success", count: 9 },
          { day: "2023-11-14", event_type: "daily_active", outcome: "success", count: 11 },
        ] as T[];
      }
      if (sql.includes("FROM telegram_alert_job_targets")) {
        return [
          { final_delivery_at: NOW_SEC - 2 * DAY_SEC },
          { final_delivery_at: NOW_SEC - 10 * DAY_SEC },
        ] as T[];
      }
      if (sql.includes("FROM telegram_alert_source_events")) return latencyRows as T[];
      if (sql.includes("FROM cron_runs")) return options.cronRows as T[];
      throw new Error(`Unexpected query: ${sql}`);
    },
    queryRaw: () => "",
    executeStatements: () => undefined,
  };
}

describe("Telegram adoption reporter", () => {
  it("reports a measured below-threshold capture without proceeding", () => {
    const report = collectTelegramAdoptionReport(
      fixtureClient(completeCaptureFixture({
        dispatchPlanningRows: [10, 0, 10],
        otherLaneRows: [{ job: "telegram-pulse-snapshot", d1RowsWritten: 150 }],
        latencyRows: [
          { source_event_id: "ev-1", detected_at: NOW_SEC - 7 * DAY_SEC, first_enqueued_at: NOW_SEC - 7 * DAY_SEC + 60 },
          { source_event_id: "ev-2", detected_at: NOW_SEC - 3 * DAY_SEC, first_enqueued_at: NOW_SEC - 3 * DAY_SEC + 120 },
        ],
      })),
      NOW_SEC,
    );

    expect(report.adoption).toEqual({
      subscriberCount: 855,
      activeWatchers7d: 14,
      dailyActive: 14,
      alertsSent7d: 1,
      alertsSent30d: 2,
    });
    expect(report.planning.dispatchInvocations).toBe(3);
    expect(report.planning.noWorkRunShare).toBeCloseTo(1 / 3);
    expect(report.planning.planningRowsWritten).toBe(20);
    expect(report.planning.fiveMinuteLaneD1Writes).toBe(270);
    expect(report.planning.planningWriteShare).toBeCloseTo(20 / 270);
    expect(report.planning.realSourceEvents).toBe(2);
    expect(report.planning.enqueuedSourceEvents).toBe(2);
    expect(report.planning.planningToFirstEnqueueMs.p95).toBe(117_000);
    expect(report.decision).toEqual({ state: "measured", reason: null, proceed41: false });

    const block = renderTelegramAdoptionBlock(report);
    expect(block).toContain("<!-- GENERATED-START: telegram-adoption -->");
    expect(block).toContain("<!-- GENERATED-END: telegram-adoption -->");
    expect(block).toContain("Status: **measured**");
    expect(block).toContain("Planning share of five-minute-lane D1 writes");
    expect(block).toContain("Planning→first-enqueue latency");
    expect(block).toContain("855");
  });

  it("proceeds when the measured planning write share exceeds 20% of lane writes", () => {
    const report = collectTelegramAdoptionReport(
      fixtureClient(completeCaptureFixture({
        dispatchPlanningRows: [60, 60, 0],
        otherLaneRows: [{ job: "telegram-pulse-snapshot", d1RowsWritten: 30 }],
        latencyRows: [
          { source_event_id: "ev-1", detected_at: NOW_SEC - DAY_SEC, first_enqueued_at: NOW_SEC - DAY_SEC + 30 },
        ],
      })),
      NOW_SEC,
    );

    expect(report.planning.planningRowsWritten).toBe(120);
    expect(report.planning.fiveMinuteLaneD1Writes).toBe(150);
    expect(report.planning.planningWriteShare).toBeCloseTo(120 / 150, 5);
    expect(report.decision).toEqual({ state: "measured", reason: null, proceed41: true });
  });

  it("proceeds when a real source event first enqueues more than ten minutes after detection", () => {
    const detectedAt = NOW_SEC - 8 * DAY_SEC;
    const report = collectTelegramAdoptionReport(
      fixtureClient(completeCaptureFixture({
        dispatchPlanningRows: [5, 0, 5],
        otherLaneRows: [{ job: "telegram-pulse-snapshot", d1RowsWritten: 990 }],
        // Detected by one five-minute invocation; the enqueue handoff only
        // completed in a later invocation eleven minutes afterward.
        latencyRows: [
          { source_event_id: "ev-slow", detected_at: detectedAt, first_enqueued_at: detectedAt + 660 },
        ],
      })),
      NOW_SEC,
    );

    expect(report.planning.planningWriteShare).toBeCloseTo(10 / 1110, 5);
    expect(report.planning.planningToFirstEnqueueMs).toEqual({ p50: 660_000, p95: 660_000 });
    expect(report.decision).toEqual({ state: "measured", reason: null, proceed41: true });
  });

  it("stays undecided with an explicit reason for a single fresh dispatch row", () => {
    const report: TelegramAdoptionReport = collectTelegramAdoptionReport(
      fixtureClient({
        cronRows: [dispatchRun(NOW_SEC - 60, { planningRowsWritten: 5, d1RowsWritten: 20 })],
      }),
      NOW_SEC,
    );

    expect(report.decision).toEqual({ state: "undecided", reason: "capture-window-incomplete", proceed41: false });
    const block = renderTelegramAdoptionBlock(report);
    expect(block).toContain("undecided (capture-window-incomplete)");
    expect(block).not.toContain("Status: **measured**");
    expect(block).toContain("**false**");
  });

  it("stays undecided when a lane run is missing its rows-written denominator", () => {
    const report = collectTelegramAdoptionReport(
      fixtureClient({
        cronRows: [
          dispatchRun(NOW_SEC - CAPTURE_SEC, { planningRowsWritten: 30, d1RowsWritten: 40 }),
          dispatchRun(NOW_SEC - 300, { planningRowsWritten: 30, d1RowsWritten: 40 }),
          laneRun("telegram-pulse-snapshot", NOW_SEC - 240, {}),
        ],
        latencyRows: [
          { source_event_id: "ev-1", detected_at: NOW_SEC - DAY_SEC, first_enqueued_at: NOW_SEC - DAY_SEC + 30 },
        ],
      }),
      NOW_SEC,
    );

    expect(report.planning.planningRowsWritten).toBe(60);
    expect(report.planning.fiveMinuteLaneD1Writes).toBeNull();
    expect(report.planning.planningWriteShare).toBeNull();
    expect(report.decision).toEqual({ state: "undecided", reason: "write-share-denominator-missing", proceed41: false });
    expect(renderTelegramAdoptionBlock(report)).toContain("undecided (write-share-denominator-missing)");
  });

  it("stays undecided when the capture contains no real source events", () => {
    const report = collectTelegramAdoptionReport(
      fixtureClient(completeCaptureFixture({
        dispatchPlanningRows: [10, 0, 10],
        otherLaneRows: [{ job: "telegram-pulse-snapshot", d1RowsWritten: 150 }],
        latencyRows: [],
      })),
      NOW_SEC,
    );

    expect(report.planning.realSourceEvents).toBe(0);
    expect(report.decision).toEqual({ state: "undecided", reason: "no-real-source-events", proceed41: false });
  });

  it("does not pass the write-share threshold for a SELECT-heavy run with zero rows written", () => {
    const report = collectTelegramAdoptionReport(
      fixtureClient({
        cronRows: [
          dispatchRun(NOW_SEC - CAPTURE_SEC, {
            planningStatements: 500,
            planningRowsWritten: 0,
            d1Statements: 1_000,
            d1RowsWritten: 40,
            noWorkRun: false,
          }),
          dispatchRun(NOW_SEC - 300, {
            planningStatements: 0,
            planningRowsWritten: 0,
            d1Statements: 0,
            d1RowsWritten: 40,
            noWorkRun: false,
          }),
          laneRun("telegram-pulse-snapshot", NOW_SEC - 240, {
            d1Statements: 900,
            d1RowsWritten: 60,
          }),
        ],
        latencyRows: [
          { source_event_id: "ev-1", detected_at: NOW_SEC - DAY_SEC, first_enqueued_at: NOW_SEC - DAY_SEC + 30 },
        ],
      }),
      NOW_SEC,
    );

    // Hundreds of prepared statements (planningStatements/d1Statements) must
    // not substitute for rows written: the share is 0 of 180, so no proceed.
    expect(report.planning.planningRowsWritten).toBe(0);
    expect(report.planning.planningWriteShare).toBe(0);
    expect(report.decision).toEqual({ state: "measured", reason: null, proceed41: false });
  });

  it("fails closed and stays undecided without any dispatch rows", () => {
    const report = collectTelegramAdoptionReport(
      fixtureClient({ cronRows: [] }),
      NOW_SEC,
    );

    expect(report.planning.dispatchInvocations).toBe(0);
    expect(report.planning.noWorkRunShare).toBeNull();
    expect(report.decision).toEqual({ state: "undecided", reason: "capture-window-incomplete", proceed41: false });
    expect(renderTelegramAdoptionBlock(report)).toContain("undecided (capture-window-incomplete)");
  });
});
