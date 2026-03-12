export type CronGroupKey =
  | "quarter-hourly"
  | "five-minute"
  | "twenty-minute"
  | "half-hourly"
  | "daily"
  | "other";

export const CRON_SCHEDULES = {
  quarterHourly: "*/15 * * * *",
  twentyMinuteOffset: "3,23,43 * * * *",
  twentyMinuteMintBurn: "4,24,44 * * * *",
  twentyMinuteDexDiscovery: "6,26,46 * * * *",
  twentyMinuteExtendedOffset: "13,33,53 * * * *",
  halfHourlyOffset: "10,40 * * * *",
  fiveMinuteTelegramAlerts: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
  daily0800Utc: "0 8 * * *",
  daily0805Utc: "5 8 * * *",
} as const;

export type CronScheduleKey = keyof typeof CRON_SCHEDULES;
export type CronScheduleExpression = (typeof CRON_SCHEDULES)[CronScheduleKey];
export type CronTriggerMode = "shared" | "isolated";

export interface CronGroupDefinition {
  key: CronGroupKey;
  title: string;
  badge: string;
  description: string;
}

export interface CronJobDefinition {
  job: string;
  label: string;
  group: CronGroupKey;
  intervalSec: number;
  scheduleKey: CronScheduleKey;
  triggerMode: CronTriggerMode;
}

export interface CronJobMeta extends CronJobDefinition {
  schedule: CronScheduleExpression;
}

export const CRON_GROUPS: readonly CronGroupDefinition[] = [
  {
    key: "quarter-hourly",
    title: "15-minute slot",
    badge: "*/15",
    description: "Core ingestion, FX rates, derived score recompute, and operator self-checks.",
  },
  {
    key: "five-minute",
    title: "5-minute slot",
    badge: "~5 min",
    description: "Telegram alert dispatch plus cemetery-announcement sidecar work, with a dedicated connection pool and pending-queue drain.",
  },
  {
    key: "twenty-minute",
    title: "20-minute slot",
    badge: "~20 min",
    description: "On-chain intake jobs shown together by cadence, but each heavy lane runs on its own isolated trigger.",
  },
  {
    key: "half-hourly",
    title: "30-minute slot",
    badge: "~30 min",
    description: "Stablecoin charts, DEX liquidity scoring, and yield refresh.",
  },
  {
    key: "daily",
    title: "Daily slot",
    badge: "~08:00",
    description: "Snapshots, slower monitors, digest generation, and coverage discovery. Split across 08:00 and 08:05 triggers for connection-pool headroom.",
  },
  {
    key: "other",
    title: "Other cadence",
    badge: "unmapped",
    description: "Fallback bucket for jobs that do not yet have status-page display metadata.",
  },
] as const;

const CRON_JOB_DEFINITIONS_BASE: readonly CronJobDefinition[] = [
  {
    job: "sync-stablecoins",
    label: "Stablecoin sync",
    group: "quarter-hourly",
    intervalSec: 900,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
  },
  {
    job: "sync-stablecoin-charts",
    label: "Stablecoin charts",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "halfHourlyOffset",
    triggerMode: "shared",
  },
  {
    job: "sync-fx-rates",
    label: "FX rates",
    group: "quarter-hourly",
    intervalSec: 900,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
  },
  {
    job: "stability-index",
    label: "PSI compute",
    group: "quarter-hourly",
    intervalSec: 900,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
  },
  {
    job: "compute-dews",
    label: "DEWS compute",
    group: "quarter-hourly",
    intervalSec: 900,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
  },
  {
    job: "status-self-check",
    label: "Status self-check",
    group: "quarter-hourly",
    intervalSec: 900,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
  },
  {
    job: "dispatch-telegram-alerts",
    label: "Telegram alerts",
    group: "five-minute",
    intervalSec: 300,
    scheduleKey: "fiveMinuteTelegramAlerts",
    triggerMode: "isolated",
  },
  {
    job: "sync-blacklist",
    label: "Blacklist sync",
    group: "twenty-minute",
    intervalSec: 1200,
    scheduleKey: "twentyMinuteOffset",
    triggerMode: "isolated",
  },
  {
    job: "sync-mint-burn",
    label: "Mint/burn critical",
    group: "twenty-minute",
    intervalSec: 1200,
    scheduleKey: "twentyMinuteMintBurn",
    triggerMode: "isolated",
  },
  {
    job: "sync-mint-burn-extended",
    label: "Mint/burn extended",
    group: "twenty-minute",
    intervalSec: 1200,
    scheduleKey: "twentyMinuteExtendedOffset",
    triggerMode: "isolated",
  },
  {
    job: "sync-dex-discovery",
    label: "DEX pool discovery",
    group: "twenty-minute",
    intervalSec: 1200,
    scheduleKey: "twentyMinuteDexDiscovery",
    triggerMode: "isolated",
  },
  {
    job: "sync-dex-liquidity",
    label: "DEX liquidity scoring",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "halfHourlyOffset",
    triggerMode: "shared",
  },
  {
    job: "sync-yield-data",
    label: "Yield sync",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "halfHourlyOffset",
    triggerMode: "shared",
  },
  {
    job: "snapshot-supply",
    label: "Supply snapshot",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
  },
  {
    job: "snapshot-safety-grade-history",
    label: "Safety grade snapshot",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
  },
  {
    job: "fetch-tbill-rate",
    label: "T-bill rate",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
  },
  {
    job: "snapshot-psi",
    label: "PSI snapshot",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
  },
  {
    job: "sync-usds-status",
    label: "USDS status",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
  },
  {
    job: "sync-bluechip",
    label: "Bluechip sync",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
  },
  {
    job: "daily-digest",
    label: "Daily digest",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
  },
  {
    job: "discovery-scan",
    label: "Coverage discovery",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
  },
] as const;

export const CRON_JOB_DEFINITIONS: readonly CronJobMeta[] = CRON_JOB_DEFINITIONS_BASE.map((definition) => ({
  ...definition,
  schedule: CRON_SCHEDULES[definition.scheduleKey],
}));

const CRON_JOB_META_BY_ID = new Map(
  CRON_JOB_DEFINITIONS.map((definition) => [definition.job, definition]),
);

export function getCronJobMeta(job: string): CronJobMeta | null {
  return CRON_JOB_META_BY_ID.get(job) ?? null;
}
