import { CRAWL_BUDGETS } from "../../lib/rate-limit";
import { rethrowIfAborted } from "../../lib/abort";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { getCirculatingRaw } from "@shared/lib/supply";
import { classifyPrimaryDepegTrust } from "../../lib/depeg-trust-policy";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcomeSafe } from "../../lib/circuit-breaker";
import { fetchMajorStablecoinOrderbookDepthSummary, type DirectCexOrderbookDepthSummary } from "../../lib/cex-orderbooks";
import {
  convertToGtNewPools,
  extractPriceObservations,
  hydrateDirectApiPoolMetadata,
  isEligibleDirectApiPool,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { fetchFluidPools } from "./fetch-fluid";
import { fetchBalancerPools } from "./fetch-balancer";
import { fetchRaydiumPools } from "./fetch-raydium";
import { fetchOrcaPools } from "./fetch-orca";
import { fetchMeteoraPools } from "./fetch-meteora";
import { fetchPancakeSwapPools } from "./fetch-pancakeswap";
import { fetchSlipstreamPools } from "./fetch-slipstream";
import { fetchUniV3Data, fetchAerodromeData } from "./fetch-primary";
import { mergeGtPools } from "./fetch-crawlers";
import { fetchDsFallbackPools, fetchCgTickersFallback, getFallbackTargets } from "./fetch-fallbacks";
import { buildDirectApiPoolIdentity } from "./direct-source-helpers";
import {
  countPoolIdentityKeys,
  getIdentityDedupReason,
  registerKnownPoolIdentity,
  type KnownPoolIdentityIndex,
} from "./pool-identity";
import type { DexPriceObs, LiquidityMetrics, SymbolLookups } from "./types";

export interface DirectApiFetcher {
  name: string;
  circuitKey: string;
  normalizedProtocol: string;
  supportedChains: string[];
  fn: (signal?: AbortSignal) => Promise<DexApiFetchResult>;
}

export interface SubgraphEnrichmentPhaseResult {
  uniV3PoolFees: Map<string, number>;
  uniV3SymbolFees: Map<string, number>;
  uniV3PriceObs: Map<string, DexPriceObs[]>;
  aerodromePriceObs: Map<string, DexPriceObs[]>;
  aerodromeIsStable: Map<string, boolean>;
}

export interface DirectApiFetchPhaseResult {
  results: Array<{
    name: string;
    circuitKey: string;
    normalizedProtocol: string;
    supportedChains: string[];
    result: DexApiFetchResult;
  }>;
  failedSources: string[];
  fallbackSignals: string[];
}

export interface AuthoritativeStagedPoolConfirmationIndex {
  enforcedChainsByProtocol: Map<string, Set<string>>;
  confirmedExactKeysByProtocol: Map<string, Set<string>>;
}

export interface DirectApiIntegrationResult {
  directApiDedupSkippedByAddress: number;
  directApiDedupSkippedByDerivedIdentity: number;
  directApiDedupSkippedByOptionalWildcardIdentity: number;
}

export interface FallbackCrawlerPhaseResult {
  dsFallbackCoins: number;
  cgTickerFallbackCoins: number;
  coverageRecoveredCoins: number;
  weakCoverageCoinsBeforeFallback: number;
  directCexOrderbookDepth: DirectCexOrderbookDepthSummary | null;
}

export async function loadTrackedStablecoinPriceMap(
  db: D1Database,
  syncStartSec: number,
): Promise<Map<string, number>> {
  const stablecoinPriceById = new Map<string, number>();
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
  if (hasUsableStablecoinsPayload(stablecoinsCache)) {
    let skippedWeakTrackedPrices = 0;
    for (const asset of stablecoinsCache.payload.peggedAssets) {
      if (
        asset.price != null &&
        Number.isFinite(asset.price) &&
        asset.price > 0 &&
        classifyPrimaryDepegTrust(asset, syncStartSec) === "authoritative"
      ) {
        stablecoinPriceById.set(asset.id, asset.price);
      } else {
        skippedWeakTrackedPrices++;
      }
    }
    if (skippedWeakTrackedPrices > 0) {
      console.log(
        `[dex-liquidity] Ignoring ${skippedWeakTrackedPrices} tracked stablecoin price(s) as weak/stale quote legs`,
      );
    }
  } else {
    console.warn(
      "[dex-liquidity] Stablecoins cache unavailable for tracked quote pricing; using reference-only fallback",
    );
  }

  return stablecoinPriceById;
}

export async function loadTrackedStablecoinMcapMap(
  db: D1Database,
): Promise<Map<string, number>> {
  const mcapById = new Map<string, number>();
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
  if (hasUsableStablecoinsPayload(stablecoinsCache)) {
    for (const asset of stablecoinsCache.payload.peggedAssets) {
      const mcap = getCirculatingRaw(asset);
      if (mcap > 0) {
        mcapById.set(asset.id, mcap);
      }
    }
  } else {
    console.warn("[dex-liquidity] Stablecoins cache unavailable for market cap data; TVL depth will use absolute fallback");
  }
  return mcapById;
}

export function buildDexDirectApiFetchers(params: {
  graphApiKey: string | null;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  symbolToChainScopedIds: SymbolLookups["symbolToChainScopedIds"];
  stablecoinPriceById: Map<string, number>;
  chainRpcs?: Map<string, ChainRpcConfig>;
}): DirectApiFetcher[] {
  return [
    {
      name: "Fluid",
      circuitKey: CIRCUIT_SOURCE.FLUID_DEX_API,
      normalizedProtocol: "fluid",
      supportedChains: ["ethereum", "arbitrum", "base", "polygon", "bsc", "plasma"],
      fn: (signal) => fetchFluidPools(signal, params.chainRpcs),
    },
    {
      name: "Balancer",
      circuitKey: CIRCUIT_SOURCE.BALANCER_API,
      normalizedProtocol: "balancer",
      supportedChains: [
        "ethereum",
        "arbitrum",
        "base",
        "polygon",
        "optimism",
        "gnosis",
        "avalanche",
        "sonic",
        "fantom",
        "fraxtal",
        "mode",
        "polygon-zkevm",
        "plasma",
        "monad",
        "hyperevm",
        "xlayer",
      ],
      fn: fetchBalancerPools,
    },
    {
      name: "PancakeSwap",
      circuitKey: CIRCUIT_SOURCE.PANCAKESWAP_API,
      normalizedProtocol: "pancakeswap",
      supportedChains: ["bsc", "ethereum", "base"],
      fn: (signal) => fetchPancakeSwapPools(params.graphApiKey, signal),
    },
    {
      name: "Meteora",
      circuitKey: CIRCUIT_SOURCE.METEORA_API,
      normalizedProtocol: "meteora",
      supportedChains: ["solana"],
      fn: fetchMeteoraPools,
    },
    {
      name: "Raydium",
      circuitKey: CIRCUIT_SOURCE.RAYDIUM_API,
      normalizedProtocol: "raydium",
      supportedChains: ["solana"],
      fn: fetchRaydiumPools,
    },
    {
      name: "Orca",
      circuitKey: CIRCUIT_SOURCE.ORCA_API,
      normalizedProtocol: "orca",
      supportedChains: ["solana"],
      fn: fetchOrcaPools,
    },
    {
      name: "Aerodrome Slipstream",
      circuitKey: CIRCUIT_SOURCE.AERODROME_SLIPSTREAM_API,
      normalizedProtocol: "aerodrome",
      supportedChains: ["base"],
      fn: (signal) =>
        fetchSlipstreamPools(
          "aerodrome-slipstream",
          params.chainAddressToId,
          params.symbolToChainScopedIds,
          params.stablecoinPriceById,
          signal,
          params.chainRpcs,
        ),
    },
    {
      name: "Velodrome Slipstream",
      circuitKey: CIRCUIT_SOURCE.VELODROME_SLIPSTREAM_API,
      normalizedProtocol: "velodrome",
      supportedChains: ["optimism"],
      fn: (signal) =>
        fetchSlipstreamPools(
          "velodrome-slipstream",
          params.chainAddressToId,
          params.symbolToChainScopedIds,
          params.stablecoinPriceById,
          signal,
          params.chainRpcs,
        ),
    },
  ];
}

export async function fetchSubgraphEnrichmentPhase(params: {
  graphApiKey: string | null;
  symbolToIds: SymbolLookups["symbolToIds"];
  symbolToChainScopedIds: SymbolLookups["symbolToChainScopedIds"];
  chainAddressToId: SymbolLookups["chainAddressToId"];
  signal?: AbortSignal;
  validationReferences: PriceValidationReferences;
}): Promise<SubgraphEnrichmentPhaseResult & { failedSources: string[] }> {
  const failedSources: string[] = [];

  let uniV3PoolFees = new Map<string, number>();
  let uniV3SymbolFees = new Map<string, number>();
  let uniV3PriceObs = new Map<string, DexPriceObs[]>();
  try {
    const uniV3Data = await fetchUniV3Data(
      params.graphApiKey,
      params.symbolToIds,
      params.symbolToChainScopedIds,
      params.chainAddressToId,
      params.signal,
      params.validationReferences,
    );
    uniV3PoolFees = uniV3Data.uniV3PoolFees;
    uniV3SymbolFees = uniV3Data.uniV3SymbolFees;
    uniV3PriceObs = uniV3Data.uniV3PriceObs;
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    console.warn("[dex-liquidity] UniV3 fetch failed (non-fatal):", err);
    failedSources.push("univ3-subgraph");
  }

  let aerodromePriceObs = new Map<string, DexPriceObs[]>();
  let aerodromeIsStable = new Map<string, boolean>();
  try {
    const aeroData = await fetchAerodromeData(
      params.graphApiKey,
      params.symbolToIds,
      params.symbolToChainScopedIds,
      params.chainAddressToId,
      params.signal,
      params.validationReferences,
    );
    aerodromePriceObs = aeroData.aerodromePriceObs;
    aerodromeIsStable = aeroData.aerodromeIsStable;
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    console.warn("[dex-liquidity] Aerodrome fetch failed (non-fatal):", err);
    failedSources.push("aerodrome-subgraph");
  }

  return {
    uniV3PoolFees,
    uniV3SymbolFees,
    uniV3PriceObs,
    aerodromePriceObs,
    aerodromeIsStable,
    failedSources,
  };
}

export async function runDirectApiFetchPhase(
  db: D1Database,
  fetchers: DirectApiFetcher[],
  signal?: AbortSignal,
): Promise<DirectApiFetchPhaseResult> {
  const results: DirectApiFetchPhaseResult["results"] = [];
  const failedSources: string[] = [];
  const fallbackSignals: string[] = [];

  for (const { name, circuitKey, normalizedProtocol, supportedChains, fn } of fetchers) {
    if (!(await shouldAttemptFetch(db, circuitKey))) {
      console.log(`[dex-liquidity] ${name} API circuit open, skipping`);
      failedSources.push(circuitKey);
      fallbackSignals.push(`${circuitKey}-circuit-open`);
      results.push({
        name,
        circuitKey,
        normalizedProtocol,
        supportedChains,
        result: makeDexApiFetchResult([], {
          ok: false,
          degraded: true,
          errors: ["circuit open"],
        }),
      });
      continue;
    }

    try {
      const result = await fn(signal);
      await recordOutcomeSafe(db, circuitKey, result.ok);
      if (!result.ok || result.degraded) {
        failedSources.push(circuitKey);
      }
      if (!result.ok) {
        fallbackSignals.push(`${circuitKey}-unavailable`);
      } else if (result.degraded) {
        fallbackSignals.push(`${circuitKey}-partial`);
      }
      results.push({ name, circuitKey, normalizedProtocol, supportedChains, result });
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[dex-liquidity] ${name} API failed (non-fatal):`, err);
      await recordOutcomeSafe(db, circuitKey, false);
      failedSources.push(circuitKey);
      fallbackSignals.push(`${circuitKey}-exception`);
      results.push({
        name,
        circuitKey,
        normalizedProtocol,
        supportedChains,
        result: makeDexApiFetchResult([], {
          ok: false,
          degraded: true,
          errors: [err instanceof Error ? err.message : String(err)],
        }),
      });
    }
  }

  return { results, failedSources, fallbackSignals };
}

export function buildAuthoritativeStagedPoolConfirmationIndex(
  results: DirectApiFetchPhaseResult["results"],
): AuthoritativeStagedPoolConfirmationIndex {
  const enforcedChainsByProtocol = new Map<string, Set<string>>();
  const confirmedExactKeysByProtocol = new Map<string, Set<string>>();

  for (const entry of results) {
    if (!entry.result.ok || entry.result.degraded) {
      continue;
    }

    const enforcedChains = enforcedChainsByProtocol.get(entry.normalizedProtocol) ?? new Set<string>();
    for (const chain of entry.supportedChains) {
      enforcedChains.add(chain);
    }
    enforcedChainsByProtocol.set(entry.normalizedProtocol, enforcedChains);

    const confirmedExactKeys = confirmedExactKeysByProtocol.get(entry.normalizedProtocol) ?? new Set<string>();
    for (const pool of entry.result.pools) {
      const exactPoolKey = buildDirectApiPoolIdentity(pool).exactPoolKey;
      if (exactPoolKey) {
        confirmedExactKeys.add(exactPoolKey);
      }
    }
    confirmedExactKeysByProtocol.set(entry.normalizedProtocol, confirmedExactKeys);
  }

  return {
    enforcedChainsByProtocol,
    confirmedExactKeysByProtocol,
  };
}

export function mergeDexPriceObservationMap(
  target: Map<string, DexPriceObs[]>,
  source: Map<string, DexPriceObs[]>,
): void {
  for (const [id, observations] of source) {
    const existing = target.get(id) ?? [];
    existing.push(...observations);
    target.set(id, existing);
  }
}

export function integrateDirectApiLiquidityPhase(params: {
  directApiPools: DexApiPool[];
  knownPoolIndex: KnownPoolIdentityIndex;
  contractMetaByChainAddress: SymbolLookups["contractMetaByChainAddress"];
  metrics: Map<string, LiquidityMetrics>;
  priceObservations: Map<string, DexPriceObs[]>;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  symbolToChainScopedIds: SymbolLookups["symbolToChainScopedIds"];
  symbolToIds: SymbolLookups["symbolToIds"];
  validationReferences: PriceValidationReferences;
  stablecoinPriceById: Map<string, number>;
}): DirectApiIntegrationResult {
  let directApiDedupSkippedByAddress = 0;
  let directApiDedupSkippedByDerivedIdentity = 0;
  let directApiDedupSkippedByOptionalWildcardIdentity = 0;

  if (params.directApiPools.length === 0) {
    return {
      directApiDedupSkippedByAddress,
      directApiDedupSkippedByDerivedIdentity,
      directApiDedupSkippedByOptionalWildcardIdentity,
    };
  }

  console.log(`[dex-liquidity] Fetched ${params.directApiPools.length} direct API pools total`);
  hydrateDirectApiPoolMetadata(params.directApiPools, params.contractMetaByChainAddress);

  const allDirectApiIdentities = params.directApiPools.map(buildDirectApiPoolIdentity);
  const eligibleDirectApiPools = params.directApiPools.filter((pool) => isEligibleDirectApiPool(pool));
  const eligibleDirectApiIdentities = eligibleDirectApiPools.map(buildDirectApiPoolIdentity);
  const directApiIdentityCounts = countPoolIdentityKeys(eligibleDirectApiIdentities);

  const retainedDirectApiPools: DexApiPool[] = [];
  for (let index = 0; index < eligibleDirectApiPools.length; index++) {
    const pool = eligibleDirectApiPools[index]!;
    const identity = eligibleDirectApiIdentities[index]!;
    const dedupReason = getIdentityDedupReason(
      identity,
      params.knownPoolIndex,
      {
        derived: identity.derivedMatchKey ? (directApiIdentityCounts.derived.get(identity.derivedMatchKey) ?? 0) : 0,
        wildcard: identity.optionalWildcardKey
          ? (directApiIdentityCounts.wildcard.get(identity.optionalWildcardKey) ?? 0)
          : 0,
      },
      { allowOptionalWildcard: true },
    );
    if (dedupReason === "exact") {
      directApiDedupSkippedByAddress++;
      continue;
    }
    if (dedupReason === "derived_unique") {
      directApiDedupSkippedByDerivedIdentity++;
      continue;
    }
    if (dedupReason === "derived_optional_wildcard") {
      directApiDedupSkippedByOptionalWildcardIdentity++;
      continue;
    }

    registerKnownPoolIdentity(params.knownPoolIndex, identity);
    retainedDirectApiPools.push(pool);
  }

  // Staged discovery sources can return the same physical pool with wildly
  // different TVL semantics. Keep every authoritative direct-API exact pool id
  // reserved for later exact-address dedupe, even if the direct row itself is
  // too small to contribute to scoring.
  for (const identity of allDirectApiIdentities) {
    if (identity.exactPoolKey) {
      params.knownPoolIndex.exactKeys.add(identity.exactPoolKey);
    }
  }

  if (
    directApiDedupSkippedByAddress > 0 ||
    directApiDedupSkippedByDerivedIdentity > 0 ||
    directApiDedupSkippedByOptionalWildcardIdentity > 0
  ) {
    console.log(
      `[dex-liquidity] Skipped ${directApiDedupSkippedByAddress} exact, ` +
        `${directApiDedupSkippedByDerivedIdentity} unique derived, and ` +
        `${directApiDedupSkippedByOptionalWildcardIdentity} optional wildcard direct API duplicates`,
    );
  }

  if (retainedDirectApiPools.length > 0) {
    const directApiGtPools = convertToGtNewPools(
      retainedDirectApiPools,
      params.chainAddressToId,
      params.symbolToChainScopedIds,
      params.symbolToIds,
      params.validationReferences,
      params.stablecoinPriceById,
    );
    if (directApiGtPools.size > 0) {
      mergeGtPools(params.metrics, directApiGtPools);
    }

    const directApiPriceObs = extractPriceObservations(
      retainedDirectApiPools,
      params.chainAddressToId,
      params.symbolToChainScopedIds,
      params.validationReferences,
      params.stablecoinPriceById,
    );
    mergeDexPriceObservationMap(params.priceObservations, directApiPriceObs);
  }

  if (directApiDedupSkippedByAddress > 0 || directApiDedupSkippedByDerivedIdentity > 0) {
    console.log(
      `[dex-liquidity] Skipped ${directApiDedupSkippedByAddress} direct API pools by exact identity and ` +
        `${directApiDedupSkippedByDerivedIdentity} by unique derived identity`,
    );
  }

  return {
    directApiDedupSkippedByAddress,
    directApiDedupSkippedByDerivedIdentity,
    directApiDedupSkippedByOptionalWildcardIdentity,
  };
}

export async function runFallbackCrawlerPhase(params: {
  metrics: Map<string, LiquidityMetrics>;
  priceObservations: Map<string, DexPriceObs[]>;
  knownPoolIndex: KnownPoolIdentityIndex;
  signal?: AbortSignal;
  validationReferences: PriceValidationReferences;
  failedSources: string[];
  coingeckoApiKey?: string | null;
}): Promise<FallbackCrawlerPhaseResult> {
  const weakCoverageTargetIdsBeforeFallback = new Set(
    getFallbackTargets(params.metrics, params.priceObservations, { requireTrackedContracts: true }).map(
      (meta) => meta.id,
    ),
  );
  const fallbackDeadlineMs = Date.now() + CRAWL_BUDGETS.FALLBACK_MS;
  let dsFallbackCoins = 0;
  let cgTickerFallbackCoins = 0;
  let directCexOrderbookDepth: DirectCexOrderbookDepthSummary | null = null;

  try {
    const dsFallback = await fetchDsFallbackPools(
      params.metrics,
      params.priceObservations,
      params.knownPoolIndex,
      params.signal,
      fallbackDeadlineMs,
      params.validationReferences,
    );
    dsFallbackCoins = dsFallback.newPools.size;
    if (dsFallback.newPools.size > 0) {
      mergeGtPools(params.metrics, dsFallback.newPools);
    }
    mergeDexPriceObservationMap(params.priceObservations, dsFallback.priceObs);
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    console.warn("[dex-liquidity] DexScreener fallback failed (non-fatal):", err);
    params.failedSources.push("dexscreener-fallback");
  }

  try {
    const cgFallback = await fetchCgTickersFallback(
      params.metrics,
      params.priceObservations,
      params.knownPoolIndex,
      params.signal,
      fallbackDeadlineMs,
      params.validationReferences,
      params.coingeckoApiKey,
    );
    cgTickerFallbackCoins = cgFallback.newPools.size;
    if (cgFallback.newPools.size > 0) {
      mergeGtPools(params.metrics, cgFallback.newPools);
    }
    mergeDexPriceObservationMap(params.priceObservations, cgFallback.priceObs);
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    console.warn("[dex-liquidity] CG tickers fallback failed (non-fatal):", err);
    params.failedSources.push("cg-tickers-fallback");
  }

  console.log(
    `[dex-liquidity] After fallbacks: ${params.priceObservations.size} coins with price observations ` +
      `(DS fallback: ${dsFallbackCoins} coins, CG tickers: ${cgTickerFallbackCoins} coins)`,
  );

  try {
    directCexOrderbookDepth = await fetchMajorStablecoinOrderbookDepthSummary(params.signal);
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    console.warn("[dex-liquidity] Direct CEX orderbook depth telemetry failed (non-fatal):", err);
    params.failedSources.push("direct-cex-orderbook-depth");
  }

  const weakCoverageTargetIdsAfterFallback = new Set(
    getFallbackTargets(params.metrics, params.priceObservations, { requireTrackedContracts: true }).map(
      (meta) => meta.id,
    ),
  );
  let coverageRecoveredCoins = 0;
  for (const stablecoinId of weakCoverageTargetIdsBeforeFallback) {
    if (!weakCoverageTargetIdsAfterFallback.has(stablecoinId)) {
      coverageRecoveredCoins++;
    }
  }

  return {
    dsFallbackCoins,
    cgTickerFallbackCoins,
    coverageRecoveredCoins,
    weakCoverageCoinsBeforeFallback: weakCoverageTargetIdsBeforeFallback.size,
    directCexOrderbookDepth,
  };
}
