import type { PriceValidationReferences } from "../../../lib/price-validation";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { shouldAttemptFetch, recordOutcomeSafe } from "../../../lib/circuit-breaker";
import {
  convertToGtNewPools,
  extractPriceObservations,
  hydrateDirectApiPoolMetadata,
  isEligibleDirectApiPool,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../../lib/dex-api-common";
import { resolveStablecoinIdForDexApiToken } from "../../../lib/dex-api-token-pricing";
import { fetchFluidPools } from "../fetch-fluid";
import { fetchBalancerPools } from "../fetch-balancer";
import { fetchRaydiumPools } from "../fetch-raydium";
import { fetchOrcaPools } from "../fetch-orca";
import { fetchMeteoraPools } from "../fetch-meteora";
import { fetchPancakeSwapPools } from "../fetch-pancakeswap";
import { fetchSlipstreamPools } from "../fetch-slipstream";
import { mergeGtPools } from "../fetch-crawlers";
import { buildDirectApiPoolIdentity } from "../direct-source-helpers";
import {
  countPoolIdentityKeys,
  getIdentityDedupReason,
  registerKnownPoolIdentity,
  type KnownPoolIdentityIndex,
} from "../pool-identity";
import type { DexPriceObs, LiquidityMetrics, SymbolLookups } from "../types";
import { mergeDexPriceObservationMap } from "./price-obs";

export interface DirectApiFetcher {
  name: string;
  circuitKey: string;
  normalizedProtocol: string;
  supportedChains: string[];
  fn: (signal?: AbortSignal) => Promise<DexApiFetchResult>;
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

export interface DirectApiIntegrationResult {
  directApiDedupSkippedByAddress: number;
  directApiDedupSkippedByDerivedIdentity: number;
  directApiDedupSkippedByOptionalWildcardIdentity: number;
  directApiSkippedUntracked: number;
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
  let directApiSkippedUntracked = 0;

  if (params.directApiPools.length === 0) {
    return {
      directApiDedupSkippedByAddress,
      directApiDedupSkippedByDerivedIdentity,
      directApiDedupSkippedByOptionalWildcardIdentity,
      directApiSkippedUntracked,
    };
  }

  console.log(`[dex-liquidity] Fetched ${params.directApiPools.length} direct API pools total`);
  const trackedDirectApiPools = params.directApiPools.filter((pool) =>
    pool.tokens.some(
      (token) =>
        resolveStablecoinIdForDexApiToken(
          pool.chain,
          token,
          params.chainAddressToId,
          params.symbolToChainScopedIds,
        ) != null,
    ),
  );
  directApiSkippedUntracked = params.directApiPools.length - trackedDirectApiPools.length;
  if (directApiSkippedUntracked > 0) {
    console.log(
      `[dex-liquidity] Retained ${trackedDirectApiPools.length} direct API pools with tracked tokens ` +
        `(skipped ${directApiSkippedUntracked} untracked pools before identity processing)`,
    );
  }

  hydrateDirectApiPoolMetadata(trackedDirectApiPools, params.contractMetaByChainAddress);

  const allDirectApiIdentities = trackedDirectApiPools.map(buildDirectApiPoolIdentity);
  const eligibleDirectApiPools = trackedDirectApiPools.filter((pool) => isEligibleDirectApiPool(pool));
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
    directApiSkippedUntracked,
  };
}
