import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { isUsdReferenceSymbol, normalizeDexSymbol } from "../../lib/dex-cron-constants";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import { fetchSubgraphEntities, mergeDexPriceObservationMap, type SubgraphPriceObservation } from "./subgraph-helpers";
import type {
  DexPriceObs,
  UniswapV4Lookups,
  UniV3Lookups,
} from "./types";
import {
  UNIV3_BASE_POOL_MAX_PAGES,
  UNIV3_MESSARI_SCHEMA_CHAINS,
  UNIV3_POOL_MAX_PAGES,
  UNIV3_POOL_PAGE_SIZE,
  UNIV3_SUBGRAPHS,
  UNISWAP_V4_POOL_MAX_PAGES,
  UNISWAP_V4_POOL_PAGE_SIZE,
  UNISWAP_V4_SUBGRAPHS,
  UNIV3_POOL_MIN_TVL_USD,
  buildUniswapV4PoolQuery,
  buildUniswapV4ExactPoolQuery,
  SUBGRAPH_PER_CHAIN_TIMEOUT_MS,
  buildUniV3MessariPoolQuery,
  buildUniV3PoolQuery,
} from "./constants";
import { buildDexPriceObservationIdentity, buildPoolIdentity } from "./pool-identity";
import { resolveTrackedStablecoinId } from "./token-resolution";
import { runSubgraphFamily, type SubgraphFamilyResult } from "./subgraph-family-runner";
import {
  buildUniswapV4ExecutionCandidateKey,
  buildUniV3ExecutionCandidateKey,
} from "../measured-execution/inventory";
import type { UniswapV4ExecutionCandidate } from "../measured-execution/candidate-types";
import { computeUniswapV4PoolId } from "../measured-execution/uniswap-v4";

type UniV3SubgraphPool = {
  id: string;
  token0: { id: string; symbol: string; decimals: string };
  token1: { id: string; symbol: string; decimals: string };
  feeTier: string;
  totalValueLockedUSD: string;
  token0Price: string;
  token1Price: string;
};

type UniV3MessariSubgraphPool = {
  id: string;
  inputTokens?: { id: string; symbol: string; decimals: number | string }[] | null;
  inputTokenBalances?: string[] | null;
  fees?: { feeType: string; feePercentage: string | null }[] | null;
  tick?: string | null;
  totalValueLockedUSD: string;
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
const UNIV3_MAX_ABS_TICK = 887_272;

function parseSubgraphInteger(value: string): number {
  const normalized = value.trim();
  if (!/^-?[0-9]+$/.test(normalized)) return Number.NaN;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function parseRawTokenAmount(raw: string | undefined, decimals: number): number {
  if (raw == null || !/^[0-9]+$/.test(raw.trim())) return Number.NaN;
  return Number(raw.trim()) / Math.pow(10, decimals);
}

/**
 * Maps one Messari-standard Uniswap V3 pool to the native pool shape, or null
 * when the row cannot be read unambiguously or sits below
 * `UNIV3_POOL_MIN_TVL_USD`. `inputTokens` must be the canonical
 * `[token0, token1]` pair (strictly ascending addresses), the fee tier is the
 * `FIXED_TRADING_FEE` percentage in pips, and both spot prices come from
 * `tick`: token1 per token0 = 1.0001^tick * 10^(decimals0 - decimals1). The
 * tick is the floor of the log spot price, so the derived spot sits within
 * 1 bp below the pool's sqrtPrice spot.
 *
 * The deployment's own USD valuations are unreliable (USD₮ ~$4.84, USDC $0 on
 * Celo, 2026-09-28), so a pool with a USD-reference side is valued from
 * `inputTokenBalances` in reference units at the tick spot; that TVL gates and
 * weights the price observations, which only exist for such pools. A pool
 * without a USD-reference side keeps the deployment's `totalValueLockedUSD`,
 * which then only gates fee enrichment and the execution candidate (Uni V3
 * targets never read the candidate TVL magnitude).
 */
function normalizeMessariUniV3Pool(pool: UniV3MessariSubgraphPool): UniV3SubgraphPool | null {
  const inputTokens = pool.inputTokens;
  if (!inputTokens || inputTokens.length !== 2) return null;
  const [token0, token1] = inputTokens;
  if (token0.id.toLowerCase() >= token1.id.toLowerCase()) return null;

  const tradingFee = pool.fees?.find((fee) => fee.feeType === "FIXED_TRADING_FEE");
  const feePips = Math.round(Number(tradingFee?.feePercentage) * 10_000);
  if (!Number.isSafeInteger(feePips) || feePips <= 0) return null;

  const tick = pool.tick == null ? Number.NaN : parseSubgraphInteger(pool.tick);
  if (!Number.isInteger(tick) || Math.abs(tick) > UNIV3_MAX_ABS_TICK) return null;

  const token0Decimals = parseSubgraphInteger(String(token0.decimals));
  const token1Decimals = parseSubgraphInteger(String(token1.decimals));
  if (
    !Number.isInteger(token0Decimals) || token0Decimals < 0 || token0Decimals > 255 ||
    !Number.isInteger(token1Decimals) || token1Decimals < 0 || token1Decimals > 255
  ) return null;
  const token1PerToken0 = Math.pow(1.0001, tick) * Math.pow(10, token0Decimals - token1Decimals);
  if (!Number.isFinite(token1PerToken0) || token1PerToken0 <= 0) return null;

  let tvl: number;
  if (isUsdReferenceSymbol(token0.symbol) || isUsdReferenceSymbol(token1.symbol)) {
    const balance0 = parseRawTokenAmount(pool.inputTokenBalances?.[0], token0Decimals);
    const balance1 = parseRawTokenAmount(pool.inputTokenBalances?.[1], token1Decimals);
    tvl = isUsdReferenceSymbol(token0.symbol)
      ? balance0 + balance1 / token1PerToken0
      : balance1 + balance0 * token1PerToken0;
  } else {
    tvl = Number(pool.totalValueLockedUSD);
  }
  if (!Number.isFinite(tvl) || tvl < UNIV3_POOL_MIN_TVL_USD) return null;

  return {
    id: pool.id,
    token0: { id: token0.id, symbol: token0.symbol, decimals: String(token0Decimals) },
    token1: { id: token1.id, symbol: token1.symbol, decimals: String(token1Decimals) },
    feeTier: String(feePips),
    totalValueLockedUSD: String(tvl),
    token0Price: String(1 / token1PerToken0),
    token1Price: String(token1PerToken0),
  };
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
        ...buildDexPriceObservationIdentity(identity),
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
  return runSubgraphFamily<UniV3SubgraphPool | null, UniV3Lookups>({
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
    buildConfig: (chain, subgraphUrl, combinedSignal, lookups) => {
      const messariSchema = UNIV3_MESSARI_SCHEMA_CHAINS[chain] === true;
      return {
        subgraphUrl,
        sourceLabel: "Uni V3 subgraph",
        chain,
        buildQuery: (skip) => (messariSchema ? buildUniV3MessariPoolQuery(skip) : buildUniV3PoolQuery(skip)),
        pageSize: UNIV3_POOL_PAGE_SIZE,
        maxPages: chain === "base" ? UNIV3_BASE_POOL_MAX_PAGES : UNIV3_POOL_MAX_PAGES,
        signal: combinedSignal,
        // Messari rows normalize 1:1 (null when unreadable) so the page length
        // still drives pagination.
        extractEntities: (data) => (messariSchema
          ? (data as { liquidityPools?: UniV3MessariSubgraphPool[] } | undefined)?.liquidityPools
            ?.map((pool) => normalizeMessariUniV3Pool(pool))
          : (data as { pools?: UniV3SubgraphPool[] } | undefined)?.pools),
        mapEntity: (pool) => {
          if (!pool) return [];
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
      };
    },
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
  exactPoolIdsByChain: ReadonlyMap<string, readonly string[]>,
  signal?: AbortSignal,
): Promise<SubgraphFamilyResult<UniswapV4Lookups>> {
  const result = await runSubgraphFamily<UniswapV4SubgraphPool, UniswapV4Lookups>({
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
        const candidate = normalizeExactUniswapV4Pool(chain, pool);
        if (candidate && candidate.tvlUsd > 0) {
          const executionKey = buildUniswapV4ExecutionCandidateKey(
            chain, candidate.tokens.map((token) => token.address), candidate.feePips,
          )!;
          const candidates = lookups.uniswapV4ExecutionCandidates.get(executionKey) ?? [];
          candidates.push(candidate);
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
  if (!graphApiKey) return result;

  // Exact requests start only after the broad family has drained. Every batch
  // uses the existing bounded, body-consuming transport before the next opens.
  for (const [chain, subgraphId] of Object.entries(UNISWAP_V4_SUBGRAPHS)) {
    const poolIds = [...new Set(exactPoolIdsByChain.get(chain) ?? [])];
    if (poolIds.length === 0) continue;
    const requested = new Set(poolIds);
    // Current exact evidence is authoritative: missing/invalid rows cannot be
    // rescued by a broad-scan copy of the same physical identity.
    for (const [key, candidates] of result.uniswapV4ExecutionCandidates) {
      const remaining = candidates.filter((candidate) =>
        candidate.chain !== chain || !requested.has(candidate.poolId));
      if (remaining.length) result.uniswapV4ExecutionCandidates.set(key, remaining);
      else result.uniswapV4ExecutionCandidates.delete(key);
    }
    const seen = new Map<string, UniswapV4ExecutionCandidate>();
    const conflicted = new Set<string>();
    const timeout = AbortSignal.timeout(SUBGRAPH_PER_CHAIN_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    for (let offset = 0; offset < poolIds.length; offset += 100) {
      const batch = poolIds.slice(offset, offset + 100);
      const batchIds = new Set(batch);
      const fetched = await fetchSubgraphEntities<UniswapV4SubgraphPool>({
        subgraphUrl: `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`,
        sourceLabel: "Uniswap V4 exact subgraph",
        chain,
        signal: combinedSignal,
        buildQuery: () => buildUniswapV4ExactPoolQuery(batch),
        extractEntities: (data) =>
          (data as { pools?: UniswapV4SubgraphPool[] } | undefined)?.pools,
        mapEntity: (pool) => {
          const id = typeof pool?.id === "string" ? pool.id.trim().toLowerCase() : "";
          if (!batchIds.has(id) || conflicted.has(id)) return [];
          const candidate = normalizeExactUniswapV4Pool(chain, pool);
          const prior = seen.get(id);
          if (!candidate || computeUniswapV4PoolId({
            currency0: candidate.tokens[0].address as `0x${string}`,
            currency1: candidate.tokens[1].address as `0x${string}`,
            feePips: candidate.feePips, tickSpacing: candidate.tickSpacing,
            hookAddress: candidate.hookAddress,
          }) !== id || (prior && JSON.stringify(prior) !== JSON.stringify(candidate))) {
            conflicted.add(id);
            seen.delete(id);
          } else {
            seen.set(id, candidate);
          }
          return [];
        },
      }).catch((error: unknown) => {
        if (signal?.aborted) throw error;
        return { failed: true, failureReason: "http" as const };
      });
      if (fetched.failed) {
        if (!result.failedChains.includes(chain)) result.failedChains.push(chain);
        result.failedChainReasons[chain] = fetched.failureReason ?? "http";
        break;
      }
    }
    for (const candidate of seen.values()) {
      const key = buildUniswapV4ExecutionCandidateKey(
        chain, candidate.tokens.map((token) => token.address), candidate.feePips,
      )!;
      const candidates = result.uniswapV4ExecutionCandidates.get(key) ?? [];
      candidates.push(candidate);
      result.uniswapV4ExecutionCandidates.set(key, candidates);
    }
  }
  return result;
}

function isReadableUniswapV4Pool(pool: UniswapV4SubgraphPool): boolean {
  return pool != null &&
    [pool.id, pool.hooks, pool.feeTier, pool.tickSpacing, pool.liquidity,
      pool.totalValueLockedUSD, pool.token0Price, pool.token1Price,
      pool.token0?.id, pool.token0?.symbol, pool.token0?.decimals,
      pool.token1?.id, pool.token1?.symbol, pool.token1?.decimals]
      .every((field) => typeof field === "string" && field.trim().length > 0);
}

function normalizeExactUniswapV4Pool(
  chain: string,
  pool: UniswapV4SubgraphPool,
): UniswapV4ExecutionCandidate | null {
  if (!isReadableUniswapV4Pool(pool)) return null;
  const poolId = pool.id.trim().toLowerCase();
  const hookAddress = canonicalEvmAddress(pool.hooks);
  const feePips = parseSubgraphInteger(pool.feeTier);
  const tickSpacing = parseSubgraphInteger(pool.tickSpacing);
  const tvlUsd = Number(pool.totalValueLockedUSD);
  const token0Price = Number(pool.token0Price);
  const token1Price = Number(pool.token1Price);
  const tokens = [pool.token0, pool.token1].map((token) => ({
    address: canonicalEvmAddress(token.id),
    symbol: token.symbol,
    decimals: parseSubgraphInteger(token.decimals),
  }));
  if (
    !/^0x[a-f0-9]{64}$/.test(poolId) || !hookAddress ||
    !buildUniswapV4ExecutionCandidateKey(chain, tokens.map((token) => token.address ?? ""), feePips) ||
    !Number.isInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing > 32_767 ||
    !/^[0-9]+$/.test(pool.liquidity.trim()) || !Number.isFinite(tvlUsd) ||
    !Number.isFinite(token0Price) || token0Price <= 0 ||
    !Number.isFinite(token1Price) || token1Price <= 0 ||
    tokens.some((token) => !token.address || !Number.isInteger(token.decimals) ||
      token.decimals < 0 || token.decimals > 255)
  ) return null;
  return {
    chain, poolId: poolId as `0x${string}`, hookAddress: hookAddress as `0x${string}`,
    feePips, tickSpacing, activeLiquidity: pool.liquidity.trim(), tvlUsd,
    token0Price, token1Price,
    tokens: tokens as [{ address: string; symbol: string; decimals: number }, { address: string; symbol: string; decimals: number }],
  };
}
