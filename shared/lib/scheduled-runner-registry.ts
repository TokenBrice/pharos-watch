import { CRON_SCHEDULES } from "./cron-jobs";

export const SCHEDULED_RUNNER_KEYS_BY_SCHEDULE = {
  [CRON_SCHEDULES.quarterHourly]: "quarterHourly",
  [CRON_SCHEDULES.hourlyBlacklist]: "hourlyBlacklist",
  [CRON_SCHEDULES.twentyMinuteMintBurn]: "twentyMinuteMintBurn",
  [CRON_SCHEDULES.thirtyMinuteDexDiscovery]: "thirtyMinuteDexDiscovery",
  [CRON_SCHEDULES.twentyMinuteExtendedOffset]: "twentyMinuteExtendedOffset",
  [CRON_SCHEDULES.halfHourlyOffset]: "halfHourlyOffset",
  [CRON_SCHEDULES.hourlyReserveSync]: "hourlyReserveSync",
  [CRON_SCHEDULES.hourlyYieldSync]: "hourlyYieldSync",
  [CRON_SCHEDULES.fourHourlyYieldSupplemental]: "fourHourlyYieldSupplemental",
  [CRON_SCHEDULES.fiveMinuteTelegramAlerts]: "fiveMinuteTelegramAlerts",
  [CRON_SCHEDULES.daily0800Utc]: "daily0800Utc",
  [CRON_SCHEDULES.monthlyYieldAudit]: "monthlyYieldAudit",
} as const;

export type ScheduledRunnerKey = (typeof SCHEDULED_RUNNER_KEYS_BY_SCHEDULE)[keyof typeof SCHEDULED_RUNNER_KEYS_BY_SCHEDULE];
