import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { setCache } from "../../lib/db";
import { USER_AGENT, CIRCUIT_SOURCE } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import {
  fetchCgTokensBatch, onchainRateLimit, CG_CHAIN_MAP,
} from "../../lib/coingecko-onchain";
import { GT_CHAIN_MAP } from "../../lib/chain-registry";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { GT_API_BASE, isUsdReferenceSymbol, normalizeDexSymbol } from "../../lib/dex-constants";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import type {
  LlamaPool, CurvePool, CurvePoolEntry, DexPriceObs,
  DataSources, CurveLookups, UniV3Lookups, AerodromeLookups,
  GtToken,
} from "./types";
import {
  DEFILLAMA_YIELDS_URL, DEFILLAMA_PROTOCOLS_URL,
  CURVE_API_BASE, CURVE_CHAINS,
  UNIV3_SUBGRAPHS, UNIV3_POOL_QUERY,
  AERODROME_SUBGRAPHS, AERODROME_PAIR_QUERY,
} from "./constants";
import {
  normalizeProtocol, getTrackedContracts,
} from "./pool-helpers";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import { fetchSubgraphEntities, mergePriceObservations, type SubgraphPriceObservation } from "./subgraph-helpers";

/** Fetch DeFiLlama Yields, Protocols list, and Curve API data. Returns null only on truly catastrophic failure. */
export async function fetchDataSources(graphApiKey: string | null, db: D1Database, signal?: AbortSignal): Promise<DataSources | null> {
  const dlYieldsAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_YIELDS);
  const dlProtocolsAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_PROTOCOLS);

  // Fetch DL first, consume bodies immediately to release connections before Curve batch.
  // sync-yield-data runs concurrently on the same cron slot (10,40), sharing the
  // Workers 6-connection limit — consuming early leaves headroom.
  const [llamaRes, protocolsRes] = await Promise.all([
    dlYieldsAllowed
      ? fetchWithRetry(DEFILLAMA_YIELDS_URL, { headers: { "User-Agent": USER_AGENT }, signal })
      : Promise.resolve(null),
    dlProtocolsAllowed
      ? fetchWithRetry(DEFILLAMA_PROTOCOLS_URL, { headers: { "User-Agent": USER_AGENT }, signal })
      : Promise.resolve(null),
  ]);

  // --- DL Yields (consume body to release connection) ---
  let pools: LlamaPool[] = [];
  const fallbackDexProjects = new Set<string>();
  let dlYieldsAvailable = false;

  if (dlYieldsAllowed) {
    if (llamaRes?.ok) {
      const llamaData = (await llamaRes.json()) as { data: LlamaPool[] };
      if (llamaData.data && llamaData.data.length >= 1000) {
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, true);
        pools = llamaData.data;
        dlYieldsAvailable = true;
        for (const pool of pools) {
          if (!pool.project || pool.exposure === "single") continue;
          fallbackDexProjects.add(pool.project);
        }
        console.log(`[dex-liquidity] Got ${pools.length} pools from DeFiLlama yields`);

        // Cache minimal stablecoin pool data for yield sync (avoids redundant 13MB re-fetch)
        try {
          const minimalPools = pools
            .filter((p) => p.stablecoin && p.exposure === "single")
            .map((p) => ({
              pool: p.pool, project: p.project, symbol: p.symbol,
              tvlUsd: p.tvlUsd, apy: p.apy, apyBase: p.apyBase,
              apyReward: p.apyReward, stablecoin: true, exposure: "single",
              underlyingTokens: p.underlyingTokens ?? null,
            }));
          await setCache(db, "dl-stablecoin-pools", JSON.stringify(minimalPools));
        } catch (e) {
          console.warn("[dex-liquidity] Failed to cache stablecoin pools for yield sync:", e);
        }
      } else {
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
        console.warn(`[dex-liquidity] DeFiLlama returned only ${llamaData.data?.length ?? 0} pools — degraded mode`);
      }
    } else {
      console.warn("[dex-liquidity] DeFiLlama yields fetch failed — CG/GT will be primary pool source");
      await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
    }
  } else {
    console.warn("[dex-liquidity] DL yields circuit open — CG/GT will be primary pool source");
  }

  // --- DL Protocols (consume body to release connection) ---
  const dexProjects = new Set<string>();
  const protocolTvlCaps = new Map<string, number>();
  let dlProtocolsAvailable = false;

  if (dlProtocolsAllowed) {
    if (protocolsRes?.ok) {
      const protocols = (await protocolsRes.json()) as {
        slug: string;
        category?: string;
        tvl?: number | null;
        deadFrom?: number | null;
        rugged?: boolean | null;
        deprecated?: boolean | null;
      }[];
      for (const p of protocols) {
        if (p.category !== "Dexs") continue;
        if (p.deadFrom || p.rugged || p.deprecated) continue;
        dexProjects.add(p.slug);
        // Store TVL cap keyed by normalized protocol name for CG/GT pool sanity checks
        if (p.tvl && p.tvl > 0) {
          const norm = normalizeProtocol(p.slug);
          protocolTvlCaps.set(norm, (protocolTvlCaps.get(norm) ?? 0) + p.tvl);
        }
      }
      dlProtocolsAvailable = dexProjects.size > 0;
      await recordOutcome(db, CIRCUIT_SOURCE.DL_PROTOCOLS, dlProtocolsAvailable);
      if (dlProtocolsAvailable) {
        console.log(`[dex-liquidity] Indexed ${dexProjects.size} active DEX projects, ${protocolTvlCaps.size} with TVL caps`);
      } else {
        console.warn("[dex-liquidity] DeFiLlama protocols response had zero active DEX projects — degraded");
      }
    } else {
      console.warn("[dex-liquidity] DeFiLlama protocols fetch failed — dead-protocol filtering degraded");
      await recordOutcome(db, CIRCUIT_SOURCE.DL_PROTOCOLS, false);
    }
  } else {
    console.warn("[dex-liquidity] DL protocols circuit open — dead-protocol filtering degraded");
  }

  if (dexProjects.size === 0 && fallbackDexProjects.size > 0) {
    for (const project of fallbackDexProjects) dexProjects.add(project);
    console.warn(
      `[dex-liquidity] Using fallback DEX project set from yields (${dexProjects.size} projects) because protocol index is unavailable`,
    );
  }

  // Now safe to start Curve batch — DL connections are released (max 4 concurrent)
  const curveResponses = await Promise.all(
    CURVE_CHAINS.map((chain) =>
      fetchWithRetry(`${CURVE_API_BASE}/${chain}`, { headers: { "User-Agent": USER_AGENT }, signal }),
    ),
  );

  // Only abort if BOTH DL sources AND Curve all failed (truly catastrophic)
  if (!dlYieldsAvailable && curveResponses.every((r) => !r?.ok)) {
    console.error("[dex-liquidity] All pool data sources failed — aborting");
    return null;
  }

  return { pools, dexProjects, protocolTvlCaps, curveResponses, graphApiKey, dlYieldsAvailable, dlProtocolsAvailable };
}

/** Parse Curve API responses into pool lookup maps and per-token price observations. */
export async function buildCurveLookups(
  curveResponses: (Response | null)[],
  symbolToIds: Map<string, string[]>,
  addressToId: Map<string, string>,
): Promise<CurveLookups> {
  const curvePoolMap = new Map<string, CurvePoolEntry>();
  const priceObservations = new Map<string, DexPriceObs[]>();

  for (let i = 0; i < CURVE_CHAINS.length; i++) {
    const res = curveResponses[i];
    if (!res?.ok) continue;
    try {
      const json = (await res.json()) as { data?: { poolData?: CurvePool[] } };
      const curvePools = json.data?.poolData ?? [];
      for (const pool of curvePools) {
        if (!pool.coins || pool.coins.length < 2) continue;
        // v2: skip broken/deprecated pools
        if (pool.isBroken) continue;
        const A = parseInt(pool.amplificationCoefficient, 10);
        if (isNaN(A)) continue;

        // Compute balance ratio (min/max) — 1.0 = perfectly balanced
        const totalUsd = pool.coins.reduce((sum, c) => {
          const raw = parseFloat(c.poolBalance);
          const decimals = parseInt(c.decimals, 10);
          return sum + (isNaN(raw) || isNaN(decimals) ? 0 : raw / 10 ** decimals * (c.usdPrice || 1));
        }, 0);

        const balances = pool.coins.map((c) => {
          const raw = parseFloat(c.poolBalance);
          const decimals = parseInt(c.decimals, 10);
          return isNaN(raw) || isNaN(decimals) ? 0 : raw / 10 ** decimals * (c.usdPrice || 1);
        }).filter((b) => b > 0);

        let balanceRatio = 1;
        if (balances.length >= 2) {
          const minBal = balances.reduce((m, b) => Math.min(m, b), Infinity);
          const maxBal = balances.reduce((m, b) => Math.max(m, b), -Infinity);
          balanceRatio = maxBal > 0 ? minBal / maxBal : 0;
        }

        // v2: Per-token balance details + learn addresses for disambiguation
        const balanceDetails = pool.coins.map((c) => {
          const raw = parseFloat(c.poolBalance);
          const decimals = parseInt(c.decimals, 10);
          const usdBal = isNaN(raw) || isNaN(decimals) ? 0 : raw / 10 ** decimals * (c.usdPrice || 1);
          // Learn address→stablecoinId from unambiguous symbol matches
          if (c.address) {
            const sym = normalizeDexSymbol(c.symbol);
            const ids = symbolToIds.get(sym);
            if (ids && ids.length === 1) {
              addressToId.set(c.address.toLowerCase(), ids[0]);
            }
          }
          return {
            symbol: c.symbol,
            balancePct: totalUsd > 0 ? Math.round((usdBal / totalUsd) * 1000) / 10 : 0,
            isTracked: symbolToIds.has(normalizeDexSymbol(c.symbol)),
          };
        });

        // v2: Use metapool-adjusted TVL when available
        const metapoolAdjustedTvl =
          pool.basePoolAddress && pool.usdTotalExcludingBasePool > 0
            ? pool.usdTotalExcludingBasePool
            : pool.usdTotal;

        // Build a key from pool coins for matching
        const coinSymbols = pool.coins
          .map((c) => normalizeDexSymbol(c.symbol))
          .sort()
          .join("-");
        const entry: CurvePoolEntry = {
          A,
          balanceRatio,
          tvl: pool.usdTotal,
          registryId: pool.registryId ?? "",
          isMetaPool: pool.isMetaPool ?? false,
          metapoolAdjustedTvl,
          creationTs: pool.creationTs ?? 0,
          balanceDetails,
        };
        curvePoolMap.set(
          `${CURVE_CHAINS[i]}:${pool.address.toLowerCase()}`,
          entry,
        );
        // Also store by symbol combo for fallback matching
        curvePoolMap.set(
          `${CURVE_CHAINS[i]}:${coinSymbols}`,
          entry,
        );

        // Extract per-token price observations for DEX cross-validation
        // Filter: pool TVL >= $50K, balance ratio >= 0.3, coin has valid usdPrice
        if (metapoolAdjustedTvl >= 50_000 && balanceRatio >= 0.3) {
          for (const coin of pool.coins) {
            if (!coin.usdPrice || coin.usdPrice <= 0) continue;
            // Resolve stablecoin ID: prefer address match, fall back to symbol
            let resolvedIds: string[] | undefined;
            if (coin.address) {
              const addrId = addressToId.get(coin.address.toLowerCase());
              if (addrId) resolvedIds = [addrId];
            }
            if (!resolvedIds) {
              const sym = normalizeDexSymbol(coin.symbol);
              resolvedIds = symbolToIds.get(sym);
            }
            if (!resolvedIds) continue;
            for (const id of resolvedIds) {
              if (!isPlausibleDexObservationPrice(id, coin.usdPrice)) continue;
              const obs = priceObservations.get(id) ?? [];
              obs.push({
                price: coin.usdPrice,
                tvl: metapoolAdjustedTvl,
                chain: CURVE_CHAINS[i],
                protocol: "curve",
              });
              priceObservations.set(id, obs);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[dex-liquidity] Failed to parse Curve ${CURVE_CHAINS[i]}:`, err);
    }
  }
  console.log(`[dex-liquidity] Indexed ${curvePoolMap.size} Curve pools, ${priceObservations.size} coins with Curve price obs`);

  return { curvePoolMap, priceObservations };
}

type UniV3SubgraphPool = {
  id: string;
  token0: { id: string; symbol: string };
  token1: { id: string; symbol: string };
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

/** Fetch Uniswap V3 subgraph data for fee tier enrichment + price observations. Mutates addressToId with learned addresses. */
export async function fetchUniV3Data(
  graphApiKey: string | null,
  symbolToIds: Map<string, string[]>,
  addressToId: Map<string, string>,
  signal?: AbortSignal,
): Promise<UniV3Lookups> {
  const uniV3PoolFees = new Map<string, number>(); // "chain:address" → feeTier
  const uniV3SymbolFees = new Map<string, number>(); // "chain:SYM0:SYM1" → lowest feeTier
  const uniV3PriceObs = new Map<string, DexPriceObs[]>();

  if (!graphApiKey) {
    console.log("[dex-liquidity] No GRAPH_API_KEY, skipping Uni V3 subgraph enrichment");
    return { uniV3PoolFees, uniV3SymbolFees, uniV3PriceObs };
  }

  for (const [chain, subgraphId] of Object.entries(UNIV3_SUBGRAPHS)) {
    const subgraphUrl = `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`;
    const { entityCount, observationCount, observations, shouldLogIndex } = await fetchSubgraphEntities<UniV3SubgraphPool>({
      subgraphUrl,
      sourceLabel: "Uni V3 subgraph",
      chain,
      buildQuery: () => UNIV3_POOL_QUERY,
      signal,
      extractEntities: (data) => (data as { pools?: UniV3SubgraphPool[] } | undefined)?.pools,
      mapEntity: (pool) => {
        const feeTier = parseInt(pool.feeTier, 10);
        if (isNaN(feeTier)) return [];
        const tvl = parseFloat(pool.totalValueLockedUSD);

        // Address-based lookup
        uniV3PoolFees.set(`${chain}:${pool.id.toLowerCase()}`, feeTier);

        // Symbol-based fallback (keep lowest fee tier per pair = most optimized for stables)
        const syms = [normalizeDexSymbol(pool.token0.symbol), normalizeDexSymbol(pool.token1.symbol)].sort().join(":");
        const symKey = `${chain}:${syms}`;
        const existing = uniV3SymbolFees.get(symKey);
        if (existing == null || feeTier < existing) {
          uniV3SymbolFees.set(symKey, feeTier);
        }

        // Learn addresses for disambiguation from Uni V3 token data
        for (const tok of [pool.token0, pool.token1]) {
          const sym = normalizeDexSymbol(tok.symbol);
          const ids = symbolToIds.get(sym);
          if (ids?.length === 1 && tok.id) {
            addressToId.set(tok.id.toLowerCase(), ids[0]);
          }
        }

        // Only for pools with TVL >= $50K
        if (isNaN(tvl) || tvl < 50_000) return [];

        const token0Price = parseFloat(pool.token0Price); // token0 per token1
        const token1Price = parseFloat(pool.token1Price); // token1 per token0
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

        const mapped: SubgraphPriceObservation[] = [];
        for (const { symbol, address, usdPrice } of pricedTokens) {
          let resolvedIds: string[] | undefined;
          const addrId = addressToId.get(address.toLowerCase());
          if (addrId) resolvedIds = [addrId];
          if (!resolvedIds) resolvedIds = symbolToIds.get(symbol);
          if (!resolvedIds) continue;

          for (const stablecoinId of resolvedIds) {
            if (!isPlausibleDexObservationPrice(stablecoinId, usdPrice)) continue;
            mapped.push({
              stablecoinId,
              obs: { price: usdPrice, tvl, chain, protocol: "uniswap-v3" },
            });
          }
        }
        return mapped;
      },
    });

    mergePriceObservations(uniV3PriceObs, observations);
    if (shouldLogIndex) {
      console.log(`[dex-liquidity] Indexed ${entityCount} Uni V3 pools from ${chain} subgraph (${observationCount} price obs)`);
    }
  }

  console.log(`[dex-liquidity] Collected ${uniV3PriceObs.size} coins with Uni V3 price observations`);
  return { uniV3PoolFees, uniV3SymbolFees, uniV3PriceObs };
}

/** Fetch Aerodrome subgraph data for price observations and pool stability flags. */
export async function fetchAerodromeData(
  graphApiKey: string | null,
  symbolToIds: Map<string, string[]>,
  addressToId: Map<string, string>,
  signal?: AbortSignal,
): Promise<AerodromeLookups> {
  const priceObs = new Map<string, DexPriceObs[]>();
  const isStableMap = new Map<string, boolean>();

  if (!graphApiKey) return { aerodromePriceObs: priceObs, aerodromeIsStable: isStableMap };

  for (const [chain, subgraphId] of Object.entries(AERODROME_SUBGRAPHS)) {
    const subgraphUrl = `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`;
    const { entityCount, observationCount, observations, shouldLogIndex } = await fetchSubgraphEntities<AerodromeSubgraphPair>({
      subgraphUrl,
      sourceLabel: "Aerodrome subgraph",
      chain,
      buildQuery: () => AERODROME_PAIR_QUERY,
      signal,
      extractEntities: (data) => (data as { pairs?: AerodromeSubgraphPair[] } | undefined)?.pairs,
      mapEntity: (pair) => {
        const reserveUSD = parseFloat(pair.reserveUSD);
        if (isNaN(reserveUSD) || reserveUSD < 50_000) return [];

        // Store isStable flag for pool type refinement in processPoolMetrics
        isStableMap.set(`${chain}:${pair.id.toLowerCase()}`, pair.isStable);

        // Compute balance ratio from reserves in USD terms
        const reserve0 = parseFloat(pair.reserve0);
        const reserve1 = parseFloat(pair.reserve1);
        const token0Price = parseFloat(pair.token0Price); // token0 per token1
        const token1Price = parseFloat(pair.token1Price); // token1 per token0
        if (isNaN(reserve0) || isNaN(reserve1) || reserve0 <= 0 || reserve1 <= 0) return [];
        if (isNaN(token0Price) || isNaN(token1Price) || token0Price <= 0 || token1Price <= 0) return [];

        const denom = reserve0 * token1Price + reserve1;
        if (denom <= 0) return [];
        const price1Usd = reserveUSD / denom;
        const price0Usd = token1Price * price1Usd;
        const reserve0Usd = reserve0 * price0Usd;
        const reserve1Usd = reserve1 * price1Usd;

        // Balance ratio filter
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

        const mapped: SubgraphPriceObservation[] = [];
        for (const { symbol, address, usdPrice } of pricedTokens) {
          let resolvedIds: string[] | undefined;
          const addrId = addressToId.get(address.toLowerCase());
          if (addrId) resolvedIds = [addrId];
          if (!resolvedIds) resolvedIds = symbolToIds.get(symbol);
          if (!resolvedIds) continue;

          for (const stablecoinId of resolvedIds) {
            if (!isPlausibleDexObservationPrice(stablecoinId, usdPrice)) continue;
            mapped.push({
              stablecoinId,
              obs: { price: usdPrice, tvl: reserveUSD, chain, protocol: "aerodrome" },
            });
          }
        }
        return mapped;
      },
    });

    mergePriceObservations(priceObs, observations);
    if (shouldLogIndex) {
      console.log(`[dex-liquidity] Indexed ${entityCount} Aerodrome pairs from ${chain} subgraph (${observationCount} price obs)`);
    }
  }

  console.log(`[dex-liquidity] Collected ${priceObs.size} coins with Aerodrome price observations, ${isStableMap.size} pool stability flags`);
  return { aerodromePriceObs: priceObs, aerodromeIsStable: isStableMap };
}

/** Collect all pool addresses from existing sources for dedup against GT */
export function buildKnownPoolAddresses(
  pools: LlamaPool[],
  dexProjects: Set<string>,
  curvePoolMap: Map<string, CurvePoolEntry>,
  uniV3PoolFees: Map<string, number>,
  aerodromeIsStable: Map<string, boolean>,
): Set<string> {
  const known = new Set<string>();
  let fingerprintCount = 0;
  const enforceDexProjectFilter = dexProjects.size > 0;

  // DeFiLlama pools (all matched DEX pools)
  for (const pool of pools) {
    if (!pool.tvlUsd || pool.tvlUsd < 10_000) continue;
    if (enforceDexProjectFilter && !dexProjects.has(pool.project)) continue;
    if (pool.exposure === "single") continue;
    // UUID-based key (DL uses UUIDs, not on-chain addresses)
    const key = `${pool.chain.toLowerCase()}:${pool.pool.toLowerCase()}`;
    known.add(key);
    // Token-pair fingerprint so CG/GT pools (which use on-chain addresses)
    // can match against DL pools despite the UUID/address format mismatch.
    // Format: fp:<chain>:<normalized_protocol>:<sorted_token_addresses>
    if (pool.underlyingTokens && pool.underlyingTokens.length >= 2) {
      const chain = pool.chain.toLowerCase();
      const proto = normalizeProtocol(pool.project);
      const sorted = pool.underlyingTokens.map((t) => t.toLowerCase()).sort().join(":");
      known.add(`fp:${chain}:${proto}:${sorted}`);
      fingerprintCount++;
    }
  }

  // Curve pools (keyed as chain:address in the map)
  for (const key of curvePoolMap.keys()) {
    // curvePoolMap keys are "chain:address" or "chain:SYMBOL-COMBO"
    // Only keep address-based keys (those containing 0x)
    if (key.includes("0x")) known.add(key);
  }

  // UniV3 pools (keyed as chain:address in the fees map)
  for (const key of uniV3PoolFees.keys()) {
    known.add(key);
  }

  // Aerodrome pools (keyed as chain:address in the isStable map)
  for (const key of aerodromeIsStable.keys()) {
    known.add(key);
  }

  console.log(`[dex-liquidity] Built known pool set: ${known.size} entries (${fingerprintCount} token-pair fingerprints)`);
  return known;
}

export interface ProviderChainAddress {
  chain: string;
  address: string;
  stablecoinId: string;
}

/** Build provider chain → tracked token addresses map from canonical chain ids. */
export function buildChainAddresses(chainMap: Record<string, string>): Map<string, ProviderChainAddress[]> {
  const result = new Map<string, ProviderChainAddress[]>();
  for (const meta of TRACKED_STABLECOINS) {
    for (const c of getTrackedContracts(meta)) {
      const canonicalChain = c.chain.toLowerCase();
      const mappedChain = chainMap[canonicalChain];
      if (!mappedChain) continue;
      const list = result.get(mappedChain) ?? [];
      // Keep original case — Solana/Sui addresses are case-sensitive base58/base64
      // EVM addresses are case-insensitive so lowercasing at comparison time is safe.
      list.push({ chain: canonicalChain, address: c.address, stablecoinId: meta.id });
      result.set(mappedChain, list);
    }
  }
  return result;
}

/** Fetch token-level aggregate data from GT multi-token endpoint.
 *  Returns price observations (one per token per chain). */
export async function fetchGtTokenBatch(
  addressToId: Map<string, string>,
  signal?: AbortSignal,
  chainAddresses: Map<string, ProviderChainAddress[]> = buildChainAddresses(GT_CHAIN_MAP),
  deadlineMs?: number,
): Promise<Map<string, DexPriceObs[]>> {
  const priceObs = new Map<string, DexPriceObs[]>();
  let requestCount = 0;

  for (const [gtChain, tokens] of chainAddresses) {
    throwIfAborted(signal);

    // Batch into groups of 30 (GT limit for multi endpoint)
    for (let i = 0; i < tokens.length; i += 30) {
      if (deadlineMs && Date.now() >= deadlineMs) {
        console.log(`[dex-liquidity] GT token batch budget exhausted after ${requestCount} requests, yielding partial results`);
        return priceObs;
      }
      const batch = tokens.slice(i, i + 30);
      const addresses = batch.map((t) => t.address).join(",");

      if (requestCount > 0) {
        await sleepWithSignal(RATE_LIMITS.GECKO_TERMINAL_MS, signal);
      }
      requestCount++;

      try {
        const url = `${GT_API_BASE}/networks/${gtChain}/tokens/multi/${addresses}`;
        const res = await fetchWithRetry(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal,
        });
        if (!res?.ok) continue;

        const json = (await res.json()) as { data?: GtToken[] };
        if (!json.data) continue;

        for (const token of json.data) {
          const a = token.attributes;
          const addr = a.address.toLowerCase();
          const trackedToken = batch.find((t) => t.address.toLowerCase() === addr);
          const stablecoinId = trackedToken?.stablecoinId ?? addressToId.get(addr);
          if (!stablecoinId || !trackedToken) continue;

          const price = parseFloat(a.price_usd ?? "");
          const tvl = parseFloat(a.total_reserve_in_usd ?? "");
          if (!price || price <= 0 || isNaN(price)) continue;
          if (!isPlausibleDexObservationPrice(stablecoinId, price)) continue;
          if (!tvl || tvl < 50_000) continue;

          const obs = priceObs.get(stablecoinId) ?? [];
          obs.push({ price, tvl, chain: trackedToken.chain, protocol: "geckoterminal-aggregate" });
          priceObs.set(stablecoinId, obs);
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[dex-liquidity] GT token batch error for ${gtChain}:`, err);
      }
    }
  }

  console.log(`[dex-liquidity] GT token batch: ${priceObs.size} coins with price obs (${requestCount} requests)`);
  return priceObs;
}

/** Fetch token-level aggregate data from CoinGecko onchain multi-token endpoint.
 *  Returns price observations (one per token per chain). */
export async function fetchCgTokenBatchPrices(
  addressToId: Map<string, string>,
  signal?: AbortSignal,
  chainAddresses: Map<string, ProviderChainAddress[]> = buildChainAddresses(CG_CHAIN_MAP),
  deadlineMs?: number,
): Promise<Map<string, DexPriceObs[]>> {
  const priceObs = new Map<string, DexPriceObs[]>();
  let requestCount = 0;

  for (const [cgChain, tokens] of chainAddresses) {
    throwIfAborted(signal);

    // Batch into groups of 30 (CG limit for multi endpoint)
    for (let i = 0; i < tokens.length; i += 30) {
      if (deadlineMs && Date.now() >= deadlineMs) {
        console.log(`[dex-liquidity] CG token batch budget exhausted after ${requestCount} requests, yielding partial results`);
        return priceObs;
      }
      const batch = tokens.slice(i, i + 30);
      const addresses = batch.map((t) => t.address);

      await onchainRateLimit(requestCount, signal);
      requestCount++;

      try {
        const cgTokens = await fetchCgTokensBatch(cgChain, addresses, signal);
        for (const token of cgTokens) {
          const a = token.attributes;
          const addr = a.address.toLowerCase();
          const trackedToken = batch.find((t) => t.address.toLowerCase() === addr);
          const stablecoinId = trackedToken?.stablecoinId ?? addressToId.get(addr);
          if (!stablecoinId || !trackedToken) continue;

          const price = parseFloat(a.price_usd ?? "");
          const tvl = parseFloat(a.total_reserve_in_usd ?? "");
          if (!price || price <= 0 || isNaN(price)) continue;
          if (!isPlausibleDexObservationPrice(stablecoinId, price)) continue;
          if (!tvl || tvl < 50_000) continue;

          const obs = priceObs.get(stablecoinId) ?? [];
          obs.push({ price, tvl, chain: trackedToken.chain, protocol: "coingecko-aggregate" });
          priceObs.set(stablecoinId, obs);
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[dex-liquidity] CG token batch error for ${cgChain}:`, err);
      }
    }
  }

  console.log(`[dex-liquidity] CG token batch: ${priceObs.size} coins with price obs (${requestCount} requests)`);
  return priceObs;
}
