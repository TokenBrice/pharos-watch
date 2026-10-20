import { describe, expect, it } from "vitest";
import { evaluateCronConnectionBudget } from "./check-cron-connection-budget";

describe("check-cron-connection-budget", () => {
  const reviewedReport = evaluateCronConnectionBudget();
  it("keeps the reviewed registry within its budget", () => {
    expect(reviewedReport.failed).toBe(false);
    expect(reviewedReport.headroomFullTriggers.map((trigger) => trigger.scheduleKey)).toContain("halfHourlyOffset");
    expect(reviewedReport.triggerReports.find((trigger) => trigger.scheduleKey === "halfHourlyOffset")?.totalConnections).toBe(5);
    expect(reviewedReport.triggerReports.find((trigger) => trigger.scheduleKey === "quarterHourly")?.groups.get("quarter-hourly-chain")?.peak).toBe(4);
  });

  it("declares Queue recovery separately with serial send and unchanged cron peaks", () => {
    expect(reviewedReport.nonCronReports).toEqual([{
      surface: "reserve-continuation", worker: "public", totalConnections: 3, postSettlementSendConnections: 1,
    }]);
    expect(reviewedReport.triggerReports.find((entry) => entry.scheduleKey === "fourHourlyReserveSync")?.totalConnections).toBe(4);
    expect(reviewedReport.triggerReports.find((entry) => entry.scheduleKey === "fiveMinuteReserveRecovery")?.totalConnections).toBe(3);
  });

  it.each([
    // Aave follows stablecoins before the same-day PSI and public-dataset catch-ups; the serial peak stays four.
    ["quarterHourly", ["sync-fx-rates", "sync-stablecoins", "sync-yield-supplemental", "snapshot-supply", "snapshot-chain-supply", "snapshot-psi", "snapshot-public-dataset"], 4],
    ["v9SupplyAttributionOffset", ["sync-v9-supply-attribution"], 3],
    ["depegResolverOffset", ["compute-depeg-resolver"], 0],
    ["v9PublicationOffset", ["compute-safety-score-v9"], 0],
    // The D1-only consumer's bounded inline stage-recovery re-run reuses the
    // stage job's nested direct-API peak, so the serial chain peaks at 5.
    ["halfHourlyChartsOffset", ["sync-dex-liquidity", "cron-sentinel", "prepare-safety-score-v9-input", "sync-stablecoin-charts"], 5],
  ] as const)("preserves reviewed %s serial topology", (scheduleKey, jobs, peak) => {
    const trigger = reviewedReport.triggerReports.find((entry) => entry.scheduleKey === scheduleKey);
    expect(trigger?.chains).toEqual([{ chainKey: "chain-1", jobs, peak }]);
    expect(trigger?.totalConnections).toBe(peak);
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
          worker: "public",
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
          worker: "public",
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
      entries: [], schedules: { slot: "*" }, slotPlans: { slot: { worker: "public", jobChains: [["absent"]] } },
    });
    expect(missingJob).toMatchObject({ failed: true, missingBudgetScheduleKeys: [], missingBudgetJobs: ["slot:absent"] });
  });

  it("requires an exact schedule budget entry", () => {
    const entry = (scheduleKey: string, maxConnections: number) => ({ job: "job", scheduleKey, maxConnections, statusTracked: true });
    const evaluate = (entries: { job: string; scheduleKey: string; maxConnections: number; statusTracked: boolean }[]) => evaluateCronConnectionBudget({
      entries, schedules: { slot: "*" }, slotPlans: { slot: { worker: "public", jobChains: [["job"]] } },
    });
    const local = evaluate([entry("other", 5), entry("slot", 2)]);
    expect(local.failed).toBe(false);
    expect(local.triggerReports[0].totalConnections).toBe(2);
    const unique = evaluate([entry("other", 3)]);
    expect(unique).toMatchObject({
      failed: true,
      missingBudgetJobs: [],
      mismatchedBudgetJobs: ["slot:job (budget entry uses other)"],
    });
    expect(unique.triggerReports[0].totalConnections).toBe(0);
    expect(evaluate([entry("other", 2), entry("another", 3)])).toMatchObject({
      failed: true,
      missingBudgetJobs: [],
      mismatchedBudgetJobs: ["slot:job (budget entry uses other, another)"],
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
        slotPlans: { slot: { worker: "public", jobChains: [["a"], ["b"]], budgetOnlyJobs: ["budget"] } },
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
        schedules: { slot: "*" }, slotPlans: { slot: { worker: "public", jobChains: [["job"]] } },
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
        schedules: { slot: "*" }, slotPlans: { slot: { worker: "public", jobChains: [["job"]] } },
      });
      expect(report).toMatchObject({
        fetchCapableEntryLimitExceeded: entryExceeded, headroomFullTriggerLimitExceeded: triggerExceeded,
        failed: entryExceeded || triggerExceeded,
      });
    }
  });
  it("counts a shared job once across exact schedule budget entries", () => {
    const report = evaluateCronConnectionBudget({
      entries: [
        {
          job: "shared-job",
          maxConnections: 1,
          scheduleKey: "slot-a",
          statusTracked: true,
        },
        {
          job: "shared-job",
          maxConnections: 1,
          scheduleKey: "slot-b",
          statusTracked: true,
        },
      ],
      growthPolicy: {
        maxFetchCapableEntriesBeforeRebalance: 1,
        maxHeadroomFullTriggersBeforeRebalance: 0,
        queuesOrWorkflowsReview: { p95DurationMs: 600_000, fanoutPerRun: 1_000, connectionPressureAt: 5 },
      },
      schedules: {
        "slot-a": "1 * * * *",
        "slot-b": "2 * * * *",
      },
      slotPlans: {
        "slot-a": { worker: "public", jobChains: [["shared-job"]] },
        "slot-b": { worker: "heavy", jobChains: [["shared-job"]] },
      },
    });

    expect(report.fetchCapableEntryCount).toBe(1);
    expect(report.fetchCapableEntryLimitExceeded).toBe(false);
    expect(report.failed).toBe(false);
  });
  it("enforces aggregate growth rather than resetting it per Worker", () => {
    const report = evaluateCronConnectionBudget({
      schedules: { a: "1 * * * *", b: "2 * * * *" },
      slotPlans: {
        a: { worker: "public", jobChains: [["a"]] },
        b: { worker: "heavy", jobChains: [["b"]] },
      },
      entries: [
        { job: "a", scheduleKey: "a", maxConnections: 1, statusTracked: true },
        { job: "b", scheduleKey: "b", maxConnections: 1, statusTracked: true },
      ],
      growthPolicy: {
        maxFetchCapableEntriesBeforeRebalance: 1,
        maxHeadroomFullTriggersBeforeRebalance: 2,
        queuesOrWorkflowsReview: { p95DurationMs: 600_000, fanoutPerRun: 1_000, connectionPressureAt: 5 },
      },
    });
    expect(report.workerReports.public.fetchCapableEntryCount).toBe(1);
    expect(report.workerReports.heavy.fetchCapableEntryCount).toBe(1);
    expect(report.fetchCapableEntryLimitExceeded).toBe(true);
    expect(report.failed).toBe(true);
  });
});
