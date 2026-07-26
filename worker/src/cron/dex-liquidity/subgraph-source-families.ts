import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { isUsdReferenceSymbol, normalizeDexSymbol } from "../../lib/dex-cron-constants";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import { mergeDexPriceObservationMap } from "./orchestrator-phases/price-obs";
import type { SubgraphPriceObservation } from "./subgraph-helpers";
import type {
  AerodromeLookups,
  DexPriceObs,
  UniswapV4Lookups,
  UniV3Lookups,
} from "./types";
import {
  AERODROME_PAIR_MAX_PAGES,
  AERODROME_PAIR_PAGE_SIZE,
  AERODROME_SUBGRAPHS,
  UNIV3_POOL_MAX_PAGES,
  UNIV3_POOL_PAGE_SIZE,
  UNIV3_SUBGRAPHS,
  UNISWAP_V4_POOL_MAX_PAGES,
  UNISWAP_V4_POOL_PAGE_SIZE,
  UNISWAP_V4_SUBGRAPHS,
  buildAerodromePairQuery,
  buildUniswapV4PoolQuery,
  buildUniV3PoolQuery,
} from "./constants";
import { buildPoolIdentity } from "./pool-identity";
import { resolveTrackedStablecoinId } from "./token-resolution";
import { runSubgraphFamily } from "./subgraph-family-runner";
import {
  buildUniswapV4ExecutionCandidateKey,
  buildUniV3ExecutionCandidateKey,
} from "../measured-execution/inventory";
import { buildEvmV2ExecutionCandidate } from "./constant-product-v2";

type UniV3SubgraphPool = {
  id: string;
  token0: { id: string; symbol: string; decimals: string };
  token1: { id: string; symbol: string; decimals: string };
  feeTier: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
  token0Price: string;
  token1Price: string;
  totalValueLockedToken0: string;
  totalValueLockedToken1: string;
};

type AerodromeSubgraphPair = {
  id: string;
  token0: { id: string; symbol: string };
  token1: { id: string; symbol: string };
  reserve0: string;
  reserve1: string;
  reserveUSD: string;
  token0Price: string;
  token1Price: string;
  isStable: boolean;
};

type UniswapV4SubgraphPool = {
  id: string;
  token0: { id: string; symbol: string; decimals: string };
  token1: { id: string; symbol: string; decimals: string };
  feeTier: string;
  tickSpacing: string;
  hooks: string;
  totalValueLockedUSD: string;
  token0Price: string;
  token1Price: string;
};

function parseSubgraphInteger(value: string): number {
  const normalized = value.trim();
  if (!/^-?[0-9]+$/.test(normalized)) return Number.NaN;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function mapTrackedSubgraphPriceObservations(config: {
  chain: string;
  protocol: "uniswap-v3" | "aerodrome";
  tvl: number;
  tokenEntries: Array<{ symbol: string; address: string; usdPrice: number }>;
  chainAddressToId: Map<string, string>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  references?: PriceValidationReferences;
  identity: ReturnType<typeof buildPoolIdentity>;
}): SubgraphPriceObservation[] {
  const mapped: SubgraphPriceObservation[] = [];
  const { chain, protocol, tvl, tokenEntries, chainAddressToId, symbolToChainScopedIds, references, identity } = config;

  for (const { symbol, address, usdPrice } of tokenEntries) {
    const resolved = resolveTrackedStablecoinId(
      { chain, address, symbol },
      { chainAddressToId, symbolToChainScopedIds },
    );
    if (resolved.status !== "matched" || !resolved.stablecoinId) continue;
    if (!isPlausibleDexObservationPrice(resolved.stablecoinId, usdPrice, references)) continue;
    mapped.push({
      stablecoinId: resolved.stablecoinId,
      obs: {
        price: usdPrice,
        tvl,
        chain,
        protocol,
        poolKey: identity.exactPoolKey ?? undefined,
        derivedMatchKey: identity.derivedMatchKey ?? undefined,
        identityConfidence: identity.exactPoolKey ? "exact" : identity.derivedMatchKey ? "derived_unique" : "none",
        sourceFamily: "dl",
      },
    });
  }

  return mapped;
}

export async function fetchUniV3Data(
  graphApiKey: string | null,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  chainAddressToId: Map<string, string>,
  signal?: AbortSignal,
  references?: PriceValidationReferences,
): Promise<UniV3Lookups> {
  return runSubgraphFamily<UniV3SubgraphPool, UniV3Lookups>({
    graphApiKey,
    signal,
    subgraphs: UNIV3_SUBGRAPHS,
    missingApiKeyMessage: "[dex-liquidity] No GRAPH_API_KEY, skipping Uni V3 subgraph enrichment",
    familyLabel: "Uni V3 subgraph",
    createLookups: () => ({
      uniV3PoolFees: new Map<string, number>(),
      uniV3SymbolFees: new Map<string, number>(),
      uniV3PriceObs: new Map<string, DexPriceObs[]>(),
      uniV3ExecutionCandidates: new Map(),
    }),
    buildConfig: (chain, subgraphUrl, combinedSignal, lookups) => ({
      subgraphUrl,
      sourceLabel: "Uni V3 subgraph",
      chain,
      buildQuery: (skip) => buildUniV3PoolQuery(skip),
      pageSize: UNIV3_POOL_PAGE_SIZE,
      maxPages: UNIV3_POOL_MAX_PAGES,
      signal: combinedSignal,
      extractEntities: (data) => (data as { pools?: UniV3SubgraphPool[] } | undefined)?.pools,
      mapEntity: (pool) => {
        const feeTier = parseInt(pool.feeTier, 10);
        if (isNaN(feeTier)) return [];
        const tvl = parseFloat(pool.totalValueLockedUSD);

        lookups.uniV3PoolFees.set(`${chain}:${pool.id.toLowerCase()}`, feeTier);

        const syms = [normalizeDexSymbol(pool.token0.symbol), normalizeDexSymbol(pool.token1.symbol)].sort().join(":");
        const symKey = `${chain}:${syms}`;
        const existing = lookups.uniV3SymbolFees.get(symKey);
        if (existing == null || feeTier < existing) {
          lookups.uniV3SymbolFees.set(symKey, feeTier);
        }

        const token0Decimals = Number.parseInt(pool.token0.decimals, 10);
        const token1Decimals = Number.parseInt(pool.token1.decimals, 10);
        const token0Price = parseFloat(pool.token0Price);
        const token1Price = parseFloat(pool.token1Price);
        const executionKey = buildUniV3ExecutionCandidateKey(chain, [pool.token0.id, pool.token1.id], feeTier);
        if (
          executionKey &&
          Number.isFinite(tvl) &&
          tvl > 0 &&
          Number.isInteger(token0Decimals) &&
          token0Decimals >= 0 &&
          token0Decimals <= 255 &&
          Number.isInteger(token1Decimals) &&
          token1Decimals >= 0 &&
          token1Decimals <= 255 &&
          Number.isFinite(token0Price) &&
          token0Price > 0 &&
          Number.isFinite(token1Price) &&
          token1Price > 0
        ) {
          const candidates = lookups.uniV3ExecutionCandidates.get(executionKey) ?? [];
          candidates.push({
            chain,
            poolAddress: pool.id,
            feePips: feeTier,
            tvlUsd: tvl,
            token0Price,
            token1Price,
            tokens: [
              { address: pool.token0.id, symbol: pool.token0.symbol, decimals: token0Decimals },
              { address: pool.token1.id, symbol: pool.token1.symbol, decimals: token1Decimals },
            ],
          });
          lookups.uniV3ExecutionCandidates.set(executionKey, candidates);
        }

        if (isNaN(tvl) || tvl < DEX_PRICE_OBSERVATION_MIN_TVL_USD) return [];

        if (isNaN(token0Price) || isNaN(token1Price) || token0Price <= 0 || token1Price <= 0) return [];

        const sym0 = normalizeDexSymbol(pool.token0.symbol);
        const sym1 = normalizeDexSymbol(pool.token1.symbol);
        const isRef0 = isUsdReferenceSymbol(pool.token0.symbol);
        const isRef1 = isUsdReferenceSymbol(pool.token1.symbol);
        if (!isRef0 && !isRef1) return [];

        const pricedTokens: { symbol: string; address: string; usdPrice: number }[] = [];
        if (isRef1) {
          pricedTokens.push({ symbol: sym0, address: pool.token0.id, usdPrice: token1Price });
        }
        if (isRef0) {
          pricedTokens.push({ symbol: sym1, address: pool.token1.id, usdPrice: token0Price });
        }

        const identity = buildPoolIdentity({
          chain,
          protocol: "uniswap-v3",
          poolAddressOrId: pool.id,
          tokenAddresses: [pool.token0.id, pool.token1.id],
          feeTierBps: feeTier / 100,
        });
        return mapTrackedSubgraphPriceObservations({
          chain,
          protocol: "uniswap-v3",
          tvl,
          tokenEntries: pricedTokens,
          chainAddressToId,
          symbolToChainScopedIds,
          references,
          identity,
        });
      },
    }),
    handleResult: (lookups, _chain, result) => {
      mergeDexPriceObservationMap(lookups.uniV3PriceObs, result.observations);
    },
    buildChainSummary: (chain, result) =>
      `[dex-liquidity] Indexed ${result.entityCount} Uni V3 pools from ${chain} subgraph (${result.observationCount} price obs)`,
    buildFinalSummary: (lookups) =>
      `[dex-liquidity] Collected ${lookups.uniV3PriceObs.size} coins with Uni V3 price observations`,
  });
}

export async function fetchAerodromeData(
  graphApiKey: string | null,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  chainAddressToId: Map<string, string>,
  signal?: AbortSignal,
  references?: PriceValidationReferences,
): Promise<AerodromeLookups> {
  return runSubgraphFamily<AerodromeSubgraphPair, AerodromeLookups>({
    graphApiKey,
    signal,
    subgraphs: AERODROME_SUBGRAPHS,
    familyLabel: "Aerodrome subgraph",
    createLookups: () => ({
      aerodromePriceObs: new Map<string, DexPriceObs[]>(),
      aerodromeIsStable: new Map<string, boolean>(),
      aerodromeV2ExecutionCandidates: new Map(),
    }),
    buildConfig: (chain, subgraphUrl, combinedSignal, lookups) => ({
      subgraphUrl,
      sourceLabel: "Aerodrome subgraph",
      chain,
      buildQuery: (skip) => buildAerodromePairQuery(skip),
      pageSize: AERODROME_PAIR_PAGE_SIZE,
      maxPages: AERODROME_PAIR_MAX_PAGES,
      signal: combinedSignal,
      extractEntities: (data) => (data as { pairs?: AerodromeSubgraphPair[] } | undefined)?.pairs,
      mapEntity: (pair) => {
        if (!pair.isStable) {
          const candidate = buildEvmV2ExecutionCandidate({
            chain,
            protocol: "aerodrome",
            poolType: "aerodrome-volatile",
            poolAddress: pair.id,
            tokenAddresses: [pair.token0.id, pair.token1.id],
            tokenSymbols: [pair.token0.symbol, pair.token1.symbol],
            confirmedStable: pair.isStable,
          });
          if (candidate) {
            lookups.aerodromeV2ExecutionCandidates.set(
              canonicalExitRouteAssetKey(chain, candidate.poolAddress),
              candidate,
            );
          }
        }

        const reserveUSD = parseFloat(pair.reserveUSD);
        if (isNaN(reserveUSD) || reserveUSD < DEX_PRICE_OBSERVATION_MIN_TVL_USD) return [];

        lookups.aerodromeIsStable.set(`${chain}:${pair.id.toLowerCase()}`, pair.isStable);

        const reserve0 = parseFloat(pair.reserve0);
        const reserve1 = parseFloat(pair.reserve1);
        const token0Price = parseFloat(pair.token0Price);
        const token1Price = parseFloat(pair.token1Price);
        if (isNaN(reserve0) || isNaN(reserve1) || reserve0 <= 0 || reserve1 <= 0) return [];
        if (isNaN(token0Price) || isNaN(token1Price) || token0Price <= 0 || token1Price <= 0) return [];

        const denom = reserve0 * token1Price + reserve1;
        if (denom <= 0) return [];
        const price1Usd = reserveUSD / denom;
        const price0Usd = token1Price * price1Usd;
        const reserve0Usd = reserve0 * price0Usd;
        const reserve1Usd = reserve1 * price1Usd;

        const minReserve = Math.min(reserve0Usd, reserve1Usd);
        const maxReserve = Math.max(reserve0Usd, reserve1Usd);
        const balanceRatio = maxReserve > 0 ? minReserve / maxReserve : 0;
        if (balanceRatio < 0.3) return [];

        const sym0 = normalizeDexSymbol(pair.token0.symbol);
        const sym1 = normalizeDexSymbol(pair.token1.symbol);
        const pricedTokens = [
          { symbol: sym0, address: pair.token0.id, usdPrice: price0Usd },
          { symbol: sym1, address: pair.token1.id, usdPrice: price1Usd },
        ];

        const identity = buildPoolIdentity({
          chain,
          protocol: "aerodrome",
          poolAddressOrId: pair.id,
          tokenAddresses: [pair.token0.id, pair.token1.id],
          isStable: pair.isStable,
        });
        return mapTrackedSubgraphPriceObservations({
          chain,
          protocol: "aerodrome",
          tvl: reserveUSD,
          tokenEntries: pricedTokens,
          chainAddressToId,
          symbolToChainScopedIds,
          references,
          identity,
        });
      },
    }),
    handleResult: (lookups, _chain, result) => {
      mergeDexPriceObservationMap(lookups.aerodromePriceObs, result.observations);
    },
    buildChainSummary: (chain, result) =>
      `[dex-liquidity] Indexed ${result.entityCount} Aerodrome pairs from ${chain} subgraph (${result.observationCount} price obs)`,
    buildFinalSummary: (lookups) =>
      `[dex-liquidity] Collected ${lookups.aerodromePriceObs.size} coins with Aerodrome price observations, ` +
      `${lookups.aerodromeIsStable.size} pool stability flags, and ` +
      `${lookups.aerodromeV2ExecutionCandidates.size} classic volatile execution candidates`,
  });
}

export async function fetchUniswapV4Data(
  graphApiKey: string | null,
  signal?: AbortSignal,
): Promise<UniswapV4Lookups> {
  return runSubgraphFamily<UniswapV4SubgraphPool, UniswapV4Lookups>({
    graphApiKey,
    signal,
    subgraphs: UNISWAP_V4_SUBGRAPHS,
    missingApiKeyMessage:
      "[dex-liquidity] No GRAPH_API_KEY, skipping Uniswap V4 execution enrichment",
    familyLabel: "Uniswap V4 subgraph",
    createLookups: () => ({
      uniswapV4ExecutionCandidates: new Map(),
    }),
    buildConfig: (chain, subgraphUrl, combinedSignal, lookups) => ({
      subgraphUrl,
      sourceLabel: "Uniswap V4 subgraph",
      chain,
      buildQuery: (skip) => buildUniswapV4PoolQuery(skip),
      pageSize: UNISWAP_V4_POOL_PAGE_SIZE,
      maxPages: UNISWAP_V4_POOL_MAX_PAGES,
      signal: combinedSignal,
      extractEntities: (data) =>
        (data as { pools?: UniswapV4SubgraphPool[] } | undefined)?.pools,
      mapEntity: (pool) => {
        const poolId = pool.id.trim().toLowerCase();
        const hookAddress = pool.hooks.trim().toLowerCase();
        const feePips = parseSubgraphInteger(pool.feeTier);
        const tickSpacing = parseSubgraphInteger(pool.tickSpacing);
        const tvlUsd = Number.parseFloat(pool.totalValueLockedUSD);
        const token0Decimals = parseSubgraphInteger(pool.token0.decimals);
        const token1Decimals = parseSubgraphInteger(pool.token1.decimals);
        const token0Price = Number.parseFloat(pool.token0Price);
        const token1Price = Number.parseFloat(pool.token1Price);
        const executionKey = buildUniswapV4ExecutionCandidateKey(
          chain,
          [pool.token0.id, pool.token1.id],
          feePips,
        );
        if (
          executionKey &&
          /^0x[a-f0-9]{64}$/.test(poolId) &&
          /^0x[a-f0-9]{40}$/.test(hookAddress) &&
          Number.isInteger(tickSpacing) &&
          tickSpacing > 0 &&
          tickSpacing <= 32_767 &&
          Number.isFinite(tvlUsd) &&
          tvlUsd > 0 &&
          Number.isInteger(token0Decimals) &&
          token0Decimals >= 0 &&
          token0Decimals <= 255 &&
          Number.isInteger(token1Decimals) &&
          token1Decimals >= 0 &&
          token1Decimals <= 255 &&
          Number.isFinite(token0Price) &&
          token0Price > 0 &&
          Number.isFinite(token1Price) &&
          token1Price > 0
        ) {
          const candidates =
            lookups.uniswapV4ExecutionCandidates.get(executionKey) ?? [];
          candidates.push({
            chain,
            poolId: poolId as `0x${string}`,
            feePips,
            tickSpacing,
            hookAddress: hookAddress as `0x${string}`,
            tvlUsd,
            token0Price,
            token1Price,
            tokens: [
              {
                address: pool.token0.id,
                symbol: pool.token0.symbol,
                decimals: token0Decimals,
              },
              {
                address: pool.token1.id,
                symbol: pool.token1.symbol,
                decimals: token1Decimals,
              },
            ],
          });
          lookups.uniswapV4ExecutionCandidates.set(executionKey, candidates);
        }
        // V4 contributes execution identity only; retained-pool pricing remains
        // sourced from the established DEX-liquidity price surface.
        return [];
      },
    }),
    handleResult: () => {},
    buildChainSummary: (chain, result) =>
      `[dex-liquidity] Indexed ${result.entityCount} Uniswap V4 pools from ${chain} subgraph`,
    buildFinalSummary: (lookups) =>
      `[dex-liquidity] Collected ${lookups.uniswapV4ExecutionCandidates.size} Uniswap V4 execution candidate keys`,
  });
}
