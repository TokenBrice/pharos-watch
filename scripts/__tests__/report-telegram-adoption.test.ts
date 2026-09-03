import { describe, expect, it } from "vitest";

import {
  collectTelegramAdoptionReport,
  renderTelegramAdoptionBlock,
} from "../maintenance/report-telegram-adoption";

const NOW_SEC = 1_700_000_000;

function fixtureClient() {
  const cronRows = [
    {
      job: "dispatch-telegram-alerts",
      duration_ms: 900_000,
      metadata: JSON.stringify({ planningMs: 900_000, planningStatements: 50, sourceEventsProcessed: 1, noWorkRun: false, d1Statements: 50 }),
    },
    {
      job: "dispatch-telegram-alerts",
      duration_ms: 100,
      metadata: JSON.stringify({ planningMs: 100, planningStatements: 0, noWorkRun: true, d1Statements: 50 }),
    },
    {
      job: "telegram-personalized-recap-planner",
      duration_ms: 20,
      metadata: JSON.stringify({ d1Statements: 100 }),
    },
    {
      job: "telegram-pulse-snapshot",
      duration_ms: 20,
      metadata: JSON.stringify({ d1Statements: 150 }),
    },
  ];
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
          { final_delivery_at: NOW_SEC - 2 * 24 * 60 * 60 },
          { final_delivery_at: NOW_SEC - 10 * 24 * 60 * 60 },
        ] as T[];
      }
      if (sql.includes("FROM cron_runs")) return cronRows as T[];
      throw new Error(`Unexpected query: ${sql}`);
    },
    queryRaw: () => "",
    executeStatements: () => undefined,
  };
}

describe("Telegram adoption reporter", () => {
  it("aggregates adoption and planning metrics and renders the decision block", () => {
    const report = collectTelegramAdoptionReport(fixtureClient(), NOW_SEC);

    expect(report.adoption).toEqual({
      subscriberCount: 855,
      activeWatchers7d: 14,
      dailyActive: 14,
      alertsSent7d: 1,
      alertsSent30d: 2,
    });
    expect(report.planning.dispatchInvocations).toBe(2);
    expect(report.planning.planningMs.p95).toBeGreaterThan(10 * 60 * 1000);
    expect(report.planning.noWorkRunShare).toBe(0.5);
    expect(report.planning.planningStatements).toBe(50);
    expect(report.planning.fiveMinuteLaneD1Statements).toBe(350);
    expect(report.planning.planningStatementFraction).toBeCloseTo(50 / 350);
    expect(report.decision.proceed41).toBe(true);

    const block = renderTelegramAdoptionBlock(report);
    expect(block).toContain("<!-- GENERATED-START: telegram-adoption -->");
    expect(block).toContain("<!-- GENERATED-END: telegram-adoption -->");
    expect(block).toContain("decision.proceed41");
    expect(block).toContain("**true**");
    expect(block).toContain("855");
  });

  it("fails closed and marks the block not yet measured without dispatch rows", () => {
    const emptyClient = fixtureClient();
    const report = collectTelegramAdoptionReport({
      ...emptyClient,
      query<T>(sql: string): T[] {
        if (sql.includes("FROM telegram_subscribers")) return [{ subscriber_count: 0, active_watchers_7d: 0 }] as T[];
        return [];
      },
    }, NOW_SEC);

    expect(report.planning.planningMs).toEqual({ p50: null, p95: null });
    expect(report.planning.noWorkRunShare).toBeNull();
    expect(report.decision.proceed41).toBe(false);
    expect(renderTelegramAdoptionBlock(report)).toContain("not yet measured");
  });
});
