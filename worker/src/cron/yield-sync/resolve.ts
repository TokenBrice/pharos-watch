import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { buildInClause } from "../../lib/db";
import {
  MIN_LENDING_POOL_APY,
  MIN_LENDING_POOL_TVL_USD,
  MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  MIN_SAFETY_SCORE_FOR_YIELD,
} from "../../lib/constants";
import {
  buildOnChainSourceKey,
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
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { COMPOUND_V3_COMETS, fetchAaveV3SupplyRates, fetchBeefySources, fetchBimaSusbdSource, fetchBprotocolLqtyOnlySource, fetchCompoundV3SupplyRates, fetchHashnoteUsycSource, fetchMorphoVaultSources, fetchOndoUsdyOracleSource, fetchPendleMarketSources, fetchYearnKongSources, getPriceDerivedApy, type AaveV3RateTarget } from "./sources";
import type { DlPool, ResolvedYieldEntry } from "./types";
import { scanForNewVariants } from "./variant-scanner";

const LIQUITY_V1_LUSD_ID = "lusd-liquity";
const BIMA_USBD_ID = "usbd-bima";
const HASHNOTE_USYC_ID = "usyc-hashnote";
const ONDO_USDY_ID = "usdy-ondo-finance";

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
  chainRpcs?: Map<string, ChainRpcConfig>;
  coingeckoApiKey?: string | null;
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
  chainRpcs,
  coingeckoApiKey,
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
         WHERE stablecoin_id IN (${tier1InClause.sql}) AND recorded_at <= ? AND exchange_rate IS NOT NULL
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
        const actualDays = (startSec - prevRow.recordedAt) / DAY_SECONDS;
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
            sourceKey: buildOnChainSourceKey(id),
            sourceObservedAt: startSec,
            comparisonAnchorObservedAt: prevRow.recordedAt,
          },
        });
        hasAnySource = true;
      } else {
        // Seed the exchange rate so the next cycle (7+ days later) can compute APY.
        // Without this, coins whose DeFiLlama pool reports 0% APY get stuck in a
        // bootstrapping deadlock: on-chain never resolves → rate never stored → on-chain
        // can never resolve.
        resolved.push({
          id,
          symbol,
          yield: {
            currentApy: 0,
            apyBase: null,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
            dataSource: "onchain",
            exchangeRate: rate,
            sourceKey: buildOnChainSourceKey(id),
            sourceObservedAt: startSec,
            comparisonAnchorObservedAt: null,
          },
        });
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
      const priceDerived = await getPriceDerivedApy(db, id);
      if (priceDerived != null) {
        resolved.push({
          id,
          symbol,
          yield: {
            currentApy: priceDerived.apy,
            apyBase: priceDerived.apy,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
            dataSource: "price-derived",
            exchangeRate: null,
            sourceKey: "price-derived",
            sourceObservedAt: priceDerived.sourceObservedAt,
            comparisonAnchorObservedAt: priceDerived.comparisonAnchorObservedAt,
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
          sourceObservedAt: startSec,
          comparisonAnchorObservedAt: null,
        },
      });
      hasAnySource = true;
    }

    if (
      id === BIMA_USBD_ID &&
      !resolved.some((entry) => entry.id === id && entry.yield?.sourceKey === "protocol-api:bima-susbd")
    ) {
      const bimaYield = await fetchBimaSusbdSource(signal);
      if (bimaYield) {
        resolved.push({
          id,
          symbol,
          yield: bimaYield,
        });
        hasAnySource = true;
      }
    }

    if (
      id === HASHNOTE_USYC_ID &&
      !resolved.some((e) => e.id === id && e.yield?.sourceKey === "protocol-api:hashnote-usyc")
    ) {
      const hashnoteYield = await fetchHashnoteUsycSource(signal);
      if (hashnoteYield) {
        resolved.push({ id, symbol, yield: hashnoteYield });
        hasAnySource = true;
      }
    }

    if (
      id === ONDO_USDY_ID &&
      !resolved.some((e) => e.id === id && e.yield?.sourceKey === "protocol-api:ondo-usdy-oracle")
    ) {
      const priorRow = await db
        .prepare(
          `SELECT exchange_rate, recorded_at FROM yield_history
           WHERE stablecoin_id = ? AND source_key = 'protocol-api:ondo-usdy-oracle'
             AND exchange_rate IS NOT NULL
           ORDER BY recorded_at DESC LIMIT 1`,
        )
        .bind(ONDO_USDY_ID)
        .first<{ exchange_rate: number; recorded_at: number }>();

      const prevPriceBigint = priorRow?.exchange_rate
        ? BigInt(Math.round(priorRow.exchange_rate * 1e18))
        : null;
      const daysDelta = priorRow ? (startSec - priorRow.recorded_at) / 86400 : 0;

      const ondoYield = await fetchOndoUsdyOracleSource(prevPriceBigint, daysDelta, signal, chainRpcs);
      if (ondoYield) {
        resolved.push({ id, symbol, yield: ondoYield });
        hasAnySource = true;
      }
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
        && entry.yield?.sourceKey === buildOnChainSourceKey(LIQUITY_V1_LUSD_ID),
    )
  ) {
    const bprotocolYield = await fetchBprotocolLqtyOnlySource(signal, chainRpcs, coingeckoApiKey);
    if (bprotocolYield) {
      resolved.push({
        id: lusdMeta.id,
        symbol: lusdMeta.symbol,
        yield: bprotocolYield,
      });
    }
  }

  // Morpho protocol-native vaults — runs once, matched by asset symbol
  const morphoVaults = await fetchMorphoVaultSources(signal);
  for (const { symbol: assetSymbol, yield: morphoYield } of morphoVaults) {
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.symbol.toUpperCase() !== assetSymbol.toUpperCase()) continue;
      if (resolved.some((e) => e.id === meta.id && e.yield?.sourceKey === morphoYield.sourceKey)) continue;
      resolved.push({ id: meta.id, symbol: meta.symbol, yield: morphoYield });
      break;
    }
  }

  // Pendle protocol-native markets — runs once, matched by asset symbol
  const pendleMarkets = await fetchPendleMarketSources(signal);
  for (const { symbol: assetSymbol, yield: pendleYield } of pendleMarkets) {
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.symbol.toUpperCase() !== assetSymbol.toUpperCase()) continue;
      if (resolved.some((e) => e.id === meta.id && e.yield?.sourceKey === pendleYield.sourceKey)) continue;
      resolved.push({ id: meta.id, symbol: meta.symbol, yield: pendleYield });
      break;
    }
  }

  // Yearn Kong ERC-4626 vaults (Yearn-native + third-party) — runs once, matched by asset symbol
  const kongVaults = await fetchYearnKongSources(signal);
  for (const { symbol: assetSymbol, yield: kongYield } of kongVaults) {
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.symbol.toUpperCase() !== assetSymbol.toUpperCase()) continue;
      if (resolved.some((e) => e.id === meta.id && e.yield?.sourceKey === kongYield.sourceKey)) continue;
      resolved.push({ id: meta.id, symbol: meta.symbol, yield: kongYield });
      break;
    }
  }

  // Beefy auto-compounded vaults — runs once, matched by asset symbol
  const beefyVaults = await fetchBeefySources(signal);
  for (const { symbol: assetSymbol, yield: beefyYield } of beefyVaults) {
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.symbol.toUpperCase() !== assetSymbol.toUpperCase()) continue;
      if (resolved.some((e) => e.id === meta.id && e.yield?.sourceKey === beefyYield.sourceKey)) continue;
      resolved.push({ id: meta.id, symbol: meta.symbol, yield: beefyYield });
      break;
    }
  }

  // Compound V3 direct on-chain supply rates — batched 4 at a time.
  const COMPOUND_V3_BATCH_SIZE = 4;
  const compoundV3Targets = [...COMPOUND_V3_COMETS];
  for (let i = 0; i < compoundV3Targets.length; i += COMPOUND_V3_BATCH_SIZE) {
    const batch = compoundV3Targets.slice(i, i + COMPOUND_V3_BATCH_SIZE);
    const batchResults = await fetchCompoundV3SupplyRates(batch, signal, chainRpcs);
    for (const entry of batchResults) {
      const meta = TRACKED_STABLECOINS.find((m) => m.symbol === entry.symbol);
      if (!meta) continue;
      if (resolved.some((r) => r.id === meta.id && r.yield?.sourceKey === entry.yield.sourceKey)) continue;
      resolved.push({ id: meta.id, symbol: meta.symbol, yield: entry.yield });
    }
  }

  // ---------------------------------------------------------------------------
  // Aave V3 direct on-chain supply rates (after batch adapters, before auto-lending)
  // ---------------------------------------------------------------------------
  const AAVE_SUPPORTED_CHAINS = new Set(["ethereum", "arbitrum", "base"]);
  const aaveTargets: AaveV3RateTarget[] = [];
  for (const meta of TRACKED_STABLECOINS) {
    for (const contract of meta.contracts ?? []) {
      if (
        AAVE_SUPPORTED_CHAINS.has(contract.chain) &&
        contract.address &&
        !aaveTargets.some((t) => t.stablecoinId === meta.id && t.chain === contract.chain)
      ) {
        aaveTargets.push({
          stablecoinId: meta.id,
          symbol: meta.symbol,
          chain: contract.chain,
          assetAddress: contract.address,
        });
      }
    }
  }

  if (aaveTargets.length > 0 && chainRpcs) {
    const { rates: aaveRates } = await fetchAaveV3SupplyRates(aaveTargets, signal, chainRpcs);
    const AAVE_SOURCE_KEY = "aave-v3-onchain";
    const AAVE_YIELD_SOURCE = "Aave v3";
    const AAVE_YIELD_TYPE = "lending";
    for (const [stablecoinId, { apy }] of aaveRates) {
      if (apy <= 0) continue;
      if (resolved.some((entry) => entry.id === stablecoinId && entry.yield?.sourceKey === AAVE_SOURCE_KEY)) {
        continue;
      }
      const meta = TRACKED_META_BY_ID.get(stablecoinId);
      if (!meta) continue;
      resolved.push({
        id: meta.id,
        symbol: meta.symbol,
        yield: {
          currentApy: apy,
          apyBase: apy,
          apyReward: null,
          sourcePool: null,
          sourceTvlUsd: null,
          dataSource: "onchain",
          exchangeRate: null,
          sourceKey: AAVE_SOURCE_KEY,
          yieldSource: AAVE_YIELD_SOURCE,
          yieldType: AAVE_YIELD_TYPE,
          sourceObservedAt: startSec,
          comparisonAnchorObservedAt: null,
        },
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

    const SMALL_ECOSYSTEM_CHAINS = new Set(["solana", "sui", "aptos", "cardano", "stacks"]);

    const PHAROS_TO_DL_CHAIN: Record<string, string> = {
      ethereum: "Ethereum", arbitrum: "Arbitrum", base: "Base", optimism: "Optimism",
      polygon: "Polygon", avalanche: "Avalanche", bsc: "BSC", solana: "Solana", gnosis: "Gnosis",
    };

    for (const meta of lendingCandidates) {
      const primaryChain = meta.contracts?.[0]?.chain;
      const minTvlUsd = primaryChain && SMALL_ECOSYSTEM_CHAINS.has(primaryChain)
        ? MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM
        : MIN_LENDING_POOL_TVL_USD;

      const coinChains = new Set(
        (meta.contracts ?? []).map((c) => PHAROS_TO_DL_CHAIN[c.chain]).filter(Boolean),
      );
      const chainFilter = coinChains.size > 0 ? coinChains : undefined;

      const pool = findBestLendingPool(
        meta.symbol,
        dlPools,
        LENDING_PROTOCOL_ALLOWLIST,
        {
          minApy: MIN_LENDING_POOL_APY,
          minTvlUsd,
          contractAddresses: (meta.contracts ?? []).map((contract) => contract.address),
          chainFilter,
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

    // Advisory: log newly discovered wrapper tokens for manual review
    const trackedSymbols = new Set(TRACKED_STABLECOINS.map((m) => m.symbol.toUpperCase()));
    const knownVariantSymbols = new Set(
      Object.values(YIELD_VARIANT_MAP).map((v) => v.variantSymbol.toUpperCase()),
    );
    const newVariants = scanForNewVariants(dlPools, trackedSymbols, knownVariantSymbols);
    if (newVariants.length > 0) {
      console.log(
        `[sync-yield-data] Variant scanner found ${newVariants.length} new wrapper tokens:`,
        newVariants.map((v) => `${v.variantSymbol} (${v.baseSymbol}, ${v.chain}, $${(v.tvlUsd / 1e6).toFixed(1)}M)`).join(", "),
      );
    }
  }

  return { resolved, tier1PrevRates };
}
