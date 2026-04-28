import { DAY_SECONDS } from "./time-constants";

export type CronGroupKey =
  | "quarter-hourly"
  | "five-minute"
  | "half-hourly"
  | "hourly"
  | "multi-hourly"
  | "daily"
  | "other";

export const CRON_SCHEDULES = {
  quarterHourly: "*/15 * * * *",
  statusSelfCheckOffset: "9,24,39,54 * * * *",
  sixHourlyBlacklist: "3 */6 * * *",
  halfHourlyMintBurnCritical: "4,34 * * * *",
  twoHourlyDexDiscovery: "6 */2 * * *",
  halfHourlyMintBurnExtended: "13,43 * * * *",
  halfHourlyOffset: "10,40 * * * *",
  halfHourlyChartsOffset: "16,46 * * * *",
  dewsPsiOffset: "26,56 * * * *",
  fourHourlyReserveSync: "11 */4 * * *",
  hourlyYieldSync: "20 * * * *",
  fourHourlyYieldSupplemental: "25 */4 * * *",
  fiveMinuteTelegramAlerts: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
  digestTriggerPoll: "*/5 * * * *",
  daily0300Utc: "0 3 * * *",
  daily0800Utc: "0 8 * * *",
  daily0805Utc: "5 8 * * *",
  monthlyYieldAudit: "0 6 1 * *",
} as const;

export const CRON_CONNECTION_BUDGET = {
  maxPerTrigger: 6,
  failAt: 6,
  fullForNewFetchHeavyWorkAt: 5,
} as const;

export type CronScheduleKey = keyof typeof CRON_SCHEDULES;
export type CronScheduleExpression = (typeof CRON_SCHEDULES)[CronScheduleKey];
export type CronTriggerMode = "shared" | "isolated";
export type CronStatusImpact = "critical" | "watch";

const CRON_SCHEDULE_BUCKETS = {
  quarterHourly: { intervalSec: 900, offsetSec: 0 },
  statusSelfCheckOffset: { intervalSec: 900, offsetSec: 9 * 60 },
  sixHourlyBlacklist: { intervalSec: 6 * 3600, offsetSec: 3 * 60 },
  halfHourlyMintBurnCritical: { intervalSec: 1800, offsetSec: 4 * 60 },
  twoHourlyDexDiscovery: { intervalSec: 2 * 3600, offsetSec: 6 * 60 },
  halfHourlyMintBurnExtended: { intervalSec: 1800, offsetSec: 13 * 60 },
  halfHourlyOffset: { intervalSec: 1800, offsetSec: 10 * 60 },
  halfHourlyChartsOffset: { intervalSec: 1800, offsetSec: 16 * 60 },
  dewsPsiOffset: { intervalSec: 1800, offsetSec: 26 * 60 },
  fourHourlyReserveSync: { intervalSec: 4 * 3600, offsetSec: 11 * 60 },
  hourlyYieldSync: { intervalSec: 3600, offsetSec: 20 * 60 },
  fourHourlyYieldSupplemental: { intervalSec: 4 * 3600, offsetSec: 25 * 60 },
  fiveMinuteTelegramAlerts: { intervalSec: 300, offsetSec: 2 * 60 },
  digestTriggerPoll: { intervalSec: 300, offsetSec: 0 },
  daily0300Utc: { intervalSec: DAY_SECONDS, offsetSec: 3 * 3600 },
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
  /** Jobs with the same trigger and concurrency group are chained, so their peak is max(), not sum(). */
  connectionGroup?: string;
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
    description: "Core ingestion, FX rates, and cache-dependent supply snapshots on the shared 15-minute lane.",
  },
  {
    key: "five-minute",
    title: "5-minute slot",
    badge: "~5 min",
    description: "Telegram alert dispatch with a dedicated connection pool and pending-queue drain.",
  },
  {
    key: "half-hourly",
    title: "30-minute slot",
    badge: "~30 min",
    description: "Dedicated DEX and chart lanes, decoupled DEWS/PSI publication, plus isolated mint/burn critical and extended triggers.",
  },
  {
    key: "hourly",
    title: "Hourly slot",
    badge: "~1h",
    description: "Dedicated core yield publication lane after DEX scoring has refreshed its inputs.",
  },
  {
    key: "multi-hourly",
    title: "Multi-hour slot",
    badge: "2-6h",
    description: "Isolated slower lanes: 2-hour DEX discovery, 4-hour reserve/redemption/Kinesis and supplemental yield, plus 6-hour critical blacklist sync.",
  },
  {
    key: "daily",
    title: "Daily slot",
    badge: "daily",
    description: "03:00 retention pruning plus 08:00 snapshots/monitors and 08:05 digest, Bluechip, recap, and coverage discovery lanes.",
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
    connectionGroup: "quarter-hourly-chain",
  },
  {
    job: "sync-stablecoin-charts",
    label: "Stablecoin charts",
    group: "half-hourly",
    intervalSec: 3600,
    scheduleKey: "halfHourlyChartsOffset",
    triggerMode: "isolated",
    maxConnections: 1, // Single DL stablecoincharts/all fetch
  },
  {
    job: "sync-fx-rates",
    label: "FX rates",
    group: "quarter-hourly",
    intervalSec: 1800, // Trigger fires every 15 min alongside sync-stablecoins, but internal cooldown gates actual writes to every 30 min.
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 2, // Frankfurter/secondary sequential, gold + silver in parallel, Chainlink overlay sequential
    connectionGroup: "quarter-hourly-chain",
  },
  {
    job: "stability-index",
    label: "PSI compute",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "dewsPsiOffset",
    triggerMode: "shared",
    maxConnections: 0, // DB-only computation
    connectionGroup: "dews-psi-chain",
  },
  {
    job: "compute-dews",
    label: "DEWS compute",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "dewsPsiOffset",
    triggerMode: "shared",
    maxConnections: 0, // DB-only computation
    connectionGroup: "dews-psi-chain",
  },
  {
    job: "status-self-check",
    label: "Status self-check",
    group: "quarter-hourly",
    intervalSec: 900,
    scheduleKey: "statusSelfCheckOffset",
    triggerMode: "isolated",
    maxConnections: 1, // Sequential self-URL probes (loopback or external)
  },
  {
    job: "dispatch-telegram-alerts",
    label: "Telegram alerts",
    group: "five-minute",
    intervalSec: 300,
    scheduleKey: "fiveMinuteTelegramAlerts",
    triggerMode: "isolated",
    maxConnections: 5, // Headroom-full slot: Telegram sendMessage batches run with SEND_BATCH_SIZE=5
  },
  {
    job: "sync-blacklist",
    label: "Blacklist sync",
    group: "multi-hourly",
    intervalSec: 6 * 3600,
    scheduleKey: "sixHourlyBlacklist",
    triggerMode: "isolated",
    maxConnections: 1, // Rate-limited sequential Etherscan/TronGrid/RPC calls
  },
  {
    job: "sync-mint-burn",
    label: "Mint/burn critical",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "halfHourlyMintBurnCritical",
    triggerMode: "isolated",
    maxConnections: 1, // Sequential Alchemy eth_getLogs + eth_getBlockByNumber calls
  },
  {
    job: "sync-mint-burn-extended",
    label: "Mint/burn extended",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "halfHourlyMintBurnExtended",
    triggerMode: "isolated",
    maxConnections: 1, // Sequential Alchemy eth_getLogs + eth_getBlockByNumber calls
  },
  {
    job: "sync-dex-discovery",
    label: "DEX pool discovery",
    group: "multi-hourly",
    intervalSec: 2 * 3600,
    scheduleKey: "twoHourlyDexDiscovery",
    triggerMode: "isolated",
    maxConnections: 1, // Rate-limited sequential GeckoTerminal/CoinGecko crawl
  },
  {
    job: "sync-dex-liquidity",
    label: "DEX liquidity scoring",
    group: "half-hourly",
    intervalSec: 1800,
    scheduleKey: "halfHourlyOffset",
    triggerMode: "isolated",
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
    maxConnections: 5, // Headroom-full slot: Morpho/Pendle/Yearn/Beefy run in parallel (peak 5), then Compound/Aave consume the isolated lane
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
    connectionGroup: "quarter-hourly-chain",
  },
  {
    job: "snapshot-chain-supply",
    label: "Chain supply snapshot",
    group: "quarter-hourly",
    intervalSec: DAY_SECONDS,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 0,
    connectionGroup: "quarter-hourly-chain",
  },
  {
    job: "publish-report-card-cache",
    label: "Report-card cache",
    group: "quarter-hourly",
    intervalSec: 900,
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 0,
    connectionGroup: "quarter-hourly-chain",
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
    connectionGroup: "daily-0800-fetch-chain",
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
    connectionGroup: "daily-0800-fetch-chain",
  },
  {
    job: "sync-live-reserves",
    label: "Live reserve sync",
    group: "multi-hourly",
    intervalSec: 4 * 3600,
    scheduleKey: "fourHourlyReserveSync",
    triggerMode: "shared",
    maxConnections: 2, // Sequential per-coin loop with per-adapter I/O limited to 2
    connectionGroup: "reserve-sync-chain",
  },
  {
    job: "sync-redemption-backstops",
    label: "Redemption backstops",
    group: "multi-hourly",
    intervalSec: 4 * 3600,
    scheduleKey: "fourHourlyReserveSync",
    triggerMode: "shared",
    maxConnections: 0, // DB-only computation from cached stablecoins + liquidity data
    connectionGroup: "reserve-sync-chain",
  },
  {
    job: "sync-kinesis-supply",
    label: "Kinesis supply",
    group: "multi-hourly",
    intervalSec: 4 * 3600,
    scheduleKey: "fourHourlyReserveSync",
    triggerMode: "shared",
    maxConnections: 1, // 2 sequential Kinesis Horizon fetches (KAU + KAG)
    connectionGroup: "reserve-sync-chain",
  },
  {
    // daily0805Utc is a headroom-full shared slot: Bluechip peak 3 plus
    // digest-chain peak 1 plus coverage discovery peak 1 totals 5/6.
    job: "sync-bluechip",
    label: "Bluechip sync",
    group: "daily",
    intervalSec: DAY_SECONDS,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
    maxConnections: 3, // Bluechip fetches in parallel batches of 3
  },
  {
    job: "daily-digest",
    label: "Daily digest",
    group: "daily",
    intervalSec: DAY_SECONDS,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
    maxConnections: 1, // Anthropic LLM call, then Twitter + Telegram posts (sequential)
    connectionGroup: "digest-chain",
  },
  {
    job: "weekly-recap",
    label: "Weekly recap",
    group: "daily",
    intervalSec: 604800,
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
    maxConnections: 1, // Anthropic LLM call, then Telegram post (sequential)
    connectionGroup: "digest-chain",
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
  {
    job: "prune-status-probe-runs",
    label: "Status probe TTL prune",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0300Utc",
    triggerMode: "isolated",
    maxConnections: 0, // DB-only DELETE
  },
  {
    job: "prune-cron-history",
    label: "Cron history TTL prune",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0300Utc",
    triggerMode: "isolated",
    maxConnections: 0, // DB-only DELETE of cron_runs + cron_slot_executions
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
