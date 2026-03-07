export const CRON_SCHEDULES = {
  quarterHourly: "*/15 * * * *",
  twentyMinuteOffset: "3,23,43 * * * *",
  halfHourlyOffset: "10,40 * * * *",
  daily0800Utc: "0 8 * * *",
} as const;

export type CronScheduleExpression = (typeof CRON_SCHEDULES)[keyof typeof CRON_SCHEDULES];

export interface CronJobDefinition {
  job: string;
  intervalSec: number;
  schedule: CronScheduleExpression;
}

const CRON_JOB_DEFINITIONS: readonly CronJobDefinition[] = [
  { job: "sync-stablecoins", intervalSec: 900, schedule: CRON_SCHEDULES.quarterHourly },
  { job: "sync-stablecoin-charts", intervalSec: 900, schedule: CRON_SCHEDULES.quarterHourly },
  { job: "sync-fx-rates", intervalSec: 900, schedule: CRON_SCHEDULES.quarterHourly },
  { job: "stability-index", intervalSec: 900, schedule: CRON_SCHEDULES.quarterHourly },
  { job: "compute-dews", intervalSec: 900, schedule: CRON_SCHEDULES.quarterHourly },
  { job: "status-self-check", intervalSec: 900, schedule: CRON_SCHEDULES.quarterHourly },
  { job: "sync-blacklist", intervalSec: 1200, schedule: CRON_SCHEDULES.twentyMinuteOffset },
  { job: "sync-mint-burn", intervalSec: 1200, schedule: CRON_SCHEDULES.twentyMinuteOffset },
  { job: "sync-dex-liquidity", intervalSec: 1800, schedule: CRON_SCHEDULES.halfHourlyOffset },
  { job: "sync-yield-data", intervalSec: 1800, schedule: CRON_SCHEDULES.halfHourlyOffset },
  { job: "snapshot-supply", intervalSec: 86400, schedule: CRON_SCHEDULES.daily0800Utc },
  { job: "snapshot-safety-grade-history", intervalSec: 86400, schedule: CRON_SCHEDULES.daily0800Utc },
  { job: "fetch-tbill-rate", intervalSec: 86400, schedule: CRON_SCHEDULES.daily0800Utc },
  { job: "snapshot-psi", intervalSec: 86400, schedule: CRON_SCHEDULES.daily0800Utc },
  { job: "sync-usds-status", intervalSec: 86400, schedule: CRON_SCHEDULES.daily0800Utc },
  { job: "sync-bluechip", intervalSec: 86400, schedule: CRON_SCHEDULES.daily0800Utc },
  { job: "daily-digest", intervalSec: 86400, schedule: CRON_SCHEDULES.daily0800Utc },
] as const;

export const CRON_INTERVALS = Object.freeze(
  Object.fromEntries(CRON_JOB_DEFINITIONS.map((item) => [item.job, item.intervalSec])) as Record<string, number>,
);
