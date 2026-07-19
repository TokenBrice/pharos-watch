import { describe, expect, it } from "vitest";
import {
  CRON_CONNECTION_BUDGET_ENTRIES,
  CRON_JOB_DEFINITIONS,
  type CronScheduleKey,
} from "@shared/lib/cron-jobs";
import {
  flattenScheduledSlotPlanJobs,
  getScheduledSlotPlanBudgetEntries,
  SHARED_SCHEDULED_JOB_IDENTITIES,
  SCHEDULED_SLOT_PLANS,
} from "@shared/lib/scheduled-runner-registry";
import { CRON_TIMEOUT_MS } from "../../../lib/cron-lease";
import {
  PUBLIC_DATASET_CRON_TIMEOUT_MS,
  PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_BUDGET_MS,
} from "../../../lib/public-dataset-snapshot-budget";
import { SLOT_RUNNER_BY_KEY } from "../../scheduled";

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

describe("scheduled runner contract", () => {
  it("keeps scheduled plans, slot runners, and cron definitions in sync", () => {
    const planKeys = Object.keys(SCHEDULED_SLOT_PLANS) as CronScheduleKey[];
    const runnerKeys = Object.keys(SLOT_RUNNER_BY_KEY) as CronScheduleKey[];

    expect(sorted(runnerKeys)).toEqual(sorted(planKeys));
    for (const plan of Object.values(SCHEDULED_SLOT_PLANS)) {
      expect(SLOT_RUNNER_BY_KEY[plan.runnerKey]).toEqual(expect.any(Function));
    }

    const plannedStatusJobs = new Set(
      Object.values(SCHEDULED_SLOT_PLANS).flatMap((plan) => flattenScheduledSlotPlanJobs(plan)),
    );
    expect(sorted(plannedStatusJobs)).toEqual(sorted(CRON_JOB_DEFINITIONS.map((definition) => definition.job)));

    for (const definition of CRON_JOB_DEFINITIONS) {
      const plan = SCHEDULED_SLOT_PLANS[definition.scheduleKey];
      expect(flattenScheduledSlotPlanJobs(plan), `${definition.job} must be planned in ${definition.scheduleKey}`)
        .toContain(definition.job);
    }

    for (const entry of CRON_CONNECTION_BUDGET_ENTRIES) {
      const plan = SCHEDULED_SLOT_PLANS[entry.scheduleKey];
      expect(getScheduledSlotPlanBudgetEntries(plan), `${entry.job} must have a scheduled budget entry`)
        .toContain(entry.job);
    }

    const durationBudgetJobs = Object.keys(CRON_TIMEOUT_MS);
    expect(sorted(durationBudgetJobs)).toEqual(sorted(CRON_JOB_DEFINITIONS.map((definition) => definition.job)));
    for (const [job, timeoutMs] of Object.entries(CRON_TIMEOUT_MS)) {
      expect(Number.isFinite(timeoutMs), `${job} duration budget must be finite`).toBe(true);
      expect(timeoutMs, `${job} duration budget must be positive`).toBeGreaterThan(0);
    }
  });

  it("keeps the public dataset cache-wait budget inside its cron timeout", () => {
    const timeoutMs = CRON_TIMEOUT_MS["snapshot-public-dataset"];
    expect(timeoutMs).toBe(PUBLIC_DATASET_CRON_TIMEOUT_MS);
    expect(timeoutMs).toBeGreaterThan(PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_BUDGET_MS);
    expect(timeoutMs - PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_BUDGET_MS).toBeGreaterThanOrEqual(2 * 60_000);
  });

  it("gives Monday daily and weekly digest generation independent trigger budgets", () => {
    expect(SCHEDULED_SLOT_PLANS.daily0805Utc.jobChains).toContainEqual(["daily-digest"]);
    expect(flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS.daily0805Utc)).not.toContain("weekly-recap");
    expect(SCHEDULED_SLOT_PLANS.daily0810Utc.jobChains).toContainEqual(["weekly-recap"]);

    const daily = CRON_JOB_DEFINITIONS.find((definition) => definition.job === "daily-digest");
    const weekly = CRON_JOB_DEFINITIONS.find((definition) => definition.job === "weekly-recap");
    expect(daily?.scheduleKey).toBe("daily0805Utc");
    expect(weekly?.scheduleKey).toBe("daily0810Utc");
    expect(CRON_TIMEOUT_MS["daily-digest"]).toBe(14 * 60_000);
    expect(CRON_TIMEOUT_MS["weekly-recap"]).toBe(12 * 60_000);
  });

  it("keeps shared cron job identities explicit", () => {
    const schedulesByJob = new Map<string, CronScheduleKey[]>();
    for (const plan of Object.values(SCHEDULED_SLOT_PLANS)) {
      for (const job of flattenScheduledSlotPlanJobs(plan)) {
        const schedules = schedulesByJob.get(job) ?? [];
        schedules.push(plan.scheduleKey);
        schedulesByJob.set(job, schedules);
      }
    }

    const sharedJobs = Object.fromEntries(
      [...schedulesByJob.entries()]
        .filter(([, schedules]) => schedules.length > 1)
        .map(([job, schedules]) => [job, sorted(schedules)]),
    );

    expect(sharedJobs).toEqual(
      Object.fromEntries(
        Object.entries(SHARED_SCHEDULED_JOB_IDENTITIES).map(([job, schedules]) => [job, sorted(schedules)]),
      ),
    );
  });
});
