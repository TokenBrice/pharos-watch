import { logWorkerEventArgs } from "../../../lib/structured-log";
import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import type { PriceValidationReferences } from "../../../lib/price-validation";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import {
  recordOutcomeSafe,
  shouldAttemptFetch,
  type CircuitOutcomeRecord,
  type CircuitState,
} from "../../../lib/circuit-breaker";
import { abortError, throwIfAborted } from "../../../lib/abort";
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
import { fetchUniswapV3BscShadowPools } from "../fetch-uniswap-v3-bsc";
import { mergeGtPools } from "../fetch-crawlers";
import { normalizeProtocol } from "../pool-helpers";
import { buildDirectApiPoolIdentity } from "../direct-source-helpers";
import {
  countPoolIdentityKeys,
  getIdentityDedupReason,
  registerKnownPoolExactStablecoin,
  registerKnownPoolIdentity,
  type KnownPoolIdentityIndex,
} from "../pool-identity";
import type { DexPriceObs, GtNewPool, LiquidityFallbackCounters, LiquidityMetrics, PoolEntry, SymbolLookups } from "../types";
import { mergeDexPriceObservationMap } from "./price-obs";
import { DIRECT_API_FETCH_PHASE_CONCURRENCY, DIRECT_API_PROVIDER_TIMEOUT_MS } from "../direct-api-policy";
import { toErrorMessage } from "@shared/lib/error-utils";
import { mapWithConcurrency } from "../../../lib/concurrency";
import {
  applyRegisteredExecutionTargetOutput,
  buildRegisteredDirectApiExecutionTarget,
  type DirectApiExecutionTargetContext,
} from "../process-pool-execution-capability";

/**
 * Whether a provider's response is an exhaustive census of its protocol on the
 * chains it declares, or only a bounded sample of it. Only an exhaustive census
 * may veto an independently staged pool (see
 * `buildAuthoritativeStagedPoolConfirmationIndex`): a sample that misses a pool
 * proves nothing about that pool's existence.
 */
export type DirectApiCensusScope = "exhaustive" | "bounded-sample";

export interface DexPoolSourceAdapter {
  /** Registry identity; optional only for injected focused-test adapters. */
  slotId?: DexPoolSourceRegistrationSlot["slotId"];
  name: string;
  circuitKey: string;
  normalizedProtocol: string;
  supportedChains: string[];
  /** Defaults to "exhaustive"; declare "bounded-sample" to withhold veto authority. */
  censusScope?: DirectApiCensusScope;
  fn: (signal?: AbortSignal) => Promise<DexApiFetchResult>;
}
export type DirectApiFetcher = DexPoolSourceAdapter;

export interface DexPoolSourceRegistrationSlot {
  slotId:
    | "fluid"
    | "balancer"
    | "pancakeswap"
    | "meteora"
    | "raydium-clmm"
    | "orca-clmm"
    | "aerodrome-slipstream"
    | "uniswap-v3-bsc-shadow"
    | "velodrome-slipstream"
    | "evm-v4"
    | "soroban-exhaustive"
    | "btcusd-provider-investigation";
  platform: "evm" | "solana" | "soroban" | "offchain";
  lifecycle: "active" | "shadow" | "disabled";
  implementationModule: string;
}

/** Source slots are frozen here so downstream units only fill their leaves. */
export const DEX_POOL_SOURCE_REGISTRY: readonly DexPoolSourceRegistrationSlot[] = [
  { slotId: "fluid", platform: "evm", lifecycle: "active", implementationModule: "../fetch-fluid" },
  { slotId: "balancer", platform: "evm", lifecycle: "active", implementationModule: "../fetch-balancer" },
  { slotId: "pancakeswap", platform: "evm", lifecycle: "active", implementationModule: "../fetch-pancakeswap" },
  { slotId: "meteora", platform: "solana", lifecycle: "active", implementationModule: "../fetch-meteora" },
  { slotId: "raydium-clmm", platform: "solana", lifecycle: "active", implementationModule: "../fetch-raydium" },
  { slotId: "orca-clmm", platform: "solana", lifecycle: "active", implementationModule: "../fetch-orca" },
  { slotId: "aerodrome-slipstream", platform: "evm", lifecycle: "active", implementationModule: "../fetch-slipstream" },
  { slotId: "uniswap-v3-bsc-shadow", platform: "evm", lifecycle: "shadow", implementationModule: "../fetch-uniswap-v3-bsc" },
  { slotId: "velodrome-slipstream", platform: "evm", lifecycle: "active", implementationModule: "../fetch-slipstream" },
  { slotId: "evm-v4", platform: "evm", lifecycle: "disabled", implementationModule: "../subgraph-source-families" },
  { slotId: "soroban-exhaustive", platform: "soroban", lifecycle: "disabled", implementationModule: "../../dex-discovery/providers/soroban-exhaustive" },
  { slotId: "btcusd-provider-investigation", platform: "offchain", lifecycle: "disabled", implementationModule: "../../dex-discovery/providers/btcusd-public-https" },
] as const;

export interface DirectApiFetchPhaseEntry {
  name: string;
  circuitKey: string;
  normalizedProtocol: string;
  supportedChains: string[];
  censusScope?: DirectApiCensusScope;
  result: DexApiFetchResult;
  /** Exact raw-source identities retained without keeping discarded pool objects alive. */
  authoritativeExactPoolKeys?: Set<string>;
  poolCompaction?: DirectApiProviderPoolCompaction;
}

export interface DirectApiFetchPhaseResult {
  results: DirectApiFetchPhaseEntry[];
  failedSources: string[];
  fallbackSignals: string[];
  sourceWarnings: string[];
  circuitEvents: DirectApiCircuitEvent[];
}

export interface DirectApiPoolCompactionCounts {
  rawPoolCount: number;
  retainedPoolCount: number;
  skippedInvalidUnitCount: number;
  skippedUntrackedCount: number;
}

export interface DirectApiProviderPoolCompaction extends DirectApiPoolCompactionCounts {
  measuredExecutionPools: DexApiPool[];
}

export interface CompactedDirectApiFetchPhase {
  phase: DirectApiFetchPhaseResult;
  pools: DexApiPool[];
  measuredExecutionPools: DexApiPool[];
  counts: DirectApiPoolCompactionCounts;
}

export interface DirectApiCircuitEvent {
  circuitKey: string;
  from: CircuitState;
  to: CircuitState;
  at: number | null;
}

class DirectApiCircuitOpenError extends Error {}

class DirectApiExecutionError extends Error {
  constructor(
    providerId: string,
    error: unknown,
    readonly circuitOutcome: CircuitOutcomeRecord | null,
  ) {
    super(`Provider ${providerId} failed: ${toErrorMessage(error)}`);
    this.name = "DirectApiExecutionError";
  }
}

async function executeDirectApiProvider(
  db: D1Database,
  fetcher: Pick<DirectApiFetcher, "name" | "circuitKey" | "fn">,
  parentSignal?: AbortSignal,
): Promise<{ value: DexApiFetchResult; circuitOutcome: CircuitOutcomeRecord | null }> {
  const { name, circuitKey, fn } = fetcher;
  const providerId = `dex-direct-api:${name.toLowerCase().replaceAll(/\s+/g, "-")}`;
  if (!(await shouldAttemptFetch(db, circuitKey))) {
    throw new DirectApiCircuitOpenError();
  }
  throwIfAborted(parentSignal);

  const timeout = createTimeoutSignal({
    timeoutMs: DIRECT_API_PROVIDER_TIMEOUT_MS,
    timeoutReason: new DOMException(
      `provider ${providerId} timed out after ${DIRECT_API_PROVIDER_TIMEOUT_MS}ms`,
      "TimeoutError",
    ),
    parentSignal,
  });

  try {
    const value = await fn(timeout.signal);
    const circuitOutcome = await recordOutcomeSafe(db, circuitKey, value.ok && !timeout.isTimedOut());
    return { value, circuitOutcome };
  } catch (error) {
    const parentAborted = Boolean(parentSignal?.aborted && !timeout.isTimedOut());
    if (parentAborted) throw abortError(parentSignal);
    const circuitOutcome = await recordOutcomeSafe(db, circuitKey, false);
    throw new DirectApiExecutionError(providerId, error, circuitOutcome);
  } finally {
    timeout.dispose();
  }
}

function hasTrackedDirectApiToken(
  pool: DexApiPool,
  lookups: Pick<SymbolLookups, "chainAddressToId" | "symbolToChainScopedIds">,
): boolean {
  return pool.tokens.some(
    (token) =>
      resolveStablecoinIdForDexApiToken(pool.chain, token, lookups.chainAddressToId, lookups.symbolToChainScopedIds) !=
      null,
  );
}

export function compactDirectApiFetchPhasePools(
  phase: DirectApiFetchPhaseResult,
  lookups: Pick<
    SymbolLookups,
    "chainAddressToId" | "symbolToChainScopedIds" | "contractMetaByChainAddress"
  >,
): CompactedDirectApiFetchPhase {
  const pools: DexApiPool[] = [];
  const measuredExecutionPools: DexApiPool[] = [];
  const counts: DirectApiPoolCompactionCounts = {
    rawPoolCount: 0,
    retainedPoolCount: 0,
    skippedInvalidUnitCount: 0,
    skippedUntrackedCount: 0,
  };

  const results = phase.results.map((entry) => compactDirectApiProviderEntry(entry, lookups));
  for (const entry of results) {
    const compaction = entry.poolCompaction!;
    counts.rawPoolCount += compaction.rawPoolCount;
    counts.retainedPoolCount += compaction.retainedPoolCount;
    counts.skippedInvalidUnitCount += compaction.skippedInvalidUnitCount;
    counts.skippedUntrackedCount += compaction.skippedUntrackedCount;
    pools.push(...entry.result.pools);
    measuredExecutionPools.push(...compaction.measuredExecutionPools);
  }
  // The exact-execution copies are intentionally split from the normalized
  // scoring copies during provider compaction, so hydrate this bounded
  // target-only list before target construction as well.
  hydrateDirectApiPoolMetadata(measuredExecutionPools, lookups.contractMetaByChainAddress);

  return {
    phase: { ...phase, results },
    pools,
    measuredExecutionPools,
    counts,
  };
}

function compactDirectApiProviderEntry(
  entry: DirectApiFetchPhaseEntry,
  lookups: Pick<SymbolLookups, "chainAddressToId" | "symbolToChainScopedIds">,
): DirectApiFetchPhaseEntry {
  if (entry.poolCompaction) return entry;

  const rawPools = entry.result.pools;
  // Warnings (a handful of malformed rows on one page) do not invalidate the
  // census, but they must not switch the confirmation set over to the compacted
  // `entry.result.pools` either: that list is filtered down to tracked tokens
  // below, so reading it back as "what the provider knows" vetoes every staged
  // pool the compaction dropped. Collect the raw keys whenever the fetch itself
  // succeeded and let the index decide whether the census may enforce.
  const authoritativeExactPoolKeys =
    entry.normalizedProtocol !== "uniswap-v3-shadow" && entry.result.ok && !entry.result.degraded
      ? new Set<string>()
      : undefined;
  const measuredExecutionPools: DexApiPool[] = [];
  const retainedPools: DexApiPool[] = [];
  let normalizedPoolCount = 0;
  let skippedInvalidUnitCount = 0;

  for (const rawPool of rawPools) {
    if (authoritativeExactPoolKeys) {
      const exactPoolKey = buildDirectApiPoolIdentity(rawPool).exactPoolKey;
      if (exactPoolKey) authoritativeExactPoolKeys.add(exactPoolKey);
    }
    if (
      (rawPool.source === "pancakeswap" ||
        rawPool.source === "uniswap-v3-shadow" ||
        rawPool.source === "aerodrome-slipstream") &&
      hasTrackedDirectApiToken(rawPool, lookups)
    ) {
      measuredExecutionPools.push(rawPool);
    }
    // Exact-execution shadow censuses do not alter liquidity scores or price
    // consensus before their separate activation reviews.
    if (rawPool.source === "uniswap-v3-shadow") continue;

    // Normalize one pool at a time so the full raw provider graph never
    // coexists with a second full normalized graph.
    const normalized = normalizeDexApiPoolsForMerge([rawPool]);
    skippedInvalidUnitCount += normalized.skippedInvalidUnitCount;
    const pool = normalized.pools[0];
    if (!pool) continue;
    normalizedPoolCount++;
    if (hasTrackedDirectApiToken(pool, lookups)) {
      retainedPools.push(pool);
    }
  }

  // The fetch result owns this array. Replacing it here drops the raw provider
  // graph before the serialized phase advances to the next provider.
  entry.result.pools = retainedPools;
  return {
    ...entry,
    ...(authoritativeExactPoolKeys ? { authoritativeExactPoolKeys } : {}),
    poolCompaction: {
      rawPoolCount: rawPools.length,
      retainedPoolCount: retainedPools.length,
      skippedInvalidUnitCount,
      skippedUntrackedCount: normalizedPoolCount - retainedPools.length,
      measuredExecutionPools,
    },
  };
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
  db: D1Database;
  graphApiKey: string | null;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  symbolToChainScopedIds: SymbolLookups["symbolToChainScopedIds"];
  stablecoinPriceById: Map<string, number>;
  chainRpcs?: Map<string, ChainRpcConfig>;
  fallbackCounters?: LiquidityFallbackCounters;
}): DirectApiFetcher[] {
  const adapters: DexPoolSourceAdapter[] = [
    {
      slotId: "fluid",
      name: "Fluid",
      circuitKey: CIRCUIT_SOURCE.FLUID_DEX_API,
      normalizedProtocol: "fluid",
      supportedChains: ["ethereum", "arbitrum", "base", "polygon", "bsc", "plasma"],
      // Emits only pools whose tokens resolve to a tracked stablecoin, so an
      // absent pool means "not resolved here", not "does not exist".
      censusScope: "bounded-sample",
      fn: (signal) => fetchFluidPools(signal, params.chainRpcs, params.fallbackCounters),
    },
    {
      slotId: "balancer",
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
      slotId: "pancakeswap",
      name: "PancakeSwap",
      circuitKey: CIRCUIT_SOURCE.PANCAKESWAP_API,
      normalizedProtocol: "pancakeswap",
      supportedChains: ["bsc", "ethereum", "base"],
      fn: (signal) => fetchPancakeSwapPools(params.graphApiKey, signal, params.db),
    },
    {
      slotId: "meteora",
      name: "Meteora",
      circuitKey: CIRCUIT_SOURCE.METEORA_API,
      normalizedProtocol: "meteora",
      supportedChains: ["solana"],
      // `dlmm.datapi.meteora.ag/pools` ignores the `limit` query parameter and
      // answers with its own 10-row pages while advertising `total: 123268`.
      // The paginated helper stops as soon as a page is shorter than the
      // requested size, so this provider returns ~10 of ~123k pools and cannot
      // speak for the pools it never saw.
      censusScope: "bounded-sample",
      fn: fetchMeteoraPools,
    },
    {
      slotId: "raydium-clmm",
      name: "Raydium",
      circuitKey: CIRCUIT_SOURCE.RAYDIUM_API,
      normalizedProtocol: "raydium",
      supportedChains: ["solana"],
      fn: fetchRaydiumPools,
    },
    {
      slotId: "orca-clmm",
      name: "Orca",
      circuitKey: CIRCUIT_SOURCE.ORCA_API,
      normalizedProtocol: "orca",
      supportedChains: ["solana"],
      fn: (signal) => fetchOrcaPools(signal, params.db),
    },
    {
      slotId: "aerodrome-slipstream",
      name: "Aerodrome Slipstream",
      circuitKey: CIRCUIT_SOURCE.AERODROME_SLIPSTREAM_API,
      normalizedProtocol: "aerodrome",
      supportedChains: ["base"],
      // `fetchSugarPools` keeps only pools holding a tracked token, and
      // `fetchSlipstreamPools` then drops any pool with a one-sided reserve or
      // an underivable USD price. A tick-spacing-1 CL pool sitting entirely on
      // one side of its range is normal, so an omission is a coverage hole in
      // this extract rather than evidence that the pool does not exist.
      censusScope: "bounded-sample",
      fn: (signal) =>
        fetchSlipstreamPools(
          "aerodrome-slipstream",
          params.chainAddressToId,
          params.symbolToChainScopedIds,
          params.stablecoinPriceById,
          signal,
          params.chainRpcs,
          params.db,
        ),
    },
    {
      slotId: "uniswap-v3-bsc-shadow",
      name: "Uniswap V3 BSC shadow",
      circuitKey: CIRCUIT_SOURCE.UNISWAP_V3_BSC_SHADOW,
      normalizedProtocol: "uniswap-v3-shadow",
      supportedChains: ["bsc"],
      fn: (signal) => fetchUniswapV3BscShadowPools({
        db: params.db,
        chainAddressToId: params.chainAddressToId,
        trackedStablecoinPrices: params.stablecoinPriceById,
        signal,
        chainRpcs: params.chainRpcs,
      }),
    },
    {
      slotId: "velodrome-slipstream",
      name: "Velodrome Slipstream",
      circuitKey: CIRCUIT_SOURCE.VELODROME_SLIPSTREAM_API,
      normalizedProtocol: "velodrome",
      supportedChains: ["optimism"],
      // Same Sugar extract as Aerodrome Slipstream above.
      censusScope: "bounded-sample",
      fn: (signal) =>
        fetchSlipstreamPools(
          "velodrome-slipstream",
          params.chainAddressToId,
          params.symbolToChainScopedIds,
          params.stablecoinPriceById,
          signal,
          params.chainRpcs,
          params.db,
        ),
    },
  ];
  const bySlot = new Map(adapters.map((adapter) => [adapter.slotId, adapter]));
  return DEX_POOL_SOURCE_REGISTRY
    .filter((registration) => registration.lifecycle !== "disabled")
    .flatMap((registration) => {
      const adapter = bySlot.get(registration.slotId);
      return adapter ? [adapter] : [];
    });
}

export async function runDirectApiFetchPhase(
  db: D1Database,
  fetchers: DirectApiFetcher[],
  signal?: AbortSignal,
  lookups?: Pick<SymbolLookups, "chainAddressToId" | "symbolToChainScopedIds">,
): Promise<DirectApiFetchPhaseResult> {
  const entries = await mapWithConcurrency(
    fetchers,
    DIRECT_API_FETCH_PHASE_CONCURRENCY,
    async ({ name, circuitKey, normalizedProtocol, supportedChains, censusScope, fn }) => {
      const failedSources: string[] = [];
      const fallbackSignals: string[] = [];
      const sourceWarnings: string[] = [];
      const circuitEvents: DirectApiCircuitEvent[] = [];

      try {
        const execution = await executeDirectApiProvider(db, { name, circuitKey, fn }, signal);
        const result = execution.value;
        const event = directApiCircuitEventFromOutcome(circuitKey, execution.circuitOutcome);
        if (event) circuitEvents.push(event);
        sourceWarnings.push(...(result.warnings ?? []).map((warning) => `${circuitKey}: ${warning}`));
        if (result.degraded) {
          sourceWarnings.push(...result.errors.map((error) => `${circuitKey}: ${error}`));
        }
        if (!result.ok) {
          failedSources.push(circuitKey);
        }
        if (!result.ok) {
          fallbackSignals.push(`${circuitKey}-unavailable`);
        } else if (result.degraded) {
          fallbackSignals.push(`${circuitKey}-partial`);
        }
        const entry: DirectApiFetchPhaseEntry = {
          name,
          circuitKey,
          normalizedProtocol,
          supportedChains,
          ...(censusScope ? { censusScope } : {}),
          result,
        };
        return {
          failedSources,
          fallbackSignals,
          sourceWarnings,
          circuitEvents,
          entry: lookups ? compactDirectApiProviderEntry(entry, lookups) : entry,
        };
      } catch (err) {
        if (err instanceof DirectApiCircuitOpenError) {
          logWorkerEventArgs("handler", "info", `[dex-liquidity] ${name} API circuit open, skipping`);
          failedSources.push(circuitKey);
          fallbackSignals.push(`${circuitKey}-circuit-open`);
          return {
            failedSources,
            fallbackSignals,
            sourceWarnings,
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
        logWorkerEventArgs("handler", "warn", `[dex-liquidity] ${name} API failed (non-fatal):`, err);
        const executionError = err instanceof DirectApiExecutionError ? err : null;
        const event = directApiCircuitEventFromOutcome(circuitKey, executionError?.circuitOutcome ?? null);
        if (event) circuitEvents.push(event);
        failedSources.push(circuitKey);
        fallbackSignals.push(`${circuitKey}-exception`);
        return {
          failedSources,
          fallbackSignals,
          sourceWarnings,
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
    },
  );

  return {
    results: entries.map((entry) => entry.entry),
    failedSources: entries.flatMap((entry) => entry.failedSources),
    fallbackSignals: entries.flatMap((entry) => entry.fallbackSignals),
    sourceWarnings: entries.flatMap((entry) => entry.sourceWarnings),
    circuitEvents: entries.flatMap((entry) => entry.circuitEvents),
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
    at: after.state === "closed" ? after.lastSuccessAt : (after.openedAt ?? after.lastFailureAt),
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
  executionTargetContext?: DirectApiExecutionTargetContext;
  preprocessedPoolCounts?: DirectApiPoolCompactionCounts;
  fallbackCounters?: LiquidityFallbackCounters;
}): Promise<DirectApiIntegrationResult> {
  if (
    params.preprocessedPoolCounts &&
    params.preprocessedPoolCounts.retainedPoolCount !== params.directApiPools.length
  ) {
    throw new Error("dex-liquidity: compacted direct API retained count does not match the integration input");
  }

  let directApiDedupSkippedByAddress = 0;
  let directApiDedupSkippedByDerivedIdentity = 0;
  let directApiDedupSkippedByOptionalWildcardIdentity = 0;
  let directApiSkippedUntracked = 0;
  let directApiSkippedBelowTvlThreshold = 0;
  let directApiSkippedAboveTvlSanityCap = 0;
  const acceptedByProtocolChain: Record<string, number> = {};
  const excludedByReason: Record<string, number> = {};
  const normalized = params.preprocessedPoolCounts
    ? {
        pools: params.directApiPools,
        skippedInvalidUnitCount: params.preprocessedPoolCounts.skippedInvalidUnitCount,
      }
    : normalizeDexApiPoolsForMerge(params.directApiPools);
  const directApiPools = normalized.pools;
  if (normalized.skippedInvalidUnitCount > 0) {
    incrementReason(excludedByReason, "invalid_units", normalized.skippedInvalidUnitCount);
  }

  const trackedDirectApiPools = params.preprocessedPoolCounts
    ? directApiPools
    : directApiPools.filter((pool) =>
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
  directApiSkippedUntracked =
    params.preprocessedPoolCounts?.skippedUntrackedCount ?? directApiPools.length - trackedDirectApiPools.length;
  if (directApiSkippedUntracked > 0) {
    incrementReason(excludedByReason, "untracked_token", directApiSkippedUntracked);
  }

  if (directApiPools.length === 0 && !params.preprocessedPoolCounts) {
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

  const fetchedPoolCount = params.preprocessedPoolCounts?.rawPoolCount ?? directApiPools.length;
  logWorkerEventArgs("handler", "info", `[dex-liquidity] Fetched ${fetchedPoolCount} direct API pools total`);
  if (directApiSkippedUntracked > 0) {
    logWorkerEventArgs("handler", "info",
      `[dex-liquidity] Retained ${trackedDirectApiPools.length} direct API pools with tracked tokens ` +
        `(skipped ${directApiSkippedUntracked} untracked pools before identity processing)`,
    );
  }

  if (trackedDirectApiPools.length === 0) {
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

  hydrateDirectApiPoolMetadata(trackedDirectApiPools, params.contractMetaByChainAddress);

  const trackedDirectApiPoolEntries = trackedDirectApiPools.map((pool) => ({
    pool,
    identity: buildDirectApiPoolIdentity(pool, params.chainAddressToId),
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
  const exactDuplicatePoolsForEvidence: DexApiPool[] = [];
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
      exactDuplicatePoolsForEvidence.push(pool);
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
  for (const { pool, identity } of trackedDirectApiPoolEntries) {
    if (identity.exactPoolKey) {
      params.knownPoolIndex.exactKeys.add(identity.exactPoolKey);
      for (const token of pool.tokens) {
        const stablecoinId = resolveStablecoinIdForDexApiToken(
          pool.chain,
          token,
          params.chainAddressToId,
          params.symbolToChainScopedIds,
        );
        if (stablecoinId) {
          registerKnownPoolExactStablecoin(params.knownPoolIndex, identity, stablecoinId);
        }
      }
    }
  }

  if (
    directApiDedupSkippedByAddress > 0 ||
    directApiDedupSkippedByDerivedIdentity > 0 ||
    directApiDedupSkippedByOptionalWildcardIdentity > 0
  ) {
    logWorkerEventArgs("handler", "info",
      `[dex-liquidity] Skipped ${directApiDedupSkippedByAddress} exact, ` +
        `${directApiDedupSkippedByDerivedIdentity} unique derived, and ` +
        `${directApiDedupSkippedByOptionalWildcardIdentity} optional wildcard direct API duplicates`,
    );
  }

  let directApiGtPools = new Map<string, GtNewPool[]>();
  if (retainedDirectApiPools.length > 0) {
    directApiGtPools = convertToGtNewPools(
      retainedDirectApiPools,
      params.chainAddressToId,
      params.symbolToChainScopedIds,
      params.validationReferences,
      params.stablecoinPriceById,
      params.fallbackCounters,
    );
    if (directApiGtPools.size > 0) {
      await mergeGtPools(params.metrics, directApiGtPools, params.db, params.fallbackCounters);
    }
  }

  let exactDuplicateGtPools = new Map<string, GtNewPool[]>();
  if (exactDuplicatePoolsForEvidence.length > 0) {
    exactDuplicateGtPools = convertToGtNewPools(
      exactDuplicatePoolsForEvidence,
      params.chainAddressToId,
      params.symbolToChainScopedIds,
      params.validationReferences,
      params.stablecoinPriceById,
    );
    retainExactDuplicatePoolEvidence(params.metrics, exactDuplicateGtPools);
  }

  if (params.executionTargetContext) {
    const executionTargetContext = params.executionTargetContext;
    attachRegisteredDirectApiExecutionTargets(
      params,
      executionTargetContext,
      retainedDirectApiPools,
      directApiGtPools,
    );
    attachRegisteredDirectApiExecutionTargets(
      params,
      executionTargetContext,
      exactDuplicatePoolsForEvidence,
      exactDuplicateGtPools,
    );
  }

  const directApiPoolsForPriceObservation = [...retainedDirectApiPools, ...exactDuplicatePoolsForEvidence];
  if (directApiPoolsForPriceObservation.length > 0) {
    const directApiPriceObs = extractPriceObservations(
      directApiPoolsForPriceObservation,
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

function attachRegisteredDirectApiExecutionTargets(
  params: Parameters<typeof integrateDirectApiLiquidityPhase>[0],
  executionTargetContext: DirectApiExecutionTargetContext,
  exactPools: readonly DexApiPool[],
  shapedPools: ReadonlyMap<string, readonly GtNewPool[]>,
): void {
  const exactPoolByKey = new Map(
    exactPools.map((pool) => [canonicalExitRouteAssetKey(pool.chain, pool.poolAddress), pool]),
  );
  for (const [stablecoinId, pools] of shapedPools) {
    const metric = params.metrics.get(stablecoinId);
    if (!metric) continue;
    for (const shapedPool of pools) {
      const poolId = canonicalExitRouteAssetKey(shapedPool.chain, shapedPool.address);
      const exactPool = exactPoolByKey.get(poolId);
      const retainedPool = metric.topPools.find((pool) => pool.poolId === poolId);
      if (
        !exactPool ||
        !retainedPool ||
        !isCompatibleExactDuplicateEvidence(retainedPool, shapedPool)
      ) continue;
      const output = buildRegisteredDirectApiExecutionTarget({
        pool: exactPool,
        stablecoinId,
        chainAddressToId: params.chainAddressToId,
        symbolToChainScopedIds: params.symbolToChainScopedIds,
        stablecoinPriceById: params.stablecoinPriceById,
        validationReferences: params.validationReferences,
        executionTargetContext,
      });
      if (!output) continue;
      retainedPool.extra ??= {};
      applyRegisteredExecutionTargetOutput(retainedPool.extra, output);
    }
  }
}

function retainExactDuplicatePoolEvidence(
  metrics: Map<string, LiquidityMetrics>,
  exactDuplicateGtPools: Map<string, GtNewPool[]>,
): void {
  for (const [stablecoinId, pools] of exactDuplicateGtPools) {
    const metric = metrics.get(stablecoinId);
    if (!metric) continue;

    for (const pool of pools) {
      const existingPool = metric.topPools.find(
        (candidate) => candidate.poolId === canonicalExitRouteAssetKey(pool.chain, pool.address),
      );
      if (!existingPool || !isCompatibleExactDuplicateEvidence(existingPool, pool)) continue;

      const existingExtra = existingPool.extra ?? {};
      if (pool.ammExecutionModel && !existingExtra.ammExecutionModel && !existingExtra.executionCapabilityGate) {
        existingPool.extra = {
          ...existingExtra,
          ammExecutionModel: pool.ammExecutionModel,
        };
      } else if (
        pool.executionCapabilityGate &&
        !existingExtra.ammExecutionModel &&
        !existingExtra.executionCapabilityGate
      ) {
        existingPool.extra = {
          ...existingExtra,
          executionCapabilityGate: pool.executionCapabilityGate,
        };
      }
    }
  }
}

function isCompatibleExactDuplicateEvidence(existingPool: PoolEntry, incomingPool: GtNewPool): boolean {
  if (normalizeProtocol(existingPool.project) !== normalizeProtocol(incomingPool.dexId)) return false;
  return poolSymbolSet(existingPool.symbol) === poolSymbolSet(incomingPool.symbol);
}

function poolSymbolSet(symbol: string): string {
  return symbol
    .split(/\s*\/\s*/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("/");
}

function incrementReason(record: Record<string, number>, reason: string, count = 1): void {
  record[reason] = (record[reason] ?? 0) + count;
}
