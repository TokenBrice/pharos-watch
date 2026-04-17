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
import { CONTRACT_CONFIGS } from "../lib/blacklist-contracts";
import { loadBlacklistCurrentBalanceMap } from "../lib/blacklist-current-balances";
import {
  BLACKLIST_STABLECOINS,
  type BlacklistEvent,
  type BlacklistStablecoin,
} from "@shared/types/market";
import { buildBlacklistQuarterlyChartFromSnapshots } from "@shared/lib/blacklist-aggregates";
import { mapBlacklistEventRow, type BlacklistEventRow } from "../lib/blacklist-api";
import {
  buildBlacklistActiveRecords,
  computeBlacklistActiveSummaryStats,
  computeBlacklistTrackedSummaryStats,
} from "@shared/lib/blacklist-active-records";

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

    // D1 supports SQLite >= 3.25 window functions (ROW_NUMBER OVER PARTITION BY).
    // Latest event per (stablecoin, chain_id, LOWER(address)) drives both net-
    // frozen semantics AND activeRecords construction.
    const latestByAddrResult = await db
      .prepare(
        `WITH ranked AS (
           SELECT
             id, stablecoin, chain_id, chain_name, event_type, address,
             amount_native, amount_usd_at_event, amount_source, amount_status,
             tx_hash, block_number, timestamp, methodology_version,
             contract_address, config_key, event_signature, event_topic0,
             suppression_reason, explorer_tx_url, explorer_address_url,
             ROW_NUMBER() OVER (PARTITION BY stablecoin, chain_id, LOWER(address) ORDER BY timestamp DESC, id DESC) AS rn
           FROM blacklist_events
           WHERE suppression_reason IS NULL
         )
         SELECT id, stablecoin, chain_id, chain_name, event_type, address,
                amount_native, amount_usd_at_event, amount_source, amount_status,
                tx_hash, block_number, timestamp, methodology_version,
                contract_address, config_key, event_signature, event_topic0,
                suppression_reason, explorer_tx_url, explorer_address_url
         FROM ranked
         WHERE rn = 1`,
      )
      .all<BlacklistEventRow>();

    // Map snake_case -> camelCase so buildBlacklistActiveRecords (and
    // buildBlacklistQuarterlyChartFromSnapshots) see a canonical BlacklistEvent.
    const latestByAddr: BlacklistEvent[] = (latestByAddrResult.results ?? []).map(mapBlacklistEventRow);

    // Preserve NET semantics: addresses whose LATEST action is still 'blacklist'.
    // A DISTINCT-ever-blacklisted count would silently inflate the metric.
    const frozenAddresses = latestByAddr.filter((e) => e.eventType === "blacklist").length;

    // Collapse total / max(timestamp) / recoverable-gap / recent-30d / recent-24h
    // into a single aggregate pass so we don't hit the public-events table five
    // separate times under the WHERE suppression_reason IS NULL predicate.
    const now = Math.floor(Date.now() / 1000);
    const aggregateRow = await db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           MAX(timestamp) AS max_ts,
           SUM(CASE WHEN amount_status IN ('recoverable_pending','provider_failed','ambiguous') THEN 1 ELSE 0 END) AS recoverable_gap,
           SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS recent_30d,
           SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS recent_24h
         FROM blacklist_events
         WHERE suppression_reason IS NULL`,
      )
      .bind(now - 30 * 86400, now - 86400)
      .first<{ total: number; max_ts: number | null; recoverable_gap: number; recent_30d: number; recent_24h: number }>();
    const latestTs = aggregateRow?.max_ts ?? Math.floor(Date.now() / 1000);

    const currentBalances = await loadBlacklistCurrentBalanceMap(db);
    const activeRecords = buildBlacklistActiveRecords(latestByAddr, currentBalances);
    const activeStats = computeBlacklistActiveSummaryStats(activeRecords);
    const trackedStats = computeBlacklistTrackedSummaryStats(currentBalances);

    const perCoinBlacklistCounts = Object.fromEntries(
      BLACKLIST_STABLECOINS.map((s) => [s, 0]),
    ) as Record<BlacklistStablecoin, number>;
    let destroyedTotal = 0;
    const blacklistBySymbol = new Map<string, number>();
    for (const row of perCoinResult.results ?? []) {
      if (row.event_type === "blacklist") {
        if (BLACKLIST_STABLECOINS.includes(row.stablecoin as BlacklistStablecoin)) {
          perCoinBlacklistCounts[row.stablecoin as BlacklistStablecoin] = row.n;
        }
        blacklistBySymbol.set(row.stablecoin, row.n);
      }
      if (row.event_type === "destroy") destroyedTotal += row.usd_sum ?? 0;
    }

    const usdcBlacklisted = blacklistBySymbol.get("USDC") ?? 0;
    const usdtBlacklisted = blacklistBySymbol.get("USDT") ?? 0;
    const goldBlacklisted = (blacklistBySymbol.get("PAXG") ?? 0) + (blacklistBySymbol.get("XAUT") ?? 0);

    const chart = buildBlacklistQuarterlyChartFromSnapshots(currentBalances, latestByAddr);

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
          recoverableGapCount: aggregateRow?.recoverable_gap ?? 0,
          activeAddressCount: activeStats.activeAddressCount,
          activeFrozenTotal: activeStats.activeFrozenTotal,
          activeAmountGapCount: activeStats.activeAmountGapCount,
          trackedAddressCount: trackedStats.trackedAddressCount,
          trackedFrozenTotal: trackedStats.trackedFrozenTotal,
          trackedAmountGapCount: trackedStats.trackedAmountGapCount,
          perCoinBlacklistCounts,
        },
        chart,
        chains: chainOptions,
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
