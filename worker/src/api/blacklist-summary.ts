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
import { buildBlacklistChartData, computeBlacklistSummaryStats } from "@shared/lib/blacklist-aggregates";
import {
  buildBlacklistActiveRecords,
  computeBlacklistActiveSummaryStats,
  computeBlacklistTrackedSummaryStats,
} from "@shared/lib/blacklist-active-records";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CONTRACT_CONFIGS } from "../lib/blacklist-contracts";
import { loadBlacklistCurrentBalanceMap } from "../lib/blacklist-current-balances";
import {
  mapBlacklistEventRow,
  type BlacklistEventRow,
} from "../lib/blacklist-api";

export const handleBlacklistSummary = withErrorHandler(
  "blacklist-summary",
  async (db: D1Database): Promise<Response> => {
    const result = await db
      .prepare(
        `SELECT id, stablecoin, chain_id, chain_name, event_type, address, amount_native, amount_usd_at_event,
                amount_source, amount_status, tx_hash, block_number, timestamp, methodology_version,
                contract_address, config_key, event_signature, event_topic0, explorer_tx_url, explorer_address_url
         FROM blacklist_events
         ORDER BY timestamp DESC`,
      )
      .all<BlacklistEventRow>();

    const events = (result.results ?? []).map(mapBlacklistEventRow);

    const currentBalances = await loadBlacklistCurrentBalanceMap(db);
    const activeRecords = buildBlacklistActiveRecords(events, currentBalances);
    const latestTs = events[0]?.timestamp ?? Math.floor(Date.now() / 1000);
    const freshnessTs = await getLatestSuccessfulCronTimestamp(db, "sync-blacklist", latestTs);
    const chainOptions = [...new Map(
      CONTRACT_CONFIGS.map((config) => [config.chain.chainId, { id: config.chain.chainId, name: config.chain.chainName }]),
    ).values()].sort((a, b) => a.name.localeCompare(b.name));
    const eventStats = computeBlacklistSummaryStats(events);
    const activeStats = computeBlacklistActiveSummaryStats(activeRecords);
    const trackedStats = computeBlacklistTrackedSummaryStats(currentBalances);

    return jsonResponse(
      {
        stats: {
          ...eventStats,
          activeAddressCount: activeStats.activeAddressCount,
          activeFrozenTotal: activeStats.activeFrozenTotal,
          activeAmountGapCount: activeStats.activeAmountGapCount,
          trackedAddressCount: trackedStats.trackedAddressCount,
          trackedFrozenTotal: trackedStats.trackedFrozenTotal,
          trackedAmountGapCount: trackedStats.trackedAmountGapCount,
        },
        chart: buildBlacklistChartData(events, currentBalances),
        chains: chainOptions,
        totalEvents: events.length,
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
