import { DAY_SECONDS } from "@shared/lib/time-constants";
import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import { QUALITY_MULTIPLIERS } from "../../lib/dex-cron-constants";
import {
  getQualityMultiplier,
  isCryptoSwap,
} from "./pool-helpers";
import { resolveActiveCurveCryptoSwapCandidateByTvl } from "./process-pool-execution-capability";
import type {
  PoolProcessingContext,
  PoolProtocolEnrichment,
  ResolvedPoolIdentity,
} from "./process-pool-types";

export function enrichPoolProtocol(
  context: PoolProcessingContext,
  identity: ResolvedPoolIdentity,
): PoolProtocolEnrichment {
  const { pool, protocol, chainNorm, poolSymbols, poolType } = identity;
  const activeCryptoSwapTvlMatch =
    protocol === "curve" &&
    identity.fpCurveKey != null &&
    !context.curvePoolMap.has(identity.fpCurveKey)
      ? resolveActiveCurveCryptoSwapCandidateByTvl(
          context.curvePoolCandidatesByFingerprint.get(identity.fpCurveKey) ?? [],
          pool.tvlUsd,
          chainNorm,
        )
      : null;
  const curveData =
    protocol === "curve"
      ? (context.curvePoolMap.get(identity.addrCurveKey) ??
        (identity.fpCurveKey != null
          ? context.curvePoolMap.get(identity.fpCurveKey)
          : undefined) ??
        context.curvePoolMap.get(identity.symCurveKey))
      : undefined;
  const curveAddressMatch =
    context.curvePoolMap.has(identity.addrCurveKey) ||
    (identity.fpCurveKey != null && context.curvePoolMap.has(identity.fpCurveKey));
  const curveMeasuredRouteData =
    activeCryptoSwapTvlMatch ?? (curveAddressMatch ? curveData : undefined);

  let qualityMultiplier: number;
  let resolvedPoolType = poolType;
  let feeTierForExtra: number | undefined;
  let balanceRatio = 1;
  let poolMaturityDays = 0;
  let organicFraction = 0.5;
  let hasMeasuredOrganicFraction = false;
  let effectivePoolTvl = pool.tvlUsd;
  let balanceDetails:
    | { symbol: string; balancePct: number; isTracked: boolean }[]
    | undefined;

  if (curveData) {
    balanceRatio = curveData.balanceRatio;
    balanceDetails = curveData.balanceDetails;
    if (isCryptoSwap(curveData.registryId)) {
      resolvedPoolType = "curve-cryptoswap";
      qualityMultiplier = QUALITY_MULTIPLIERS["curve-cryptoswap"]!;
    } else {
      resolvedPoolType =
        curveData.A >= 500 ? "curve-stableswap-high-a" : "curve-stableswap";
      qualityMultiplier = getQualityMultiplier(resolvedPoolType, curveData.A);
    }
    effectivePoolTvl = curveAddressMatch
      ? curveData.metapoolAdjustedTvl
      : pool.tvlUsd;
    if (curveData.creationTs > 0) {
      poolMaturityDays = Math.floor(
        (Date.now() / 1000 - curveData.creationTs) / DAY_SECONDS,
      );
    }
  } else if (poolType === "uniswap-v3-5bp" && context.uniV3PoolFees.size > 0) {
    const addrKey = canonicalExitRouteAssetKey(chainNorm, pool.pool);
    let feeTier = context.uniV3PoolFees.get(addrKey);
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
  } else if (
    poolType === "aerodrome-volatile" &&
    context.aerodromeIsStable.size > 0
  ) {
    const addrKey = canonicalExitRouteAssetKey(chainNorm, pool.pool);
    if (context.aerodromeIsStable.get(addrKey) === true) {
      resolvedPoolType = "aerodrome-stable";
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
    poolMaturityDays,
    organicFraction,
    hasMeasuredOrganicFraction,
    effectivePoolTvl,
    rawContribTvl: curveAddressMatch
      ? curveData!.metapoolAdjustedTvl
      : pool.tvlUsd,
    balanceDetails,
    volumeUsd1d: pool.volumeUsd1d ?? 0,
    volumeUsd7d: pool.volumeUsd7d,
  };
}
