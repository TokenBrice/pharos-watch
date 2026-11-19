import { DEPEG_SEVERITY_BPS } from "@shared/lib/depeg-config";
import { getMintBurnPressureUnavailableReason } from "../mint-burn-scoring";
import { z } from "zod";
import { getCirculatingRawOrNull, getPrevDayRawOrNull, getPrevWeekRawOrNull } from "@shared/lib/supply";
import { DEWS_ELIGIBLE_STABLECOINS } from "@shared/lib/psi-eligible";
import { getPegReference, isParityPrice, normalizePegType } from "@shared/lib/peg-rates";
import { getCommodityOuncesAtQuote } from "@shared/lib/commodity-median";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import { getReferenceMarket, getReferenceMarketClosureStart, getLegacyReferenceClosureStart } from "@shared/lib/reference-market-hours";
import { getPegTaxonomyByType, pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { evaluateReferenceAdmission, REFERENCE_INTRADAY_BUDGET_SEC } from "@shared/lib/reference-admission";
import { asRawDeviationBps } from "@shared/types/reference-admission";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { computeDEWS } from "../dews";
import type { DEWSInput, DEWSResult, PoolEntry } from "../dews";
import type { TopPoolsUnavailableReason } from "./types";
import { isAuthoritativeDepegPegReference } from "../depeg-trust-policy";
import type { DewsScoringResult, DewsScoringState, PersistedJsonDecodeReason } from "./contracts";
import { decodeJsonString } from "../cache-json";
import { CONTAGION_BUMP_DANGER, CONTAGION_BUMP_WARNING } from "../dews-contagion-policy";
import { CONTRACT_CONFIGS } from "../blacklist-contracts";
import { numberValue } from "@shared/lib/type-guards";
import { getDewsPrimaryQuoteClock, hasIndependentDewsVenues } from "./reference-evidence";
import { computeDivergSignal } from "./signal-families";
import { EVIDENCE_STRESS_THRESHOLD } from "@shared/lib/dews-config";
import { hasLoneMentoBrokerPrice } from "./evidence-policy";

// Missing `extra`/`balanceRatio` means "no balance measurement" (null), never perfect balance; a missing
// or invalid TVL, or a non-numeric ratio, makes the entry unreadable.
const RawPoolDataSchema = z.object({
  tvlUsd: z.number().finite().nonnegative(),
  extra: z
    .object({
      balanceRatio: z.number().finite().nullish(),
    })
    .nullish(),
});

const BLACKLIST_TRACKED_ID_SET = new Set(CONTRACT_CONFIGS.map((config) => config.stablecoinId));

interface BuildDewsScoringResultOptions extends DewsScoringState {
  registerMalformedPersistedInput: (options: {
    source: string;
    context: string;
    stablecoinId: string;
    updatedAt?: number | null;
    reason: PersistedJsonDecodeReason;
    degradesRun: boolean;
  }) => void;
}

type TopPoolsRead =
  | { pools: PoolEntry[]; unavailableReason: null }
  | { pools: null; unavailableReason: TopPoolsUnavailableReason };

const TOP_POOLS_DECODE_UNAVAILABLE_REASON = {
  missing: "top-pools-missing",
  "json-parse-failed": "top-pools-json-parse-failed",
  "invalid-shape": "top-pools-invalid-shape",
} as const;

/**
 * Reads the worst-pool evidence for one asset. A readable `[]` is an observed empty set; a missing,
 * unparseable or non-array list, or any unreadable entry, makes the list unavailable for this asset only.
 * Decode failures are recorded as per-asset diagnostics (`degradesRun: false`): the asset's pool signal
 * degrades through its unavailable worst-pool component, never through a whole-cohort hold.
 */
function readTopPools(
  stablecoinId: string,
  topPoolsJson: string | null,
  updatedAt: number | null,
  registerMalformedPersistedInput: BuildDewsScoringResultOptions["registerMalformedPersistedInput"],
): TopPoolsRead {
  if (!topPoolsJson) return { pools: null, unavailableReason: "top-pools-missing" };

  const decoded = decodeJsonString<unknown[], keyof typeof TOP_POOLS_DECODE_UNAVAILABLE_REASON>(topPoolsJson, {
    updatedAt,
    missingReason: "missing",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) =>
      Array.isArray(parsed) ? { ok: true, payload: parsed } : { ok: false, reason: "invalid-shape" as const },
  });

  if (!decoded.ok) {
    registerMalformedPersistedInput({
      source: "dex_liquidity",
      context: "dex_liquidity.top_pools_json",
      stablecoinId,
      updatedAt,
      reason: decoded.reason,
      degradesRun: false,
    });
    return { pools: null, unavailableReason: TOP_POOLS_DECODE_UNAVAILABLE_REASON[decoded.reason] };
  }

  const pools: PoolEntry[] = [];
  for (const rawPool of decoded.payload) {
    const parsedPool = RawPoolDataSchema.safeParse(rawPool);
    if (!parsedPool.success) {
      registerMalformedPersistedInput({
        source: "dex_liquidity",
        context: "dex_liquidity.top_pools_json[entry]",
        stablecoinId,
        updatedAt,
        reason: "invalid-shape",
        degradesRun: false,
      });
      return { pools: null, unavailableReason: "top-pools-entry-malformed" };
    }
    pools.push({ tvlUsd: parsedPool.data.tvlUsd, balanceRatio: parsedPool.data.extra?.balanceRatio ?? null });
  }
  return { pools, unavailableReason: null };
}

export function buildDewsScoringResult(options: BuildDewsScoringResultOptions): DewsScoringResult {
  const {
    assetById,
    nowSec,
    pegRates,
    pegRateContributorCounts = {},
    pegRateSources = {},
    registerMalformedPersistedInput,
    sourceState,
  } = options;
  const results: DewsScoringResult["results"] = [];
  let liqHistCoverageCount = 0;
  let insufficientDataCount = 0;
  const noCurrentSupplyIds: string[] = [];

  const scored: Array<{ input: DEWSInput; firstPass: DEWSResult }> = [];
  for (const meta of DEWS_ELIGIBLE_STABLECOINS) {
    const asset = assetById.get(meta.id);
    if (!asset) continue;
    const pegType = normalizePegType(asset.pegType) ?? null;
    if (pegType != null && pegType !== pegTypeFromCurrency(meta.flags.pegCurrency)) {
      registerMalformedPersistedInput({ source: "stablecoins", context: "stablecoins.pegType", stablecoinId: meta.id,
        reason: "invalid-shape", degradesRun: true });
      continue;
    }

    // Retire only on observed zero. When native quantity exists it owns the verdict.
    const current = getCirculatingRawOrNull(asset);
    if (asset.circulatingNative === 0 || (asset.circulatingNative == null && current === 0)) {
      noCurrentSupplyIds.push(meta.id);
      continue;
    }
    if (current === null) continue;

    const nativeHistory = sourceState.nativeHistory?.get(meta.id);
    const useNativeSupply = asset.supplyObservedAt != null && (nativeHistory != null
      || (asset.circulatingNative !== undefined && sourceState.nativeHistory === null));

    const dexLiq = sourceState.dexLiquidity.dexLiqMap.get(meta.id);
    const dexPrice = sourceState.dexPrices.dexPriceMap.get(meta.id);
    const liqHist = sourceState.liquidityHistory.liqHist7dMap.get(meta.id);
    if (liqHist) liqHistCoverageCount++;
    const prevSnapshot = sourceState.previousSignals.prevSignals.get(meta.id);
    const prev = prevSnapshot?.signals;
    // An unreadable accepted-generation pointer leaves the previous reading
    // unavailable, not absent: the persisted unavailable envelope (`{value: 0,
    // available: false}`) makes the pool signal report `previous-unavailable`
    // instead of claiming `no-previous`.
    const previousUnavailable = sourceState.previousSignals.generationUnavailable;
    const mintBurn = sourceState.mintBurn.mintBurnMap.get(meta.id);
    const mintBurnAgeSec = sourceState.mintBurn.mintBurnAgeSecById.get(meta.id) ?? null;
    const yieldSourceRisk = sourceState.yieldRankings.yieldSourceRisk.get(meta.id) ?? null;
    const yieldSourceOverdue = sourceState.yieldRankings.overdueSourceIds?.has(meta.id) === true;
    const yieldRankChangeAttribution = sourceState.yieldRankings.yieldRankChangeAttribution.get(meta.id) ?? null;
    const hasYieldRankingEvidence = yieldSourceOverdue || yieldSourceRisk != null || yieldRankChangeAttribution != null;

    const hasBlacklistTracking = BLACKLIST_TRACKED_ID_SET.has(meta.id);
    const blacklistCounts = hasBlacklistTracking ? sourceState.blacklist.blacklistCounts.get(meta.id) : undefined;

    const topPools = readTopPools(
      meta.id,
      dexLiq?.top_pools_json ?? null,
      dexLiq?.updated_at ?? null,
      registerMalformedPersistedInput,
    );

    const market = getReferenceMarket(getPegTaxonomyByType(pegType ?? undefined)?.currency);
    const scheduled = market != null && nowSec != null && sourceState.references !== undefined &&
      sourceState.legacyFxReferenceIds?.has(meta.id) !== true;
    const selected = pegType == null ? undefined : sourceState.references?.get(pegType);
    const hasPegReference = scheduled ? selected != null : pegType != null
      && (pegType === "peggedUSD" || Object.prototype.hasOwnProperty.call(pegRates, pegType));
    const pegRateSource = scheduled ? selected?.kind ?? null : pegType == null ? null : pegRateSources[pegType] ?? null;
    const pegRateContributorCount = scheduled ? selected?.kind === "median" ? selected.contributors.length : null
      : pegType == null ? null : pegRateContributorCounts[pegType] ?? null;
    const pegReferenceTrusted =
      hasPegReference &&
      isAuthoritativeDepegPegReference({
        pegCurrency: meta.flags?.pegCurrency ?? null,
        pegType,
        pegRateSource,
        pegRateContributorCount,
      });
    const hasEntitlement = market === "metal" && asset.commodityEntitlement !== undefined;
    const ouncesAt = (quoteObservedAtSec: number | null) => getCommodityOuncesAtQuote(meta.commodityOunces,
      scheduled || hasEntitlement ? { assetId: meta.id, commodityEntitlement: asset.commodityEntitlement, quoteObservedAtSec } : undefined);
    const pegRefFor = (ounces: number | null) => pegReferenceTrusted && pegType != null && ounces != null
      ? getPegReference(pegType, scheduled && selected ? { [pegType]: selected.usdPerUnit } : pegRates, ounces) : null;
    const parityPrice = isParityPrice(asset) ? asset.price ?? null : null;
    const primaryClock = nowSec != null && parityPrice != null && (scheduled || hasEntitlement)
      ? getDewsPrimaryQuoteClock(asset, nowSec) : null;
    const primaryOunces = ouncesAt(primaryClock);
    const dexOunces = ouncesAt(dexPrice?.updatedAt ?? null);
    const price = primaryOunces == null ? null : parityPrice;
    const dexPriceUsd = dexOunces == null ? null : dexPrice?.dexPriceUsd ?? null;
    // Both legs use the same denominator only after each qualifies for the same unit.
    const pegRef = pegRefFor(primaryOunces ?? dexOunces) ?? 0;
    const closureStart = scheduled ? getReferenceMarketClosureStart(market, nowSec) : null;
    const legacyMarketHeld = !scheduled && market != null && nowSec != null && pegRef > 0
      && getLegacyReferenceClosureStart(market, nowSec) !== null && Math.max(
        deriveDepegSignal(price ?? NaN, pegRef)?.absRawBps ?? 0,
        deriveDepegSignal(dexPriceUsd ?? NaN, pegRef)?.absRawBps ?? 0,
      ) < DEPEG_SEVERITY_BPS.severe;
    const reference = pegReferenceTrusted ? selected : undefined;
    const evaluateLeg = (leg: number | null, quoteObservedAtSec: number | null, ounces: number | null) => {
      const legPegRef = pegRefFor(ounces);
      const raw = leg == null || legPegRef == null ? null : deriveDepegSignal(leg, legPegRef)?.rawBps;
      return evaluateReferenceAdmission({
        ...(legPegRef != null && reference ? reference : { kind: "none" }),
        decisionAtSec: nowSec!,
        quoteObservedAtSec,
        rawDeviationBps: raw != null && Number.isFinite(raw) ? asRawDeviationBps(raw) : null,
      });
    };
    const referenceAdmission = scheduled ? {
      primary: evaluateLeg(parityPrice, primaryClock, primaryOunces),
      dex: evaluateLeg(dexPrice?.dexPriceUsd ?? null, dexPrice?.updatedAt ?? null, dexOunces),
    } : undefined;
    const priorReference = sourceState.previousSignals.referenceDivergenceById?.get(meta.id);
    const carriedReferenceDivergence = closureStart != null && priorReference != null
      && priorReference.observedAtSec >= closureStart - REFERENCE_INTRADAY_BUDGET_SEC ? priorReference : undefined;
    const venueSpreadBps = !scheduled && !hasEntitlement ? undefined
      : !legacyMarketHeld && primaryClock != null && price != null && dexPrice && dexPriceUsd != null
        && hasIndependentDewsVenues(asset, dexPrice)
        ? numberValue(deriveDepegSignal(price, dexPriceUsd)?.absBps) : null;
    const pegReferenceUnavailableReason = pegType == null
      ? "peg-type-unavailable"
      : !hasPegReference
        ? "peg-reference-missing"
        : !pegReferenceTrusted
          ? "peg-reference-untrusted"
          : closureStart != null || legacyMarketHeld
            ? "reference-market-closed"
            : referenceAdmission && ![referenceAdmission.primary, referenceAdmission.dex].some((leg) => leg.status === "admitted")
              ? (parityPrice != null ? referenceAdmission.primary.reason : referenceAdmission.dex.reason)
              : primaryOunces == null && dexOunces == null ? "commodity-entitlement-unavailable" : null;
    const input: DEWSInput = {
      stablecoinId: meta.id,
      mcapUsd: current,
      pegType,
      circulatingCurrent: useNativeSupply ? asset.circulatingNative ?? null : current,
      circulatingPrevDay: useNativeSupply ? nativeHistory?.day ?? null : getPrevDayRawOrNull(asset),
      circulatingPrevWeek: useNativeSupply ? nativeHistory?.week ?? null : getPrevWeekRawOrNull(asset),
      legacySupplyUsd: useNativeSupply && nativeHistory ? {
        day: nativeHistory.day === undefined ? getPrevDayRawOrNull(asset) : null,
        week: nativeHistory.week === undefined ? getPrevWeekRawOrNull(asset) : null,
      } : undefined,
      weightedBalanceRatio: dexLiq?.weighted_balance_ratio ?? null,
      avgPoolStress: dexLiq?.avg_pool_stress ?? null,
      topPools: topPools.pools,
      topPoolsUnavailableReason: topPools.unavailableReason,
      liquidityScore: dexLiq?.liquidity_score ?? null,
      liquidityScore7dAgo: liqHist?.score ?? null,
      tvlCurrent: dexLiq?.total_tvl_usd ?? null,
      tvl7dAgo: liqHist?.tvl ?? null,
      priceConfidence: asset.priceConfidence ?? null,
      prevPriceConfidence: (prev?.price as { confidence?: string })?.confidence ?? null,
      observedPrice: isObservedPrice(asset) ? asset.price ?? null : null,
      price,
      priceSource: asset.priceSource ?? null,
      agreeSources: asset.agreeSources,
      pegRef,
      pegReferenceAvailable: pegReferenceTrusted && !legacyMarketHeld,
      pegReferenceUnavailableReason,
      referenceAdmission,
      carriedReferenceDivergence,
      venueSpreadBps,
      pegRateSource,
      pegRateContributorCount,
      dexPriceUsd,
      independentDexPrices: hasEntitlement ? dexPrice?.independentQuotes
        ?.filter(({ observedAtSec }) => ouncesAt(observedAtSec) != null).map(({ price }) => price) : dexPrice?.independentPrices,
      blacklistEvents24h: blacklistCounts?.count24h ?? 0,
      blacklistEvents7d: blacklistCounts?.count7d ?? 0,
      hasBlacklistTracking,
      blacklistSourceOk: sourceState.blacklist.blacklistSourceOk,
      burnVolume24hUsd: mintBurn?.burn24h ?? null,
      flowIsolated: mintBurn?.isolated === true,
      flowScope: mintBurn?.scope,
      flowChainIds: mintBurn?.chainIds,
      flowHolderPressureWithheld: getMintBurnPressureUnavailableReason(meta.id) != null,
      flowEpochIssue: mintBurn?.epochIssue,
      mintVolume24hUsd: mintBurn?.mint24h ?? null,
      burnBaseline30dUsd: mintBurn?.burnBaseline ?? null,
      flowDataAgeDays: mintBurnAgeSec == null ? null : mintBurnAgeSec / DAY_SECONDS,
      flowBaselineDays: mintBurn?.baselineDays ?? null,
      flowValuation24h: mintBurn?.valuation24h ?? null,
      flowBurnBaselineValuation: mintBurn?.burnBaselineValuation ?? null,
      yieldWarnings: sourceState.yieldWarnings.yieldWarnings.get(meta.id) ?? [],
      yieldSourceRisk,
      yieldSourceOverdue,
      yieldRankChangeAttribution,
      psiScore: sourceState.psi.latestPsiScore,
      prevPoolValue: prev?.pool?.value ?? (previousUnavailable ? 0 : undefined),
      prevPoolAvailable: prev?.pool?.available === true,
      prevPoolComponentCoverage: numberValue((prev?.pool as { componentCoverage?: unknown } | undefined)?.componentCoverage),
      prevDivergValue: referenceAdmission
        ? numberValue((prev?.diverg as { currentDivergenceValue?: unknown } | undefined)?.currentDivergenceValue) ?? undefined
        : prev?.diverg?.value,
      prevDivergAvailable: prev?.diverg?.available === true,
      contagionAmplifier: 1,
      sourceAges: {
        dexLiquidity: sourceState.dexLiquidity.dexLiqAgeSecById.get(meta.id) ?? null,
        dexPrice: sourceState.dexPrices.dexPriceAgeSecById.get(meta.id) ?? null,
        previousSignals: prevSnapshot?.ageSec ?? null,
        mintBurn: mintBurnAgeSec,
        yieldRankings: hasYieldRankingEvidence ? sourceState.yieldRankings.yieldRankingsAgeSec : null,
      },
      staleFlags: {
        dexLiquidity: sourceState.dexLiquidity.dexLiqStaleIds.has(meta.id),
        dexPrice: sourceState.dexPrices.dexPriceStaleIds.has(meta.id),
        previousSignals: sourceState.previousSignals.prevSignalStaleIds.has(meta.id),
        mintBurn: sourceState.mintBurn.mintBurnStaleIds.has(meta.id),
        yieldRankings: hasYieldRankingEvidence && sourceState.yieldRankings.yieldRankingsRetained,
        pegReference: scheduled ? pegReferenceUnavailableReason != null : !pegReferenceTrusted,
      },
    };
    if (referenceAdmission && dexPrice?.independentQuotes && hasLoneMentoBrokerPrice(input)) {
      input.independentDexDivergence = dexPrice.independentQuotes.some(({ price: dex, observedAtSec }) => {
        const signal = computeDivergSignal({
          ...input, price: null, dexPriceUsd: dex, venueSpreadBps: null, carriedReferenceDivergence: undefined,
          prevDivergAvailable: false,
          referenceAdmission: { primary: referenceAdmission.primary, dex: evaluateLeg(dex, observedAtSec, ouncesAt(observedAtSec)) },
        });
        return signal.available && signal.value >= EVIDENCE_STRESS_THRESHOLD;
      });
    }

    const firstPass = computeDEWS(input);
    if (!firstPass) {
      insufficientDataCount++;
      continue;
    }
    scored.push({ input, firstPass });
  }

  const peerBumps = new Map<string, { id: string; strongest: number; second: number }>();
  for (const { input, firstPass } of scored) {
    const bump =
      firstPass.band === "DANGER" ? CONTAGION_BUMP_DANGER : firstPass.band === "WARNING" ? CONTAGION_BUMP_WARNING : 1;
    // An unavailable peg type has no contagion cohort to amplify.
    if (bump <= 1 || input.pegType == null) continue;
    const current = peerBumps.get(input.pegType);
    if (!current || bump > current.strongest) {
      peerBumps.set(input.pegType, { id: input.stablecoinId, strongest: bump, second: current?.strongest ?? 1 });
    } else {
      current.second = Math.max(current.second, bump);
    }
  }

  for (const { input, firstPass } of scored) {
    const bumps = input.pegType == null ? undefined : peerBumps.get(input.pegType);
    const contagion = (bumps?.id === input.stablecoinId ? bumps.second : bumps?.strongest) ?? 1;
    const finalResult = contagion > 1 ? computeDEWS({ ...input, contagionAmplifier: contagion }) : firstPass;
    if (!finalResult) {
      insufficientDataCount++;
      continue;
    }
    results.push({
      stablecoinId: input.stablecoinId,
      score: finalResult.score,
      band: finalResult.band,
      signals: finalResult.signals,
      amplifiers: finalResult.amplifiers,
      baseScore: finalResult.baseScore,
      finalScore: finalResult.finalScore,
      availableWeight: finalResult.availableWeight,
      effectiveWeights: finalResult.effectiveWeights,
      evidenceKinds: finalResult.evidenceKinds,
      insufficientEvidenceReason: finalResult.insufficientEvidenceReason,
      dataQualityScore: finalResult.dataQualityScore,
      topContributors: finalResult.topContributors,
      ...(finalResult.sourceAges ? { sourceAges: finalResult.sourceAges } : {}),
      ...(finalResult.staleFlags ? { staleFlags: finalResult.staleFlags } : {}),
    });
  }

  return {
    results,
    liqHistCoverageCount,
    insufficientDataCount,
    noCurrentSupplyIds,
  };
}
