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
});
