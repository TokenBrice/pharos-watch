import { afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateCronScheduleSync,
  parseWranglerCronTriggers,
  printCronScheduleSyncReport,
} from "../ci/check-cron-schedule-sync";

describe("check-cron-schedule-sync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses configured wrangler triggers", () => {
    expect(
      parseWranglerCronTriggers(`
      [triggers]
      crons = [
        "*/15 * * * *",
        "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
      ]
    `),
    ).toEqual(["*/15 * * * *", "2,7,12,17,22,27,32,37,42,47,52,57 * * * *"]);
  });

  it("keeps budget-only entries valid without requiring runtime job definitions", () => {
    const report = evaluateCronScheduleSync({
      cronSchedules: {
        configuredSlot: "1 * * * *",
      },
      scheduledSlotPlans: {
        configuredSlot: {
          jobChains: [["runtime-job"]],
          budgetOnlyJobs: ["budget-only-sidecar"],
        },
      },
      cronJobDefinitions: [{ job: "runtime-job" }],
      cronConnectionBudgetEntries: [{ job: "runtime-job" }, { job: "budget-only-sidecar" }],
      wranglerCronTriggers: ["1 * * * *"],
    });

    expect(report.failed).toBe(false);
    expect(report.missingRuntimeJobs).toEqual([]);
    expect(report.unknownRuntimeJobs).toEqual([]);
    expect(report.missingBudgetJobs).toEqual([]);
    expect(report.unknownBudgetJobs).toEqual([]);
  });

  it("maps multiple physical triggers to one logical scheduled slot", () => {
    const report = evaluateCronScheduleSync({
      cronSchedules: {
        v9PublicationOffset: "22,52 * * * *",
      },
      cronTriggerSchedules: {
        v9PublicationOffset: ["22 * * * *", "52 * * * *"],
      },
      scheduledSlotPlans: {
        v9PublicationOffset: {
          schedule: "22,52 * * * *",
          triggerSchedules: ["22 * * * *", "52 * * * *"],
          jobChains: [["compute-safety-score-v9"]],
        },
      },
      cronJobDefinitions: [{ job: "compute-safety-score-v9" }],
      cronConnectionBudgetEntries: [{ job: "compute-safety-score-v9" }],
      wranglerCronTriggers: ["22 * * * *", "52 * * * *"],
    });

    expect(report.failed).toBe(false);
    expect(report.wranglerTriggerCount).toBe(2);
    expect(report.slotPlanTriggerCount).toBe(2);
    expect(report.scheduleKeyByExpression.get("22 * * * *")).toBe("v9PublicationOffset");
    expect(report.scheduleKeyByExpression.get("52 * * * *")).toBe("v9PublicationOffset");
  });

  it("requires consolidation before the reviewed physical trigger topology grows", () => {
    const report = evaluateCronScheduleSync({
      cronSchedules: {
        slotA: "1 * * * *",
        slotB: "2 * * * *",
      },
      cronJobDefinitions: [{ job: "job-a" }, { job: "job-b" }],
      cronConnectionBudgetEntries: [{ job: "job-a" }, { job: "job-b" }],
      growthPolicy: { maxPhysicalTriggersBeforeRebalance: 1 },
      scheduledSlotPlans: {
        slotA: { jobChains: [["job-a"]] },
        slotB: { jobChains: [["job-b"]] },
      },
      wranglerCronTriggers: ["1 * * * *", "2 * * * *"],
    });

    expect(report.physicalTriggerLimitExceeded).toBe(true);
    expect(report.failed).toBe(true);
  });

  it("reports configured trigger drift as missing and extra slots", () => {
    const report = evaluateCronScheduleSync({
      cronSchedules: {
        slotA: "1 * * * *",
        slotB: "2 * * * *",
      },
      scheduledSlotPlans: {
        slotA: { jobChains: [["job-a"]] },
        slotB: { jobChains: [["job-b"]] },
      },
      cronJobDefinitions: [{ job: "job-a" }, { job: "job-b" }],
      cronConnectionBudgetEntries: [{ job: "job-a" }, { job: "job-b" }],
      wranglerCronTriggers: ["1 * * * *", "9 * * * *"],
    });

    expect(report.failed).toBe(true);
    expect(report.onlyInWranglerSchedules).toEqual(["9 * * * *"]);
    expect(report.onlyInSharedSchedules).toEqual(["2 * * * *"]);
  });

  it("rejects a duplicate raw Wrangler cron expression before set comparison", () => {
    const report = evaluateCronScheduleSync({
      cronSchedules: { slotA: "1 * * * *" },
      scheduledSlotPlans: { slotA: { jobChains: [["job-a"]] } },
      cronJobDefinitions: [{ job: "job-a" }],
      cronConnectionBudgetEntries: [{ job: "job-a" }],
      wranglerCronTriggers: ["1 * * * *", "1 * * * *"],
    });

    expect(report.duplicateWranglerSchedules).toEqual(["1 * * * *"]);
    expect(report.duplicateSlotPlanSchedules).toEqual([]);
    expect(report.onlyInWranglerSchedules).toEqual([]);
    expect(report.onlyInSharedSchedules).toEqual([]);
    expect(report.failed).toBe(true);
  });

  it("rejects a duplicate raw slot trigger schedule before set comparison", () => {
    const report = evaluateCronScheduleSync({
      cronSchedules: { slotA: "1 * * * *" },
      cronTriggerSchedules: { slotA: ["1 * * * *"] },
      scheduledSlotPlans: {
        slotA: {
          triggerSchedules: ["1 * * * *", "1 * * * *"],
          jobChains: [["job-a"]],
        },
      },
      cronJobDefinitions: [{ job: "job-a" }],
      cronConnectionBudgetEntries: [{ job: "job-a" }],
      wranglerCronTriggers: ["1 * * * *"],
    });

    expect(report.duplicateSlotPlanSchedules).toEqual(["1 * * * *"]);
    expect(report.duplicateWranglerSchedules).toEqual([]);
    expect(report.onlyInSlotPlanSchedules).toEqual([]);
    expect(report.missingSlotPlanSchedules).toEqual([]);
    expect(report.failed).toBe(true);
  });

  it.each([
    ["missingPlanKeys", { cronSchedules: { slotA: "1 * * * *", missing: "1 * * * *" } }, "missing"],
    ["extraPlanKeys", { scheduledSlotPlans: {
      slotA: { jobChains: [["job-a"]] },
      extra: { jobChains: [] },
    } }, "extra"],
    ["missingRuntimeJobs", { cronJobDefinitions: [{ job: "job-a" }, { job: "missing" }] }, "missing"],
    ["unknownRuntimeJobs", { cronJobDefinitions: [] }, "job-a"],
    ["missingBudgetJobs", { cronConnectionBudgetEntries: [{ job: "job-a" }, { job: "missing" }] }, "missing"],
    ["unknownBudgetJobs", { cronConnectionBudgetEntries: [] }, "job-a"],
  ] as const)("fails independently for %s", (field, mutation, offender) => {
    const valid = {
      cronSchedules: { slotA: "1 * * * *" },
      scheduledSlotPlans: { slotA: { jobChains: [["job-a"]] } },
      cronJobDefinitions: [{ job: "job-a" }],
      cronConnectionBudgetEntries: [{ job: "job-a" }],
      wranglerCronTriggers: ["1 * * * *"],
      growthPolicy: { maxPhysicalTriggersBeforeRebalance: 1 },
    };
    expect(evaluateCronScheduleSync(valid).failed).toBe(false);
    const report = evaluateCronScheduleSync({ ...valid, ...mutation });
    expect(report[field]).toEqual([offender]);
    expect(report.failed).toBe(true);
    for (const other of [
      "duplicateSlotPlanSchedules", "duplicateWranglerSchedules", "missingPlanKeys",
      "extraPlanKeys", "missingRuntimeJobs", "unknownRuntimeJobs", "missingBudgetJobs",
      "unknownBudgetJobs", "onlyInWranglerSchedules", "onlyInSharedSchedules",
      "onlyInSlotPlanSchedules", "missingSlotPlanSchedules",
    ] as const) {
      if (other !== field) expect(report[other]).toEqual([]);
    }
  });

  it("prints the offending job identifier", () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });
    printCronScheduleSyncReport(evaluateCronScheduleSync({
      cronSchedules: {},
      scheduledSlotPlans: {},
      cronJobDefinitions: [{ job: "missing-runtime-sentinel" }],
      cronConnectionBudgetEntries: [],
      wranglerCronTriggers: [],
    }));
    expect(errors.join("\n")).toContain("missing-runtime-sentinel");
  });
});
