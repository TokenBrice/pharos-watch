import type { PriceValidationReferences } from "../../../lib/price-validation";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import {
  type CircuitOutcomeRecord,
  type CircuitState,
} from "../../../lib/circuit-breaker";
import {
  ProviderCircuitOpenError,
  ProviderExecutionError,
  createProviderExecutionContextForJob,
  withProviderExecution,
  type ProviderExecutionPolicy,
} from "../../../lib/provider-execution";
import {
  DIRECT_API_POOL_MIN_TVL_USD,
  convertToGtNewPools,
  extractPriceObservations,
  hydrateDirectApiPoolMetadata,
  isEligibleDirectApiPool,
  makeDexApiFetchResult,
  normalizeDexApiPoolsForMerge,
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
import {
  DIRECT_API_FETCH_PHASE_CONCURRENCY,
  DIRECT_API_PROVIDER_TIMEOUT_MS,
} from "../direct-api-policy";
import { toErrorMessage } from "../../../lib/error-utils";

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
  circuitEvents: DirectApiCircuitEvent[];
}

export interface DirectApiCircuitEvent {
  circuitKey: string;
  from: CircuitState;
  to: CircuitState;
  at: number | null;
}

export interface DirectApiIntegrationResult {
  directApiDedupSkippedByAddress: number;
  directApiDedupSkippedByDerivedIdentity: number;
  directApiDedupSkippedByOptionalWildcardIdentity: number;
  directApiSkippedUntracked: number;
  directApiSkippedInvalidUnits: number;
  directApiSkippedBelowTvlThreshold: number;
  directApiSkippedAboveTvlSanityCap: number;
  acceptedByProtocolChain: Record<string, number>;
  excludedByReason: Record<string, number>;
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
  const providerContext = createProviderExecutionContextForJob({
    job: "sync-dex-liquidity",
    laneId: "sync-dex-liquidity:direct-api",
    laneMaxConcurrent: DIRECT_API_FETCH_PHASE_CONCURRENCY,
    db,
    signal,
  });
  const entries = await runBounded(fetchers, DIRECT_API_FETCH_PHASE_CONCURRENCY, async ({
    name,
    circuitKey,
    normalizedProtocol,
    supportedChains,
    fn,
  }) => {
    const failedSources: string[] = [];
    const fallbackSignals: string[] = [];
    const circuitEvents: DirectApiCircuitEvent[] = [];

    try {
      const execution = await withProviderExecution(
        providerContext,
        buildDirectApiProviderPolicy(name, circuitKey),
        ({ signal: providerSignal }) => fn(providerSignal),
      );
      const result = execution.value;
      const event = directApiCircuitEventFromOutcome(circuitKey, execution.circuitOutcome);
      if (event) circuitEvents.push(event);
      if (!result.ok || result.degraded) {
        failedSources.push(circuitKey);
      }
      if (!result.ok) {
        fallbackSignals.push(`${circuitKey}-unavailable`);
      } else if (result.degraded) {
        fallbackSignals.push(`${circuitKey}-partial`);
      }
      return {
        failedSources,
        fallbackSignals,
        circuitEvents,
        entry: { name, circuitKey, normalizedProtocol, supportedChains, result },
      };
    } catch (err) {
      if (err instanceof ProviderCircuitOpenError) {
        console.log(`[dex-liquidity] ${name} API circuit open, skipping`);
        failedSources.push(circuitKey);
        fallbackSignals.push(`${circuitKey}-circuit-open`);
        return {
          failedSources,
          fallbackSignals,
          circuitEvents,
          entry: {
            name,
            circuitKey,
            normalizedProtocol,
            supportedChains,
            result: makeDexApiFetchResult([], {
              ok: false,
              degraded: true,
              errors: ["circuit open"],
            }),
          },
        };
      }
      if (signal?.aborted) throw err;
      console.warn(`[dex-liquidity] ${name} API failed (non-fatal):`, err);
      const executionError = err instanceof ProviderExecutionError ? err : null;
      const event = directApiCircuitEventFromOutcome(circuitKey, executionError?.circuitOutcome ?? null);
      if (event) circuitEvents.push(event);
      failedSources.push(circuitKey);
      fallbackSignals.push(`${circuitKey}-exception`);
      return {
        failedSources,
        fallbackSignals,
        circuitEvents,
        entry: {
          name,
          circuitKey,
          normalizedProtocol,
          supportedChains,
          result: makeDexApiFetchResult([], {
            ok: false,
            degraded: true,
            errors: [toErrorMessage(err)],
          }),
        },
      };
    }
  });

  return {
    results: entries.map((entry) => entry.entry),
    failedSources: entries.flatMap((entry) => entry.failedSources),
    fallbackSignals: entries.flatMap((entry) => entry.fallbackSignals),
    circuitEvents: entries.flatMap((entry) => entry.circuitEvents),
  };
}

async function runBounded<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex++;
      results[currentIndex] = await worker(items[currentIndex]!);
    }
  }));

  return results;
}

function buildDirectApiProviderPolicy(
  name: string,
  circuitKey: string,
): ProviderExecutionPolicy<DexApiFetchResult> {
  return {
    providerId: `dex-direct-api:${name.toLowerCase().replaceAll(/\s+/g, "-")}`,
    maxConcurrent: 1,
    timeoutMs: DIRECT_API_PROVIDER_TIMEOUT_MS,
    breakerPolicy: { circuitKey },
    countsAgainstLaneBudget: true,
    responseBodyPolicy: "stream",
    classifyOutcome: (result) => result.ok ? "success" : "failure",
  };
}

function directApiCircuitEventFromOutcome(
  circuitKey: string,
  outcome: CircuitOutcomeRecord | null,
): DirectApiCircuitEvent | null {
  if (!outcome) return null;
  const { before, after } = outcome;

  if (before.state === after.state) return null;
  return {
    circuitKey,
    from: before.state,
    to: after.state,
    at: after.state === "closed" ? after.lastSuccessAt : after.openedAt ?? after.lastFailureAt,
  };
}

export async function integrateDirectApiLiquidityPhase(params: {
  db?: D1Database;
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
}): Promise<DirectApiIntegrationResult> {
  let directApiDedupSkippedByAddress = 0;
  let directApiDedupSkippedByDerivedIdentity = 0;
  let directApiDedupSkippedByOptionalWildcardIdentity = 0;
  let directApiSkippedUntracked = 0;
  let directApiSkippedBelowTvlThreshold = 0;
  let directApiSkippedAboveTvlSanityCap = 0;
  const acceptedByProtocolChain: Record<string, number> = {};
  const excludedByReason: Record<string, number> = {};
  const normalized = normalizeDexApiPoolsForMerge(params.directApiPools);
  const directApiPools = normalized.pools;
  if (normalized.skippedInvalidUnitCount > 0) {
    incrementReason(excludedByReason, "invalid_units", normalized.skippedInvalidUnitCount);
  }

  if (directApiPools.length === 0) {
    return {
      directApiDedupSkippedByAddress,
      directApiDedupSkippedByDerivedIdentity,
      directApiDedupSkippedByOptionalWildcardIdentity,
      directApiSkippedUntracked,
      directApiSkippedInvalidUnits: normalized.skippedInvalidUnitCount,
      directApiSkippedBelowTvlThreshold,
      directApiSkippedAboveTvlSanityCap,
      acceptedByProtocolChain,
      excludedByReason,
    };
  }

  console.log(`[dex-liquidity] Fetched ${directApiPools.length} direct API pools total`);
  const trackedDirectApiPools = directApiPools.filter((pool) =>
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
  directApiSkippedUntracked = directApiPools.length - trackedDirectApiPools.length;
  if (directApiSkippedUntracked > 0) {
    incrementReason(excludedByReason, "untracked_token", directApiSkippedUntracked);
    console.log(
      `[dex-liquidity] Retained ${trackedDirectApiPools.length} direct API pools with tracked tokens ` +
        `(skipped ${directApiSkippedUntracked} untracked pools before identity processing)`,
    );
  }

  hydrateDirectApiPoolMetadata(trackedDirectApiPools, params.contractMetaByChainAddress);

  const trackedDirectApiPoolEntries = trackedDirectApiPools.map((pool) => ({
    pool,
    identity: buildDirectApiPoolIdentity(pool),
  }));
  const eligibleDirectApiPoolEntries = trackedDirectApiPoolEntries.filter(({ pool }) => {
    const eligible = isEligibleDirectApiPool(pool);
    if (eligible) return true;
    if (pool.tvlUsd < DIRECT_API_POOL_MIN_TVL_USD) {
      directApiSkippedBelowTvlThreshold++;
      incrementReason(excludedByReason, "below_tvl_threshold");
    } else {
      directApiSkippedAboveTvlSanityCap++;
      incrementReason(excludedByReason, "above_tvl_sanity_cap");
    }
    return false;
  });
  const eligibleDirectApiIdentities = eligibleDirectApiPoolEntries.map((entry) => entry.identity);
  const directApiIdentityCounts = countPoolIdentityKeys(eligibleDirectApiIdentities);

  const retainedDirectApiPools: DexApiPool[] = [];
  for (const { pool, identity } of eligibleDirectApiPoolEntries) {
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
      incrementReason(excludedByReason, "duplicate_exact_identity");
      continue;
    }
    if (dedupReason === "derived_unique") {
      directApiDedupSkippedByDerivedIdentity++;
      incrementReason(excludedByReason, "duplicate_unique_derived_identity");
      continue;
    }
    if (dedupReason === "derived_optional_wildcard") {
      directApiDedupSkippedByOptionalWildcardIdentity++;
      incrementReason(excludedByReason, "duplicate_optional_wildcard_identity");
      continue;
    }

    registerKnownPoolIdentity(params.knownPoolIndex, identity);
    retainedDirectApiPools.push(pool);
    const key = `${pool.source}:${pool.chain}`;
    acceptedByProtocolChain[key] = (acceptedByProtocolChain[key] ?? 0) + 1;
  }

  // Staged discovery sources can return the same physical pool with wildly
  // different TVL semantics. Keep every authoritative direct-API exact pool id
  // reserved for later exact-address dedupe, even if the direct row itself is
  // too small to contribute to scoring.
  for (const { identity } of trackedDirectApiPoolEntries) {
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
      params.validationReferences,
      params.stablecoinPriceById,
    );
    if (directApiGtPools.size > 0) {
      await mergeGtPools(params.metrics, directApiGtPools, params.db);
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

  return {
    directApiDedupSkippedByAddress,
    directApiDedupSkippedByDerivedIdentity,
    directApiDedupSkippedByOptionalWildcardIdentity,
    directApiSkippedUntracked,
    directApiSkippedInvalidUnits: normalized.skippedInvalidUnitCount,
    directApiSkippedBelowTvlThreshold,
    directApiSkippedAboveTvlSanityCap,
    acceptedByProtocolChain,
    excludedByReason,
  };
}

function incrementReason(record: Record<string, number>, reason: string, count = 1): void {
  record[reason] = (record[reason] ?? 0) + count;
}
