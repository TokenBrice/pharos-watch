import {
  addFreshnessHeaders,
  buildMethodologyEnvelope,
  getLatestSuccessfulCronTimestamp,
  jsonResponseWithHeaders,
  } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/blacklist-tracker";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { getBlacklistGapStatus, type FreshnessStatus } from "@shared/lib/status-thresholds";
import { isRecord } from "@shared/lib/type-guards";
import { CONTRACT_CONFIGS } from "../lib/blacklist-contracts";
import { getDeferredBlacklistCoverage } from "../lib/blacklist-coverage-manifest";
import { loadBlacklistCurrentBalanceMap } from "../lib/blacklist-current-balances";
import {
  BLACKLIST_GAP_METRICS_DIAGNOSTIC_CACHE_TTL_SEC,
  BLACKLIST_GAP_METRICS_PRODUCER_SNAPSHOT_TTL_SEC,
  queryBlacklistGapMetrics,
  type BlacklistGapMetrics,
} from "../lib/blacklist-gaps";
import {
  BLACKLIST_STABLECOINS,
  type BlacklistEvent,
  type BlacklistQuarterlyEventTypePoint,
  type BlacklistRecentEventTypeCounts,
  type BlacklistStablecoin,
} from "@shared/types/market";
import { buildBlacklistQuarterlyChartFromSnapshots, sortKeyToLabel } from "@shared/lib/blacklist-aggregates";
import { isBlacklistStablecoin } from "@shared/lib/blacklist";
import { mapBlacklistEventRow, type BlacklistEventRow } from "../lib/blacklist-api";
import {
  buildBlacklistActiveRecords,
  computeBlacklistActiveSummaryStats,
  computeBlacklistTrackedSummaryStats,
  type BlacklistCurrentBalanceSnapshot,
} from "@shared/lib/blacklist-active-records";
import { loadBlacklistReconciliationStatus } from "../lib/blacklist-reconciliation-status";
import {
  BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY,
  BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION,
} from "../lib/blacklist-cache-keys";

type BlacklistSummaryPayload = Record<string, unknown>;

interface BuiltBlacklistSummary {
  payload: BlacklistSummaryPayload;
  freshnessTs: number;
}

interface CachedBlacklistSummarySnapshot {
  version: typeof BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION;
  materializedAt: number;
  freshnessTs: number;
  payload: BlacklistSummaryPayload;
}

const BLACKLIST_IDENTITY_PARTITION_SQL = `
  stablecoin,
  chain_id,
  LOWER(address),
  COALESCE(LOWER(config_key), ''),
  COALESCE(LOWER(contract_address), '')
`;

function incrementCount(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function getProviderSource(chainType: "evm" | "tron" | "other"): "evm-logs" | "trongrid" | "other" {
  if (chainType === "tron") return "trongrid";
  if (chainType === "evm") return "evm-logs";
  return "other";
}

function buildCoverage() {
  const deferredCoverage = getDeferredBlacklistCoverage();
  const bySymbol: Record<string, number> = {};
  const byChain: Record<string, number> = {};
  const byProviderSource: Record<string, number> = {};
  const supported = CONTRACT_CONFIGS.map((config) => {
    const providerSource = getProviderSource(config.chain.type);
    incrementCount(bySymbol, config.stablecoin);
    incrementCount(byChain, config.chain.chainId);
    incrementCount(byProviderSource, providerSource);
    return {
      symbol: config.stablecoin,
      stablecoinId: config.stablecoinId,
      chainId: config.chain.chainId,
      chainName: config.chain.chainName,
      contractAddress: config.contractAddress,
      configKey: config.configKey,
      providerSource,
      eventFamilies: [...new Set(config.events.map((event) => event.signature))],
      eventTypes: [...new Set(config.events.map((event) => event.eventType))],
    };
  });

  return {
    supported,
    unsupportedDeferred: deferredCoverage,
    counts: {
      supportedConfigs: supported.length,
      unsupportedDeferredConfigs: deferredCoverage.length,
      bySymbol,
      byChain,
      byProviderSource,
    },
  };
}

function classifyLedgerFreshness(observedAt: number | null | undefined, now: number): FreshnessStatus {
  if (observedAt == null) return "stale";
  const ageSec = Math.max(0, now - observedAt);
  if (ageSec <= API_FRESHNESS_MAX_AGE_SEC.blacklistSummary) return "fresh";
  if (ageSec <= API_FRESHNESS_MAX_AGE_SEC.blacklistSummary * 2) return "degraded";
  return "stale";
}

function sourceCategory(source: string): "bootstrap" | "current" | "destroy" | "other" {
  if (source.includes("bootstrap")) return "bootstrap";
  if (source === "destroy_event") return "destroy";
  if (source === "current_balance") return "current";
  return "other";
}

function isDestroySnapshot(snapshot: BlacklistCurrentBalanceSnapshot): boolean {
  return sourceCategory(snapshot.source) === "destroy";
}

async function queryLatestEventTypeHistory(db: D1Database): Promise<BlacklistEvent[]> {
  const activeHistoryResult = await db
    .prepare(
      `/* blacklist-summary-latest-event-type-history */
       WITH latest_event_type AS (
         SELECT
           id, stablecoin, chain_id, chain_name, event_type, address,
           amount_native, amount_usd_at_event, amount_source, amount_status,
           tx_hash, block_number, timestamp, methodology_version,
           contract_address, config_key, event_signature, event_topic0,
           suppression_reason, explorer_tx_url, explorer_address_url,
           ROW_NUMBER() OVER (
             PARTITION BY ${BLACKLIST_IDENTITY_PARTITION_SQL}, event_type
             ORDER BY timestamp DESC, id DESC
           ) AS rn
         FROM blacklist_events
         WHERE suppression_reason IS NULL
           AND event_type IN ('blacklist', 'unblacklist', 'destroy')
       )
       SELECT id, stablecoin, chain_id, chain_name, event_type, address,
              amount_native, amount_usd_at_event, amount_source, amount_status,
              tx_hash, block_number, timestamp, methodology_version,
              contract_address, config_key, event_signature, event_topic0,
              suppression_reason, explorer_tx_url, explorer_address_url
       FROM latest_event_type
       WHERE rn = 1
       ORDER BY timestamp ASC, id ASC`,
    )
    .all<BlacklistEventRow>();

  return (activeHistoryResult.results ?? []).map(mapBlacklistEventRow);
}

function buildFreezeLedgerMeta(
  currentBalances: ReadonlyMap<string, BlacklistCurrentBalanceSnapshot>,
  gapMetrics: BlacklistGapMetrics,
  trackedGapCount: number,
  now: number,
) {
  const statusDistribution: Record<string, number> = {};
  const sourceDistribution: Record<string, number> = {};
  const freshnessDistribution = { fresh: 0, degraded: 0, stale: 0 };
  const currentFreshnessDistribution = { fresh: 0, degraded: 0, stale: 0 };
  const sourceCategoryCounts = { bootstrap: 0, current: 0, destroy: 0, other: 0 };
  const lastErrorClassDistribution: Record<string, number> = {};
  let oldestObservedAt: number | null = null;
  let newestObservedAt: number | null = null;
  let providerFailedCount = 0;
  let scopedRows = 0;
  let legacyRows = 0;

  for (const snapshot of currentBalances.values()) {
    const category = sourceCategory(snapshot.source);
    const freshness = classifyLedgerFreshness(snapshot.observedAt, now);
    incrementCount(statusDistribution, snapshot.status);
    incrementCount(sourceDistribution, snapshot.source);
    sourceCategoryCounts[category]++;
    freshnessDistribution[freshness]++;
    if (category === "current" || snapshot.status === "provider_failed") {
      currentFreshnessDistribution[freshness]++;
    }
    if (snapshot.status === "provider_failed") providerFailedCount++;
    if (snapshot.lastErrorClass) incrementCount(lastErrorClassDistribution, snapshot.lastErrorClass);
    if (snapshot.configKey || snapshot.contractAddress) scopedRows++;
    else legacyRows++;
    oldestObservedAt = oldestObservedAt == null ? snapshot.observedAt : Math.min(oldestObservedAt, snapshot.observedAt);
    newestObservedAt = newestObservedAt == null ? snapshot.observedAt : Math.max(newestObservedAt, snapshot.observedAt);
  }

  return {
    totalRows: currentBalances.size,
    scopedRows,
    legacyRows,
    oldestObservedAt,
    newestObservedAt,
    oldestAgeSec: oldestObservedAt == null ? null : Math.max(0, now - oldestObservedAt),
    newestAgeSec: newestObservedAt == null ? null : Math.max(0, now - newestObservedAt),
    statusDistribution,
    sourceDistribution,
    freshnessDistribution,
    currentFreshnessDistribution,
    providerFailedCount,
    lastErrorClassDistribution,
    sourceCategoryCounts,
    gaps: {
      tracked: trackedGapCount,
      recoverable: gapMetrics.missingAmounts,
      unrecoverable: gapMetrics.unrecoverableMissingAmounts,
      recentRecoverable: gapMetrics.recentMissingAmounts,
      neverAttempted: gapMetrics.neverAttemptedCount,
      repeatedFailures: gapMetrics.repeatedFailureCount,
      oldestRecoverableAgeSec: gapMetrics.oldestRecoverableAgeSec,
      amountStatusDistribution: gapMetrics.statusDistribution,
      amountSourceDistribution: gapMetrics.sourceDistribution,
    },
  };
}

function buildDataQuality(
  freezeLedgerMeta: ReturnType<typeof buildFreezeLedgerMeta>,
  gapMetrics: BlacklistGapMetrics,
  coverage: ReturnType<typeof buildCoverage>,
) {
  const gapStatus = getBlacklistGapStatus({
    missingRatio: gapMetrics.missingRatio,
    recentMissingAmounts: gapMetrics.recentMissingAmounts,
  });
  // Resolved freeze-ledger rows are retained historical snapshots by design.
  // Their age remains visible in freezeLedgerMeta.currentFreshnessDistribution,
  // but it is not an actionable stale condition unless the provider is failing
  // or recoverable amount gaps cross the shared gap thresholds.
  const actionableStaleSnapshotCount = 0;
  const status =
    gapStatus === "stale"
      ? "stale"
      : gapStatus === "degraded" || freezeLedgerMeta.providerFailedCount > 0
        ? "degraded"
        : "ok";
  const warnings: string[] = [];
  if (gapStatus !== "healthy" && gapMetrics.missingAmounts > 0) warnings.push("recoverable-amount-gaps");
  if (freezeLedgerMeta.providerFailedCount > 0) warnings.push("current-balance-provider-failures");

  return {
    status,
    warnings,
    amountGaps: {
      totalEvents: gapMetrics.totalEvents,
      recoverable: gapMetrics.missingAmounts,
      unrecoverable: gapMetrics.unrecoverableMissingAmounts,
      recentRecoverable: gapMetrics.recentMissingAmounts,
      missingRatio: gapMetrics.missingRatio,
      recentWindowSec: gapMetrics.recentWindowSec,
    },
    freezeLedger: {
      providerFailedCount: freezeLedgerMeta.providerFailedCount,
      staleSnapshotCount: actionableStaleSnapshotCount,
      trackedGapCount: freezeLedgerMeta.gaps.tracked,
      scopedRows: freezeLedgerMeta.scopedRows,
      legacyRows: freezeLedgerMeta.legacyRows,
    },
    coverage: {
      supportedConfigs: coverage.counts.supportedConfigs,
      unsupportedDeferredConfigs: coverage.counts.unsupportedDeferredConfigs,
    },
  };
}

interface ActiveBlacklistRecords {
  activeRecordEvents: BlacklistEvent[];
  frozenAddresses: number;
  perCoinFrozenAddressCount: Record<BlacklistStablecoin, number>;
  activeStats: ReturnType<typeof computeBlacklistActiveSummaryStats>;
}

/**
 * Resolve active freeze records from event history for net blacklist state.
 * Current-balance rows are retained freeze-ledger snapshots, including after
 * releases, so they are only used to hydrate amounts for event-derived active
 * records and must not define the active address set.
 */
function resolveActiveBlacklistRecords(
  activeHistory: BlacklistEvent[],
  currentBalances: ReadonlyMap<string, BlacklistCurrentBalanceSnapshot>,
): ActiveBlacklistRecords {
  const activeRecordEvents = activeHistory;
  const activeRecords = buildBlacklistActiveRecords(activeRecordEvents, currentBalances);
  const activeStats = computeBlacklistActiveSummaryStats(activeRecords);
  const frozenAddresses = activeRecords.filter((record) => record.destroyedAt == null).length;

  const perCoinFrozenAddressCount = Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<
    BlacklistStablecoin,
    number
  >;
  for (const record of activeRecords) {
    if (record.destroyedAt != null) continue;
    if (!isBlacklistStablecoin(record.stablecoin)) continue;
    perCoinFrozenAddressCount[record.stablecoin] += 1;
  }

  return { activeRecordEvents, frozenAddresses, perCoinFrozenAddressCount, activeStats };
}

/**
 * Build per-coin quarterly event-type arrays. Missing quarters between a coin's
 * first and last event are zero-filled so bars render contiguously, matching
 * buildBlacklistQuarterlyChartFromSnapshots.
 */
function buildPerCoinQuarterlyEventTypes(
  rows: readonly { stablecoin: string; quarter_sort_key: number; event_type: string; n: number }[],
): Record<BlacklistStablecoin, BlacklistQuarterlyEventTypePoint[]> {
  const perCoinQuarterlyEventTypes = Object.fromEntries(
    BLACKLIST_STABLECOINS.map((s) => [s, [] as BlacklistQuarterlyEventTypePoint[]]),
  ) as Record<BlacklistStablecoin, BlacklistQuarterlyEventTypePoint[]>;
  const perCoinBucketMap = new Map<
    BlacklistStablecoin,
    Map<number, { blacklist: number; unblacklist: number; destroy: number }>
  >();
  for (const row of rows) {
    if (!isBlacklistStablecoin(row.stablecoin)) continue;
    const symbol = row.stablecoin;
    const coinBuckets = perCoinBucketMap.get(symbol) ?? new Map();
    const bucket = coinBuckets.get(row.quarter_sort_key) ?? { blacklist: 0, unblacklist: 0, destroy: 0 };
    if (row.event_type === "blacklist") bucket.blacklist += row.n;
    else if (row.event_type === "unblacklist") bucket.unblacklist += row.n;
    else if (row.event_type === "destroy") bucket.destroy += row.n;
    coinBuckets.set(row.quarter_sort_key, bucket);
    perCoinBucketMap.set(symbol, coinBuckets);
  }
  for (const [symbol, buckets] of perCoinBucketMap.entries()) {
    let minKey: number | null = null;
    let maxKey: number | null = null;
    for (const sortKey of buckets.keys()) {
      minKey = minKey == null ? sortKey : Math.min(minKey, sortKey);
      maxKey = maxKey == null ? sortKey : Math.max(maxKey, sortKey);
    }
    if (minKey == null || maxKey == null) continue;
    const points: BlacklistQuarterlyEventTypePoint[] = [];
    for (let k = minKey; k <= maxKey; k++) {
      const b = buckets.get(k) ?? { blacklist: 0, unblacklist: 0, destroy: 0 };
      points.push({ quarter: sortKeyToLabel(k), ...b });
    }
    perCoinQuarterlyEventTypes[symbol] = points;
  }
  return perCoinQuarterlyEventTypes;
}

/**
 * Build per-coin 7d event-type buckets so every supported coin has a defined
 * record (zero defaults) — clients can read without presence checks.
 */
function buildPerCoinRecentEventTypes(
  rows: readonly { stablecoin: string; event_type: string; n: number }[],
): Record<BlacklistStablecoin, BlacklistRecentEventTypeCounts> {
  const perCoinRecentEventTypes = Object.fromEntries(
    BLACKLIST_STABLECOINS.map((s) => [s, { freezes: 0, destroys: 0, releases: 0 }]),
  ) as Record<BlacklistStablecoin, BlacklistRecentEventTypeCounts>;
  for (const row of rows) {
    if (!isBlacklistStablecoin(row.stablecoin)) continue;
    const symbol = row.stablecoin;
    if (row.event_type === "blacklist") perCoinRecentEventTypes[symbol].freezes += row.n;
    else if (row.event_type === "destroy") perCoinRecentEventTypes[symbol].destroys += row.n;
    else if (row.event_type === "unblacklist") perCoinRecentEventTypes[symbol].releases += row.n;
  }
  return perCoinRecentEventTypes;
}

function isBlacklistSummaryPayload(value: unknown): value is BlacklistSummaryPayload {
  if (!isRecord(value)) return false;
  return (
    isRecord(value.stats) &&
    Array.isArray(value.chart) &&
    Array.isArray(value.chains) &&
    isRecord(value.coverage) &&
    isRecord(value.freezeLedgerMeta) &&
    isRecord(value.dataQuality) &&
    typeof value.totalEvents === "number" &&
    isRecord(value.methodology)
  );
}

function parseBlacklistSummarySnapshot(value: string): CachedBlacklistSummarySnapshot | null {
  try {
    const parsed = JSON.parse(value) as Partial<CachedBlacklistSummarySnapshot>;
    if (
      parsed.version !== BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION ||
      typeof parsed.materializedAt !== "number" ||
      typeof parsed.freshnessTs !== "number" ||
      !isBlacklistSummaryPayload(parsed.payload)
    ) {
      return null;
    }
    return {
      version: parsed.version,
      materializedAt: parsed.materializedAt,
      freshnessTs: parsed.freshnessTs,
      payload: parsed.payload,
    };
  } catch {
    return null;
  }
}

async function readBlacklistSummarySnapshot(db: D1Database): Promise<CachedBlacklistSummarySnapshot | null> {
  const row = await db
    .prepare("/* blacklist-summary-snapshot-read */ SELECT value, updated_at FROM cache WHERE key = ?")
    .bind(BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY)
    .first<{ value: string; updated_at: number }>();
  if (!row) return null;
  return parseBlacklistSummarySnapshot(row.value);
}

async function writeBlacklistSummarySnapshot(db: D1Database, snapshot: CachedBlacklistSummarySnapshot): Promise<void> {
  await db
    .prepare(
      "/* blacklist-summary-snapshot-write */ INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
    )
    .bind(BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY, JSON.stringify(snapshot), snapshot.materializedAt)
    .run();
}

async function buildBlacklistSummaryPayload(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  options?: { freshnessTsOverride?: number },
): Promise<BuiltBlacklistSummary> {
  const sevenDayCutoffSec = now - 7 * 86400;
  const [
    perCoinResult,
    perCoinQuarterlyResult,
    perCoinRecentResult,
    aggregateRow,
    currentBalances,
    activeHistory,
    gapMetrics,
    reconciliation,
  ] = await Promise.all([
    db
      .prepare(
        `/* blacklist-summary-per-coin-event-counts */
           SELECT stablecoin, event_type, COUNT(*) AS n, SUM(COALESCE(amount_usd_at_event, 0)) AS usd_sum
           FROM blacklist_events
           WHERE suppression_reason IS NULL
           GROUP BY stablecoin, event_type`,
      )
      .all<{ stablecoin: string; event_type: string; n: number; usd_sum: number }>(),

    // Per-coin, per-quarter, per-event-type counts for the stablecoin detail
    // page chart. Bucketing matches the JS helper in
    // shared/lib/blacklist-aggregates.ts (year*4 + floor(month/3)) so labels
    // align with the main-page chart.
    db
      .prepare(
        `/* blacklist-summary-quarterly-event-counts */
           SELECT
             stablecoin,
             (CAST(strftime('%Y', datetime(timestamp, 'unixepoch')) AS INTEGER) * 4 +
              CAST((CAST(strftime('%m', datetime(timestamp, 'unixepoch')) AS INTEGER) - 1) / 3 AS INTEGER)) AS quarter_sort_key,
             event_type,
             COUNT(*) AS n
           FROM blacklist_events
           WHERE suppression_reason IS NULL
           GROUP BY stablecoin, quarter_sort_key, event_type`,
      )
      .all<{ stablecoin: string; quarter_sort_key: number; event_type: string; n: number }>(),

    // Per-coin, per-event-type counts for the last 7 days. Powers the
    // detail-page RecentBlacklistBanner without forcing the client to fetch
    // a 250-row event payload just to compute three counters. Time window
    // mirrors the 7d cutoff applied client-side previously.
    db
      .prepare(
        `/* blacklist-summary-per-coin-recent-7d per_coin_recent_7d */
           SELECT stablecoin, event_type, COUNT(*) AS n
           FROM blacklist_events
           WHERE suppression_reason IS NULL
             AND timestamp >= ?
           GROUP BY stablecoin, event_type`,
      )
      .bind(sevenDayCutoffSec)
      .all<{ stablecoin: string; event_type: string; n: number }>(),

    // Collapse total / max(timestamp) / recoverable-gap / recent-30d /
    // recent-24h into a single aggregate pass so we don't hit the
    // public-events table five separate times under the
    // WHERE suppression_reason IS NULL predicate.
    db
      .prepare(
        `/* blacklist-summary-public-aggregate */
           SELECT
             COUNT(*) AS total,
             MAX(timestamp) AS max_ts,
             SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS recent_30d,
             SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS recent_24h
           FROM blacklist_events
           WHERE suppression_reason IS NULL`,
      )
      .bind(now - 30 * 86400, now - 86400)
      .first<{ total: number; max_ts: number | null; recent_30d: number; recent_24h: number }>(),

    loadBlacklistCurrentBalanceMap(db),
    queryLatestEventTypeHistory(db),
    queryBlacklistGapMetrics(db, now, {
      producerSnapshotTtlSec: BLACKLIST_GAP_METRICS_PRODUCER_SNAPSHOT_TTL_SEC,
      cacheTtlSec: BLACKLIST_GAP_METRICS_DIAGNOSTIC_CACHE_TTL_SEC,
    }),
    loadBlacklistReconciliationStatus(db),
  ]);
  const latestTs = aggregateRow?.max_ts ?? now;

  const { activeRecordEvents, frozenAddresses, perCoinFrozenAddressCount, activeStats } = resolveActiveBlacklistRecords(
    activeHistory,
    currentBalances,
  );
  const trackedStats = computeBlacklistTrackedSummaryStats(currentBalances);
  const coverage = buildCoverage();
  const freezeLedgerMeta = buildFreezeLedgerMeta(currentBalances, gapMetrics, trackedStats.trackedAmountGapCount, now);
  const dataQuality = buildDataQuality(freezeLedgerMeta, gapMetrics, coverage);

  const perCoinBlacklistCounts = Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<
    BlacklistStablecoin,
    number
  >;
  const perCoinTotalEvents = Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<
    BlacklistStablecoin,
    number
  >;
  let destroyedTotal = 0;
  const blacklistBySymbol = new Map<string, number>();
  for (const row of perCoinResult.results ?? []) {
    if (!isBlacklistStablecoin(row.stablecoin)) continue;
    const symbol = row.stablecoin;
    perCoinTotalEvents[symbol] += row.n;
    if (row.event_type === "blacklist") {
      perCoinBlacklistCounts[symbol] = row.n;
      blacklistBySymbol.set(row.stablecoin, row.n);
    }
    if (row.event_type === "destroy") destroyedTotal += row.usd_sum ?? 0;
  }

  const usdcBlacklisted = blacklistBySymbol.get("USDC") ?? 0;
  const usdtBlacklisted = blacklistBySymbol.get("USDT") ?? 0;
  const goldBlacklisted = (blacklistBySymbol.get("PAXG") ?? 0) + (blacklistBySymbol.get("XAUT") ?? 0);

  // ---------------- Per-coin detail fields (detail-page block) ----------------
  // perCoinFrozenAddressCount is resolved alongside activeRecordEvents in
  // resolveActiveBlacklistRecords so its legacy-vs-snapshot branch matches frozenAddresses.

  const perCoinFrozenTotal = Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<
    BlacklistStablecoin,
    number
  >;
  for (const snapshot of currentBalances.values()) {
    if (isDestroySnapshot(snapshot)) continue;
    if (snapshot.amountUsd == null || snapshot.amountUsd <= 0) continue;
    if (!isBlacklistStablecoin(snapshot.stablecoin)) continue;
    perCoinFrozenTotal[snapshot.stablecoin] += snapshot.amountUsd;
  }

  const perCoinDestroyedTotal = Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<
    BlacklistStablecoin,
    number
  >;
  for (const row of perCoinResult.results ?? []) {
    if (row.event_type !== "destroy") continue;
    if (!isBlacklistStablecoin(row.stablecoin)) continue;
    perCoinDestroyedTotal[row.stablecoin] += row.usd_sum ?? 0;
  }

  const perCoinQuarterlyEventTypes = buildPerCoinQuarterlyEventTypes(perCoinQuarterlyResult.results ?? []);
  const perCoinRecentEventTypes = buildPerCoinRecentEventTypes(perCoinRecentResult.results ?? []);

  const chart = buildBlacklistQuarterlyChartFromSnapshots(currentBalances, activeRecordEvents);

  const chainOptions = [
    ...new Map(
      CONTRACT_CONFIGS.map((c) => [c.chain.chainId, { id: c.chain.chainId, name: c.chain.chainName }]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const freshnessTs =
    options?.freshnessTsOverride ?? (await getLatestSuccessfulCronTimestamp(db, "sync-blacklist", latestTs));

  return {
    payload: {
      stats: {
        usdcBlacklisted,
        usdtBlacklisted,
        goldBlacklisted,
        frozenAddresses, // NET, not distinct-ever
        destroyedTotal,
        recentCount: aggregateRow?.recent_30d ?? 0,
        recentCount24h: aggregateRow?.recent_24h ?? 0,
        recoverableGapCount: gapMetrics.missingAmounts,
        activeAddressCount: activeStats.activeAddressCount,
        activeFrozenTotal: activeStats.activeFrozenTotal,
        activeAmountGapCount: activeStats.activeAmountGapCount,
        trackedAddressCount: trackedStats.trackedAddressCount,
        trackedFrozenTotal: trackedStats.trackedFrozenTotal,
        trackedAmountGapCount: trackedStats.trackedAmountGapCount,
        perCoinBlacklistCounts,
        perCoinTotalEvents,
        perCoinFrozenAddressCount,
        perCoinFrozenTotal,
        perCoinDestroyedTotal,
        perCoinQuarterlyEventTypes,
        perCoinRecentEventTypes,
      },
      chart,
      chains: chainOptions,
      coverage,
      freezeLedgerMeta,
      dataQuality,
      reconciliation,
      totalEvents: aggregateRow?.total ?? 0,
      methodology: buildMethodologyEnvelope({
        version: BLACKLIST_TRACKER_METHODOLOGY_VERSION,
        versionLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
        currentVersion: BLACKLIST_TRACKER_METHODOLOGY_VERSION,
        currentVersionLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
        changelogPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
        asOf: latestTs,
      }),
    },
    freshnessTs,
  };
}

export async function materializeBlacklistSummarySnapshot(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  freshnessTs = now,
): Promise<{ written: boolean }> {
  const boundedFreshnessTs = Math.min(now, Math.max(0, Math.floor(freshnessTs)));
  const built = await buildBlacklistSummaryPayload(db, now, { freshnessTsOverride: boundedFreshnessTs });
  await writeBlacklistSummarySnapshot(db, {
    version: BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION,
    materializedAt: now,
    freshnessTs: built.freshnessTs,
    payload: built.payload,
  });
  return { written: true };
}

function blacklistSummaryHeaders(freshnessTs: number): Record<string, string> {
  return addFreshnessHeaders(
    { "Cache-Control": CACHE_PROFILES.producerBacked },
    freshnessTs,
    API_FRESHNESS_MAX_AGE_SEC.blacklistSummary,
  );
}

export const handleBlacklistSummary = async (db: D1Database): Promise<Response> => {
    const now = Math.floor(Date.now() / 1000);
    const snapshot = await readBlacklistSummarySnapshot(db);
    if (snapshot) {
      let payload = snapshot.payload;
      if (!isRecord(payload.reconciliation)) {
        try {
          const reconciliation = await loadBlacklistReconciliationStatus(db);
          if (reconciliation.status !== "not-run") payload = { ...payload, reconciliation };
        } catch {
          // The summary cache remains backward-compatible while migration 0181
          // rolls out. A later producer write includes the durable status.
        }
      }
      return jsonResponseWithHeaders(payload, blacklistSummaryHeaders(snapshot.freshnessTs));
    }

    const built = await buildBlacklistSummaryPayload(db, now);
    return jsonResponseWithHeaders(built.payload, blacklistSummaryHeaders(built.freshnessTs));
  };
