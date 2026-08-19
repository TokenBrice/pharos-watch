import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { mapWithConcurrency } from "../../lib/concurrency";
import { setCache } from "../../lib/db-cache";
import { USER_AGENT, CIRCUIT_SOURCE, DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { buildDlStablecoinPoolsCache } from "../yield-sync/cache";
import { isYieldRelevantDlPool } from "../yield-sync/pool-filter";
import { normalizeDexSymbol } from "../../lib/dex-cron-constants";
import type {
  LlamaPool,
  CurveApiPayload,
  CurvePoolEntry,
  DexPriceObs,
  DataSources,
  CurveLookups,
  SymbolLookups,
} from "./types";
import {
  DEFILLAMA_YIELDS_URL,
  DEFILLAMA_PROTOCOLS_URL,
  CURVE_API_BASE,
  CURVE_API_CHAIN_PATHS,
  CURVE_CHAINS,
  DEX_LIQUIDITY_POOL_MIN_TVL_USD,
} from "./constants";
import { normalizeProtocol, classifyPoolType, isCryptoSwap, buildPoolFingerprint } from "./pool-helpers";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import type { PriceValidationReferences } from "../../lib/price-validation";
import {
  buildPoolIdentity,
  createKnownPoolIdentityIndex,
  registerKnownPoolIdentity,
  type KnownPoolIdentityIndex,
} from "./pool-identity";
import { resolveTrackedStablecoinId } from "./token-resolution";
import { toErrorMessage } from "../../lib/error-utils";
import { resolveLlamaPoolStablecoinMatches } from "./pool-match-resolution";
import { logWorkerEvent } from "../../lib/structured-log";
import { shouldRetainCurveCompositePoolIdentity } from "../measured-execution/curve-composite-identities";

const PRIMARY_SOURCE_JSON_TIMEOUT_MS = 30_000;
const CURVE_API_FETCH_CONCURRENCY = 4;

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

export interface PrimaryPoolCompactionResult {
  pools: LlamaPool[];
  rawPoolCount: number;
  retainedPoolCount: number;
  skippedUntrackedCount: number;
}

export function compactPrimaryPoolsForTrackedStablecoins(
  pools: LlamaPool[],
  lookups: Pick<SymbolLookups, "chainAddressToId" | "symbolToChainScopedIds">,
): PrimaryPoolCompactionResult {
  const retainedPools: LlamaPool[] = [];
  for (const pool of pools) {
    if (resolveLlamaPoolStablecoinMatches(pool, lookups).matchedIds.size > 0) {
      retainedPools.push(pool);
    }
  }

  return {
    pools: retainedPools,
    rawPoolCount: pools.length,
    retainedPoolCount: retainedPools.length,
    skippedUntrackedCount: pools.length - retainedPools.length,
  };
}

/** Fetch DeFiLlama Yields, Protocols list, and Curve API data. Returns null only on truly catastrophic failure. */
export async function fetchDataSources(
  graphApiKey: string | null,
  db: D1Database,
  lookups: Pick<SymbolLookups, "chainAddressToId" | "symbolToChainScopedIds">,
  signal?: AbortSignal,
): Promise<DataSources | null> {
  const dlYieldsAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_YIELDS);
  const dlProtocolsAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_PROTOCOLS);

  // Fetch DL first, consume bodies immediately to release connections before Curve batch.
  // Jobs on this trigger run sequentially; consume early to stay within the
  // repo's six-request budget during the Curve parallel phase that follows.
  let [llamaResult, protocolsResult] = await Promise.all([
    dlYieldsAllowed
      ? fetchJsonWithRetry<DefiLlamaYieldsPayload>(
          DEFILLAMA_YIELDS_URL,
          { headers: { "User-Agent": USER_AGENT }, signal },
          2,
          { timeoutMs: PRIMARY_SOURCE_JSON_TIMEOUT_MS },
        )
      : Promise.resolve(null),
    dlProtocolsAllowed
      ? fetchJsonWithRetry<unknown>(DEFILLAMA_PROTOCOLS_URL, { headers: { "User-Agent": USER_AGENT }, signal }, 2, {
          timeoutMs: PRIMARY_SOURCE_JSON_TIMEOUT_MS,
        })
      : Promise.resolve(null),
  ]);

  // --- DL Yields (consume body to release connection) ---
  let pools: LlamaPool[] = [];
  let rawPoolCount = 0;
  const fallbackDexProjects = new Set<string>();
  let dlYieldsAvailable = false;

  if (dlYieldsAllowed) {
    if (llamaResult?.response.ok) {
      try {
        const llamaData = llamaResult.body;
        if (llamaData.data && llamaData.data.length >= 1000) {
          const rawPools = llamaData.data;
          rawPoolCount = rawPools.length;
          for (const pool of rawPools) {
            if (!pool.project || pool.exposure === "single") continue;
            fallbackDexProjects.add(pool.project);
          }
          logWorkerEvent({
            scope: "lib",
            job: "sync-dex-liquidity",
            level: "info",
            event: "defillama-yields-loaded",
            message: "Got pools from DeFiLlama yields",
            metadata: { rawPoolCount },
          });

          // Cache minimal stablecoin pool data for yield sync (avoids redundant 13MB re-fetch)
          try {
            const minimalPools = rawPools.filter(isYieldRelevantDlPool).map((p) => ({
              pool: p.pool,
              chain: p.chain,
              project: p.project,
              symbol: p.symbol,
              poolMeta: p.poolMeta ?? null,
              tvlUsd: p.tvlUsd,
              apy: p.apy,
              apyBase: p.apyBase,
              apyReward: p.apyReward,
              apyMean30d: p.apyMean30d ?? p.apy,
              stablecoin: p.stablecoin,
              exposure: p.exposure,
              underlyingTokens: p.underlyingTokens ?? null,
            }));
            await setCache(db, "dl-stablecoin-pools", buildDlStablecoinPoolsCache(minimalPools));
          } catch (e) {
            logWorkerEvent({
              scope: "lib",
              job: "sync-dex-liquidity",
              level: "warn",
              event: "yield-pool-cache-failed",
              message: "Failed to cache stablecoin pools for yield sync",
              error: e,
            });
          }

          const compacted = compactPrimaryPoolsForTrackedStablecoins(rawPools, lookups);
          await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, true);
          pools = compacted.pools;
          dlYieldsAvailable = true;
          if (compacted.skippedUntrackedCount > 0) {
            logWorkerEvent({
              scope: "lib",
              job: "sync-dex-liquidity",
              level: "info",
              event: "defillama-pools-compacted",
              message: "Retained DeFiLlama pools with tracked tokens",
              metadata: {
                retainedPoolCount: compacted.retainedPoolCount,
                skippedUntrackedCount: compacted.skippedUntrackedCount,
              },
            });
          }
        } else {
          await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
          logWorkerEvent({
            scope: "lib",
            job: "sync-dex-liquidity",
            level: "warn",
            event: "defillama-yields-degraded",
            message: "DeFiLlama returned too few pools",
            metadata: { poolCount: llamaData.data?.length ?? 0 },
          });
        }
      } catch (e) {
        pools = [];
        rawPoolCount = 0;
        fallbackDexProjects.clear();
        dlYieldsAvailable = false;
        logWorkerEvent({
          scope: "lib",
          job: "sync-dex-liquidity",
          level: "warn",
          event: "defillama-yields-parse-failed",
          message: "DeFiLlama yields response parse failed",
          error: toErrorMessage(e),
        });
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
      }
    } else {
      logWorkerEvent({
        scope: "lib",
        job: "sync-dex-liquidity",
        level: "warn",
        event: "defillama-yields-fetch-failed",
        message: "DeFiLlama yields fetch failed; CG/GT will be the primary pool source",
      });
      await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
    }
  } else {
    logWorkerEvent({
      scope: "lib",
      job: "sync-dex-liquidity",
      level: "warn",
      event: "defillama-yields-circuit-open",
      message: "DL yields circuit open; CG/GT will be the primary pool source",
    });
  }
  llamaResult = null;

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
          logWorkerEvent({
            scope: "lib",
            level: "info",
            event: "active_dex_projects_loaded",
            job: "sync-dex-liquidity",
            provider: "defillama",
            message: "Active DEX projects loaded",
            metadata: { projectCount: dexProjects.size, tvlCapCount: protocolTvlCaps.size },
          });
        } else {
          logWorkerEvent({
            scope: "lib",
            job: "sync-dex-liquidity",
            level: "warn",
            event: "defillama-protocols-empty",
            message: "DeFiLlama protocols response had zero active DEX projects",
          });
        }
      } catch (e) {
        logWorkerEvent({
          scope: "lib",
          job: "sync-dex-liquidity",
          level: "warn",
          event: "defillama-protocols-parse-failed",
          message: "DeFiLlama protocols response parse failed",
          error: toErrorMessage(e),
        });
        await recordOutcome(db, CIRCUIT_SOURCE.DL_PROTOCOLS, false);
      }
    } else {
      logWorkerEvent({
        scope: "lib",
        job: "sync-dex-liquidity",
        level: "warn",
        event: "defillama-protocols-fetch-failed",
        message: "DeFiLlama protocols fetch failed; dead-protocol filtering is degraded",
      });
      await recordOutcome(db, CIRCUIT_SOURCE.DL_PROTOCOLS, false);
    }
  } else {
    logWorkerEvent({
      scope: "lib",
      job: "sync-dex-liquidity",
      level: "warn",
      event: "defillama-protocols-circuit-open",
      message: "DL protocols circuit open; dead-protocol filtering is degraded",
    });
  }
  protocolsResult = null;

  if (dexProjects.size === 0 && fallbackDexProjects.size > 0) {
    for (const project of fallbackDexProjects) dexProjects.add(project);
    logWorkerEvent({
      scope: "lib",
      job: "sync-dex-liquidity",
      level: "warn",
      event: "fallback-dex-projects",
      message: "Using fallback DEX project set from yields because the protocol index is unavailable",
      metadata: { projectCount: dexProjects.size },
    });
  }

  // DeFiLlama bodies are consumed before Curve opens its bounded request batch.
  let curvePayloads: (CurveApiPayload | null)[];
  const curveCircuitAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_LIQUIDITY_API);

  if (curveCircuitAllowed) {
    const curveResults = await mapWithConcurrency(CURVE_CHAINS, CURVE_API_FETCH_CONCURRENCY, (chain) =>
      fetchJsonWithRetry<CurveApiPayload>(
        `${CURVE_API_BASE}/${CURVE_API_CHAIN_PATHS[chain] ?? chain}`,
        { headers: { "User-Agent": USER_AGENT }, signal },
        2,
        { timeoutMs: PRIMARY_SOURCE_JSON_TIMEOUT_MS },
      ),
    );
    curvePayloads = curveResults.map((result) => result?.body ?? null);
    const curveSuccess = curvePayloads.some((payload) => payload != null);
    await recordOutcome(db, CIRCUIT_SOURCE.CURVE_LIQUIDITY_API, curveSuccess);
  } else {
    logWorkerEvent({
      scope: "lib",
      job: "sync-dex-liquidity",
      level: "warn",
      event: "curve-liquidity-circuit-open",
      message: "Curve liquidity API circuit open; skipping Curve pool data",
    });
    curvePayloads = CURVE_CHAINS.map(() => null);
  }

  // Only abort if BOTH DL sources AND Curve all failed (truly catastrophic)
  if (!dlYieldsAvailable && curvePayloads.every((payload) => payload == null)) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-dex-liquidity",
      event: "all-pool-sources-failed",
      message: "All pool data sources failed; aborting",
    });
    return null;
  }

  return {
    pools,
    rawPoolCount,
    dexProjects,
    protocolTvlCaps,
    curvePayloads,
    graphApiKey,
    dlYieldsAvailable,
    dlProtocolsAvailable,
  };
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
  const curvePoolCandidatesByFingerprint = new Map<string, CurvePoolEntry[]>();
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
          const usdBalance = isNaN(raw) || isNaN(decimals) ? 0 : (raw / 10 ** decimals) * (coin.usdPrice || 1);
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
          pool.basePoolAddress && pool.usdTotalExcludingBasePool > 0 ? pool.usdTotalExcludingBasePool : pool.usdTotal;

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
        // Exact physical coin identity is retained for reviewed direct-quote
        // adapters, including the base LP leg of a metapool. Reserve
        // simulation remains limited to complete non-meta, non-LP rows.
        const poolCoins = coinBalances.map(({ coin }) => {
          const decimals = parseInt(coin.decimals, 10);
          if (
            !coin.address?.trim() ||
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
            usdPrice: coin.usdPrice,
            isBasePoolLpToken: coin.isBasePoolLpToken === true,
          };
        });
        const executionCoins = coinBalances.map(({ coin }, index) => {
          const identity = poolCoins[index];
          const balance = parseFloat(coin.poolBalance);
          if (
            identity == null ||
            identity.isBasePoolLpToken ||
            !Number.isFinite(balance) ||
            balance <= 0
          ) return null;
          return {
            address: identity.address,
            symbol: identity.symbol,
            decimals: identity.decimals,
            balance: balance / 10 ** identity.decimals,
            usdPrice: identity.usdPrice,
          };
        });
        const poolIdentityComplete = poolCoins.every((coin) => coin !== null);
        const retainCompositePoolIdentity = shouldRetainCurveCompositePoolIdentity(
          chain,
          pool.address,
        );
        const underlyingCoins = pool.underlyingCoins?.map((coin) => {
          const decimals = parseInt(coin.decimals, 10);
          if (
            !coin.address?.trim() ||
            !coin.symbol?.trim() ||
            !Number.isInteger(decimals) ||
            decimals < 0 ||
            decimals > 255 ||
            !(coin.usdPrice > 0)
          ) return null;
          return {
            address: coin.address,
            symbol: coin.symbol,
            decimals,
            usdPrice: coin.usdPrice,
          };
        });
        const underlyingIdentityComplete =
          underlyingCoins != null &&
          underlyingCoins.length >= 2 &&
          underlyingCoins.length <= 8 &&
          underlyingCoins.every((coin) => coin !== null);
        const executionComplete =
          pool.isMetaPool !== true &&
          pool.coins.length >= 2 &&
          pool.coins.length <= 8 &&
          executionCoins.every((coin) => coin !== null);

        const entry: CurvePoolEntry = {
          poolAddress: pool.address,
          apiIsBroken: false,
          A,
          balanceRatio,
          tvl: pool.usdTotal,
          registryId: pool.registryId ?? "",
          isMetaPool: pool.isMetaPool ?? false,
          ...(pool.basePoolAddress && retainCompositePoolIdentity
            ? { basePoolAddress: pool.basePoolAddress }
            : {}),
          metapoolAdjustedTvl,
          creationTs: pool.creationTs ?? 0,
          balanceDetails,
          tokenPrices,
          ...(poolIdentityComplete && retainCompositePoolIdentity
            ? { poolCoins: poolCoins as NonNullable<CurvePoolEntry["poolCoins"]> }
            : {}),
          ...(underlyingIdentityComplete && retainCompositePoolIdentity
            ? {
                underlyingCoins:
                  underlyingCoins as NonNullable<CurvePoolEntry["underlyingCoins"]>,
              }
            : {}),
          ...(executionComplete
            ? { executionCoins: executionCoins as NonNullable<CurvePoolEntry["executionCoins"]> }
            : {}),
        };
        curvePoolMap.set(`${chain}:${pool.address.toLowerCase()}`, entry);
        const curveCoinAddresses = pool.coins.map((coin) => coin.address);
        const hasCompleteCurveCoinAddresses = curveCoinAddresses.every(
          (address): address is string => typeof address === "string" && address.trim().length > 0,
        );
        const fingerprintKey = hasCompleteCurveCoinAddresses
          ? buildPoolFingerprint(chain, "curve", curveCoinAddresses)
          : null;
        if (
          fingerprintKey &&
          pool.usdTotal >= DEX_LIQUIDITY_POOL_MIN_TVL_USD &&
          !ambiguousFingerprints.has(fingerprintKey)
        ) {
          const candidates = curvePoolCandidatesByFingerprint.get(fingerprintKey) ?? [];
          candidates.push(entry);
          curvePoolCandidatesByFingerprint.set(fingerprintKey, candidates);
          if (curvePoolMap.has(fingerprintKey)) {
            curvePoolMap.delete(fingerprintKey);
            ambiguousFingerprints.add(fingerprintKey);
          } else {
            curvePoolMap.set(fingerprintKey, entry);
          }
        } else if (fingerprintKey && pool.usdTotal >= DEX_LIQUIDITY_POOL_MIN_TVL_USD) {
          const candidates = curvePoolCandidatesByFingerprint.get(fingerprintKey) ?? [];
          candidates.push(entry);
          curvePoolCandidatesByFingerprint.set(fingerprintKey, candidates);
        }
        // Also store by symbol combo for fallback matching
        curvePoolMap.set(`${chain}:${coinSymbols}`, entry);

        // Extract per-token price observations for DEX cross-validation
        // Filter: pool TVL >= $50K, balance ratio >= 0.3, coin has valid usdPrice
        if (metapoolAdjustedTvl >= DEX_PRICE_OBSERVATION_MIN_TVL_USD && balanceRatio >= 0.3) {
          const identity = buildPoolIdentity({
            chain,
            protocol: "curve",
            poolAddressOrId: pool.address,
            tokenAddresses: hasCompleteCurveCoinAddresses ? curveCoinAddresses : [],
            poolType: isCryptoSwap(pool.registryId ?? "") ? "curve-cryptoswap" : "curve-stableswap",
            isStable: true,
          });
          for (const coin of pool.coins) {
            if (!coin.usdPrice || coin.usdPrice <= 0) continue;
            const resolved = resolveTrackedStablecoinId(
              { chain, address: typeof coin.address === "string" ? coin.address : "", symbol: coin.symbol },
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
              identityConfidence: identity.exactPoolKey
                ? "exact"
                : identity.derivedMatchKey
                  ? "derived_unique"
                  : "none",
              sourceFamily: "dl",
            });
            priceObservations.set(resolved.stablecoinId, obs);
          }
        }
      }
    } catch (err) {
      logWorkerEvent({
        scope: "lib",
        job: "sync-dex-liquidity",
        level: "warn",
        event: "curve-payload-parse-failed",
        message: "Failed to parse Curve payload",
        metadata: { chain: CURVE_CHAINS[i] },
        error: err,
      });
    }
  }
  logWorkerEvent({
    scope: "lib",
    job: "sync-dex-liquidity",
    level: "info",
    event: "curve-pools-indexed",
    message: "Indexed Curve pools and price observations",
    metadata: { curvePoolCount: curvePoolMap.size, priceObservationCount: priceObservations.size },
  });

  return { curvePoolMap, curvePoolCandidatesByFingerprint, priceObservations };
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
    if (!pool.tvlUsd || pool.tvlUsd < DEX_LIQUIDITY_POOL_MIN_TVL_USD) continue;
    if (enforceDexProjectFilter && !dexProjects.has(pool.project)) continue;
    if (pool.exposure === "single") continue;
    const identity = buildPoolIdentity({
      chain: pool.chain,
      protocol: pool.project,
      poolAddressOrId: pool.pool,
      tokenAddresses: pool.underlyingTokens ?? [],
      poolType: classifyPoolType(pool.project, pool.poolMeta),
      isStable: pool.stablecoin,
    });
    if (identity.derivedMatchKey) derivedCount++;
    registerKnownPoolIdentity(known, identity);
  }

  // Curve pools (keyed as chain:address in the map)
  for (const key of curvePoolMap.keys()) {
    const [chain, poolAddress] = key.split(":");
    if (!poolAddress || !poolAddress.includes("0x")) continue;
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain,
        protocol: "curve",
        poolAddressOrId: poolAddress,
        tokenAddresses: [],
        poolType: "curve-stableswap",
        isStable: true,
      }),
    );
  }

  // UniV3 pools (keyed as chain:address in the fees map)
  for (const key of uniV3PoolFees.keys()) {
    const [chain, poolAddress] = key.split(":");
    if (!poolAddress) continue;
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain,
        protocol: "uniswap-v3",
        poolAddressOrId: poolAddress,
        tokenAddresses: [],
      }),
    );
  }

  // Aerodrome pools (keyed as chain:address in the isStable map)
  for (const [key, isStable] of aerodromeIsStable.entries()) {
    const [chain, poolAddress] = key.split(":");
    if (!poolAddress) continue;
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain,
        protocol: "aerodrome",
        poolAddressOrId: poolAddress,
        tokenAddresses: [],
        isStable,
      }),
    );
  }

  logWorkerEvent({
    scope: "lib",
    job: "sync-dex-liquidity",
    level: "info",
    event: "known-pool-identity-index-built",
    message: "Built known pool identity index",
    metadata: { exactKeyCount: known.exactKeys.size, derivedDlKeyCount: derivedCount },
  });
  return known;
}
