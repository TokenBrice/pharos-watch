import { CRON_SCHEDULES, type CronScheduleKey } from "./cron-jobs";

export const SCHEDULED_RUNNER_KEYS_BY_SCHEDULE: Readonly<Record<string, CronScheduleKey>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CRON_SCHEDULES).map(([runnerKey, schedule]) => [schedule, runnerKey as CronScheduleKey]),
  ),
);

export type ScheduledRunnerKey = CronScheduleKey;
