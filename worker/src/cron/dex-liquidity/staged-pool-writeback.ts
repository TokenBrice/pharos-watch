import {
  canonicalExitRouteChain,
  canonicalExitRouteScopedKey,
} from "@shared/types/exit-route-identity";
import type { LiquidityPoolSourceFamily } from "@shared/types/dex-liquidity";
import { isValidStagedPoolId } from "../dex-discovery/persistence";
import { SLIPSTREAM_POOL_IDENTITY_REVIEW_VERSION, type StagedPool } from "../dex-discovery/types";
import { getQualityMultiplier } from "./pool-helpers";
import { isTrustworthyExactPoolId } from "./pool-identity";
import {
  checkedCurveOverlap,
  checkedPancakeWindowEnd,
  checkedRegistryClock,
  isCurveWriteback,
  isPancakeV3Writeback,
} from "./registry-writeback-evidence";
import type { SourcePoolGraph } from "./types";

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
 * make it immortal (see the pre-merge snapshot in `staging-merge.ts`).
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
  sundaeswap: false,
};

export interface StagedPoolWriteback {
  /** This run's own live-lane observations, ready for `upsertStagedPools`. */
  pools: StagedPool[];
  /** Live-lane entries dropped because their id is not a trustworthy exact id. */
  skippedUntrustedIds: number;
}

/**
 * Snapshot this run's live-lane observations (DeFiLlama, direct API, subgraph)
 * for write-back into `dex_pool_registry`, so those pools survive a provider
 * outage the same way discovery-sourced pools do.
 *
 * MUST run before `mergeStagedPools`: entries the merge backfills keep
 * `extra.measurement.decayed` and are excluded here, so a row whose pool is
 * only ever backfilled ages out instead of renting a fresh `refreshed_at`
 * every hour.
 */
export function buildStagedPoolWriteback(
  metrics: Map<string, SourcePoolGraph>,
  nowSec: number,
): StagedPoolWriteback {
  const pools: StagedPool[] = [];
  const seen = new Set<string>();
  let skippedUntrustedIds = 0;

  for (const metric of metrics.values()) {
    for (const entry of metric.pools) {
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

      const rowIdentity = { source: entry.source, protocol: entry.project, dexId: entry.project, poolType: entry.poolType };
      const isCurve = isCurveWriteback(rowIdentity);
      const isPancakeV3 = isPancakeV3Writeback(rowIdentity);
      const chain = canonicalExitRouteChain(entry.chain);
      const curvePriceObservedAtSec = isCurve ? checkedRegistryClock(entry.priceObservedAt, nowSec) : null;
      const curveBasePoolOverlap = isCurve ? checkedCurveOverlap(chain, poolId, entry.tvlUsd, entry.curveBasePoolOverlap) : undefined;
      const pancakeV3VolumeWindowEndSec = isPancakeV3
        ? checkedPancakeWindowEnd(entry.volumeReading?.observedAtSec, nowSec)
        : null;
      const measuredPrice =
        (!isCurve || curvePriceObservedAtSec != null) &&
        (entry.priceSource ?? entry.source) !== "direct_api" &&
        entry.extra?.measurement?.priceMeasured === true ? entry.price : undefined;
      const priceUsd = measuredPrice != null && Number.isFinite(measuredPrice) && measuredPrice > 0 ? measuredPrice : null;
      const volume24h = isPancakeV3
        ? pancakeV3VolumeWindowEndSec != null ? entry.volumeReading?.volume24hUsd ?? null : null
        : entry.volumeUsd1d;
      const rawEvidence = {
        ...(priceUsd != null && curvePriceObservedAtSec != null ? { curvePriceObservedAtSec } : {}),
        ...(curveBasePoolOverlap ? { curveBasePoolOverlap } : {}),
        ...(volume24h != null && pancakeV3VolumeWindowEndSec != null ? { pancakeV3VolumeWindowEndSec } : {}),
        ...(entry.source === "direct_api" && entry.poolType.includes("slipstream")
          ? { identityReviewVersion: SLIPSTREAM_POOL_IDENTITY_REVIEW_VERSION } : {}),
      };
      pools.push({
        poolId,
        stablecoinId: metric.stablecoinId,
        ...rowIdentity,
        chain,
        symbol: entry.symbol,
        tvlUsd: entry.tvlUsd,
        volume24h,
        qualityMultiplier: getQualityMultiplier(
          entry.poolType,
          entry.extra?.amplificationCoefficient,
        ),
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
        priceUsd,
        lockedLiqPct: entry.extra?.lockedLiquidityPct ?? null,
        rawJson: Object.keys(rawEvidence).length > 0 ? JSON.stringify(rawEvidence) : null,
        discoveredAt: nowSec,
        refreshedAt: nowSec,
      });
    }
  }

  return { pools, skippedUntrustedIds };
}
