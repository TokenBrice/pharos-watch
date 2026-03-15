export type CronGroupKey =
  | "quarter-hourly"
  | "five-minute"
  | "twenty-minute"
  | "half-hourly"
  | "hourly"
  | "daily"
  | "other";

export const CRON_SCHEDULES = {
  quarterHourly: "*/15 * * * *",
  twentyMinuteOffset: "3,23,43 * * * *",
  twentyMinuteMintBurn: "4,24,44 * * * *",
  thirtyMinuteDexDiscovery: "6,36 * * * *",
  twentyMinuteExtendedOffset: "13,33,53 * * * *",
  halfHourlyOffset: "10,40 * * * *",
  hourlyReserveSync: "11 * * * *",
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
  /** Maximum outbound fetch connections this job may use (of the 6-per-trigger pool). */
  maxConnections?: number;
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
    description: "On-chain intake jobs (blacklist, mint/burn) shown together by cadence, each on its own isolated trigger.",
  },
  {
    key: "half-hourly",
    title: "30-minute slot",
    badge: "~30 min",
    description: "Stablecoin charts, DEX liquidity scoring, and yield refresh.",
  },
  {
    key: "hourly",
    title: "Hourly slot",
    badge: "~1h",
    description: "Reserve-sync tuning lane with its own trigger so cadence changes do not perturb daily or half-hourly jobs.",
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
    maxConnections: 3, // DL stablecoins + supplemental tokens (DL coins + CG parallel) + enrich-prices
  },
  {
    job: "sync-stablecoin-charts",
    label: "Stablecoin charts",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "halfHourlyOffset",
    triggerMode: "shared",
    maxConnections: 1, // Single DL stablecoincharts/all fetch
  },
  {
    job: "sync-fx-rates",
    label: "FX rates",
    group: "quarter-hourly",
    intervalSec: 900,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 2, // Frankfurter/ExchangeRate sequential, then gold + silver in parallel
  },
  {
    job: "stability-index",
    label: "PSI compute",
    group: "quarter-hourly",
    intervalSec: 900,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 0, // DB-only computation
  },
  {
    job: "compute-dews",
    label: "DEWS compute",
    group: "quarter-hourly",
    intervalSec: 900,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 0, // DB-only computation
  },
  {
    job: "status-self-check",
    label: "Status self-check",
    group: "quarter-hourly",
    intervalSec: 900,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 1, // Sequential self-URL probes (loopback or external)
  },
  {
    job: "dispatch-telegram-alerts",
    label: "Telegram alerts",
    group: "five-minute",
    intervalSec: 300,
    scheduleKey: "fiveMinuteTelegramAlerts",
    triggerMode: "isolated",
    maxConnections: 1, // Sequential Telegram sendMessage calls
  },
  {
    job: "sync-blacklist",
    label: "Blacklist sync",
    group: "twenty-minute",
    intervalSec: 1200,
    scheduleKey: "twentyMinuteOffset",
    triggerMode: "isolated",
    maxConnections: 1, // Rate-limited sequential Etherscan/TronGrid/RPC calls
  },
  {
    job: "sync-mint-burn",
    label: "Mint/burn critical",
    group: "twenty-minute",
    intervalSec: 1200,
    scheduleKey: "twentyMinuteMintBurn",
    triggerMode: "isolated",
    maxConnections: 1, // Sequential Alchemy eth_getLogs + eth_getBlockByNumber calls
  },
  {
    job: "sync-mint-burn-extended",
    label: "Mint/burn extended",
    group: "twenty-minute",
    intervalSec: 1200,
    scheduleKey: "twentyMinuteExtendedOffset",
    triggerMode: "isolated",
    maxConnections: 1, // Sequential Alchemy eth_getLogs + eth_getBlockByNumber calls
  },
  {
    job: "sync-dex-discovery",
    label: "DEX pool discovery",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "thirtyMinuteDexDiscovery",
    triggerMode: "isolated",
    maxConnections: 1, // Rate-limited sequential GeckoTerminal/CoinGecko crawl
  },
  {
    job: "sync-dex-liquidity",
    label: "DEX liquidity scoring",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "halfHourlyOffset",
    triggerMode: "shared",
    maxConnections: 4, // DL yields + protocols parallel (2), then Curve chains parallel (4 peak), then GT crawl (1)
  },
  {
    job: "sync-yield-data",
    label: "Yield sync",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "halfHourlyOffset",
    triggerMode: "shared",
    maxConnections: 2, // DL yields (1) + on-chain rates / CG price lookups (1)
  },
  {
    // Runs on the quarter-hourly trigger after a safe stablecoins cache write.
    // The daily 08:00 UTC trigger is a safety-net fallback.
    // intervalSec stays 86400 because the job only writes one snapshot per day.
    job: "snapshot-supply",
    label: "Supply snapshot",
    group: "quarter-hourly",
    intervalSec: 86400,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 0, // DB-only snapshot from cached stablecoins data
  },
  {
    job: "snapshot-safety-grade-history",
    label: "Safety grade snapshot",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 0, // DB-only snapshot
  },
  {
    job: "fetch-tbill-rate",
    label: "T-bill rate",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 1, // FRED CSV then Treasury XML fallback (sequential)
  },
  {
    job: "snapshot-psi",
    label: "PSI snapshot",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 0, // DB-only snapshot
  },
  {
    job: "sync-usds-status",
    label: "USDS status",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 1, // Sequential Etherscan eth_getStorageAt + eth_call probes
  },
  {
    job: "sync-live-reserves",
    label: "Live reserve sync",
    group: "hourly",
    intervalSec: 3600,
    scheduleKey: "hourlyReserveSync",
    triggerMode: "shared",
    maxConnections: 1, // Sequential per-adapter reserve fetches
  },
  {
    job: "sync-redemption-backstops",
    label: "Redemption backstops",
    group: "hourly",
    intervalSec: 3600,
    scheduleKey: "hourlyReserveSync",
    triggerMode: "shared",
    maxConnections: 0, // DB-only computation from cached stablecoins + liquidity data
  },
  {
    job: "sync-bluechip",
    label: "Bluechip sync",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
    maxConnections: 1, // Sequential batched bluechip API fetches
  },
  {
    job: "daily-digest",
    label: "Daily digest",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
    maxConnections: 1, // Anthropic LLM call, then Twitter + Telegram posts (sequential)
  },
  {
    job: "weekly-digest",
    label: "Weekly digest",
    group: "daily",
    intervalSec: 604800,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
    maxConnections: 1, // Anthropic LLM call, then Telegram post (sequential)
  },
  {
    job: "discovery-scan",
    label: "Coverage discovery",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
    maxConnections: 1, // CoinGecko stablecoins market list fetch
  },
] as const;

export const CRON_JOB_DEFINITIONS: readonly CronJobMeta[] = CRON_JOB_DEFINITIONS_BASE.map((definition) => ({
  ...definition,
  schedule: CRON_SCHEDULES[definition.scheduleKey],
}));

/** Job name → expected interval in seconds, derived from definitions. */
export const CRON_INTERVALS = Object.freeze(
  Object.fromEntries(CRON_JOB_DEFINITIONS.map((item) => [item.job, item.intervalSec])) as Record<string, number>,
);

const CRON_JOB_META_BY_ID = new Map(
  CRON_JOB_DEFINITIONS.map((definition) => [definition.job, definition]),
);

export function getCronJobMeta(job: string): CronJobMeta | null {
  return CRON_JOB_META_BY_ID.get(job) ?? null;
}
