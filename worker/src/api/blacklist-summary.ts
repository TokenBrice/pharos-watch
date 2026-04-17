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
    // 1) Per-coin blacklist-event counts (public only = suppression_reason IS NULL)
    const perCoinResult = await db
      .prepare(
        `SELECT stablecoin, event_type, COUNT(*) AS n, SUM(COALESCE(amount_usd_at_event, 0)) AS usd_sum
         FROM blacklist_events
         WHERE suppression_reason IS NULL
         GROUP BY stablecoin, event_type`,
      )
      .all<{ stablecoin: string; event_type: string; n: number; usd_sum: number }>();

    // 2) Latest event per (stablecoin, chain_id, LOWER(address)) — drives both
    //    net-frozen semantics AND activeRecords construction. D1 supports
    //    SQLite >= 3.25 window functions (ROW_NUMBER ... OVER PARTITION BY).
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

    // 3) frozenAddresses - preserve NET semantics (blacklist events whose LATEST
    //    action is still 'blacklist'). Do NOT use a DISTINCT-ever-blacklisted
    //    count; that silently inflates the metric.
    const frozenAddresses = latestByAddr.filter((e) => e.eventType === "blacklist").length;

    // 4) recoverableGapCount - required by BlacklistSummaryStatsSchema.
    const recoverableGapResult = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM blacklist_events
         WHERE suppression_reason IS NULL
           AND amount_status IN ('recoverable_pending','provider_failed','ambiguous')`,
      )
      .first<{ n: number }>();

    // 5) Total row count (events)
    const totalResult = await db
      .prepare(`SELECT COUNT(*) AS n FROM blacklist_events WHERE suppression_reason IS NULL`)
      .first<{ n: number }>();

    // 6) Latest public event timestamp (freshness)
    const latestTsRow = await db
      .prepare(`SELECT MAX(timestamp) AS t FROM blacklist_events WHERE suppression_reason IS NULL`)
      .first<{ t: number | null }>();
    const latestTs = latestTsRow?.t ?? Math.floor(Date.now() / 1000);

    // 7) Recent counts
    const now = Math.floor(Date.now() / 1000);
    const recent30dRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM blacklist_events WHERE suppression_reason IS NULL AND timestamp >= ?`)
      .bind(now - 30 * 86400)
      .first<{ n: number }>();
    const recent24hRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM blacklist_events WHERE suppression_reason IS NULL AND timestamp >= ?`)
      .bind(now - 86400)
      .first<{ n: number }>();

    // 8) Current-balances snapshot-derived stats
    const currentBalances = await loadBlacklistCurrentBalanceMap(db);
    const activeRecords = buildBlacklistActiveRecords(latestByAddr, currentBalances);
    const activeStats = computeBlacklistActiveSummaryStats(activeRecords);
    const trackedStats = computeBlacklistTrackedSummaryStats(currentBalances);

    // 9) Build per-coin counts (all BLACKLIST_STABLECOINS keys present; 0 by default)
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
          frozenAddresses,                         // NET, not distinct-ever
          destroyedTotal,
          recentCount: recent30dRow?.n ?? 0,       // required
          recentCount24h: recent24hRow?.n ?? 0,    // required
          recoverableGapCount: recoverableGapResult?.n ?? 0, // required
          activeAddressCount: activeStats.activeAddressCount,
          activeFrozenTotal: activeStats.activeFrozenTotal,
          activeAmountGapCount: activeStats.activeAmountGapCount,
          trackedAddressCount: trackedStats.trackedAddressCount,
          trackedFrozenTotal: trackedStats.trackedFrozenTotal,
          trackedAmountGapCount: trackedStats.trackedAmountGapCount,
          perCoinBlacklistCounts,                  // required (see SF-10)
        },
        chart,
        chains: chainOptions,
        totalEvents: totalResult?.n ?? 0,
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
