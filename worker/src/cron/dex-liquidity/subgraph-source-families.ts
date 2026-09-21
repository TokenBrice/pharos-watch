import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { isUsdReferenceSymbol, normalizeDexSymbol } from "../../lib/dex-cron-constants";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import { mergeDexPriceObservationMap, type SubgraphPriceObservation } from "./subgraph-helpers";
import type {
  DexPriceObs,
  UniswapV4Lookups,
  UniV3Lookups,
} from "./types";
import {
  UNIV3_POOL_MAX_PAGES,
  UNIV3_POOL_PAGE_SIZE,
  UNIV3_SUBGRAPHS,
  UNISWAP_V4_POOL_MAX_PAGES,
  UNISWAP_V4_POOL_PAGE_SIZE,
  UNISWAP_V4_SUBGRAPHS,
  buildUniswapV4PoolQuery,
  buildUniV3PoolQuery,
} from "./constants";
import { buildPoolIdentity } from "./pool-identity";
import { resolveTrackedStablecoinId } from "./token-resolution";
import { runSubgraphFamily, type SubgraphFamilyResult } from "./subgraph-family-runner";
import {
  buildUniswapV4ExecutionCandidateKey,
  buildUniV3ExecutionCandidateKey,
} from "../measured-execution/inventory";

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

type UniswapV4SubgraphPool = {
  id: string;
  token0: { id: string; symbol: string; decimals: string };
  token1: { id: string; symbol: string; decimals: string };
  feeTier: string;
  tickSpacing: string;
  hooks: string;
  liquidity: string;
  totalValueLockedUSD: string;
  token0Price: string;
  token1Price: string;
};

const UNIV3_EXECUTION_ONLY_CHAINS = new Set(["bsc"]);

function parseSubgraphInteger(value: string): number {
  const normalized = value.trim();
  if (!/^-?[0-9]+$/.test(normalized)) return Number.NaN;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function mapTrackedSubgraphPriceObservations(config: {
  chain: string;
  protocol: "uniswap-v3";
  tvl: number;
  tokenEntries: Array<{ symbol: string; address: string; usdPrice: number; tvl?: number }>;
  chainAddressToId: Map<string, string>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  references?: PriceValidationReferences;
  identity: ReturnType<typeof buildPoolIdentity>;
}): SubgraphPriceObservation[] {
  const mapped: SubgraphPriceObservation[] = [];
  const { chain, protocol, tvl, tokenEntries, chainAddressToId, symbolToChainScopedIds, references, identity } = config;

  for (const { symbol, address, usdPrice, tvl: observationTvl } of tokenEntries) {
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
        tvl: observationTvl ?? tvl,
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
): Promise<SubgraphFamilyResult<UniV3Lookups>> {
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
        const executionOnly = UNIV3_EXECUTION_ONLY_CHAINS.has(chain);

        if (!executionOnly) {
          lookups.uniV3PoolFees.set(`${chain}:${pool.id.toLowerCase()}`, feeTier);

          const syms = [normalizeDexSymbol(pool.token0.symbol), normalizeDexSymbol(pool.token1.symbol)].sort().join(":");
          const symKey = `${chain}:${syms}`;
          const existing = lookups.uniV3SymbolFees.get(symKey);
          if (existing == null || feeTier < existing) {
            lookups.uniV3SymbolFees.set(symKey, feeTier);
          }
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

        // BSC is a shadow measured-execution source. Until a later activation
        // review, its subgraph rows cannot alter fee-quality enrichment or DEX
        // price consensus.
        if (executionOnly) return [];

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

export async function fetchUniswapV4Data(
  graphApiKey: string | null,
  signal?: AbortSignal,
): Promise<SubgraphFamilyResult<UniswapV4Lookups>> {
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
        const activeLiquidity = pool.liquidity.trim();
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
          /^[0-9]+$/.test(activeLiquidity) &&
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
            activeLiquidity,
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
