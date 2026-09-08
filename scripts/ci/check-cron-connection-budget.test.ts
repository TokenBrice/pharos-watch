import { describe, expect, it } from "vitest";
import { CRON_CONNECTION_BUDGET_ENTRIES } from "@shared/lib/cron-jobs";
import { evaluateCronConnectionBudget } from "./check-cron-connection-budget";

describe("check-cron-connection-budget", () => {
  const reviewedReport = evaluateCronConnectionBudget();
  it("keeps the reviewed registry within its budget", () => {
    expect(reviewedReport.failed).toBe(false);
    expect(reviewedReport.headroomFullTriggers.map((trigger) => trigger.scheduleKey)).toContain("halfHourlyOffset");
    expect(reviewedReport.triggerReports.find((trigger) => trigger.scheduleKey === "halfHourlyOffset")?.totalConnections).toBe(5);
    expect(reviewedReport.triggerReports.find((trigger) => trigger.scheduleKey === "quarterHourly")?.groups.get("quarter-hourly-chain")?.peak).toBe(4);
  });

  it.each([
    ["quarterHourly", ["sync-fx-rates", "sync-stablecoins", "snapshot-supply", "snapshot-chain-supply"], 4],
    ["v9SupplyAttributionOffset", ["sync-v9-supply-attribution"], 3],
    ["depegResolverOffset", ["compute-depeg-resolver"], 0],
    ["v9PublicationOffset", ["compute-safety-score-v9"], 0],
    ["halfHourlyChartsOffset", ["sync-dex-liquidity", "cron-sentinel", "prepare-safety-score-v9-input", "sync-stablecoin-charts"], 3],
  ] as const)("preserves reviewed %s serial topology", (scheduleKey, jobs, peak) => {
    const trigger = reviewedReport.triggerReports.find((entry) => entry.scheduleKey === scheduleKey);
    expect(trigger?.chains).toEqual([{ chainKey: "chain-1", jobs, peak }]);
    expect(trigger?.totalConnections).toBe(peak);
  });

  it.each([
    ["sync-stablecoins", 4], ["compute-depeg-resolver", 0], ["compute-safety-score-v9", 0],
    ["sync-dex-liquidity-stage", 5], ["prepare-safety-score-v9-input", 3],
  ] as const)("preserves reviewed %s job pressure", (job, peak) => {
    expect(CRON_CONNECTION_BUDGET_ENTRIES.find((entry) => entry.job === job)?.maxConnections).toBe(peak);
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

  it("fails independently for a missing schedule plan or job", () => {
    const missingPlan = evaluateCronConnectionBudget({ entries: [], schedules: { slot: "*" }, slotPlans: {} });
    expect(missingPlan).toMatchObject({ failed: true, missingBudgetScheduleKeys: ["slot"], missingBudgetJobs: [] });
    const missingJob = evaluateCronConnectionBudget({
      entries: [], schedules: { slot: "*" }, slotPlans: { slot: { jobChains: [["absent"]] } },
    });
    expect(missingJob).toMatchObject({ failed: true, missingBudgetScheduleKeys: [], missingBudgetJobs: ["slot:absent"] });
  });

  it("prefers the same schedule and accepts only unambiguous cross-schedule budgets", () => {
    const entry = (scheduleKey: string, maxConnections: number) => ({ job: "job", scheduleKey, maxConnections, statusTracked: true });
    const evaluate = (entries: { job: string; scheduleKey: string; maxConnections: number; statusTracked: boolean }[]) => evaluateCronConnectionBudget({
      entries, schedules: { slot: "*" }, slotPlans: { slot: { jobChains: [["job"]] } },
    });
    const local = evaluate([entry("other", 5), entry("slot", 2)]);
    expect(local.failed).toBe(false);
    expect(local.triggerReports[0].totalConnections).toBe(2);
    const unique = evaluate([entry("other", 3)]);
    expect(unique.failed).toBe(false);
    expect(unique.triggerReports[0].totalConnections).toBe(3);
    expect(evaluate([entry("other", 2), entry("another", 3)])).toMatchObject({
      failed: true, missingBudgetJobs: ["slot:job (ambiguous budget entry)"],
    });
  });

  it("competes budget-only pressure against parallel pressure instead of adding it", () => {
    for (const budgetOnlyPeak of [1, 4]) {
      const report = evaluateCronConnectionBudget({
        entries: [
          { job: "a", scheduleKey: "slot", maxConnections: 1, statusTracked: true },
          { job: "b", scheduleKey: "slot", maxConnections: 2, statusTracked: true },
          { job: "budget", scheduleKey: "slot", maxConnections: budgetOnlyPeak, statusTracked: false },
        ],
        schedules: { slot: "*" },
        slotPlans: { slot: { jobChains: [["a"], ["b"]], budgetOnlyJobs: ["budget"] } },
      });
      expect(report.triggerReports[0]).toMatchObject({
        parallelConnections: 3, totalConnections: budgetOnlyPeak === 1 ? 3 : 4,
      });
      expect(report.failed).toBe(false);
    }
  });

  it("warns at exact headroom and fails at exact capacity with failure taking precedence", () => {
    for (const [peak, failed, warnings] of [[4, false, []], [5, false, ["slot"]], [6, true, []]] as const) {
      const report = evaluateCronConnectionBudget({
        budget: { maxPerTrigger: 6, failAt: 6, fullForNewFetchHeavyWorkAt: 5 },
        entries: [{ job: "job", scheduleKey: "slot", maxConnections: peak, statusTracked: true }],
        schedules: { slot: "*" }, slotPlans: { slot: { jobChains: [["job"]] } },
      });
      expect(report.failed).toBe(failed);
      expect(report.headroomFullTriggers.map((trigger) => trigger.scheduleKey)).toEqual(warnings);
    }
  });

  it("allows exact growth limits and fails each independent exceedance", () => {
    for (const [entryLimit, triggerLimit, entryExceeded, triggerExceeded] of [
      [1, 1, false, false], [0, 1, true, false], [1, 0, false, true],
    ] as const) {
      const report = evaluateCronConnectionBudget({
        budget: { maxPerTrigger: 6, failAt: 6, fullForNewFetchHeavyWorkAt: 5 },
        growthPolicy: {
          maxFetchCapableEntriesBeforeRebalance: entryLimit,
          maxHeadroomFullTriggersBeforeRebalance: triggerLimit,
          queuesOrWorkflowsReview: { connectionPressureAt: 5, fanoutPerRun: 100, p95DurationMs: 60_000 },
        },
        entries: [{ job: "job", scheduleKey: "slot", maxConnections: 5, statusTracked: true }],
        schedules: { slot: "*" }, slotPlans: { slot: { jobChains: [["job"]] } },
      });
      expect(report).toMatchObject({
        fetchCapableEntryLimitExceeded: entryExceeded, headroomFullTriggerLimitExceeded: triggerExceeded,
        failed: entryExceeded || triggerExceeded,
      });
    }
  });
});
