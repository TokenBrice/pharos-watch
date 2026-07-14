import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { setCache } from "../../lib/db-cache";
import { USER_AGENT, CIRCUIT_SOURCE, DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { buildDlStablecoinPoolsCache } from "../yield-sync/cache";
import { isYieldRelevantDlPool } from "../yield-sync/pool-filter";
import { normalizeDexSymbol } from "../../lib/dex-cron-constants";
import type {
  LlamaPool, CurveApiPayload, CurvePoolEntry, DexPriceObs,
  DataSources, CurveLookups,
} from "./types";
import {
  DEFILLAMA_YIELDS_URL, DEFILLAMA_PROTOCOLS_URL,
  CURVE_API_BASE, CURVE_CHAINS,
} from "./constants";
import {
  normalizeProtocol, classifyPoolType, isCryptoSwap, buildPoolFingerprint,
} from "./pool-helpers";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import type { PriceValidationReferences } from "../../lib/price-validation";
import {
  buildPoolIdentity,
  createKnownPoolIdentityIndex,
  registerKnownPoolIdentity,
  type KnownPoolIdentityIndex,
} from "./pool-identity";
import {
  resolveTrackedStablecoinId,
} from "./token-resolution";
import { toErrorMessage } from "../../lib/error-utils";

const PRIMARY_SOURCE_JSON_TIMEOUT_MS = 30_000;

interface DefiLlamaYieldsPayload {
  data?: LlamaPool[];
}

interface DefiLlamaProtocolRow {
  slug?: string;
  category?: string;
  tvl?: number | null;
  deadFrom?: number | null;
  rugged?: boolean | null;
  deprecated?: boolean | null;
}

function buildProtocolCategoryCachePayload(protocols: DefiLlamaProtocolRow[]): string {
  const compactProtocols = protocols
    .filter((protocol) => typeof protocol.slug === "string" && typeof protocol.category === "string")
    .map((protocol) => ({
      slug: protocol.slug,
      category: protocol.category,
    }));

  return JSON.stringify({ protocols: compactProtocols });
}

/** Fetch DeFiLlama Yields, Protocols list, and Curve API data. Returns null only on truly catastrophic failure. */
export async function fetchDataSources(graphApiKey: string | null, db: D1Database, signal?: AbortSignal): Promise<DataSources | null> {
  const dlYieldsAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_YIELDS);
  const dlProtocolsAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_PROTOCOLS);

  // Fetch DL first, consume bodies immediately to release connections before Curve batch.
  // Jobs on this trigger run sequentially; consume early to stay within the
  // repo's six-request budget during the Curve parallel phase that follows.
  const [llamaResult, protocolsResult] = await Promise.all([
    dlYieldsAllowed
      ? fetchJsonWithRetry<DefiLlamaYieldsPayload>(
          DEFILLAMA_YIELDS_URL,
          { headers: { "User-Agent": USER_AGENT }, signal },
          2,
          { timeoutMs: PRIMARY_SOURCE_JSON_TIMEOUT_MS },
        )
      : Promise.resolve(null),
    dlProtocolsAllowed
      ? fetchJsonWithRetry<unknown>(
          DEFILLAMA_PROTOCOLS_URL,
          { headers: { "User-Agent": USER_AGENT }, signal },
          2,
          { timeoutMs: PRIMARY_SOURCE_JSON_TIMEOUT_MS },
        )
      : Promise.resolve(null),
  ]);

  // --- DL Yields (consume body to release connection) ---
  let pools: LlamaPool[] = [];
  const fallbackDexProjects = new Set<string>();
  let dlYieldsAvailable = false;

  if (dlYieldsAllowed) {
    if (llamaResult?.response.ok) {
      try {
        const llamaData = llamaResult.body;
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
              .filter(isYieldRelevantDlPool)
              .map((p) => ({
                pool: p.pool, chain: p.chain, project: p.project, symbol: p.symbol,
                poolMeta: p.poolMeta ?? null,
                tvlUsd: p.tvlUsd, apy: p.apy, apyBase: p.apyBase,
                apyReward: p.apyReward, apyMean30d: p.apyMean30d ?? p.apy, stablecoin: p.stablecoin, exposure: p.exposure,
                underlyingTokens: p.underlyingTokens ?? null,
              }));
            await setCache(db, "dl-stablecoin-pools", buildDlStablecoinPoolsCache(minimalPools));
          } catch (e) {
            console.warn("[dex-liquidity] Failed to cache stablecoin pools for yield sync:", e);
          }
        } else {
          await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
          console.warn(`[dex-liquidity] DeFiLlama returned only ${llamaData.data?.length ?? 0} pools — degraded mode`);
        }
      } catch (e) {
        console.warn("[dex-liquidity] DeFiLlama yields response parse failed:", toErrorMessage(e));
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
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
    if (protocolsResult?.response.ok) {
      try {
        if (!Array.isArray(protocolsResult.body)) {
          throw new Error("DefiLlama protocols payload is not an array");
        }
        const protocols = protocolsResult.body as DefiLlamaProtocolRow[];
        try {
          await setCache(db, CIRCUIT_SOURCE.DL_PROTOCOLS, buildProtocolCategoryCachePayload(protocols), signal);
        } catch (cacheError) {
          if (signal?.aborted) {
            throw cacheError;
          }
          // Non-critical: the run has already loaded the categories it needs.
        }
        for (const p of protocols) {
          if (typeof p.slug !== "string") continue;
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
      } catch (e) {
        console.warn("[dex-liquidity] DeFiLlama protocols response parse failed:", toErrorMessage(e));
        await recordOutcome(db, CIRCUIT_SOURCE.DL_PROTOCOLS, false);
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
  let curvePayloads: (CurveApiPayload | null)[];
  const curveCircuitAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_LIQUIDITY_API);

  if (curveCircuitAllowed) {
    const curveResults = await Promise.all(
      CURVE_CHAINS.map((chain) =>
        fetchJsonWithRetry<CurveApiPayload>(
          `${CURVE_API_BASE}/${chain}`,
          { headers: { "User-Agent": USER_AGENT }, signal },
          2,
          { timeoutMs: PRIMARY_SOURCE_JSON_TIMEOUT_MS },
        ),
      ),
    );
    curvePayloads = curveResults.map((result) => result?.body ?? null);
    const curveSuccess = curvePayloads.some((payload) => payload != null);
    await recordOutcome(db, CIRCUIT_SOURCE.CURVE_LIQUIDITY_API, curveSuccess);
  } else {
    console.warn("[dex-liquidity] Curve liquidity API circuit open — skipping Curve pool data");
    curvePayloads = CURVE_CHAINS.map(() => null);
  }

  // Only abort if BOTH DL sources AND Curve all failed (truly catastrophic)
  if (!dlYieldsAvailable && curvePayloads.every((payload) => payload == null)) {
    console.error("[dex-liquidity] All pool data sources failed — aborting");
    return null;
  }

  return { pools, dexProjects, protocolTvlCaps, curvePayloads, graphApiKey, dlYieldsAvailable, dlProtocolsAvailable };
}

/** Parse Curve API responses into pool lookup maps and per-token price observations. */
export async function buildCurveLookups(
  curvePayloads: (CurveApiPayload | null)[],
  symbolToIds: Map<string, string[]>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  chainAddressToId: Map<string, string>,
  references?: PriceValidationReferences,
): Promise<CurveLookups> {
  const curvePoolMap = new Map<string, CurvePoolEntry>();
  const priceObservations = new Map<string, DexPriceObs[]>();
  // DeFiLlama yields rows carry UUID pool ids, so the address key alone never
  // matches them; the coin-set fingerprint gives an address-grade join. Two
  // physical pools sharing an identical coin set are ambiguous and fail
  // closed to the weaker symbol path.
  const ambiguousFingerprints = new Set<string>();

  for (let i = 0; i < CURVE_CHAINS.length; i++) {
    const json = curvePayloads[i];
    if (!json) continue;
    try {
      const curvePools = json.data?.poolData ?? [];
      for (const pool of curvePools) {
        const chain = CURVE_CHAINS[i];
        if (!pool.coins || pool.coins.length < 2) continue;
        // v2: skip broken/deprecated pools
        if (pool.isBroken) continue;
        const A = parseInt(pool.amplificationCoefficient, 10);
        if (isNaN(A)) continue;

        const coinBalances = pool.coins.map((coin) => {
          const raw = parseFloat(coin.poolBalance);
          const decimals = parseInt(coin.decimals, 10);
          const usdBalance = isNaN(raw) || isNaN(decimals) ? 0 : raw / 10 ** decimals * (coin.usdPrice || 1);
          return { coin, usdBalance };
        });

        // Compute balance ratio (min/max) — 1.0 = perfectly balanced
        const totalUsd = coinBalances.reduce((sum, { usdBalance }) => sum + usdBalance, 0);
        const balances = coinBalances.map(({ usdBalance }) => usdBalance).filter((balance) => balance > 0);

        let balanceRatio = 1;
        if (balances.length >= 2) {
          const minBal = balances.reduce((m, b) => Math.min(m, b), Infinity);
          const maxBal = balances.reduce((m, b) => Math.max(m, b), -Infinity);
          balanceRatio = maxBal > 0 ? minBal / maxBal : 0;
        }

        // v2: Per-token balance details
        const balanceDetails = coinBalances.map(({ coin, usdBalance }) => ({
          symbol: coin.symbol,
          balancePct: totalUsd > 0 ? Math.round((usdBalance / totalUsd) * 1000) / 10 : 0,
          isTracked: symbolToIds.has(normalizeDexSymbol(coin.symbol)),
        }));

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
        const tokenPrices: Record<string, number> = {};
        for (const c of pool.coins) {
          if (c.usdPrice && c.usdPrice > 0) {
            tokenPrices[normalizeDexSymbol(c.symbol)] = c.usdPrice;
          }
        }
        // Exact execution inputs: plain pools only, every coin complete.
        const executionCoins = coinBalances.map(({ coin }) => {
          const balance = parseFloat(coin.poolBalance);
          const decimals = parseInt(coin.decimals, 10);
          if (
            !coin.address?.trim() ||
            coin.isBasePoolLpToken === true ||
            !Number.isFinite(balance) ||
            balance <= 0 ||
            !Number.isInteger(decimals) ||
            decimals < 0 ||
            decimals > 255 ||
            !(coin.usdPrice > 0)
          ) {
            return null;
          }
          return {
            address: coin.address,
            symbol: coin.symbol,
            decimals,
            balance: balance / 10 ** decimals,
            usdPrice: coin.usdPrice,
          };
        });
        const executionComplete =
          pool.isMetaPool !== true &&
          pool.coins.length >= 2 &&
          pool.coins.length <= 8 &&
          executionCoins.every((coin) => coin !== null);

        const entry: CurvePoolEntry = {
          A,
          balanceRatio,
          tvl: pool.usdTotal,
          registryId: pool.registryId ?? "",
          isMetaPool: pool.isMetaPool ?? false,
          metapoolAdjustedTvl,
          creationTs: pool.creationTs ?? 0,
          balanceDetails,
          tokenPrices,
          ...(executionComplete
            ? { executionCoins: executionCoins as NonNullable<CurvePoolEntry["executionCoins"]> }
            : {}),
        };
        curvePoolMap.set(
          `${chain}:${pool.address.toLowerCase()}`,
          entry,
        );
        const fingerprintKey = buildPoolFingerprint(chain, "curve", pool.coins.map((coin) => coin.address));
        if (fingerprintKey && !ambiguousFingerprints.has(fingerprintKey)) {
          if (curvePoolMap.has(fingerprintKey)) {
            curvePoolMap.delete(fingerprintKey);
            ambiguousFingerprints.add(fingerprintKey);
          } else {
            curvePoolMap.set(fingerprintKey, entry);
          }
        }
        // Also store by symbol combo for fallback matching
        curvePoolMap.set(
          `${chain}:${coinSymbols}`,
          entry,
        );

        // Extract per-token price observations for DEX cross-validation
        // Filter: pool TVL >= $50K, balance ratio >= 0.3, coin has valid usdPrice
        if (metapoolAdjustedTvl >= DEX_PRICE_OBSERVATION_MIN_TVL_USD && balanceRatio >= 0.3) {
          const identity = buildPoolIdentity({
            chain,
            protocol: "curve",
            poolAddressOrId: pool.address,
            tokenAddresses: pool.coins.map((coin) => coin.address),
            poolType: isCryptoSwap(pool.registryId ?? "") ? "curve-cryptoswap" : "curve-stableswap",
            isStable: true,
          });
          for (const coin of pool.coins) {
            if (!coin.usdPrice || coin.usdPrice <= 0) continue;
            const resolved = resolveTrackedStablecoinId(
              { chain, address: coin.address, symbol: coin.symbol },
              { chainAddressToId, symbolToChainScopedIds },
            );
            if (resolved.status !== "matched" || !resolved.stablecoinId) continue;
            if (!isPlausibleDexObservationPrice(resolved.stablecoinId, coin.usdPrice, references)) continue;
            const obs = priceObservations.get(resolved.stablecoinId) ?? [];
            obs.push({
              price: coin.usdPrice,
              tvl: metapoolAdjustedTvl,
              chain,
              protocol: "curve",
              poolKey: identity.exactPoolKey ?? undefined,
              derivedMatchKey: identity.derivedMatchKey ?? undefined,
              identityConfidence: identity.exactPoolKey ? "exact" : identity.derivedMatchKey ? "derived_unique" : "none",
              sourceFamily: "dl",
            });
            priceObservations.set(resolved.stablecoinId, obs);
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

/** Collect all pool addresses from existing sources for dedup against GT */
export function buildKnownPoolAddresses(
  pools: LlamaPool[],
  dexProjects: Set<string>,
  curvePoolMap: Map<string, CurvePoolEntry>,
  uniV3PoolFees: Map<string, number>,
  aerodromeIsStable: Map<string, boolean>,
): KnownPoolIdentityIndex {
  const known = createKnownPoolIdentityIndex();
  let derivedCount = 0;
  const enforceDexProjectFilter = dexProjects.size > 0;

  // DeFiLlama pools are identity-poor, so only their derived keys are trustworthy.
  for (const pool of pools) {
    if (!pool.tvlUsd || pool.tvlUsd < 10_000) continue;
    if (enforceDexProjectFilter && !dexProjects.has(pool.project)) continue;
    if (pool.exposure === "single") continue;
    const identity = buildPoolIdentity({
      chain: pool.chain,
      protocol: pool.project,
      poolAddressOrId: pool.pool,
      tokenAddresses: pool.underlyingTokens ?? [],
      poolType: classifyPoolType(pool.project),
      isStable: pool.stablecoin,
    });
    if (identity.derivedMatchKey) derivedCount++;
    registerKnownPoolIdentity(known, identity);
  }

  // Curve pools (keyed as chain:address in the map)
  for (const key of curvePoolMap.keys()) {
    const [chain, poolAddress] = key.split(":");
    if (!poolAddress || !poolAddress.includes("0x")) continue;
    registerKnownPoolIdentity(known, buildPoolIdentity({
      chain,
      protocol: "curve",
      poolAddressOrId: poolAddress,
      tokenAddresses: [],
      poolType: "curve-stableswap",
      isStable: true,
    }));
  }

  // UniV3 pools (keyed as chain:address in the fees map)
  for (const key of uniV3PoolFees.keys()) {
    const [chain, poolAddress] = key.split(":");
    if (!poolAddress) continue;
    registerKnownPoolIdentity(known, buildPoolIdentity({
      chain,
      protocol: "uniswap-v3",
      poolAddressOrId: poolAddress,
      tokenAddresses: [],
    }));
  }

  // Aerodrome pools (keyed as chain:address in the isStable map)
  for (const [key, isStable] of aerodromeIsStable.entries()) {
    const [chain, poolAddress] = key.split(":");
    if (!poolAddress) continue;
    registerKnownPoolIdentity(known, buildPoolIdentity({
      chain,
      protocol: "aerodrome",
      poolAddressOrId: poolAddress,
      tokenAddresses: [],
      isStable,
    }));
  }

  console.log(
    `[dex-liquidity] Built known pool identity index: ${known.exactKeys.size} exact keys, ` +
    `${derivedCount} derived DL keys`,
  );
  return known;
}
