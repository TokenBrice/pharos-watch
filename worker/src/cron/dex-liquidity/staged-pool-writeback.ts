import {
  canonicalExitRouteChain,
  canonicalExitRouteScopedKey,
} from "@shared/lib/exit-route-identity";
import type { LiquidityPoolSourceFamily } from "@shared/types/market";
import { isValidStagedPoolId } from "../dex-discovery/persistence";
import type { StagedPool } from "../dex-discovery/types";
import { getQualityMultiplier } from "./pool-helpers";
import { isTrustworthyExactPoolId } from "./pool-identity";
import type { LiquidityMetrics } from "./types";

/**
 * Do not re-stamp a row the live lane refreshed within this window. The DO
 * UPDATE then matches no row, which D1 counts as zero rows written, so a
 * steady-state write-back costs roughly one statement per observed pool instead
 * of one per retained pool.
 */
export const STAGED_WRITEBACK_MIN_REFRESH_GAP_SEC = 4 * 60 * 60;

/**
 * Exhaustive: which retained source families the live-lane write-back owns.
 * Discovery owns its families outright — re-stamping a row that
 * `mergeStagedPools` backfilled would advance `refreshed_at` every hour and
 * make it immortal (see the pre-merge snapshot invariant in `orchestrator.ts`).
 * Adding a family without a row fails this record's type.
 */
const LIVE_LANE_SOURCE_FAMILY: Record<LiquidityPoolSourceFamily, boolean> = {
  dl: true,
  direct_api: true,
  cg_onchain: false,
  gecko_terminal: false,
  dexscreener: false,
  cg_tickers: false,
  horizon: false,
  aquarius: false,
  tezos: false,
  "icon-balanced": false,
  "kava-swap": false,
  "osmosis-sqs": false,
  "noble-swap": false,
};

export interface StagedPoolWriteback {
  /** This run's own live-lane observations, ready for `upsertStagedPools`. */
  pools: StagedPool[];
  /** Live-lane entries dropped because their id is not a trustworthy exact id. */
  skippedUntrustedIds: number;
  /**
   * Live-lane entries dropped because `mergeStagedPools` read the same key from
   * a discovery source this run. Zero until `filterDiscoveryOwned` runs.
   */
  skippedDiscoveryOwned: number;
}

/**
 * Snapshot this run's live-lane observations (DeFiLlama, direct API, subgraph)
 * for write-back into `dex_pool_staging`, so those pools survive a provider
 * outage the same way discovery-sourced pools do.
 *
 * MUST run before `mergeStagedPools`: entries the merge backfills keep
 * `extra.measurement.decayed` and are excluded here, so a row whose pool is
 * only ever backfilled ages out instead of renting a fresh `refreshed_at`
 * every hour.
 */
export function buildStagedPoolWriteback(
  metrics: Map<string, LiquidityMetrics>,
  nowSec: number,
): StagedPoolWriteback {
  const pools: StagedPool[] = [];
  const seen = new Set<string>();
  let skippedUntrustedIds = 0;

  for (const metric of metrics.values()) {
    for (const entry of metric.topPools) {
      // `!== true` rather than truthiness: a persisted source string could name a
      // prototype member that plain Record indexing would return as a function.
      if (LIVE_LANE_SOURCE_FAMILY[entry.source] !== true) continue;
      if (entry.extra?.measurement?.decayed === true) continue;

      const poolId = canonicalExitRouteScopedKey(entry.chain, entry.poolId);
      const separatorIndex = poolId.indexOf(":");
      const addressOrId = separatorIndex >= 0 ? poolId.slice(separatorIndex + 1) : poolId;
      // The merge reads these rows back through the same split, so a row is only
      // worth writing when the unscoped part is a trustworthy exact id and the
      // scoped form matches the persisted `chain:id` shape.
      if (!isTrustworthyExactPoolId(addressOrId, entry.project) || !isValidStagedPoolId(poolId)) {
        skippedUntrustedIds++;
        continue;
      }
      const dedupeKey = `${metric.stablecoinId}\u0000${poolId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const measuredPrice =
        entry.extra?.measurement?.priceMeasured === true ? entry.price : undefined;
      pools.push({
        poolId,
        stablecoinId: metric.stablecoinId,
        source: entry.source,
        chain: canonicalExitRouteChain(entry.chain),
        protocol: entry.project,
        dexId: entry.project,
        symbol: entry.symbol,
        tvlUsd: entry.tvlUsd,
        volume24h: entry.volumeUsd1d,
        qualityMultiplier: getQualityMultiplier(
          entry.poolType,
          entry.extra?.amplificationCoefficient,
        ),
        poolType: entry.poolType,
        feeTier: entry.extra?.feeTier ?? null,
        balanceRatio: entry.extra?.balanceRatio ?? null,
        // Same stability rule the direct-API identity builder applies: a live
        // entry only ever encodes stability in its pool type.
        isStable: entry.poolType.includes("stable") || entry.poolType.includes("fluid"),
        // The live lanes carry no token-address inventory on the retained entry;
        // an unproven guess here would poison cross-source derived identity.
        baseToken: null,
        quoteToken: null,
        quoteSymbol: null,
        priceUsd: measuredPrice != null && measuredPrice > 0 ? measuredPrice : null,
        lockedLiqPct: entry.extra?.lockedLiquidityPct ?? null,
        rawJson: null,
        discoveredAt: nowSec,
        refreshedAt: nowSec,
      });
    }
  }

  return { pools, skippedUntrustedIds, skippedDiscoveryOwned: 0 };
}

/**
 * Subtract the keys `mergeStagedPools` read from discovery sources this run.
 *
 * `buildStagedPoolWriteback` cannot do this itself: the snapshot is taken
 * before the merge, and the merge owns the key set. A live-lane copy of a
 * dual-observed pool is the *hollow* one — DeFiLlama carries no prices, so its
 * upsert would relabel the row `dl` with `price_usd = NULL` and delete the
 * discovery price the same run already emitted to `dex_prices`.
 */
export function filterDiscoveryOwned(
  writeback: StagedPoolWriteback,
  ownedKeys: Set<string>,
): StagedPoolWriteback {
  const pools = writeback.pools.filter(
    (pool) => !ownedKeys.has(`${pool.stablecoinId}\u0000${pool.poolId}`),
  );
  return {
    pools,
    skippedUntrustedIds: writeback.skippedUntrustedIds,
    skippedDiscoveryOwned:
      writeback.skippedDiscoveryOwned + (writeback.pools.length - pools.length),
  };
}
