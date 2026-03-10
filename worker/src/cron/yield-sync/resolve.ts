import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { buildInClause } from "../../lib/db";
import {
  MIN_LENDING_POOL_APY,
  MIN_LENDING_POOL_TVL_USD,
  MIN_SAFETY_SCORE_FOR_YIELD,
} from "../../lib/constants";
import {
  computeApyFromRate,
  findBestLendingPool,
  matchAllDlPools,
} from "../yield-helpers";
import {
  AUTO_LENDING_POOL_MAP,
  AUTO_LENDING_SAFETY_BYPASS_IDS,
  LENDING_PROTOCOL_ALLOWLIST,
  ON_CHAIN_RATE_CONFIGS,
  PRICE_DERIVED_FALLBACK_IDS,
  RATE_DERIVED_CONFIGS,
  YIELD_POOL_MAP,
  YIELD_VARIANT_MAP,
} from "../yield-config";
import {
  fetchBprotocolLqtyOnlySource,
  getPriceDerivedApy,
} from "./sources";
import type { DlPool, ResolvedYieldEntry } from "./types";

const BPROTOCOL_LQTY_ONLY_SOURCE_KEY = "bprotocol-lqty-only";
const LIQUITY_V1_LUSD_ID = "lusd-liquity";
const TRACKED_META_BY_ID = new Map(
  TRACKED_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);

interface SafetyScoreSnapshot {
  score: number;
  grade: string;
}

interface YieldResolutionResult {
  resolved: ResolvedYieldEntry[];
  tier1PrevRates: Map<string, number | null>;
}

interface ResolveYieldSourcesParams {
  db: D1Database;
  startSec: number;
  sevenDaysAgoSec: number;
  dlPools: DlPool[];
  onChainRates: Map<string, { rate: number }>;
  safetyScores: Map<string, SafetyScoreSnapshot>;
  riskFreeRate: number;
  signal?: AbortSignal;
}

export async function resolveYieldSources({
  db,
  startSec,
  sevenDaysAgoSec,
  dlPools,
  onChainRates,
  safetyScores,
  riskFreeRate,
  signal,
}: ResolveYieldSourcesParams): Promise<YieldResolutionResult> {
  const resolved: ResolvedYieldEntry[] = [];
  const tier1PrevRates = new Map<string, number | null>();
  const tier1CandidateIds = YIELD_BEARING_STABLECOINS
    .map((meta) => meta.id)
    .filter(
      (id) => ON_CHAIN_RATE_CONFIGS.some((config) => config.stablecoinId === id)
        && onChainRates.has(id),
    );
  const tier1PrevRateRows = new Map<string, { exchangeRate: number | null; recordedAt: number }>();

  if (tier1CandidateIds.length > 0) {
    const tier1InClause = buildInClause(tier1CandidateIds);
    const rows = await db
      .prepare(
        `SELECT stablecoin_id, exchange_rate, recorded_at
         FROM yield_history
         WHERE stablecoin_id IN (${tier1InClause.sql}) AND recorded_at <= ?
         ORDER BY stablecoin_id ASC, recorded_at DESC`,
      )
      .bind(...tier1InClause.binds, sevenDaysAgoSec)
      .all<{
        stablecoin_id: string;
        exchange_rate: number | null;
        recorded_at: number;
      }>();
    for (const row of rows.results ?? []) {
      if (!tier1PrevRateRows.has(row.stablecoin_id)) {
        tier1PrevRateRows.set(row.stablecoin_id, {
          exchangeRate: row.exchange_rate,
          recordedAt: row.recorded_at,
        });
      }
    }
  }

  for (const meta of YIELD_BEARING_STABLECOINS) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("sync-yield-data resolution aborted");
    }

    const id = meta.id;
    const symbol = meta.symbol;
    let hasAnySource = false;
    const rateConfig = ON_CHAIN_RATE_CONFIGS.find((config) => config.stablecoinId === id);
    if (rateConfig && onChainRates.has(id)) {
      const { rate } = onChainRates.get(id)!;
      const prevRow = tier1PrevRateRows.get(id);
      tier1PrevRates.set(id, prevRow?.exchangeRate ?? null);

      if (prevRow?.exchangeRate && prevRow.exchangeRate > 0) {
        const actualDays = (startSec - prevRow.recordedAt) / 86400;
        const apy = computeApyFromRate(rate, prevRow.exchangeRate, actualDays);
        const nativePoolId = YIELD_POOL_MAP[id] ?? null;
        resolved.push({
          id,
          symbol,
          yield: {
            currentApy: apy,
            apyBase: apy,
            apyReward: null,
            sourcePool: nativePoolId,
            sourceTvlUsd: null,
            dataSource: "onchain",
            exchangeRate: rate,
            sourceKey: nativePoolId ?? `onchain:${id}`,
          },
        });
        hasAnySource = true;
      }
    }

    const alreadyResolvedKeys = new Set(
      resolved
        .filter((entry) => entry.id === id && entry.yield != null)
        .map((entry) => entry.yield!.sourceKey),
    );
    const dlSources = matchAllDlPools(id, symbol, dlPools, YIELD_POOL_MAP, YIELD_VARIANT_MAP);
    for (const dlPool of dlSources) {
      if (alreadyResolvedKeys.has(dlPool.pool) || dlPool.apy == null || dlPool.apy < 0) {
        continue;
      }

      const fullPool = dlPools.find((pool) => pool.pool === dlPool.pool);
      if (!fullPool) continue;

      const variant = YIELD_VARIANT_MAP[id];
      const isVariantPool = variant != null && dlPool.pool !== YIELD_POOL_MAP[id];
      resolved.push({
        id,
        symbol,
        yield: {
          currentApy: fullPool.apy,
          apyBase: fullPool.apyBase,
          apyReward: fullPool.apyReward,
          sourcePool: fullPool.pool,
          sourceTvlUsd: fullPool.tvlUsd,
          dataSource: "defillama",
          exchangeRate: null,
          sourceKey: fullPool.pool,
          yieldSource: isVariantPool ? variant.yieldSource : undefined,
          yieldType: isVariantPool ? variant.yieldType : undefined,
        },
      });
      alreadyResolvedKeys.add(dlPool.pool);
      hasAnySource = true;
    }

    // For navToken / PRICE_DERIVED_FALLBACK_IDS coins, also try price-derived
    // when DL sources all returned 0% APY. DL Layer 3 symbol matching can find
    // spurious pools (e.g. a tiny Aave lending market) that report 0% and block
    // the price-derived path. Adding price-derived as an additional source lets
    // the is_best logic pick the higher-APY winner.
    const allDlSourcesZero = hasAnySource
      && resolved
        .filter((e) => e.id === id && e.yield != null)
        .every((e) => e.yield!.currentApy === 0);

    const shouldTryPriceDerived =
      (meta.flags.navToken || PRICE_DERIVED_FALLBACK_IDS.has(id))
      && (!hasAnySource || allDlSourcesZero);

    if (shouldTryPriceDerived) {
      const apy = await getPriceDerivedApy(db, id);
      if (apy != null) {
        resolved.push({
          id,
          symbol,
          yield: {
            currentApy: apy,
            apyBase: apy,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
            dataSource: "price-derived",
            exchangeRate: null,
            sourceKey: "price-derived",
          },
        });
        hasAnySource = true;
      }
    }

    // Rate-derived: for dividend-distributing tokens and T-bill-backed funds,
    // compute yield from the cached T-bill rate minus the token's fee spread.
    const rateDerivedConfig = RATE_DERIVED_CONFIGS.find((c) => c.stablecoinId === id);
    if (rateDerivedConfig && riskFreeRate > 0) {
      const apy = Math.max(0, riskFreeRate - rateDerivedConfig.spreadBps / 100);
      resolved.push({
        id,
        symbol,
        yield: {
          currentApy: apy,
          apyBase: apy,
          apyReward: null,
          sourcePool: null,
          sourceTvlUsd: null,
          dataSource: "rate-derived",
          exchangeRate: null,
          sourceKey: "rate-derived",
          yieldSource: rateDerivedConfig.label,
        },
      });
      hasAnySource = true;
    }

    if (hasAnySource) continue;

    resolved.push({ id, symbol, yield: null });
  }

  const lusdMeta = TRACKED_META_BY_ID.get(LIQUITY_V1_LUSD_ID);
  if (
    lusdMeta
    && !resolved.some(
      (entry) =>
        entry.id === LIQUITY_V1_LUSD_ID
        && entry.yield?.sourceKey === BPROTOCOL_LQTY_ONLY_SOURCE_KEY,
    )
  ) {
    const bprotocolYield = await fetchBprotocolLqtyOnlySource(signal);
    if (bprotocolYield) {
      resolved.push({
        id: lusdMeta.id,
        symbol: lusdMeta.symbol,
        yield: bprotocolYield,
      });
    }
  }

  if (dlPools.length > 0) {
    const autoDiscoveredIds = new Set<string>();
    let autoCount = 0;
    let deterministicCount = 0;

    for (const [stablecoinId, poolId] of Object.entries(AUTO_LENDING_POOL_MAP)) {
      if (autoDiscoveredIds.has(stablecoinId)) continue;

      const pool = dlPools.find((entry) => entry.pool === poolId);
      if (!pool) continue;

      const safetyScore = safetyScores.get(stablecoinId)?.score ?? 0;
      const bypassSafety = AUTO_LENDING_SAFETY_BYPASS_IDS.has(stablecoinId);
      if (!bypassSafety && safetyScore < MIN_SAFETY_SCORE_FOR_YIELD) continue;

      const eligible =
        pool.exposure === "single"
        && pool.stablecoin
        && LENDING_PROTOCOL_ALLOWLIST.has(pool.project)
        && pool.apy >= MIN_LENDING_POOL_APY
        && pool.tvlUsd >= MIN_LENDING_POOL_TVL_USD;
      if (!eligible) continue;

      if (resolved.some((entry) => entry.id === stablecoinId && entry.yield?.sourceKey === poolId)) {
        continue;
      }

      const meta = TRACKED_META_BY_ID.get(stablecoinId);
      if (!meta) continue;

      resolved.push({
        id: meta.id,
        symbol: meta.symbol,
        yield: {
          currentApy: pool.apy,
          apyBase: pool.apyBase,
          apyReward: pool.apyReward,
          sourcePool: pool.pool,
          sourceTvlUsd: pool.tvlUsd,
          dataSource: "defillama-auto",
          exchangeRate: null,
          sourceKey: pool.pool,
          project: pool.project,
        },
      });
      autoDiscoveredIds.add(meta.id);
      autoCount++;
      deterministicCount++;
    }

    const lendingCandidates = TRACKED_STABLECOINS.filter(
      (meta) =>
        !autoDiscoveredIds.has(meta.id)
        && meta.flags.pegCurrency !== "GOLD"
        && meta.flags.pegCurrency !== "SILVER"
        && (safetyScores.get(meta.id)?.score ?? 0) >= MIN_SAFETY_SCORE_FOR_YIELD,
    );

    for (const meta of lendingCandidates) {
      const pool = findBestLendingPool(
        meta.symbol,
        dlPools,
        LENDING_PROTOCOL_ALLOWLIST,
        {
          minApy: MIN_LENDING_POOL_APY,
          minTvlUsd: MIN_LENDING_POOL_TVL_USD,
          contractAddresses: (meta.contracts ?? []).map((contract) => contract.address),
        },
      );
      if (!pool) continue;

      if (resolved.some((entry) => entry.id === meta.id && entry.yield?.sourceKey === pool.pool)) {
        continue;
      }

      resolved.push({
        id: meta.id,
        symbol: meta.symbol,
        yield: {
          currentApy: pool.apy,
          apyBase: pool.apyBase,
          apyReward: pool.apyReward,
          sourcePool: pool.pool,
          sourceTvlUsd: pool.tvlUsd,
          dataSource: "defillama-auto",
          exchangeRate: null,
          sourceKey: pool.pool,
          project: pool.project,
        },
      });
      autoDiscoveredIds.add(meta.id);
      autoCount++;
    }

    console.log(
      `[sync-yield-data] Auto-discovery: ${autoCount} lending pools (${deterministicCount} deterministic, ${autoCount - deterministicCount} dynamic)`,
    );
  }

  return { resolved, tier1PrevRates };
}
