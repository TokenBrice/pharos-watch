import { WORKER_TRACKED_META_BY_ID, WORKER_ACTIVE_STABLECOINS } from "./stablecoins/worker-runtime-registry";
import { derivePegRates, getPegReference, normalizePegType } from "./peg-rates";
import { pegTypeFromCurrency } from "./peg-taxonomy";
import { getCirculatingRawOrNull } from "./supply";
import { isObservedPrice } from "./pricing-source-policy";
import { isAuthoritativeDepegPegReference } from "./peg-reference-trust";
import type { StablecoinData } from "../types/market";
import { deriveDepegSignal, type DepegSignal } from "./depeg-signals";
import { classifyPrimaryDepegTrust } from "./depeg-primary-trust";
import { DEPEG_EVENT_MIN_SUPPLY_USD } from "./depeg-config";
import type { CurrentPeg } from "../types/current-peg";

export interface CurrentPegObservation extends CurrentPeg {
  currentSignal: DepegSignal | null;
  /**
   * The asset (or its current supply buckets) is absent, so the live-event supply floor
   * cannot be assessed. This does not withhold an otherwise observed deviation.
   */
  currentSupplyUnavailable: boolean;
}

export function deriveCurrentPegObservationMap(options: {
  peggedAssets: StablecoinData[];
  fxFallbackRates?: Record<string, number>;
  asOf: number;
  now?: number;
  dexPrices?: ReadonlyMap<string, CurrentPegDexPrice>;
}): Map<string, CurrentPegObservation> {
  const priceById = new Map(options.peggedAssets.map((asset) => [asset.id, asset]));
  const {
    rates: pegRates,
    sources: pegRateSources = {},
    counts: pegRateCounts = {},
  } = derivePegRates(options.peggedAssets, WORKER_TRACKED_META_BY_ID, options.fxFallbackRates);
  const result = new Map<string, CurrentPegObservation>();

  for (const meta of WORKER_ACTIVE_STABLECOINS) {
    const asset = priceById.get(meta.id);
    const supply = getCirculatingRawOrNull(asset);
    const currentSupplyUnavailable = !meta.flags.navToken && supply === null;
    const currentPriceUnavailable =
      !meta.flags.navToken && (asset === undefined || !hasUsableCurrentPrice(asset));
    let currentDeviationBps: number | null = null;
    let currentSignal: DepegSignal | null = null;
    let pegReferenceUnavailable = false;
    let pegReference: CurrentPeg["pegReference"] = null;

    if (!meta.flags.navToken && asset && hasUsableCurrentPrice(asset)) {
      const pegType = normalizePegType(asset.pegType);
      // One authority for the peg unit: the curated registry currency decides
      // whether the snapshot's pegType may anchor a same-unit reference.
      const registryPegType = normalizePegType(pegTypeFromCurrency(meta.flags.pegCurrency));
      if (registryPegType != null && registryPegType !== pegType) {
        pegReferenceUnavailable = true;
      } else if (
        !isAuthoritativeDepegPegReference({
          pegType,
          pegCurrency: meta.flags.pegCurrency,
          pegRateSource: pegType ? pegRateSources[pegType] ?? null : null,
          pegRateContributorCount: pegType ? pegRateCounts[pegType] ?? null : null,
        })
      ) {
        pegReferenceUnavailable = true;
      } else {
        const pegRef = getPegReference(pegType, pegRates, meta.commodityOunces);
        const pegRateSource = pegType ? pegRateSources[pegType] : undefined;
        if (pegRef != null && Number.isFinite(pegRef) && pegRef > 0 && pegRateSource) {
          pegReference = {
            valueUsd: pegRef,
            ...((pegType === "peggedGOLD" || pegType === "peggedSILVER")
              ? { usdPerTroyOunce: pegRates[pegType] }
              : {}),
            source: pegRateSource,
            contributorCount: pegType ? pegRateCounts[pegType] ?? 0 : 0,
            asOf: options.asOf,
          };
        }
        currentSignal =
          pegRef != null && Number.isFinite(pegRef) && pegRef > 0
            ? deriveDepegSignal(asset.price, pegRef)
            : null;
        currentDeviationBps = currentSignal?.bps ?? null;
      }
    }

    const primaryTrust = asset ? classifyPrimaryDepegTrust(asset, options.now ?? options.asOf) : "unusable";
    const dexRow = options.dexPrices?.get(meta.id);
    let dexPriceCheck: CurrentPeg["dexPriceCheck"] = null;
    if (!pegReferenceUnavailable && dexRow && supply !== null && supply >= DEPEG_EVENT_MIN_SUPPLY_USD) {
      const pegType = normalizePegType(pegTypeFromCurrency(meta.flags.pegCurrency)) ?? normalizePegType(asset?.pegType) ?? null;
      const dexBps = meta.flags.navToken
        ? primaryTrust !== "unusable" && asset?.price != null
          ? deriveDepegSignal(dexRow.dex_price_usd, asset.price)?.bps ?? null : null
        : deriveDexDeviationBps(dexRow.dex_price_usd, pegType, pegRates, meta.commodityOunces, currentDeviationBps, dexRow.deviation_from_primary_bps);
      if (dexBps != null) dexPriceCheck = {
        dexPrice: dexRow.dex_price_usd, dexDeviationBps: dexBps,
        agrees: currentDeviationBps != null ? Math.abs(currentDeviationBps - dexBps) < 50 : Math.abs(dexBps) < 50,
        sourcePools: dexRow.source_pool_count, sourceTvl: dexRow.source_total_tvl,
      };
    }

    result.set(meta.id, {
      primaryTrust,
      dexPriceCheck,
      currentDeviationBps,
      currentSignal,
      pegReference,
      pegReferenceUnavailable,
      currentPriceUnavailable,
      currentSupplyUnavailable,
    });
  }

  return result;
}

/** The published quotes peg summary measures; the detail overlay displays exactly these. */
export function hasUsableCurrentPrice(asset: StablecoinData): asset is StablecoinData & { price: number } {
  return isObservedPrice(asset) && typeof asset.price === "number" && Number.isFinite(asset.price) && asset.price > 0;
}

export interface CurrentPegDexPrice {
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

