import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluateCronConnectionBudget, printReport } from "../ci/check-cron-connection-budget";

describe("check-cron-connection-budget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints thresholds from the injected budget used for evaluation", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const report = evaluateCronConnectionBudget({
      budget: {
        maxPerTrigger: 3,
        failAt: 4,
        fullForNewFetchHeavyWorkAt: 2,
      },
      entries: [
        {
          job: "job-a",
          maxConnections: 2,
          scheduleKey: "slot-a",
          statusTracked: true,
        },
      ],
      schedules: {
        "slot-a": "* * * * *",
      },
      slotPlans: {
        "slot-a": {
          jobChains: [["job-a"]],
        },
      },
    });

    printReport(report);

    expect(report.failed).toBe(false);
    expect(logs.join("\n")).toContain("2/3 connections is full for new fetch-heavy work");
    expect(logs.join("\n")).toContain("slot-a: 2/3");
  });

  it("rejects a budget entry whose job moved to a different schedule identity", () => {
    const report = evaluateCronConnectionBudget({
      entries: [
        {
          job: "job-a",
          maxConnections: 1,
          scheduleKey: "stale-slot",
          statusTracked: true,
        },
      ],
      schedules: {
        "current-slot": "* * * * *",
      },
      slotPlans: {
        "current-slot": {
          jobChains: [["job-a"]],
        },
      },
    });

    expect(report.failed).toBe(true);
    expect(report.missingBudgetJobs).toEqual([]);
    expect(report.mismatchedBudgetJobs).toEqual([
      "current-slot:job-a (budget entry uses stale-slot)",
    ]);
    expect(report.triggerReports[0].jobs).toEqual([]);
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
        "slot-a": { jobChains: [["shared-job"]] },
        "slot-b": { jobChains: [["shared-job"]] },
      },
    });

    expect(report.fetchCapableEntryCount).toBe(1);
    expect(report.fetchCapableEntryLimitExceeded).toBe(false);
    expect(report.failed).toBe(false);
  });
});
