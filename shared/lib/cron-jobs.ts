import { DAY_SECONDS } from "./time-constants";

export type CronGroupKey =
  | "quarter-hourly"
  | "five-minute"
  | "twenty-minute"
  | "half-hourly"
  | "hourly"
  | "multi-hourly"
  | "daily"
  | "other";

export const CRON_SCHEDULES = {
  quarterHourly: "*/15 * * * *",
  hourlyBlacklist: "3 * * * *",
  twentyMinuteMintBurn: "4,24,44 * * * *",
  thirtyMinuteDexDiscovery: "6,36 * * * *",
  twentyMinuteExtendedOffset: "13,33,53 * * * *",
  halfHourlyOffset: "10,40 * * * *",
  hourlyReserveSync: "11 * * * *",
  hourlyYieldSync: "20 * * * *",
  fourHourlyYieldSupplemental: "25 */4 * * *",
  fiveMinuteTelegramAlerts: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
  daily0800Utc: "0 8 * * *",
  daily0805Utc: "5 8 * * *",
  monthlyYieldAudit: "0 6 1 * *",
} as const;

export type CronScheduleKey = keyof typeof CRON_SCHEDULES;
export type CronScheduleExpression = (typeof CRON_SCHEDULES)[CronScheduleKey];
export type CronTriggerMode = "shared" | "isolated";
export type CronStatusImpact = "critical" | "watch";

const CRON_SCHEDULE_BUCKETS = {
  quarterHourly: { intervalSec: 900, offsetSec: 0 },
  hourlyBlacklist: { intervalSec: 3600, offsetSec: 3 * 60 },
  twentyMinuteMintBurn: { intervalSec: 1200, offsetSec: 4 * 60 },
  thirtyMinuteDexDiscovery: { intervalSec: 1800, offsetSec: 6 * 60 },
  twentyMinuteExtendedOffset: { intervalSec: 1200, offsetSec: 13 * 60 },
  halfHourlyOffset: { intervalSec: 1800, offsetSec: 10 * 60 },
  hourlyReserveSync: { intervalSec: 3600, offsetSec: 11 * 60 },
  hourlyYieldSync: { intervalSec: 3600, offsetSec: 20 * 60 },
  fourHourlyYieldSupplemental: { intervalSec: 4 * 3600, offsetSec: 25 * 60 },
  fiveMinuteTelegramAlerts: { intervalSec: 300, offsetSec: 2 * 60 },
  daily0800Utc: { intervalSec: DAY_SECONDS, offsetSec: 8 * 3600 },
  daily0805Utc: { intervalSec: DAY_SECONDS, offsetSec: 8 * 3600 + 5 * 60 },
  monthlyYieldAudit: { intervalSec: 30 * 86400, offsetSec: 6 * 3600 },
} as const satisfies Record<CronScheduleKey, { intervalSec: number; offsetSec: number }>;

const CRON_SCHEDULE_INTERVALS = Object.freeze(
  Object.fromEntries(
    Object.entries(CRON_SCHEDULE_BUCKETS).map(([scheduleKey, bucket]) => [scheduleKey, bucket.intervalSec]),
  ) as Record<CronScheduleKey, number>,
);

const CRON_SCHEDULE_BUCKET_OFFSETS = Object.freeze(
  Object.fromEntries(
    Object.entries(CRON_SCHEDULE_BUCKETS).map(([scheduleKey, bucket]) => [scheduleKey, bucket.offsetSec]),
  ) as Record<CronScheduleKey, number>,
);

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
  statusImpact: CronStatusImpact;
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
    description: "Telegram alert dispatch with a dedicated connection pool and pending-queue drain.",
  },
  {
    key: "twenty-minute",
    title: "20-minute slot",
    badge: "~20 min",
    description: "On-chain mint/burn intake jobs shown together by cadence, each on its own isolated trigger.",
  },
  {
    key: "half-hourly",
    title: "30-minute slot",
    badge: "~30 min",
    description: "Stablecoin charts, DEX discovery/liquidity, DEWS, and PSI refresh.",
  },
  {
    key: "hourly",
    title: "Hourly slot",
    badge: "~1h",
    description: "Blacklist sync plus dedicated reserve and core yield publication lanes, each on its own trigger.",
  },
  {
    key: "multi-hourly",
    title: "Multi-hour slot",
    badge: "~4h",
    description: "Best-effort slower refresh lanes isolated from the hourly publication paths.",
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
    intervalSec: 3600,
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
    maxConnections: 2, // Frankfurter/secondary sequential, gold + silver in parallel, Chainlink overlay sequential
  },
  {
    job: "stability-index",
    label: "PSI compute",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "halfHourlyOffset",
    triggerMode: "shared",
    maxConnections: 0, // DB-only computation
  },
  {
    job: "compute-dews",
    label: "DEWS compute",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "halfHourlyOffset",
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
    group: "hourly",
    intervalSec: 3600,
    scheduleKey: "hourlyBlacklist",
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
    group: "hourly",
    intervalSec: 3600,
    scheduleKey: "hourlyYieldSync",
    triggerMode: "isolated",
    maxConnections: 1, // on-chain rate batch (1); DL pools read from cache written by sync-dex-liquidity (sequential)
  },
  {
    job: "sync-yield-supplemental",
    label: "Yield supplemental sync",
    group: "multi-hourly",
    intervalSec: 4 * 3600,
    scheduleKey: "fourHourlyYieldSupplemental",
    triggerMode: "isolated",
    maxConnections: 5, // Morpho/Pendle/Yearn/Beefy run in parallel (peak 5), then Compound/Aave consume the isolated lane
  },
  {
    // Runs on the quarter-hourly trigger after a safe stablecoins cache write.
    // The daily 08:00 UTC trigger is a safety-net fallback.
    // intervalSec stays DAY_SECONDS because the job only writes one snapshot per day.
    job: "snapshot-supply",
    label: "Supply snapshot",
    group: "quarter-hourly",
    intervalSec: DAY_SECONDS,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 0, // DB-only snapshot from cached stablecoins data
  },
  {
    job: "snapshot-chain-supply",
    label: "Chain supply snapshot",
    group: "quarter-hourly",
    intervalSec: DAY_SECONDS,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 0,
  },
  {
    job: "snapshot-safety-grade-history",
    label: "Safety grade snapshot",
    group: "daily",
    intervalSec: DAY_SECONDS,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 0, // DB-only snapshot
  },
  {
    job: "fetch-tbill-rate",
    label: "T-bill rate",
    group: "daily",
    intervalSec: DAY_SECONDS,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 1, // Sequential benchmark fetches (ECB/FRED/Treasury/SNB)
  },
  {
    job: "snapshot-psi",
    label: "PSI snapshot",
    group: "daily",
    intervalSec: DAY_SECONDS,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 0, // DB-only snapshot
  },
  {
    job: "sync-usds-status",
    label: "USDS status",
    group: "daily",
    intervalSec: DAY_SECONDS,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 1, // Sequential Etherscan eth_getStorageAt + eth_call probes
  },
  {
    job: "sync-treasury-stable-exposure",
    label: "Treasury stable exposure",
    group: "daily",
    intervalSec: DAY_SECONDS,
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 2, // Per owner group: full balances + stablecoin balances, fetched sequentially
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
    job: "sync-kinesis-supply",
    label: "Kinesis supply",
    group: "hourly",
    intervalSec: 3600,
    scheduleKey: "hourlyReserveSync",
    triggerMode: "shared",
    maxConnections: 1, // 2 sequential Kinesis Horizon fetches (KAU + KAG)
  },
  {
    job: "sync-bluechip",
    label: "Bluechip sync",
    group: "daily",
    intervalSec: DAY_SECONDS,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
    maxConnections: 1, // Sequential batched bluechip API fetches
  },
  {
    job: "daily-digest",
    label: "Daily digest",
    group: "daily",
    intervalSec: DAY_SECONDS,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
    maxConnections: 1, // Anthropic LLM call, then Twitter + Telegram posts (sequential)
  },
  {
    job: "weekly-recap",
    label: "Weekly recap",
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
    intervalSec: 604800,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
    maxConnections: 1, // CoinGecko stablecoins market list fetch
  },
  {
    job: "yield-coverage-audit",
    label: "Yield coverage audit",
    group: "other",
    intervalSec: 30 * 86400,
    scheduleKey: "monthlyYieldAudit",
    triggerMode: "isolated",
    maxConnections: 1,
  },
] as const;

export const CRON_JOB_DEFINITIONS: readonly CronJobMeta[] = CRON_JOB_DEFINITIONS_BASE.map((definition) => ({
  ...definition,
  schedule: CRON_SCHEDULES[definition.scheduleKey],
  statusImpact:
    definition.job === "sync-stablecoins"
    || definition.job === "sync-fx-rates"
    || definition.job === "sync-blacklist"
    || definition.job === "sync-mint-burn"
      ? "critical"
      : "watch",
}));

/** Job name → expected interval in seconds, derived from definitions. */
export const CRON_INTERVALS = Object.freeze(
  Object.fromEntries(CRON_JOB_DEFINITIONS.map((item) => [item.job, item.intervalSec])) as Record<string, number>,
);

const CRON_JOB_META_BY_ID = new Map(
  CRON_JOB_DEFINITIONS.map((definition) => [definition.job, definition]),
);
const CRON_SCHEDULE_KEY_BY_EXPRESSION = new Map<string, CronScheduleKey>(
  Object.entries(CRON_SCHEDULES).map(([scheduleKey, expression]) => [expression, scheduleKey as CronScheduleKey]),
);

export function getCronJobMeta(job: string): CronJobMeta | null {
  return CRON_JOB_META_BY_ID.get(job) ?? null;
}

export function getCronStatusImpact(job: string): CronStatusImpact {
  return getCronJobMeta(job)?.statusImpact ?? "watch";
}

export function getCronScheduleKey(expression: string): CronScheduleKey | null {
  return CRON_SCHEDULE_KEY_BY_EXPRESSION.get(expression) ?? null;
}

function normalizeCronSlotStartedAt(
  timestampSec: number,
  intervalSec: number,
  offsetSec = 0,
): number {
  if (!Number.isFinite(timestampSec) || !Number.isFinite(intervalSec) || intervalSec <= 0) {
    return Math.floor(Date.now() / 1000);
  }

  const shifted = timestampSec - offsetSec;
  return Math.floor(shifted / intervalSec) * intervalSec + offsetSec;
}

export function getCronSlotStartedAtForSchedule(
  scheduleKey: CronScheduleKey | null | undefined,
  scheduledTimeMs?: number | null,
): number {
  const intervalSec = scheduleKey ? CRON_SCHEDULE_INTERVALS[scheduleKey] : null;
  const offsetSec = scheduleKey ? CRON_SCHEDULE_BUCKET_OFFSETS[scheduleKey] : 0;
  const rawTimestampSec = Number.isFinite(scheduledTimeMs)
    ? Math.floor(Number(scheduledTimeMs) / 1000)
    : Math.floor(Date.now() / 1000);

  if (!intervalSec) {
    return rawTimestampSec;
  }

  return normalizeCronSlotStartedAt(rawTimestampSec, intervalSec, offsetSec);
}
