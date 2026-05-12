import {
  addFreshnessHeaders,
  buildMethodologyEnvelope,
  getLatestSuccessfulCronTimestamp,
  jsonResponse,
  withErrorHandler,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { getBlacklistGapStatus } from "@shared/lib/status-thresholds";
import { CONTRACT_CONFIGS } from "../lib/blacklist-contracts";
import { getDeferredBlacklistCoverage } from "../lib/blacklist-coverage-manifest";
import { loadBlacklistCurrentBalanceMap } from "../lib/blacklist-current-balances";
import { queryBlacklistGapMetrics, type BlacklistGapMetrics } from "../lib/blacklist-gaps";
import {
  BLACKLIST_STABLECOINS,
  type BlacklistEvent,
  type BlacklistQuarterlyEventTypePoint,
  type BlacklistStablecoin,
} from "@shared/types/market";
import {
  buildBlacklistQuarterlyChartFromSnapshots,
  sortKeyToLabel,
} from "@shared/lib/blacklist-aggregates";
import { mapBlacklistEventRow, type BlacklistEventRow } from "../lib/blacklist-api";
import {
  buildBlacklistActiveRecords,
  buildBlacklistRecordIdentityKey,
  computeBlacklistActiveSummaryStats,
  computeBlacklistTrackedSummaryStats,
  type BlacklistCurrentBalanceSnapshot,
} from "@shared/lib/blacklist-active-records";

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

function classifyLedgerFreshness(observedAt: number | null | undefined, now: number): "fresh" | "degraded" | "stale" {
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

function isLaterBlacklistEvent(candidate: BlacklistEvent, current: BlacklistEvent): boolean {
  if (candidate.timestamp !== current.timestamp) {
    return candidate.timestamp > current.timestamp;
  }
  return candidate.id.localeCompare(current.id) > 0;
}

function deriveLatestByIdentity(events: BlacklistEvent[]): BlacklistEvent[] {
  const latest = new Map<string, BlacklistEvent>();

  for (const event of events) {
    const key = buildBlacklistRecordIdentityKey(event);
    const current = latest.get(key);
    if (!current || isLaterBlacklistEvent(event, current)) {
      latest.set(key, event);
    }
  }

  return [...latest.values()];
}

function isDestroySnapshot(snapshot: BlacklistCurrentBalanceSnapshot): boolean {
  return sourceCategory(snapshot.source) === "destroy";
}

function computeActiveSummaryStatsFromCurrentBalances(
  currentBalances: ReadonlyMap<string, BlacklistCurrentBalanceSnapshot>,
): ReturnType<typeof computeBlacklistActiveSummaryStats> {
  let activeAddressCount = 0;
  let activeFrozenTotal = 0;
  let activeAmountGapCount = 0;

  for (const snapshot of currentBalances.values()) {
    activeAddressCount++;
    if (isDestroySnapshot(snapshot)) continue;
    if (snapshot.amountUsd == null) {
      activeAmountGapCount++;
      continue;
    }
    activeFrozenTotal += snapshot.amountUsd;
  }

  return { activeAddressCount, activeFrozenTotal, activeAmountGapCount };
}

function buildSyntheticBlacklistEvent(row: {
  id?: string | null;
  stablecoin: string;
  chain_id: string;
  chain_name?: string | null;
  address: string;
  timestamp: number | null;
  config_key?: string | null;
  contract_address?: string | null;
}): BlacklistEvent | null {
  if (row.timestamp == null) return null;
  return {
    id: row.id ?? `${row.stablecoin}:${row.chain_id}:${row.address}:${row.timestamp}`,
    stablecoin: row.stablecoin as BlacklistStablecoin,
    chainId: row.chain_id,
    chainName: row.chain_name ?? row.chain_id,
    eventType: "blacklist",
    address: row.address,
    amountNative: null,
    amountUsdAtEvent: null,
    amountSource: "unavailable",
    amountStatus: "recoverable_pending",
    txHash: "",
    blockNumber: 0,
    timestamp: row.timestamp,
    methodologyVersion: "",
    contractAddress: row.contract_address ?? null,
    configKey: row.config_key ?? null,
    eventSignature: null,
    eventTopic0: null,
    suppressionReason: null,
    explorerTxUrl: "",
    explorerAddressUrl: "",
  };
}

async function queryLatestBlacklistEventsForCurrentBalances(
  db: D1Database,
  currentBalances: ReadonlyMap<string, BlacklistCurrentBalanceSnapshot>,
): Promise<BlacklistEvent[]> {
  if (currentBalances.size === 0) return [];

  const result = await db
    .prepare(
      `/* latest_event_type_by_balance */
       SELECT
         b.id,
         b.stablecoin,
         b.chain_id,
         b.address,
         b.config_key,
         b.contract_address,
         MAX(e.timestamp) AS timestamp
       FROM blacklist_current_balances b
       LEFT JOIN blacklist_events e
         ON e.stablecoin = b.stablecoin
        AND e.chain_id = b.chain_id
        AND LOWER(e.address) = LOWER(b.address)
        AND e.event_type = 'blacklist'
        AND e.suppression_reason IS NULL
        AND (
          (b.config_key IS NOT NULL AND e.config_key = b.config_key)
          OR (b.config_key IS NULL AND b.contract_address IS NOT NULL AND LOWER(e.contract_address) = LOWER(b.contract_address))
          OR (b.config_key IS NULL AND b.contract_address IS NULL)
        )
       GROUP BY b.id, b.stablecoin, b.chain_id, b.address, b.config_key, b.contract_address`,
    )
    .all<{
      id: string | null;
      stablecoin: string;
      chain_id: string;
      chain_name?: string | null;
      event_type?: string | null;
      address: string;
      timestamp: number | null;
      config_key: string | null;
      contract_address: string | null;
    }>();

  return (result.results ?? []).flatMap((row) => {
    if (row.event_type != null && row.event_type !== "blacklist") return [];
    const event = buildSyntheticBlacklistEvent(row);
    return event ? [event] : [];
  });
}

async function queryLatestEventTypeHistory(db: D1Database): Promise<BlacklistEvent[]> {
  const activeHistoryResult = await db
    .prepare(
      `WITH latest_event_type AS (
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
  const staleLedgerRows = freezeLedgerMeta.currentFreshnessDistribution.stale;
  const status = gapStatus === "stale" || staleLedgerRows > 0
    ? "stale"
    : gapStatus === "degraded" || freezeLedgerMeta.providerFailedCount > 0
      ? "degraded"
      : "ok";
  const warnings: string[] = [];
  if (gapMetrics.missingAmounts > 0) warnings.push("recoverable-amount-gaps");
  if (gapMetrics.unrecoverableMissingAmounts > 0) warnings.push("unrecoverable-amount-gaps");
  if (freezeLedgerMeta.providerFailedCount > 0) warnings.push("current-balance-provider-failures");
  if (staleLedgerRows > 0) warnings.push("stale-current-balance-snapshots");
  if (coverage.counts.unsupportedDeferredConfigs > 0) warnings.push("deferred-coverage");

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
      staleSnapshotCount: staleLedgerRows,
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

export const handleBlacklistSummary = withErrorHandler(
  "blacklist-summary",
  async (db: D1Database): Promise<Response> => {
    const perCoinResult = await db
      .prepare(
        `SELECT stablecoin, event_type, COUNT(*) AS n, SUM(COALESCE(amount_usd_at_event, 0)) AS usd_sum
         FROM blacklist_events
         WHERE suppression_reason IS NULL
         GROUP BY stablecoin, event_type`,
      )
      .all<{ stablecoin: string; event_type: string; n: number; usd_sum: number }>();

    // Per-coin, per-quarter, per-event-type counts for the stablecoin detail
    // page chart. Bucketing matches the JS helper in
    // shared/lib/blacklist-aggregates.ts (year*4 + floor(month/3)) so labels
    // align with the main-page chart.
    const perCoinQuarterlyResult = await db
      .prepare(
        `SELECT
           stablecoin,
           (CAST(strftime('%Y', datetime(timestamp, 'unixepoch')) AS INTEGER) * 4 +
            CAST((CAST(strftime('%m', datetime(timestamp, 'unixepoch')) AS INTEGER) - 1) / 3 AS INTEGER)) AS quarter_sort_key,
           event_type,
           COUNT(*) AS n
         FROM blacklist_events
         WHERE suppression_reason IS NULL
         GROUP BY stablecoin, quarter_sort_key, event_type`,
      )
      .all<{ stablecoin: string; quarter_sort_key: number; event_type: string; n: number }>();

    // Collapse total / max(timestamp) / recoverable-gap / recent-30d / recent-24h
    // into a single aggregate pass so we don't hit the public-events table five
    // separate times under the WHERE suppression_reason IS NULL predicate.
    const now = Math.floor(Date.now() / 1000);
    const aggregateRow = await db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           MAX(timestamp) AS max_ts,
           SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS recent_30d,
           SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS recent_24h
         FROM blacklist_events
         WHERE suppression_reason IS NULL`,
      )
      .bind(now - 30 * 86400, now - 86400)
      .first<{ total: number; max_ts: number | null; recent_30d: number; recent_24h: number }>();
    const latestTs = aggregateRow?.max_ts ?? Math.floor(Date.now() / 1000);

    const currentBalances = await loadBlacklistCurrentBalanceMap(db);
    const activeHistory = currentBalances.size === 0 ? await queryLatestEventTypeHistory(db) : [];
    const latestByAddr = currentBalances.size === 0
      ? deriveLatestByIdentity(activeHistory)
      : await queryLatestBlacklistEventsForCurrentBalances(db, currentBalances);
    const activeRecordEvents = currentBalances.size === 0 ? (activeHistory.length > 0 ? activeHistory : latestByAddr) : latestByAddr;
    const frozenAddresses = currentBalances.size === 0
      ? latestByAddr.filter((e) => e.eventType === "blacklist").length
      : [...currentBalances.values()].filter((snapshot) => !isDestroySnapshot(snapshot)).length;
    const gapMetrics = await queryBlacklistGapMetrics(db, now);
    const activeStats = currentBalances.size === 0
      ? computeBlacklistActiveSummaryStats(buildBlacklistActiveRecords(activeRecordEvents, currentBalances))
      : computeActiveSummaryStatsFromCurrentBalances(currentBalances);
    const trackedStats = computeBlacklistTrackedSummaryStats(currentBalances);
    const coverage = buildCoverage();
    const freezeLedgerMeta = buildFreezeLedgerMeta(currentBalances, gapMetrics, trackedStats.trackedAmountGapCount, now);
    const dataQuality = buildDataQuality(freezeLedgerMeta, gapMetrics, coverage);

    const perCoinBlacklistCounts = Object.fromEntries(
      BLACKLIST_STABLECOINS.map((s) => [s, 0]),
    ) as Record<BlacklistStablecoin, number>;
    const perCoinTotalEvents = Object.fromEntries(
      BLACKLIST_STABLECOINS.map((s) => [s, 0]),
    ) as Record<BlacklistStablecoin, number>;
    let destroyedTotal = 0;
    const blacklistBySymbol = new Map<string, number>();
    for (const row of perCoinResult.results ?? []) {
      if (!BLACKLIST_STABLECOINS.includes(row.stablecoin as BlacklistStablecoin)) continue;
      const symbol = row.stablecoin as BlacklistStablecoin;
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

    const perCoinFrozenAddressCount = Object.fromEntries(
      BLACKLIST_STABLECOINS.map((s) => [s, 0]),
    ) as Record<BlacklistStablecoin, number>;
    if (currentBalances.size === 0) {
      for (const row of latestByAddr) {
        if (row.eventType !== "blacklist") continue;
        if (!BLACKLIST_STABLECOINS.includes(row.stablecoin as BlacklistStablecoin)) continue;
        perCoinFrozenAddressCount[row.stablecoin as BlacklistStablecoin] += 1;
      }
    } else {
      for (const snapshot of currentBalances.values()) {
        if (isDestroySnapshot(snapshot)) continue;
        if (!BLACKLIST_STABLECOINS.includes(snapshot.stablecoin as BlacklistStablecoin)) continue;
        perCoinFrozenAddressCount[snapshot.stablecoin as BlacklistStablecoin] += 1;
      }
    }

    const perCoinFrozenTotal = Object.fromEntries(
      BLACKLIST_STABLECOINS.map((s) => [s, 0]),
    ) as Record<BlacklistStablecoin, number>;
    for (const snapshot of currentBalances.values()) {
      if (isDestroySnapshot(snapshot)) continue;
      if (snapshot.amountUsd == null || snapshot.amountUsd <= 0) continue;
      if (!BLACKLIST_STABLECOINS.includes(snapshot.stablecoin as BlacklistStablecoin)) continue;
      perCoinFrozenTotal[snapshot.stablecoin as BlacklistStablecoin] += snapshot.amountUsd;
    }

    const perCoinDestroyedTotal = Object.fromEntries(
      BLACKLIST_STABLECOINS.map((s) => [s, 0]),
    ) as Record<BlacklistStablecoin, number>;
    for (const row of perCoinResult.results ?? []) {
      if (row.event_type !== "destroy") continue;
      if (!BLACKLIST_STABLECOINS.includes(row.stablecoin as BlacklistStablecoin)) continue;
      perCoinDestroyedTotal[row.stablecoin as BlacklistStablecoin] += row.usd_sum ?? 0;
    }

    // Build per-coin quarterly event-type arrays. Missing quarters between a
    // coin's first and last event are zero-filled so bars render contiguously,
    // matching buildBlacklistQuarterlyChartFromSnapshots.
    const perCoinQuarterlyEventTypes = Object.fromEntries(
      BLACKLIST_STABLECOINS.map((s) => [s, [] as BlacklistQuarterlyEventTypePoint[]]),
    ) as Record<BlacklistStablecoin, BlacklistQuarterlyEventTypePoint[]>;
    const perCoinBucketMap = new Map<
      BlacklistStablecoin,
      Map<number, { blacklist: number; unblacklist: number; destroy: number }>
    >();
    for (const row of perCoinQuarterlyResult.results ?? []) {
      if (!BLACKLIST_STABLECOINS.includes(row.stablecoin as BlacklistStablecoin)) continue;
      const symbol = row.stablecoin as BlacklistStablecoin;
      const coinBuckets = perCoinBucketMap.get(symbol) ?? new Map();
      const bucket = coinBuckets.get(row.quarter_sort_key) ?? { blacklist: 0, unblacklist: 0, destroy: 0 };
      if (row.event_type === "blacklist") bucket.blacklist += row.n;
      else if (row.event_type === "unblacklist") bucket.unblacklist += row.n;
      else if (row.event_type === "destroy") bucket.destroy += row.n;
      coinBuckets.set(row.quarter_sort_key, bucket);
      perCoinBucketMap.set(symbol, coinBuckets);
    }
    for (const [symbol, buckets] of perCoinBucketMap.entries()) {
      const sortKeys = [...buckets.keys()].sort((a, b) => a - b);
      if (sortKeys.length === 0) continue;
      const minKey = sortKeys[0]!;
      const maxKey = sortKeys[sortKeys.length - 1]!;
      const points: BlacklistQuarterlyEventTypePoint[] = [];
      for (let k = minKey; k <= maxKey; k++) {
        const b = buckets.get(k) ?? { blacklist: 0, unblacklist: 0, destroy: 0 };
        points.push({ quarter: sortKeyToLabel(k), ...b });
      }
      perCoinQuarterlyEventTypes[symbol] = points;
    }

    const chart = buildBlacklistQuarterlyChartFromSnapshots(currentBalances, activeRecordEvents);

    const chainOptions = [
      ...new Map(
        CONTRACT_CONFIGS.map((c) => [c.chain.chainId, { id: c.chain.chainId, name: c.chain.chainName }]),
      ).values(),
    ].sort((a, b) => a.name.localeCompare(b.name));

    const freshnessTs = await getLatestSuccessfulCronTimestamp(db, "sync-blacklist", latestTs);

    return jsonResponse(
      {
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
        },
        chart,
        chains: chainOptions,
        coverage,
        freezeLedgerMeta,
        dataQuality,
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
      addFreshnessHeaders(
        { "Cache-Control": CACHE_PROFILES.realtime },
        freshnessTs,
        API_FRESHNESS_MAX_AGE_SEC.blacklistSummary,
      ),
    );
  },
);
