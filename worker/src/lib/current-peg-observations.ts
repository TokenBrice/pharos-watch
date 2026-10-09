import { WORKER_TRACKED_META_BY_ID, WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { derivePegRates, getPegReference, normalizePegType } from "@shared/lib/peg-rates";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { isAuthoritativeDepegPegReference } from "@shared/lib/peg-reference-trust";
import type { StablecoinData } from "@shared/types/market";
import type { PegSummaryCoin } from "@shared/types/peg";
import { deriveDepegSignal } from "./depeg-signals";

export interface CurrentPegObservation {
  currentDeviationBps: number | null;
  pegReference: PegSummaryCoin["pegReference"];
  pegReferenceUnavailable: boolean;
  currentPriceUnavailable: boolean;
  /**
   * The asset (or its current supply buckets) is absent, so the live-event supply floor
   * cannot be assessed. This does not withhold an otherwise observed deviation.
   */
  currentSupplyUnavailable: boolean;
  /** Original asset clock/provenance, never the analytics or cache generation clock. */
  priceObservedAt: PegSummaryCoin["priceObservedAt"];
  priceSource: PegSummaryCoin["priceSource"];
  priceObservedAtMode: PegSummaryCoin["priceObservedAtMode"];
}

export function deriveCurrentPegObservationMap(options: {
  peggedAssets: StablecoinData[];
  fxFallbackRates?: Record<string, number>;
  asOf: number;
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
    let pegReferenceUnavailable = false;
    let pegReference: PegSummaryCoin["pegReference"] = null;

    if (!meta.flags.navToken && asset && hasUsableCurrentPrice(asset)) {
      const pegType = normalizePegType(asset.pegType);
      if (
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
        currentDeviationBps =
          pegRef != null && Number.isFinite(pegRef) && pegRef > 0
            ? deriveDepegSignal(asset.price, pegRef)?.bps ?? null
            : null;
      }
    }

    result.set(meta.id, {
      currentDeviationBps,
      pegReference,
      pegReferenceUnavailable,
      currentPriceUnavailable,
      currentSupplyUnavailable,
      // priceUpdatedAt is the same asset's retained price clock on legacy list
      // rows. priceSyncedAt and asOf describe processing, not price evidence.
      priceObservedAt: asset?.priceObservedAt === undefined
        ? asset?.priceUpdatedAt ?? null
        : asset.priceObservedAt,
      priceSource: asset?.priceSource ?? undefined,
      priceObservedAtMode: asset?.priceObservedAtMode ?? null,
    });
  }

  return result;
}

function hasUsableCurrentPrice(asset: StablecoinData): asset is StablecoinData & { price: number } {
  return isObservedPrice(asset) && typeof asset.price === "number" && Number.isFinite(asset.price) && asset.price > 0;
}
