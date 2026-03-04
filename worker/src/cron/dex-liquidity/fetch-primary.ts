import { TRACKED_STABLECOINS } from "../../../../src/lib/stablecoins";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { setCache } from "../../lib/db";
import { USER_AGENT, CIRCUIT_SOURCE } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import {
  fetchCgTokensBatch, onchainRateLimit,
} from "../../lib/coingecko-onchain";
import { GT_CHAIN_REVERSE } from "../../lib/chain-registry";
import { RATE_LIMITS } from "../../lib/rate-limits";
import { GT_API_BASE, USD_REFERENCE_SYMBOLS } from "../../lib/dex-constants";
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
import { normalizeProtocol, getActiveChainMap, getActiveChainReverse } from "./pool-helpers";

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
            const sym = c.symbol.toUpperCase();
            const ids = symbolToIds.get(sym);
            if (ids && ids.length === 1) {
              addressToId.set(c.address.toLowerCase(), ids[0]);
            }
          }
          return {
            symbol: c.symbol,
            balancePct: totalUsd > 0 ? Math.round((usdBal / totalUsd) * 1000) / 10 : 0,
            isTracked: symbolToIds.has(c.symbol.toUpperCase()),
          };
        });

        // v2: Use metapool-adjusted TVL when available
        const metapoolAdjustedTvl =
          pool.basePoolAddress && pool.usdTotalExcludingBasePool > 0
            ? pool.usdTotalExcludingBasePool
            : pool.usdTotal;

        // Build a key from pool coins for matching
        const coinSymbols = pool.coins
          .map((c) => c.symbol.toUpperCase())
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
              const sym = coin.symbol.toUpperCase();
              resolvedIds = symbolToIds.get(sym);
            }
            if (!resolvedIds) continue;
            for (const id of resolvedIds) {
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
    try {
      const url = `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`;
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query: UNIV3_POOL_QUERY }),
        signal,
      });
      if (!res?.ok) {
        console.warn(`[dex-liquidity] Uni V3 subgraph failed for ${chain}: ${res?.status}`);
        continue;
      }
      const json = (await res.json()) as {
        data?: {
          pools?: {
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
          }[];
        };
        errors?: { message: string }[];
      };
      if (json.errors?.length) {
        console.warn(`[dex-liquidity] Uni V3 subgraph GraphQL errors for ${chain}:`, json.errors.map((e) => e.message).join("; "));
        if (!json.data?.pools?.length) continue;
      }
      const subPools = json.data?.pools ?? [];
      let priceObsCount = 0;
      for (const p of subPools) {
        const feeTier = parseInt(p.feeTier, 10);
        if (isNaN(feeTier)) continue;
        const tvl = parseFloat(p.totalValueLockedUSD);
        // Address-based lookup
        uniV3PoolFees.set(`${chain}:${p.id.toLowerCase()}`, feeTier);
        // Symbol-based fallback (keep lowest fee tier per pair = most optimized for stables)
        const syms = [p.token0.symbol.toUpperCase(), p.token1.symbol.toUpperCase()].sort().join(":");
        const symKey = `${chain}:${syms}`;
        const existing = uniV3SymbolFees.get(symKey);
        if (existing == null || feeTier < existing) {
          uniV3SymbolFees.set(symKey, feeTier);
        }
        // Learn addresses for disambiguation from Uni V3 token data
        for (const tok of [p.token0, p.token1]) {
          const sym = tok.symbol.toUpperCase();
          const ids = symbolToIds.get(sym);
          if (ids?.length === 1 && tok.id) {
            addressToId.set(tok.id.toLowerCase(), ids[0]);
          }
        }

        // --- Price observations from Uni V3 pools ---
        // Only for pools with TVL >= $50K
        if (isNaN(tvl) || tvl < 50_000) continue;

        const token0Price = parseFloat(p.token0Price); // token0 per token1
        const token1Price = parseFloat(p.token1Price); // token1 per token0
        if (isNaN(token0Price) || isNaN(token1Price) || token0Price <= 0 || token1Price <= 0) continue;

        const sym0 = p.token0.symbol.toUpperCase();
        const sym1 = p.token1.symbol.toUpperCase();
        const isRef0 = USD_REFERENCE_SYMBOLS.has(sym0);
        const isRef1 = USD_REFERENCE_SYMBOLS.has(sym1);

        // If neither side is a known USD reference, skip (can't derive USD price reliably)
        if (!isRef0 && !isRef1) continue;

        // Derive USD prices: if token1 is a USD ref (~$1), token0's USD price ≈ token1Price (units of token1 per token0) × $1
        // token0Price = how many token0 you get per token1
        // token1Price = how many token1 you get per token0
        // So: token0 USD price = token1Price × $1 (when token1 is USD ref)
        //     token1 USD price = token0Price × $1 (when token0 is USD ref)
        const pairs: { symbol: string; address: string; usdPrice: number }[] = [];
        if (isRef1) {
          // token1 is a USD reference, so token0's price = token1Price × ~$1
          pairs.push({ symbol: sym0, address: p.token0.id, usdPrice: token1Price });
        }
        if (isRef0) {
          // token0 is a USD reference, so token1's price = token0Price × ~$1
          pairs.push({ symbol: sym1, address: p.token1.id, usdPrice: token0Price });
        }

        for (const { symbol, address, usdPrice } of pairs) {
          // Resolve to tracked stablecoin ID
          let resolvedIds: string[] | undefined;
          const addrId = addressToId.get(address.toLowerCase());
          if (addrId) resolvedIds = [addrId];
          if (!resolvedIds) resolvedIds = symbolToIds.get(symbol);
          if (!resolvedIds) continue;

          // Basic sanity check: USD-pegged stablecoins should be near $1
          if (usdPrice < 0.5 || usdPrice > 2.0) continue;

          for (const id of resolvedIds) {
            const obs = uniV3PriceObs.get(id) ?? [];
            obs.push({ price: usdPrice, tvl, chain, protocol: "uniswap-v3" });
            uniV3PriceObs.set(id, obs);
            priceObsCount++;
          }
        }
      }
      console.log(`[dex-liquidity] Indexed ${subPools.length} Uni V3 pools from ${chain} subgraph (${priceObsCount} price obs)`);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[dex-liquidity] Uni V3 subgraph error for ${chain}:`, err);
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
    try {
      const url = `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`;
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query: AERODROME_PAIR_QUERY }),
        signal,
      });
      if (!res?.ok) {
        console.warn(`[dex-liquidity] Aerodrome subgraph failed for ${chain}: ${res?.status}`);
        continue;
      }
      const json = (await res.json()) as {
        data?: {
          pairs?: {
            id: string;
            token0: { id: string; symbol: string };
            token1: { id: string; symbol: string };
            reserve0: string;
            reserve1: string;
            reserveUSD: string;
            token0Price: string;
            token1Price: string;
            isStable: boolean;
          }[];
        };
        errors?: { message: string }[];
      };
      if (json.errors?.length) {
        console.warn(`[dex-liquidity] Aerodrome subgraph GraphQL errors for ${chain}:`, json.errors.map((e) => e.message).join("; "));
        if (!json.data?.pairs?.length) continue;
      }
      const pairs = json.data?.pairs ?? [];
      let obsCount = 0;
      for (const pair of pairs) {
        const reserveUSD = parseFloat(pair.reserveUSD);
        if (isNaN(reserveUSD) || reserveUSD < 50_000) continue;

        // Store isStable flag for pool type refinement in processPoolMetrics
        isStableMap.set(`${chain}:${pair.id.toLowerCase()}`, pair.isStable);

        // Compute balance ratio from reserves in USD terms
        const reserve0 = parseFloat(pair.reserve0);
        const reserve1 = parseFloat(pair.reserve1);
        const token0Price = parseFloat(pair.token0Price); // token0 per token1
        const token1Price = parseFloat(pair.token1Price); // token1 per token0
        if (isNaN(reserve0) || isNaN(reserve1) || reserve0 <= 0 || reserve1 <= 0) continue;
        if (isNaN(token0Price) || isNaN(token1Price) || token0Price <= 0 || token1Price <= 0) continue;

        // Approximate USD values: each reserve is half of reserveUSD in a balanced pool
        // More precisely: reserveUSD = reserve0 × price0_usd + reserve1 × price1_usd
        // We can infer: price0_usd = token1Price × price1_usd, and reserveUSD = reserve0 × token1Price × price1_usd + reserve1 × price1_usd
        // => price1_usd = reserveUSD / (reserve0 × token1Price + reserve1)
        const denom = reserve0 * token1Price + reserve1;
        if (denom <= 0) continue;
        const price1Usd = reserveUSD / denom;
        const price0Usd = token1Price * price1Usd;
        const reserve0Usd = reserve0 * price0Usd;
        const reserve1Usd = reserve1 * price1Usd;

        // Balance ratio filter
        const minReserve = Math.min(reserve0Usd, reserve1Usd);
        const maxReserve = Math.max(reserve0Usd, reserve1Usd);
        const balanceRatio = maxReserve > 0 ? minReserve / maxReserve : 0;
        if (balanceRatio < 0.3) continue;

        const sym0 = pair.token0.symbol.toUpperCase();
        const sym1 = pair.token1.symbol.toUpperCase();

        // Extract price observations for tracked stablecoins
        const tokens = [
          { symbol: sym0, address: pair.token0.id, usdPrice: price0Usd },
          { symbol: sym1, address: pair.token1.id, usdPrice: price1Usd },
        ];
        for (const { symbol, address, usdPrice } of tokens) {
          if (usdPrice < 0.5 || usdPrice > 2.0) continue; // sanity for USD pegs
          let resolvedIds: string[] | undefined;
          const addrId = addressToId.get(address.toLowerCase());
          if (addrId) resolvedIds = [addrId];
          if (!resolvedIds) resolvedIds = symbolToIds.get(symbol);
          if (!resolvedIds) continue;

          for (const id of resolvedIds) {
            const obs = priceObs.get(id) ?? [];
            obs.push({ price: usdPrice, tvl: reserveUSD, chain, protocol: "aerodrome" });
            priceObs.set(id, obs);
            obsCount++;
          }
        }
      }
      console.log(`[dex-liquidity] Indexed ${pairs.length} Aerodrome pairs from ${chain} subgraph (${obsCount} price obs)`);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[dex-liquidity] Aerodrome subgraph error for ${chain}:`, err);
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

/** Build chain → addresses map from TRACKED_STABLECOINS contracts, filtered to supported chains */
export function buildChainAddresses(): Map<string, { address: string; stablecoinId: string }[]> {
  const chainMap = getActiveChainMap();
  const result = new Map<string, { address: string; stablecoinId: string }[]>();
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts) continue;
    for (const c of meta.contracts) {
      const mappedChain = chainMap[c.chain.toLowerCase()];
      if (!mappedChain) continue;
      const list = result.get(mappedChain) ?? [];
      // Keep original case — Solana/Sui addresses are case-sensitive base58/base64
      // EVM addresses are case-insensitive so lowercasing at comparison time is safe.
      list.push({ address: c.address, stablecoinId: meta.id });
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
): Promise<Map<string, DexPriceObs[]>> {
  const priceObs = new Map<string, DexPriceObs[]>();
  const chainAddresses = buildChainAddresses();
  let requestCount = 0;

  for (const [gtChain, tokens] of chainAddresses) {
    throwIfAborted(signal);
    const ourChain = GT_CHAIN_REVERSE[gtChain] ?? gtChain;

    // Batch into groups of 30 (GT limit for multi endpoint)
    for (let i = 0; i < tokens.length; i += 30) {
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
          const stablecoinId = batch.find((t) => t.address.toLowerCase() === addr)?.stablecoinId
            ?? addressToId.get(addr);
          if (!stablecoinId) continue;

          const price = parseFloat(a.price_usd ?? "");
          const tvl = parseFloat(a.total_reserve_in_usd ?? "");
          if (!price || price <= 0 || isNaN(price)) continue;
          if (price < 0.5 || price > 2.0) continue; // USD peg sanity
          if (!tvl || tvl < 50_000) continue;

          const obs = priceObs.get(stablecoinId) ?? [];
          obs.push({ price, tvl, chain: ourChain, protocol: "geckoterminal-aggregate" });
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
): Promise<Map<string, DexPriceObs[]>> {
  const priceObs = new Map<string, DexPriceObs[]>();
  const chainAddresses = buildChainAddresses();
  let requestCount = 0;

  for (const [cgChain, tokens] of chainAddresses) {
    throwIfAborted(signal);
    const ourChain = getActiveChainReverse()[cgChain] ?? cgChain;

    // Batch into groups of 30 (CG limit for multi endpoint)
    for (let i = 0; i < tokens.length; i += 30) {
      const batch = tokens.slice(i, i + 30);
      const addresses = batch.map((t) => t.address);

      await onchainRateLimit(requestCount, signal);
      requestCount++;

      try {
        const cgTokens = await fetchCgTokensBatch(cgChain, addresses, signal);
        for (const token of cgTokens) {
          const a = token.attributes;
          const addr = a.address.toLowerCase();
          const stablecoinId = batch.find((t) => t.address.toLowerCase() === addr)?.stablecoinId
            ?? addressToId.get(addr);
          if (!stablecoinId) continue;

          const price = parseFloat(a.price_usd ?? "");
          const tvl = parseFloat(a.total_reserve_in_usd ?? "");
          if (!price || price <= 0 || isNaN(price)) continue;
          if (price < 0.5 || price > 2.0) continue; // USD peg sanity
          if (!tvl || tvl < 50_000) continue;

          const obs = priceObs.get(stablecoinId) ?? [];
          obs.push({ price, tvl, chain: ourChain, protocol: "coingecko-aggregate" });
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
