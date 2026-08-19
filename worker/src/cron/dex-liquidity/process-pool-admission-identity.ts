import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
} from "@shared/lib/exit-route-identity";
import { isBlockedDexId } from "../../lib/dex-cron-constants";
import { DEX_LIQUIDITY_POOL_MIN_TVL_USD } from "./constants";
import {
  buildPoolFingerprint,
  classifyPoolType,
  normalizeProtocol,
} from "./pool-helpers";
import { resolveLlamaPoolStablecoinMatches } from "./pool-match-resolution";
import type { LlamaPool } from "./types";
import {
  ExpectedPoolInputError,
  type PoolProcessingContext,
  type ResolvedPoolIdentity,
} from "./process-pool-types";

function requirePoolIdentity(pool: LlamaPool): void {
  if (
    typeof pool.pool !== "string" ||
    pool.pool.trim().length === 0 ||
    typeof pool.chain !== "string" ||
    pool.chain.trim().length === 0 ||
    typeof pool.project !== "string" ||
    pool.project.trim().length === 0 ||
    typeof pool.symbol !== "string" ||
    pool.symbol.trim().length === 0 ||
    (pool.underlyingTokens != null &&
      (!Array.isArray(pool.underlyingTokens) ||
        pool.underlyingTokens.some((token) => typeof token !== "string")))
  ) {
    throw new ExpectedPoolInputError("invalid-pool-identity");
  }
}

function requirePoolValues(pool: LlamaPool): void {
  if (
    typeof pool.tvlUsd !== "number" ||
    !Number.isFinite(pool.tvlUsd) ||
    pool.tvlUsd < 0 ||
    pool.tvlUsd > 1e12
  ) {
    throw new ExpectedPoolInputError("invalid-pool-tvl");
  }
  if (
    (pool.volumeUsd1d != null &&
      (typeof pool.volumeUsd1d !== "number" ||
        !Number.isFinite(pool.volumeUsd1d) ||
        pool.volumeUsd1d < 0)) ||
    (pool.volumeUsd7d != null &&
      (typeof pool.volumeUsd7d !== "number" ||
        !Number.isFinite(pool.volumeUsd7d) ||
        pool.volumeUsd7d < 0))
  ) {
    throw new ExpectedPoolInputError("invalid-pool-volume");
  }
}

export function admitAndResolvePoolIdentity(
  context: PoolProcessingContext,
  pool: LlamaPool,
  enforceDexProjectFilter: boolean,
): ResolvedPoolIdentity | null {
  requirePoolIdentity(pool);
  requirePoolValues(pool);
  if (pool.tvlUsd < DEX_LIQUIDITY_POOL_MIN_TVL_USD) return null;
  if (enforceDexProjectFilter && !context.dexProjects.has(pool.project)) return null;
  if (isBlockedDexId(pool.project) || pool.exposure === "single") return null;

  const { matchedIds, poolSymbols } = resolveLlamaPoolStablecoinMatches(pool, {
    chainAddressToId: context.chainAddressToId,
    symbolToChainScopedIds: context.symbolToChainScopedIds,
  });
  if (matchedIds.size === 0) return null;

  const poolType = classifyPoolType(pool.project, pool.poolMeta);
  const protocol = normalizeProtocol(pool.project);
  const chainNorm = canonicalExitRouteChain(pool.chain);
  const addrCurveKey = canonicalExitRouteAssetKey(chainNorm, pool.pool);
  const fpCurveKey =
    protocol === "curve"
      ? buildPoolFingerprint(chainNorm, "curve", pool.underlyingTokens ?? [])
      : null;
  const symCurveKey = `${chainNorm}:${poolSymbols
    .map((symbol) => symbol.toUpperCase())
    .sort()
    .join("-")}`;

  return {
    pool,
    matchedIds,
    poolSymbols,
    poolType,
    protocol,
    chainNorm,
    addrCurveKey,
    fpCurveKey,
    symCurveKey,
  };
}
