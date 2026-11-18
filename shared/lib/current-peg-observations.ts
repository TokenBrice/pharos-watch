import { WORKER_TRACKED_META_BY_ID, WORKER_ACTIVE_STABLECOINS } from "./stablecoins/worker-runtime-registry";
import { derivePegRates, getPegReference, isParityPrice, normalizePegType, type PegRatesResult } from "./peg-rates";
import { pegTypeFromCurrency } from "./peg-taxonomy";
import { getCirculatingRawOrNull } from "./supply";
import { isObservedPrice } from "./pricing-source-policy";
import { isAuthoritativeDepegPegReference } from "./peg-reference-trust";
import type { StablecoinData } from "../types/supply";
import { deriveDepegSignal, relativeBps, type DepegSignal } from "./depeg-signals";
import { classifyPrimaryDepegTrust } from "./depeg-primary-trust";
import { DEPEG_EVENT_MIN_SUPPLY_USD } from "./depeg-config";
import type { CurrentPeg } from "../types/current-peg";
import { asRawDeviationBps, type ReferenceAdmission } from "../types/reference-admission";
import { admittedDeviationBps, evaluateReferenceAdmission, type ReferenceAdmissionInput } from "./reference-admission";
import { getReferenceMarket, getReferenceSessionState } from "./reference-market-hours";
import { isRecord } from "./type-guards";

export interface CurrentPegObservation extends CurrentPeg {
  currentSignal: DepegSignal | null;
  /**
   * The asset (or its current supply buckets) is absent, so the live-event supply floor
   * cannot be assessed. This does not withhold an otherwise observed deviation.
   */
  currentSupplyUnavailable: boolean;
}

/** A clocked generation opts in by default, including pegs without a matching clock. */
export function hasFxReferenceEvidence(observations: unknown): boolean {
  return isRecord(observations);
}

// A published marker is scoped to one asset, peg and accepted publication.
export function getPublishedLegacyPegReference(
  asset: Pick<StablecoinData, "pegType" | "currentPeg"> | undefined,
  publication: { fxReferenceObservations?: unknown; fxFallbackRates?: Record<string, number> },
  asOf: number,
): NonNullable<CurrentPeg["pegReference"]> | undefined {
  const pegType = normalizePegType(asset?.pegType);
  const observation = asset?.currentPeg;
  const reference = observation?.pegReference;
  const evidence = publication.fxReferenceObservations;
  if (!pegType || !isRecord(evidence) || Object.prototype.hasOwnProperty.call(evidence, pegType) ||
      observation?.legacyFxReference !== true || observation.pegReferenceUnavailable || observation.currentPriceUnavailable ||
      observation.referenceAdmission !== undefined || observation.admittedDeviationBps !== undefined ||
      !reference || reference.asOf !== asOf || !Number.isFinite(reference.valueUsd) || reference.valueUsd <= 0) return;
  const fallback = publication.fxFallbackRates?.[pegType];
  if (fallback == null || !Number.isFinite(fallback) || fallback <= 0) return;
  if (pegType === "peggedGOLD" || pegType === "peggedSILVER") {
    const unit = reference.usdPerTroyOunce;
    if (unit != null && Number.isFinite(unit) && unit > 0 &&
        (reference.source === "median" || (reference.source === "fallback" && unit === fallback))) return reference;
  } else if (pegType !== "peggedUSD" && reference.source === "fx" && reference.valueUsd === fallback) {
    return reference;
  }
}

function evaluateSelectedReference(
  evidence: Pick<ReferenceAdmissionInput, "quoteObservedAtSec" | "decisionAtSec" | "rawDeviationBps" | "generation" | "purpose">,
  pegType: string | undefined,
  pegCurrency: string,
  rates: PegRatesResult,
): ReferenceAdmission {
  const kind = pegType ? rates.sources[pegType] : undefined;
  if (kind === "median" && pegType) {
    return evaluateReferenceAdmission({ ...evidence, kind, pegKey: pegType, contributors: rates.contributors?.[pegType] ?? [] });
  }
  const observation = pegType ? rates.observations?.[pegType] : undefined;
  if (kind === "fx" || kind === "fallback") {
    if (!observation) {
      return { ...evaluateReferenceAdmission({ ...evidence, kind: "none" }),
        kind, status: "unavailable", reason: "reference-clock-unavailable" };
    }
    const market = getReferenceMarket(pegCurrency);
    const sessionOpenedAtSec = market ? getReferenceSessionState(market, evidence.decisionAtSec).sessionOpenedAtSec : null;
    const anchors = observation.repricing;
    const repricing = anchors && anchors.sessionOpenedAtSec === sessionOpenedAtSec &&
      (anchors.source === undefined || anchors.source === observation.source) ? anchors : undefined;
    return evaluateReferenceAdmission({ ...evidence, ...repricing, kind, observation });
  }
  return evaluateReferenceAdmission({ ...evidence, kind: "none" });
}

export function deriveCurrentPegObservationMap(options: {
  peggedAssets: StablecoinData[];
  fxFallbackRates?: Record<string, number>;
  fxReferenceObservations?: unknown;
  legacyFxPegs?: ReadonlySet<string>;
  pegRates?: PegRatesResult;
  generation?: string;
  asOf: number;
  now?: number;
  dexPrices?: ReadonlyMap<string, CurrentPegDexPrice>;
}): Map<string, CurrentPegObservation> {
  const priceById = new Map(options.peggedAssets.map((asset) => [asset.id, asset]));
  const decisionAtSec = options.now ?? options.asOf;
  const referenceRates = options.pegRates ?? derivePegRates(
    options.peggedAssets, WORKER_TRACKED_META_BY_ID, options.fxFallbackRates, options.fxReferenceObservations, decisionAtSec,
  );
  const evidence = options.fxReferenceObservations;
  const publishedLegacyById = new Map<string, NonNullable<CurrentPeg["pegReference"]>>();
  let hasLegacyBullion = false;
  if (options.legacyFxPegs === undefined && hasFxReferenceEvidence(evidence)) {
    for (const asset of options.peggedAssets) {
      const reference = getPublishedLegacyPegReference(asset, options, options.asOf);
      if (!reference) continue;
      publishedLegacyById.set(asset.id, reference);
      if (reference.usdPerTroyOunce !== undefined) hasLegacyBullion = true;
    }
  }
  const legacyBullionRates = hasLegacyBullion
    ? derivePegRates(options.peggedAssets, WORKER_TRACKED_META_BY_ID, options.fxFallbackRates) : undefined;
  const result = new Map<string, CurrentPegObservation>();

  for (const meta of WORKER_ACTIVE_STABLECOINS) {
    const asset = priceById.get(meta.id);
    const observedAsset = asset && hasUsableCurrentPrice(asset) ? asset : undefined;
    const supply = getCirculatingRawOrNull(asset);
    const { navToken, pegCurrency } = meta.flags;
    const currentPriceUnavailable = !navToken && !observedAsset;
    const pegType = normalizePegType(asset?.pegType);
    const registryPegType = pegTypeFromCurrency(pegCurrency);
    const referencePegType = !navToken && (registryPegType == null || registryPegType === pegType) ? pegType : undefined;
    const unit = {
      assetId: meta.id, commodityEntitlement: asset?.commodityEntitlement, quoteObservedAtSec: observedAsset?.priceObservedAt,
    };
    const publishedLegacy = publishedLegacyById.get(meta.id);
    const candidate = publishedLegacy?.usdPerTroyOunce !== undefined ? legacyBullionRates ?? referenceRates : referenceRates;
    const legacyFxReference = isRecord(evidence) && !!referencePegType &&
      !Object.prototype.hasOwnProperty.call(evidence, referencePegType) && (
        options.legacyFxPegs?.has(referencePegType) ?? (
          publishedLegacy !== undefined &&
          publishedLegacy.source === candidate.sources[referencePegType] &&
          publishedLegacy.valueUsd === getPegReference(referencePegType, candidate.rates, meta.commodityOunces, unit) &&
          (publishedLegacy.usdPerTroyOunce === undefined || publishedLegacy.usdPerTroyOunce === candidate.rates[referencePegType])
        )
      );
    const selectedRates = legacyFxReference ? candidate : referenceRates;
    const { rates: pegRates, sources: pegRateSources, counts: pegRateCounts } = selectedRates;
    const pegRef = getPegReference(referencePegType, pegRates, meta.commodityOunces, unit);
    const source = referencePegType ? pegRateSources[referencePegType] : undefined;
    const contributorCount = referencePegType ? pegRateCounts[referencePegType] ?? 0 : 0;
    const unresolvedMedian = registryPegType == null && source === "median" &&
      (pegCurrency === "OTHER" || pegCurrency === "VAR");
    const parityQuote = observedAsset && isParityPrice(observedAsset);
    const authoritative = !unresolvedMedian && pegRef != null && Number.isFinite(pegRef) && isAuthoritativeDepegPegReference({
      pegType: referencePegType, pegCurrency, pegRateSource: source, pegRateContributorCount: contributorCount,
    });
    const pegReferenceUnavailable = !navToken && !!observedAsset && (!authoritative || !parityQuote);
    const signal = parityQuote && authoritative ? deriveDepegSignal(observedAsset.price, pegRef) : null;
    const rawSignal = signal && Number.isFinite(signal.rawBps) ? signal : null;
    const admissionEnabled = hasFxReferenceEvidence(evidence) && !legacyFxReference;
    const rawDeviationBps = admissionEnabled && rawSignal ? asRawDeviationBps(rawSignal.rawBps) : null;
    const fixedUsd = !navToken && pegCurrency === "USD";
    const referenceAdmission = !admissionEnabled || fixedUsd ? undefined : evaluateSelectedReference({
      quoteObservedAtSec: !navToken && observedAsset?.priceObservedAtMode === "upstream" ? observedAsset.priceObservedAt : null,
      decisionAtSec, rawDeviationBps, generation: options.generation, purpose: "current",
    }, unresolvedMedian || (observedAsset && (!parityQuote || pegRef == null)) ? undefined : referencePegType, pegCurrency, selectedRates);
    const withheld = referenceAdmission != null && referenceAdmission.status !== "admitted";
    const currentSignal = withheld ? null : rawSignal;
    const currentDeviationBps = currentSignal?.bps ?? null;
    const referenceAsOf = !admissionEnabled || fixedUsd ? options.asOf : referenceAdmission?.referenceObservedAtSec;
    // The dated denominator can still support an independently budgeted currency conversion.
    const pegReference = parityQuote && authoritative && source && referenceAsOf != null &&
      referenceAdmission?.status !== "unavailable" ? {
      valueUsd: pegRef,
      ...((referencePegType === "peggedGOLD" || referencePegType === "peggedSILVER")
        ? { usdPerTroyOunce: pegRates[referencePegType] }
        : {}),
      source, contributorCount, asOf: referenceAsOf,
    } : null;
    const primaryTrust = asset ? classifyPrimaryDepegTrust(asset, decisionAtSec) : "unusable";
    const dexRow = options.dexPrices?.get(meta.id);
    let dexPriceCheck: CurrentPeg["dexPriceCheck"] = null;
    const dexUnitComparable = meta.id !== "susd-solayer" || asset?.parityQuoteUnit === undefined;
    if (!pegReferenceUnavailable && dexUnitComparable && dexRow && supply !== null && supply >= DEPEG_EVENT_MIN_SUPPLY_USD) {
      const dexUnit = { ...unit, quoteObservedAtSec: dexRow.observedAtSec };
      const dexPegType = registryPegType ?? pegType ?? null;
      const dexReference = getPegReference(dexPegType ?? undefined, pegRates, meta.commodityOunces, dexUnit);
      const dexRawSignal = !navToken && dexReference != null ? deriveDepegSignal(dexRow.dex_price_usd, dexReference) : null;
      const dexAdmission = admissionEnabled && !fixedUsd && !navToken ? evaluateSelectedReference({
        quoteObservedAtSec: dexRow.observedAtSec ?? null, decisionAtSec, generation: options.generation, purpose: "current",
        rawDeviationBps: dexRawSignal ? asRawDeviationBps(dexRawSignal.rawBps) : null,
      }, dexReference != null && !unresolvedMedian ? dexPegType ?? undefined : undefined, pegCurrency, selectedRates) : undefined;
      const dexBps = navToken
        ? primaryTrust !== "unusable" && asset?.price != null
          ? deriveDepegSignal(dexRow.dex_price_usd, asset.price)?.bps ?? null : null
        : dexRawSignal?.bps ?? (dexReference == null && meta.id !== "xagm-matrixdock"
          ? deriveDexDeviationBps(dexRow.dex_price_usd, null, pegRates, meta.commodityOunces, currentDeviationBps, dexRow.deviation_from_primary_bps)
          : null);
      const quoteDifference = dexAdmission && observedAsset ? relativeBps(dexRow.dex_price_usd, observedAsset.price) : null;
      if (dexBps != null && (!dexAdmission || (dexAdmission.status === "admitted" && quoteDifference))) dexPriceCheck = {
        dexPrice: dexRow.dex_price_usd, dexDeviationBps: dexBps,
        agrees: quoteDifference ? quoteDifference.absRawBps < 50
          : Math.abs(dexBps - (currentDeviationBps ?? 0)) < 50,
        sourcePools: dexRow.source_pool_count, sourceTvl: dexRow.source_total_tvl,
        ...(dexRow.observedAtSec != null ? { observedAtSec: dexRow.observedAtSec } : {}),
        ...(dexAdmission ? { referenceAdmission: dexAdmission } : {}),
      };
    }

    result.set(meta.id, {
      primaryTrust,
      dexPriceCheck,
      dexPriceCheckExpiresAt: dexPriceCheck && !currentPriceUnavailable ? dexRow?.expiresAt ?? null : null,
      currentDeviationBps,
      ...(legacyFxReference && pegReference ? { legacyFxReference: true as const } : {}),
      ...(referenceAdmission ? { referenceAdmission } : {}),
      ...(admissionEnabled ? {
        admittedDeviationBps: referenceAdmission ? admittedDeviationBps(rawDeviationBps, referenceAdmission) : rawDeviationBps,
      } : {}),
      currentSignal,
      pegReference,
      pegReferenceUnavailable: pegReferenceUnavailable || (withheld && !navToken),
      currentPriceUnavailable,
      currentSupplyUnavailable: !navToken && supply === null,
    });
  }

  return result;
}

/** The published quotes peg summary measures; the detail overlay displays exactly these. */
export function hasUsableCurrentPrice(asset: StablecoinData): asset is StablecoinData & { price: number } {
  return isObservedPrice(asset) && typeof asset.price === "number" && Number.isFinite(asset.price) && asset.price > 0;
}

export interface CurrentPegDexPrice {
  expiresAt: number;
  observedAtSec?: number;
  dex_price_usd: number;
  deviation_from_primary_bps: number | null;
  source_pool_count: number;
  source_total_tvl: number;
}

export function deriveDexDeviationBps(
  dexPriceUsd: number,
  pegType: string | null,
  pegRates: Record<string, number>,
  commodityOunces: number | undefined,
  currentDeviationBps: number | null,
  dexVsPrimaryBps: number | null,
): number | null {
  const pegRef = pegType
    ? getPegReference(pegType, pegRates, commodityOunces)
    : null;
  if (pegRef != null && Number.isFinite(pegRef) && pegRef > 0 && Number.isFinite(dexPriceUsd) && dexPriceUsd > 0) {
    return deriveDepegSignal(dexPriceUsd, pegRef)?.bps ?? null;
  }
  if (currentDeviationBps != null && dexVsPrimaryBps != null) {
    const currentMultiplier = 1 + currentDeviationBps / 10000;
    const dexVsPrimaryMultiplier = 1 + dexVsPrimaryBps / 10000;
    return Math.round(((currentMultiplier * dexVsPrimaryMultiplier) - 1) * 10000);
  }
  return null;
}
