import { describe, expect, it } from "vitest";
import { CRON_CONNECTION_BUDGET_ENTRIES } from "../../shared/lib/cron-jobs";
import { evaluateCronConnectionBudget } from "./check-cron-connection-budget";

describe("check-cron-connection-budget", () => {
  it("models sync-stablecoins at the bounded provider fanout peak", () => {
    const report = evaluateCronConnectionBudget();
    const quarterHourly = report.triggerReports.find((trigger) => trigger.scheduleKey === "quarterHourly");
    const syncStablecoins = CRON_CONNECTION_BUDGET_ENTRIES.find((entry) => entry.job === "sync-stablecoins");

    expect(syncStablecoins?.maxConnections).toBe(4);
    expect(quarterHourly?.groups.get("quarter-hourly-chain")?.peak).toBe(4);
    expect(quarterHourly?.chains).toEqual([
      {
        chainKey: "chain-1",
        jobs: [
          "sync-fx-rates",
          "sync-stablecoins",
          "snapshot-supply",
          "snapshot-chain-supply",
          "sync-v9-supply-attribution",
          "publish-report-card-cache",
          "compute-depeg-resolver",
        ],
        peak: 4,
      },
    ]);
    expect(quarterHourly?.totalConnections).toBe(4);
    expect(report.failed).toBe(false);
  });

  it("models sync-dex-liquidity-stage at its nested direct-API peak", () => {
    const report = evaluateCronConnectionBudget();
    const halfHourlyOffset = report.triggerReports.find((trigger) => trigger.scheduleKey === "halfHourlyOffset");
    const syncDexLiquidityStage = CRON_CONNECTION_BUDGET_ENTRIES.find(
      (entry) => entry.job === "sync-dex-liquidity-stage",
    );

    expect(syncDexLiquidityStage?.maxConnections).toBe(5);
    expect(halfHourlyOffset?.totalConnections).toBe(5);
    expect(report.headroomFullTriggers.map((trigger) => trigger.scheduleKey)).toContain("halfHourlyOffset");
    expect(report.failed).toBe(false);
  });

  it("sums independent parallel chains even when they share a connection group", () => {
    const report = evaluateCronConnectionBudget({
      budget: {
        maxPerTrigger: 6,
        failAt: 6,
        fullForNewFetchHeavyWorkAt: 5,
      },
      entries: [
        {
          job: "chain-a",
          maxConnections: 4,
          connectionGroup: "shared-chain",
          scheduleKey: "testParallel",
          statusTracked: true,
        },
        {
          job: "chain-b",
          maxConnections: 3,
          connectionGroup: "shared-chain",
          scheduleKey: "testParallel",
          statusTracked: true,
        },
      ],
      schedules: { testParallel: "* * * * *" },
      slotPlans: {
        testParallel: {
          jobChains: [["chain-a"], ["chain-b"]],
        },
      },
    });

    expect(report.triggerReports[0]?.groups.get("shared-chain")?.peak).toBe(4);
    expect(report.triggerReports[0]?.parallelConnections).toBe(7);
    expect(report.triggerReports[0]?.totalConnections).toBe(7);
    expect(report.failed).toBe(true);
  });

  it("uses the max peak inside a serial chain", () => {
    const report = evaluateCronConnectionBudget({
      entries: [
        {
          job: "first",
          maxConnections: 4,
          scheduleKey: "testSerial",
          statusTracked: true,
        },
        {
          job: "second",
          maxConnections: 3,
          scheduleKey: "testSerial",
          statusTracked: true,
        },
      ],
      schedules: { testSerial: "* * * * *" },
      slotPlans: {
        testSerial: {
          jobChains: [["first", "second"]],
        },
      },
    });

    expect(report.triggerReports[0]?.parallelConnections).toBe(4);
    expect(report.triggerReports[0]?.totalConnections).toBe(4);
    expect(report.failed).toBe(false);
  });
});
