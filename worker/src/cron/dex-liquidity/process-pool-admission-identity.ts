import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
} from "@shared/types/exit-route-identity";
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

// Verified against https://yields.llama.fi/distinctID for the two pools in #2142.
const REVIEWED_ETHEREUM_CURVE_YIELD_ADDRESSES = new Map([
  ["21d224c9-fe8d-571f-89e4-b234858a0aae", "0x04710a7b238386da58efad8b65e150e5e17aa522"],
  ["a5ed9aac-3cec-4c88-b996-94b6cc76c2fe", "0x6206ca315c2fcdd2a857b47efb285aa12c529a7a"],
]);

export function requirePoolIdentity(pool: LlamaPool): void {
  if (
    pool == null ||
    typeof pool !== "object" ||
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
  const reviewedCurveAddress = protocol === "curve" && chainNorm === "ethereum"
    ? REVIEWED_ETHEREUM_CURVE_YIELD_ADDRESSES.get(pool.pool.trim().toLowerCase())
    : undefined;
  const addrCurveKey = canonicalExitRouteAssetKey(chainNorm, reviewedCurveAddress ?? pool.pool);
  // A missing exact observation must never enrich a reviewed ID with its twin's state.
  const fpCurveKey =
    protocol === "curve" && !reviewedCurveAddress
      ? buildPoolFingerprint(chainNorm, "curve", pool.underlyingTokens ?? [])
      : null;
  const symCurveKey = reviewedCurveAddress ? null : `${chainNorm}:${poolSymbols
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
    reviewedCurveAddress,
    addrCurveKey,
    fpCurveKey,
    symCurveKey,
  };
}
