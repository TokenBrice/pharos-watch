import { CRON_SCHEDULES } from "./cron-jobs";

export const SCHEDULED_RUNNER_KEYS_BY_SCHEDULE = {
  [CRON_SCHEDULES.quarterHourly]: "quarterHourly",
  [CRON_SCHEDULES.statusSelfCheckOffset]: "statusSelfCheckOffset",
  [CRON_SCHEDULES.sixHourlyBlacklist]: "sixHourlyBlacklist",
  [CRON_SCHEDULES.halfHourlyMintBurnCritical]: "halfHourlyMintBurnCritical",
  [CRON_SCHEDULES.twoHourlyDexDiscovery]: "twoHourlyDexDiscovery",
  [CRON_SCHEDULES.halfHourlyMintBurnExtended]: "halfHourlyMintBurnExtended",
  [CRON_SCHEDULES.halfHourlyOffset]: "halfHourlyOffset",
  [CRON_SCHEDULES.halfHourlyChartsOffset]: "halfHourlyChartsOffset",
  [CRON_SCHEDULES.dewsPsiOffset]: "dewsPsiOffset",
  [CRON_SCHEDULES.fourHourlyReserveSync]: "fourHourlyReserveSync",
  [CRON_SCHEDULES.hourlyYieldSync]: "hourlyYieldSync",
  [CRON_SCHEDULES.fourHourlyYieldSupplemental]: "fourHourlyYieldSupplemental",
  [CRON_SCHEDULES.fiveMinuteTelegramAlerts]: "fiveMinuteTelegramAlerts",
  [CRON_SCHEDULES.digestTriggerPoll]: "digestTriggerPoll",
  [CRON_SCHEDULES.daily0300Utc]: "daily0300Utc",
  [CRON_SCHEDULES.daily0800Utc]: "daily0800Utc",
  [CRON_SCHEDULES.daily0805Utc]: "daily0805Utc",
  [CRON_SCHEDULES.monthlyYieldAudit]: "monthlyYieldAudit",
} as const;

export type ScheduledRunnerKey = (typeof SCHEDULED_RUNNER_KEYS_BY_SCHEDULE)[keyof typeof SCHEDULED_RUNNER_KEYS_BY_SCHEDULE];
