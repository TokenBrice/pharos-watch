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
        dexSlot: "10,40 * * * *",
      },
      cronTriggerSchedules: {
        dexSlot: ["10 * * * *", "40 * * * *"],
      },
      scheduledSlotPlans: {
        dexSlot: {
          schedule: "10,40 * * * *",
          triggerSchedules: ["10 * * * *", "40 * * * *"],
          jobChains: [["sync-dex"]],
        },
      },
      cronJobDefinitions: [{ job: "sync-dex" }],
      cronConnectionBudgetEntries: [{ job: "sync-dex" }],
      wranglerCronTriggers: ["10 * * * *", "40 * * * *"],
    });

    expect(report.failed).toBe(false);
    expect(report.wranglerTriggerCount).toBe(2);
    expect(report.slotPlanTriggerCount).toBe(2);
    expect(report.scheduleKeyByExpression.get("40 * * * *")).toBe("dexSlot");
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

  it("prints actionable diagnostics with source owners for slot and job drift", () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });

    const report = evaluateCronScheduleSync({
      cronSchedules: {
        slotA: "1 * * * *",
        slotB: "2 * * * *",
      },
      scheduledSlotPlans: {
        slotA: {
          jobChains: [["job-a", "unknown-runtime-job"]],
          budgetOnlyJobs: ["unknown-budget-sidecar"],
        },
        extraSlot: {
          schedule: "3 * * * *",
          jobChains: [],
        },
      },
      cronJobDefinitions: [{ job: "job-a" }, { job: "job-b" }],
      cronConnectionBudgetEntries: [{ job: "job-a" }, { job: "job-b" }, { job: "budget-b" }],
      wranglerCronTriggers: ["1 * * * *", "9 * * * *"],
    });

    printCronScheduleSyncReport(report);

    const output = errors.join("\n");
    expect(output).toContain("Cron schedule mismatch detected!");
    expect(output).toContain("worker/wrangler.toml [triggers.crons]");
    expect(output).toContain(
      "shared/lib/cron-jobs.ts [CRON_SCHEDULES/CRON_TRIGGER_SCHEDULES]",
    );
    expect(output).toContain("Missing from worker/wrangler.toml [triggers.crons]");
    expect(output).toContain('slotB: "2 * * * *"');
    expect(output).toContain('extraSlot: "3 * * * *"');
    expect(output).toContain("Missing key in shared/lib/scheduled-runner-registry.ts [SCHEDULED_SLOT_PLANS]");
    expect(output).toContain("job-b");
    expect(output).toContain("unknown-runtime-job");
    expect(output).toContain("budget-b");
    expect(output).toContain("unknown-budget-sidecar");
  });
});
