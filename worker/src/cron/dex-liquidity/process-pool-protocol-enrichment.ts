import { CURVE_LITE_DEPLOYMENTS } from "@shared/lib/dex-deployment-coverage";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { getCurveCompositePolicy } from "@shared/lib/curve-composite-policies";
import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { canonicalExitRouteAssetKey, canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";
import { QUALITY_MULTIPLIERS } from "../../lib/dex-cron-constants";
import { CURVE_TWIN_FINGERPRINT_MAX_TVL_RATIO } from "./constants";
import {
  classifyCurveStableSwapQuality,
  getQualityMultiplier,
  isCryptoSwap,
} from "./pool-helpers";
import { resolveActiveCurveCryptoSwapCandidateByTvl } from "./process-pool-execution-capability";
import { getReviewedQuoterV2SourcePoolPolicy } from "./pool-identity";
import type { CurvePool, CurvePoolEntry } from "./types";
import type {
  PoolProcessingContext,
  PoolProtocolEnrichment,
  ResolvedPoolIdentity,
} from "./process-pool-types";

export interface CurveBasePoolOverlapEvidence {
  curveBasePoolOverlap?: { basePoolKey: string; lpLegTvlUsd: number };
}

export function resolveCurveBasePoolOverlap(
  chain: string,
  pool: Pick<CurvePool, "address" | "basePoolAddress" | "isMetaPool" | "usdTotal">,
  coinBalances: readonly {
    coin: Pick<CurvePool["coins"][number], "address" | "isBasePoolLpToken">;
    decimals: number | null;
    usdBalance: number | null;
  }[],
): CurveBasePoolOverlapEvidence["curveBasePoolOverlap"] {
  if (pool.isMetaPool !== true) return undefined;
  const policy = getCurveCompositePolicy(chain, pool.address);
  if (
    policy?.quoteFunction !== "get_dy_underlying" ||
    canonicalEvmAddress(pool.basePoolAddress) !== policy.metapool.basePoolAddress ||
    coinBalances.length !== policy.poolTokens.length ||
    !coinBalances.every(({ coin, decimals }, index) =>
      canonicalEvmAddress(coin.address) === policy.poolTokens[index]?.address &&
      decimals === policy.poolTokens[index]?.decimals &&
      (coin.isBasePoolLpToken === true) === (index === 1))
  ) return undefined;
  const lpLegTvlUsd = coinBalances[1]?.usdBalance;
  if (
    lpLegTvlUsd == null || !Number.isFinite(lpLegTvlUsd) || lpLegTvlUsd <= 0 ||
    !Number.isFinite(pool.usdTotal) || lpLegTvlUsd > pool.usdTotal
  ) return undefined;
  return { basePoolKey: canonicalExitRouteScopedKey(chain, policy.metapool.basePoolAddress), lpLegTvlUsd };
}

function isClaimedExactCurveAddress(
  context: PoolProcessingContext,
  chainNorm: string,
  entry: CurvePoolEntry | undefined,
): boolean {
  if (!entry?.poolAddress || !context.claimedExactCurveAddresses?.size) return false;
  return context.claimedExactCurveAddresses.has(
    canonicalExitRouteAssetKey(chainNorm, entry.poolAddress),
  );
}

export function enrichPoolProtocol(
  context: PoolProcessingContext,
  identity: ResolvedPoolIdentity,
): PoolProtocolEnrichment {
  const { pool, protocol, chainNorm, poolSymbols, poolType } = identity;
  const reviewedQuoterPool = protocol === "uniswap-v3" ? getReviewedQuoterV2SourcePoolPolicy(pool) : undefined;
  const addrCurveData = protocol === "curve" ? context.curvePoolMap.get(identity.addrCurveKey) : undefined;
  const rawFpCurveData =
    protocol === "curve" && addrCurveData == null && identity.fpCurveKey != null
      ? context.curvePoolMap.get(identity.fpCurveKey)
      : undefined;
  const hasBelowFloorTwin =
    identity.fpCurveKey != null && context.curveBelowFloorTwinFingerprints.has(identity.fpCurveKey);
  const dlFpCount =
    identity.fpCurveKey != null ? (context.dlCurvePoolCountByFingerprint?.get(identity.fpCurveKey) ?? 0) : 0;
  // Guard 2C: a UUID-only Curve row may never bind to a physical address already
  // claimed by an exact-attached row in the same run.
  const fpBlockedByClaimed = isClaimedExactCurveAddress(context, chainNorm, rawFpCurveData);
  // Guard 2A: multiple admitted Curve observations on a below-floor-twin fingerprint
  // fail closed to their distinct keys instead of collapsing into a false conflict.
  const fpBlockedByMultiRowTwin = hasBelowFloorTwin && dlFpCount >= 2;
  // Guard 2B: a lone stale drained twin on a below-floor-twin fingerprint cannot
  // bind to the surviving sibling when TVL diverges beyond the coherence bound.
  const fpBlockedByTvlDivergence =
    hasBelowFloorTwin &&
    dlFpCount <= 1 &&
    rawFpCurveData != null &&
    !(
      Number.isFinite(rawFpCurveData.tvl) &&
      rawFpCurveData.tvl > 0 &&
      Number.isFinite(pool.tvlUsd) &&
      pool.tvlUsd > 0 &&
      Math.max(rawFpCurveData.tvl / pool.tvlUsd, pool.tvlUsd / rawFpCurveData.tvl) <=
        CURVE_TWIN_FINGERPRINT_MAX_TVL_RATIO
    );
  const fpSuppressed = fpBlockedByClaimed || fpBlockedByMultiRowTwin || fpBlockedByTvlDivergence;
  const fpCurveData = fpSuppressed ? undefined : rawFpCurveData;
  const rawSymCurveData =
    protocol === "curve" &&
    addrCurveData == null &&
    fpCurveData == null &&
    !fpSuppressed &&
    identity.symCurveKey != null
      ? context.curvePoolMap.get(identity.symCurveKey)
      : undefined;
  const symCurveData = isClaimedExactCurveAddress(context, chainNorm, rawSymCurveData)
    ? undefined
    : rawSymCurveData;
  const curveData = addrCurveData ?? fpCurveData ?? symCurveData;
  const curveAddressMatch = addrCurveData != null || fpCurveData != null;
  const activeCryptoSwapTvlMatch =
    protocol === "curve" &&
    identity.fpCurveKey != null &&
    !curveAddressMatch
      ? resolveActiveCurveCryptoSwapCandidateByTvl(
          (context.curvePoolCandidatesByFingerprint.get(identity.fpCurveKey) ?? []).filter(
            (candidate) => !isClaimedExactCurveAddress(context, chainNorm, candidate),
          ),
          pool.tvlUsd,
          chainNorm,
        )
      : null;
  const curveMeasuredRouteData =
    activeCryptoSwapTvlMatch ?? (curveAddressMatch ? curveData : undefined);

  let qualityMultiplier: number;
  let resolvedPoolType = poolType;
  let feeTierForExtra: number | undefined;
  let balanceRatio = 1;
  let hasMeasuredBalance = false;
  let poolMaturityDays = 0;
  let organicFraction = 0.5;
  let hasMeasuredOrganicFraction = false;
  let effectivePoolTvl = pool.tvlUsd;
  let balanceDetails:
    | { symbol: string; balancePct: number; isTracked: boolean }[]
    | undefined;

  if (curveData) {
    hasMeasuredBalance = curveData.balanceRatio != null;
    // An incomplete balance capture cannot weight this notional.
    balanceRatio = hasMeasuredBalance ? curveData.balanceRatio! : 1;
    balanceDetails = hasMeasuredBalance ? curveData.balanceDetails : undefined;
    if (isCryptoSwap(curveData.registryId)) {
      resolvedPoolType = "curve-cryptoswap";
      qualityMultiplier = QUALITY_MULTIPLIERS["curve-cryptoswap"]!;
    } else {
      ({ resolvedPoolType, qualityMultiplier } = classifyCurveStableSwapQuality(curveData.A));
    }
    // API Core may report only its priced legs in usdTotal. Keep the exact DL
    // inventory if any Lite leg is unvalued, even when the pool identity is proven.
    if (curveAddressMatch && (!CURVE_LITE_DEPLOYMENTS.has(chainNorm) ||
      (hasMeasuredBalance && Number.isFinite(curveData.tvl) && curveData.tvl >= 0))) {
      effectivePoolTvl = curveData.tvl;
    }
    if (curveData.creationTs > 0) {
      poolMaturityDays = Math.floor(
        (Date.now() / 1000 - curveData.creationTs) / DAY_SECONDS,
      );
    }
  } else if (poolType === "uniswap-v3-5bp" && (context.uniV3PoolFees.size > 0 || reviewedQuoterPool != null)) {
    const addrKey = canonicalExitRouteAssetKey(chainNorm, pool.pool);
    let feeTier = context.uniV3PoolFees.get(addrKey) ?? reviewedQuoterPool?.feePips;
    if (feeTier == null) {
      const symKey = `${chainNorm}:${poolSymbols
        .map((symbol) => symbol.toUpperCase())
        .sort()
        .join(":")}`;
      feeTier = context.uniV3SymbolFees.get(symKey);
    }
    if (feeTier != null) {
      feeTierForExtra = feeTier;
      if (feeTier <= 100) resolvedPoolType = "uniswap-v3-1bp";
      else if (feeTier <= 500) resolvedPoolType = "uniswap-v3-5bp";
      else resolvedPoolType = "uniswap-v3-30bp";
    }
    qualityMultiplier = getQualityMultiplier(resolvedPoolType);
  } else {
    qualityMultiplier = getQualityMultiplier(poolType);
  }

  if (
    pool.apyBase != null &&
    Number.isFinite(pool.apyBase) &&
    pool.apy != null &&
    Number.isFinite(pool.apy) &&
    pool.apy > 0.01
  ) {
    organicFraction = Math.min(1, Math.max(0, pool.apyBase / pool.apy));
    hasMeasuredOrganicFraction = true;
  } else if (pool.apyBase != null && Number.isFinite(pool.apyBase)) {
    organicFraction = pool.apyBase > 0 ? 1 : 0;
    hasMeasuredOrganicFraction = true;
  }
  if (poolMaturityDays === 0 && pool.count > 0) {
    poolMaturityDays = pool.count;
  }

  return {
    curveData,
    curveMeasuredRouteData,
    curveAddressMatch,
    resolvedPoolType,
    qualityMultiplier,
    feeTierForExtra,
    balanceRatio,
    hasMeasuredBalance,
    poolMaturityDays,
    organicFraction,
    hasMeasuredOrganicFraction,
    effectivePoolTvl,
    rawContribTvl: effectivePoolTvl,
    balanceDetails,
    volumeUsd1d: pool.volumeUsd1d ?? null,
    volumeUsd7d: pool.volumeUsd7d ?? null,
    volumeObservedAtSec: context.volumeObservedAtSec ?? null,
  };
}
