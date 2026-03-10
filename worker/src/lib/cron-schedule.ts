import { CRON_JOB_DEFINITIONS, CRON_SCHEDULES } from "@shared/lib/cron-jobs";

export { CRON_SCHEDULES };
export type CronScheduleExpression = (typeof CRON_SCHEDULES)[keyof typeof CRON_SCHEDULES];

export const CRON_INTERVALS = Object.freeze(
  Object.fromEntries(CRON_JOB_DEFINITIONS.map((item) => [item.job, item.intervalSec])) as Record<string, number>,
);
