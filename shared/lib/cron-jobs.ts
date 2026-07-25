import { DAY_SECONDS } from "./time-constants";

export type CronGroupKey =
  | "quarter-hourly"
  | "five-minute"
  | "half-hourly"
  | "hourly"
  | "multi-hourly"
  | "daily"
  | "other";

const CRON_SCHEDULE_DEFINITIONS = {
  quarterHourly: { schedule: "*/15 * * * *", intervalSec: 900, offsetSec: 0 },
  statusSelfCheckOffset: { schedule: "9,24,39,54 * * * *", intervalSec: 900, offsetSec: 9 * 60 },
  sixHourlyBlacklist: { schedule: "3 */6 * * *", intervalSec: 6 * 3600, offsetSec: 3 * 60 },
  halfHourlyMintBurnCritical: { schedule: "4,34 * * * *", intervalSec: 1800, offsetSec: 4 * 60 },
  twoHourlyDexDiscovery: { schedule: "6 */2 * * *", intervalSec: 2 * 3600, offsetSec: 6 * 60 },
  halfHourlyMintBurnExtended: { schedule: "13,43 * * * *", intervalSec: 1800, offsetSec: 13 * 60 },
  halfHourlyMeasuredExecution: { schedule: "0,30 * * * *", intervalSec: 1800, offsetSec: 0 },
  halfHourlyOffset: { schedule: "10,40 * * * *", intervalSec: 1800, offsetSec: 10 * 60 },
  halfHourlyChartsOffset: { schedule: "16,46 * * * *", intervalSec: 1800, offsetSec: 16 * 60 },
  dewsPsiOffset: { schedule: "26,56 * * * *", intervalSec: 1800, offsetSec: 26 * 60 },
  fourHourlyReserveSync: { schedule: "11 */4 * * *", intervalSec: 4 * 3600, offsetSec: 11 * 60 },
  hourlyYieldSync: { schedule: "20 * * * *", intervalSec: 3600, offsetSec: 20 * 60 },
  fourHourlyYieldSupplemental: { schedule: "25 */4 * * *", intervalSec: 4 * 3600, offsetSec: 25 * 60 },
  fiveMinuteTelegramAlerts: {
    schedule: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
    intervalSec: 300,
    offsetSec: 2 * 60,
  },
  fiveMinuteReserveRecovery: {
    schedule: "1,6,11,16,21,26,31,36,41,46,51,56 * * * *",
    intervalSec: 300,
    offsetSec: 60,
  },
  digestTriggerPoll: { schedule: "*/5 * * * *", intervalSec: 300, offsetSec: 0 },
  daily0300Utc: { schedule: "0 3 * * *", intervalSec: DAY_SECONDS, offsetSec: 3 * 3600 },
  daily0800Utc: { schedule: "0 8 * * *", intervalSec: DAY_SECONDS, offsetSec: 8 * 3600 },
  daily0805Utc: { schedule: "5 8 * * *", intervalSec: DAY_SECONDS, offsetSec: 8 * 3600 + 5 * 60 },
  daily0810Utc: { schedule: "10 8 * * *", intervalSec: DAY_SECONDS, offsetSec: 8 * 3600 + 10 * 60 },
  monthlyYieldAudit: { schedule: "0 6 1 * *", intervalSec: 30 * 86400, offsetSec: 6 * 3600 },
} as const;

export const CRON_CONNECTION_BUDGET = {
  maxPerTrigger: 6,
  failAt: 6,
  fullForNewFetchHeavyWorkAt: 5,
} as const;

export type CronScheduleKey = keyof typeof CRON_SCHEDULE_DEFINITIONS;
export type CronScheduleExpression = (typeof CRON_SCHEDULE_DEFINITIONS)[CronScheduleKey]["schedule"];
export type CronTriggerMode = "shared" | "isolated";
export type CronStatusImpact = "critical" | "watch";

const _cronSchedules: Record<string, CronScheduleExpression> = {};
const _cronIntervals: Record<string, number> = {};
const _cronOffsets: Record<string, number> = {};
for (const [scheduleKey, definition] of Object.entries(CRON_SCHEDULE_DEFINITIONS)) {
  _cronSchedules[scheduleKey] = definition.schedule;
  _cronIntervals[scheduleKey] = definition.intervalSec;
  _cronOffsets[scheduleKey] = definition.offsetSec;
}

export const CRON_SCHEDULES = Object.freeze(_cronSchedules as Record<CronScheduleKey, CronScheduleExpression>);
const CRON_SCHEDULE_INTERVALS = Object.freeze(_cronIntervals as Record<CronScheduleKey, number>);
const CRON_SCHEDULE_BUCKET_OFFSETS = Object.freeze(_cronOffsets as Record<CronScheduleKey, number>);

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
  /** Maximum simultaneous outbound fetches under the repo's six-per-trigger budget. */
  maxConnections?: number;
  /** Jobs with the same trigger and concurrency group are chained, so their peak is max(), not sum(). */
  connectionGroup?: string;
}

export interface CronJobMeta extends CronJobDefinition {
  schedule: CronScheduleExpression;
  statusImpact: CronStatusImpact;
}

export interface CronConnectionBudgetDefinition {
  job: string;
  label: string;
  scheduleKey: CronScheduleKey;
  /** Maximum simultaneous outbound fetches under the repo's six-per-trigger budget. */
  maxConnections: number;
  /** Work with the same trigger and connection group is chained, so its peak is max(), not sum(). */
  connectionGroup?: string;
  /** False for scheduled side work that is not represented as a separate cron_runs job. */
  statusTracked: boolean;
  notes?: string;
}

export interface CronConnectionBudgetMeta extends CronConnectionBudgetDefinition {
  schedule: CronScheduleExpression;
  intervalSec: number;
}

type CronJobDefinitionInput = Omit<CronJobDefinition, "intervalSec"> & {
  intervalSec?: number;
  statusImpact?: CronStatusImpact;
};

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
    description:
      "Dedicated DEX and chart lanes, decoupled DEWS/PSI publication, plus isolated mint/burn critical and extended triggers.",
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
    description:
      "Isolated slower lanes: 2-hour DEX discovery, 4-hour reserve/redemption/Kinesis and supplemental yield, plus 6-hour critical blacklist sync.",
  },
  {
    key: "daily",
    title: "Daily slot",
    badge: "daily",
    description:
      "03:00 retention pruning plus 08:00 snapshots/monitors, 08:05 digest/Bluechip, and 08:10 weekly recap lanes.",
  },
  {
    key: "other",
    title: "Other cadence",
    badge: "unmapped",
    description: "Fallback bucket for jobs that do not yet have status-page display metadata.",
  },
] as const;

const CRON_JOB_DEFINITIONS_BASE: readonly CronJobDefinitionInput[] = [
  {
    job: "sync-stablecoins",
    label: "Stablecoin sync",
    group: "quarter-hourly",
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    statusImpact: "critical",
    maxConnections: 4, // Intake and supplemental families retain the slot reservation; primary provider fanout is lower for Worker heap headroom.
    connectionGroup: "quarter-hourly-chain",
  },
  {
    job: "sync-stablecoin-charts",
    label: "Stablecoin charts",
    group: "half-hourly",
    intervalSec: 3600,
    scheduleKey: "halfHourlyChartsOffset",
    triggerMode: "shared",
    maxConnections: 1, // Single DL stablecoincharts/all fetch
    connectionGroup: "half-hourly-scoring-charts-chain",
  },
  {
    job: "sync-fx-rates",
    label: "FX rates",
    group: "quarter-hourly",
    intervalSec: 1800, // Trigger fires every 15 min alongside sync-stablecoins, but internal cooldown gates actual writes to every 30 min.
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    statusImpact: "critical",
    maxConnections: 3, // Secondary FX races three mirrors; Chainlink feed pipelines are also bounded at three.
    connectionGroup: "quarter-hourly-chain",
  },
  {
    job: "stability-index",
    label: "PSI compute",
    group: "half-hourly",
    scheduleKey: "dewsPsiOffset",
    triggerMode: "shared",
    maxConnections: 0, // DB-only computation
    connectionGroup: "dews-psi-chain",
  },
  {
    job: "compute-dews",
    label: "DEWS compute",
    group: "half-hourly",
    scheduleKey: "dewsPsiOffset",
    triggerMode: "shared",
    maxConnections: 0, // DB-only computation
    connectionGroup: "dews-psi-chain",
  },
  {
    job: "project-tape",
    label: "Tape projector",
    group: "half-hourly",
    scheduleKey: "dewsPsiOffset",
    triggerMode: "shared",
    maxConnections: 0, // Pure D1 projection from existing source tables
    connectionGroup: "dews-psi-chain",
  },
  {
    job: "cron-slot-sweeper",
    label: "Cron slot sweeper",
    group: "quarter-hourly",
    scheduleKey: "statusSelfCheckOffset",
    triggerMode: "isolated",
    maxConnections: 1, // DB stale-slot reconciliation
    connectionGroup: "status-self-check-chain",
  },
  {
    job: "reserve-recovery",
    label: "Reserve recovery",
    group: "five-minute",
    scheduleKey: "fiveMinuteReserveRecovery",
    triggerMode: "isolated",
    statusImpact: "critical",
    maxConnections: 2,
    connectionGroup: "reserve-recovery-chain",
  },
  {
    job: "status-self-check",
    label: "Status self-check",
    group: "quarter-hourly",
    scheduleKey: "statusSelfCheckOffset",
    triggerMode: "isolated",
    maxConnections: 1, // Sequential internal/external status probes
    connectionGroup: "status-self-check-chain",
  },
  {
    job: "data-invariant-canary",
    label: "Data invariant canary",
    group: "quarter-hourly",
    scheduleKey: "statusSelfCheckOffset",
    triggerMode: "isolated",
    maxConnections: 0, // DB/cache-only structural checks; no outbound fetches
    connectionGroup: "status-self-check-chain",
  },
  {
    job: "cron-staleness-watchdog",
    label: "Cron staleness watchdog",
    group: "quarter-hourly",
    scheduleKey: "statusSelfCheckOffset",
    triggerMode: "isolated",
    maxConnections: 1, // DB freshness inspection
    connectionGroup: "status-self-check-chain",
  },
  {
    job: "dispatch-telegram-alerts",
    label: "Telegram alerts",
    group: "five-minute",
    scheduleKey: "fiveMinuteTelegramAlerts",
    triggerMode: "isolated",
    maxConnections: 4, // Telegram sendMessage batches run with SEND_BATCH_SIZE=4
    connectionGroup: "five-minute-telegram-chain",
  },
  {
    job: "telegram-personalized-recap-planner",
    label: "Telegram personalized recap planner",
    group: "five-minute",
    scheduleKey: "fiveMinuteTelegramAlerts",
    triggerMode: "isolated",
    maxConnections: 0, // D1-only deterministic planning; delivery remains in the pending drain
    connectionGroup: "five-minute-telegram-chain",
  },
  {
    job: "telegram-degradation-watchdog",
    label: "Telegram degradation watchdog",
    group: "five-minute",
    scheduleKey: "fiveMinuteTelegramAlerts",
    triggerMode: "isolated",
    maxConnections: 1, // DB inspection plus one serial durable-broker webhook retry
    connectionGroup: "five-minute-telegram-chain",
  },
  {
    job: "telegram-disambiguation-cleanup",
    label: "Telegram disambiguation cleanup",
    group: "five-minute",
    scheduleKey: "fiveMinuteTelegramAlerts",
    triggerMode: "isolated",
    maxConnections: 0, // DB-only DELETE of expired pending disambiguation rows
    connectionGroup: "five-minute-telegram-chain",
  },
  {
    job: "telegram-pulse-snapshot",
    label: "Telegram pulse snapshot",
    group: "five-minute",
    scheduleKey: "fiveMinuteTelegramAlerts",
    triggerMode: "isolated",
    maxConnections: 0, // DB-only materialization for the public pulse endpoint
    connectionGroup: "five-minute-telegram-chain",
  },
  {
    job: "sync-blacklist",
    label: "Blacklist sync",
    group: "multi-hourly",
    scheduleKey: "sixHourlyBlacklist",
    triggerMode: "isolated",
    statusImpact: "critical",
    maxConnections: 1, // Rate-limited sequential Etherscan/TronGrid/RPC calls
  },
  {
    job: "sync-mint-burn",
    label: "Mint/burn critical",
    group: "half-hourly",
    scheduleKey: "halfHourlyMintBurnCritical",
    triggerMode: "isolated",
    statusImpact: "critical",
    maxConnections: 1, // Sequential Alchemy eth_getLogs + eth_getBlockByNumber calls
  },
  {
    job: "sync-mint-burn-extended",
    label: "Mint/burn extended",
    group: "half-hourly",
    scheduleKey: "halfHourlyMintBurnExtended",
    triggerMode: "isolated",
    maxConnections: 1, // Sequential Alchemy eth_getLogs + eth_getBlockByNumber calls
  },
  {
    job: "sync-dex-discovery",
    label: "DEX pool discovery",
    group: "multi-hourly",
    scheduleKey: "twoHourlyDexDiscovery",
    triggerMode: "isolated",
    maxConnections: 1, // Rate-limited sequential GeckoTerminal/CoinGecko crawl
  },
  {
    job: "sync-cl-exit-depth",
    label: "CL exit depth",
    group: "half-hourly",
    scheduleKey: "halfHourlyMeasuredExecution",
    triggerMode: "isolated",
    maxConnections: 5, // Three EVM chain lanes plus serialized Solana and Tron quote streams.
  },
  {
    job: "sync-dex-liquidity-stage",
    label: "DEX liquidity source stage",
    group: "half-hourly",
    scheduleKey: "halfHourlyOffset",
    triggerMode: "isolated",
    maxConnections: 5, // Nested direct-API peak; below the platform header-wait ceiling and repo budget.
  },
  {
    job: "sync-dex-liquidity",
    label: "DEX liquidity scoring",
    group: "half-hourly",
    scheduleKey: "halfHourlyChartsOffset",
    triggerMode: "shared",
    maxConnections: 0, // D1-only consumer of the complete source-stage generation.
    connectionGroup: "half-hourly-scoring-charts-chain",
  },
  {
    job: "sync-yield-data",
    label: "Yield sync",
    group: "hourly",
    scheduleKey: "hourlyYieldSync",
    triggerMode: "isolated",
    maxConnections: 1, // on-chain rate batch (1); DL pools read from cache written by sync-dex-liquidity (sequential)
  },
  {
    job: "sync-yield-supplemental",
    label: "Yield supplemental sync",
    group: "multi-hourly",
    scheduleKey: "fourHourlyYieldSupplemental",
    triggerMode: "isolated",
    maxConnections: 3, // Supplemental families run serially; Beefy is the peak with 3 parallel API reads
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
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 1, // Due-only V9 shadow enrichment uses one Ethereum multicall after V8 commits.
    connectionGroup: "quarter-hourly-chain",
  },
  {
    job: "compute-depeg-resolver",
    label: "Depeg Duration Resolver",
    group: "quarter-hourly",
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 0,
    connectionGroup: "quarter-hourly-chain",
  },
  {
    job: "snapshot-safety-grade-history",
    label: "Safety grade snapshot",
    group: "daily",
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 0, // DB-only snapshot
  },
  {
    job: "fetch-tbill-rate",
    label: "T-bill rate",
    group: "daily",
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 1, // Sequential benchmark fetches (ECB/FRED/Treasury/SNB)
    connectionGroup: "daily-0800-fetch-chain",
  },
  {
    job: "snapshot-psi",
    label: "PSI snapshot",
    group: "daily",
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 0, // DB-only snapshot
  },
  {
    job: "snapshot-public-dataset",
    label: "Public dataset snapshot",
    group: "daily",
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 0, // D1 read + D1 write; no outbound fetches
  },
  {
    job: "sync-usds-status",
    label: "USDS status",
    group: "daily",
    scheduleKey: "daily0800Utc",
    triggerMode: "shared",
    maxConnections: 1, // Sequential Etherscan eth_getStorageAt + eth_call probes
    connectionGroup: "daily-0800-fetch-chain",
  },
  {
    job: "sync-live-reserves",
    label: "Live reserve sync",
    group: "multi-hourly",
    scheduleKey: "fourHourlyReserveSync",
    triggerMode: "shared",
    maxConnections: 2, // Sequential per-coin loop with per-adapter I/O limited to 2
    connectionGroup: "reserve-sync-chain",
  },
  {
    job: "sync-redemption-backstops",
    label: "Redemption backstops",
    group: "multi-hourly",
    scheduleKey: "fourHourlyReserveSync",
    triggerMode: "shared",
    maxConnections: 0, // DB-only computation from cached stablecoins + liquidity data
    connectionGroup: "reserve-sync-chain",
  },
  {
    job: "sync-kinesis-supply",
    label: "Kinesis supply",
    group: "multi-hourly",
    scheduleKey: "fourHourlyReserveSync",
    triggerMode: "shared",
    maxConnections: 1, // 2 sequential Kinesis Horizon fetches (KAU + KAG)
    connectionGroup: "reserve-sync-chain",
  },
  {
    job: "reserve-post-sync-watchdog",
    label: "Reserve post-sync watchdog",
    group: "multi-hourly",
    scheduleKey: "fourHourlyReserveSync",
    triggerMode: "shared",
    maxConnections: 1, // DB drift/cache/age checks
    connectionGroup: "reserve-sync-chain",
  },
  {
    job: "sync-bluechip",
    label: "Bluechip sync",
    group: "daily",
    scheduleKey: "daily0805Utc",
    triggerMode: "shared",
    maxConnections: 3, // Bluechip fetches in parallel batches of 3
  },
  {
    job: "daily-digest",
    label: "Daily digest",
    group: "daily",
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
    scheduleKey: "daily0810Utc",
    triggerMode: "shared",
    maxConnections: 1, // Anthropic LLM call, then Telegram post (sequential)
    connectionGroup: "weekly-recap",
  },
  {
    job: "yield-coverage-audit",
    label: "Yield coverage audit",
    group: "other",
    scheduleKey: "monthlyYieldAudit",
    triggerMode: "isolated",
    maxConnections: 1,
  },
  {
    job: "prune-status-probe-runs",
    label: "Status probe TTL prune",
    group: "daily",
    scheduleKey: "daily0300Utc",
    triggerMode: "isolated",
    maxConnections: 0, // DB-only DELETE
  },
  {
    job: "prune-cron-history",
    label: "Cron history TTL prune",
    group: "daily",
    scheduleKey: "daily0300Utc",
    triggerMode: "isolated",
    maxConnections: 0, // DB-only DELETE of cron_runs + cron_slot_executions
  },
  {
    job: "worker-repair-runner",
    label: "Worker repair runner",
    group: "daily",
    scheduleKey: "daily0300Utc",
    triggerMode: "isolated",
    maxConnections: 0, // DB-only due/stale repair-debt telemetry
  },
  {
    job: "prune-detail-cache",
    label: "Detail cache orphan/stale prune",
    group: "daily",
    scheduleKey: "daily0300Utc",
    triggerMode: "isolated",
    maxConnections: 0, // DB-only scan + DELETE of detail:* cache rows
  },
  {
    job: "telegram-inactive-cleanup",
    label: "Telegram inactive subscriber cleanup",
    group: "daily",
    intervalSec: 7 * DAY_SECONDS,
    scheduleKey: "daily0300Utc",
    triggerMode: "isolated",
    maxConnections: 0, // DB-only cascade DELETE per inactive chat
  },
  {
    job: "telegram-retention-cleanup",
    label: "Telegram audit retention cleanup",
    group: "daily",
    scheduleKey: "daily0300Utc",
    triggerMode: "isolated",
    maxConnections: 0, // DB-only retention DELETEs and target reconciliation
  },
  {
    job: "mint-burn-growth-watchdog",
    label: "Mint/burn growth budget watchdog",
    group: "daily",
    scheduleKey: "daily0300Utc",
    triggerMode: "isolated",
    maxConnections: 1, // DB row-count read
  },
  {
    job: "cron-duration-watchdog",
    label: "Cron duration budget watchdog",
    group: "daily",
    scheduleKey: "daily0300Utc",
    triggerMode: "isolated",
    maxConnections: 1, // DB duration aggregates
  },
] as const;

export const CRON_JOB_DEFINITIONS: readonly CronJobMeta[] = CRON_JOB_DEFINITIONS_BASE.map((definition) => {
  const intervalSec = definition.intervalSec ?? CRON_SCHEDULE_INTERVALS[definition.scheduleKey];
  return {
    ...definition,
    intervalSec,
    schedule: CRON_SCHEDULES[definition.scheduleKey],
    statusImpact: definition.statusImpact ?? "watch",
  };
});

const CRON_CONNECTION_BUDGET_ONLY_DEFINITIONS: readonly CronConnectionBudgetDefinition[] = [
  {
    job: "telegram-registration-reconciliation",
    label: "Telegram registration reconciliation",
    scheduleKey: "fiveMinuteTelegramAlerts",
    maxConnections: 1,
    connectionGroup: "five-minute-telegram-chain",
    statusTracked: false,
    notes:
      "Best-effort command, profile, and webhook reconciliation runs serially before dispatch when 15-minute cache markers expire.",
  },
  {
    job: "telegram-digest-outbox-drain",
    label: "Telegram digest outbox drain",
    scheduleKey: "digestTriggerPoll",
    maxConnections: 1,
    connectionGroup: "digest-trigger-poll-chain",
    statusTracked: false,
    notes:
      "Retries immutable Telegram daily/weekly digest editions without regenerating copy and surfaces ambiguous sends for operator reconciliation.",
  },
  {
    job: "digest-trigger-poll",
    label: "Manual digest trigger poll",
    scheduleKey: "digestTriggerPoll",
    maxConnections: 1,
    connectionGroup: "digest-trigger-poll-chain",
    statusTracked: false,
    notes:
      "Polls the force-run cache key every 5 minutes; when pending, it runs daily-digest under the existing daily-digest lease.",
  },
] as const;

export const CRON_CONNECTION_BUDGET_ENTRIES: readonly CronConnectionBudgetMeta[] = [
  ...CRON_JOB_DEFINITIONS_BASE.map((definition) => ({
    job: definition.job,
    label: definition.label,
    scheduleKey: definition.scheduleKey,
    maxConnections: definition.maxConnections ?? 0,
    connectionGroup: definition.connectionGroup,
    statusTracked: true,
  })),
  ...CRON_CONNECTION_BUDGET_ONLY_DEFINITIONS,
].map((definition) => ({
  ...definition,
  schedule: CRON_SCHEDULES[definition.scheduleKey],
  intervalSec: CRON_SCHEDULE_INTERVALS[definition.scheduleKey],
}));

/** Job name → expected interval in seconds, derived from definitions. */
export const CRON_INTERVALS = Object.freeze(
  Object.fromEntries(CRON_JOB_DEFINITIONS.map((item) => [item.job, item.intervalSec])) as Record<string, number>,
);

/** Set of all valid cron job names, derived from definitions. */
export const VALID_CRON_JOB_IDS: ReadonlySet<string> = new Set(CRON_JOB_DEFINITIONS.map((def) => def.job));

const CRON_JOB_META_BY_ID = new Map(CRON_JOB_DEFINITIONS.map((definition) => [definition.job, definition]));

export function getCronJobMeta(job: string): CronJobMeta | null {
  return CRON_JOB_META_BY_ID.get(job) ?? null;
}

export function getCronStatusImpact(job: string): CronStatusImpact {
  return getCronJobMeta(job)?.statusImpact ?? "watch";
}

function normalizeCronSlotStartedAt(timestampSec: number, intervalSec: number, offsetSec = 0): number {
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
