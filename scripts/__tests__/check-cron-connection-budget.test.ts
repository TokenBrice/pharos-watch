import { describe, expect, it } from "vitest";

import { evaluateCronConnectionBudget } from "../ci/check-cron-connection-budget";

describe("check-cron-connection-budget", () => {
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
