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
