import { hasComparablePegQuote } from "@shared/lib/current-peg-projection";
import { deriveCurrentPegObservationMap } from "@shared/lib/current-peg-observations";
import { hasPublishedDeviation } from "@shared/lib/depeg-signals";
import { currentAdmissionUnavailableReason } from "@shared/lib/reference-admission";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { StablecoinData } from "@shared/types/supply";
export { deriveCurrentPegObservationMap, hasUsableCurrentPrice } from "@shared/lib/current-peg-observations";
export type { CurrentPegObservation } from "@shared/lib/current-peg-observations";
import {
  assessClockedCurveNavPayload,
  getDexTrustPolicy,
  isAffirmativeDexPriceRow,
  isTrustedDexPriceRow,
  parseDexPricePayload,
  readDexAggregateObservedAt,
} from "./depeg-trust-policy";
import type { CurrentPegDexPrice } from "@shared/lib/current-peg-observations";

/** Older cache generations can precede the per-asset block. Derive their cohort just once. */
export function createCurrentPegReader(options: Parameters<typeof deriveCurrentPegObservationMap>[0]) {
  let observations: ReturnType<typeof deriveCurrentPegObservationMap> | undefined;
  return (asset: StablecoinData) => {
    const peg = asset.currentPeg;
    if (peg && (hasPublishedDeviation(peg) || options.fxReferenceObservations === undefined)) {
      if (!hasComparablePegQuote(asset)) {
        return { ...peg, currentDeviationBps: null, pegReference: null, pegReferenceUnavailable: true };
      }
      const admission = peg.referenceAdmission;
      const currency = WORKER_TRACKED_META_BY_ID.get(asset.id)?.flags.pegCurrency;
      if (options.now != null && admission?.status === "admitted" && currency && currency !== "USD" &&
          currentAdmissionUnavailableReason(admission, currency, asset.priceObservedAt, options.now)) {
        return { ...peg, currentDeviationBps: null, admittedDeviationBps: null, pegReferenceUnavailable: true };
      }
      return peg;
    }
    observations ??= deriveCurrentPegObservationMap(options);
    return observations.get(asset.id);
  };
}

export interface CurrentPegDexRow extends Omit<CurrentPegDexPrice, "expiresAt"> {
  stablecoin_id: string;
  updated_at: number;
  price_sources_json: string | null;
}

/** Successful reads still need original aggregate-clock admission before an affirmative verdict. */
export function selectCurrentPegDexPrices(rows: CurrentPegDexRow[], now: number): Map<string, CurrentPegDexPrice> {
  const prices = new Map<string, CurrentPegDexPrice>();
  const uiMaxAgeSec = getDexTrustPolicy("ui").maxAgeSec;
  for (const row of rows) {
    if (!isTrustedDexPriceRow({ updated_at: row.updated_at, source_total_tvl: row.source_total_tvl }, now, "ui")) continue;
    const aggregateObservedAt = readDexAggregateObservedAt(row.price_sources_json, now);
    if (aggregateObservedAt == null) continue;
    const pricePayload = parseDexPricePayload(row.price_sources_json);
    if (
      !isTrustedDexPriceRow({ ...row, pricePayload }, now, "ui") ||
      !isAffirmativeDexPriceRow({ ...row, pricePayload, aggregateObservedAt }, now, "ui")
    ) {
      continue;
    }
    const curveNav = assessClockedCurveNavPayload(pricePayload, {
      nowSec: now,
      publicationUpdatedAt: row.updated_at,
      aggregateObservedAt,
    });
    const maxAgeSec = curveNav.isClockedCurveNav && curveNav.maxAgeSec != null
      ? Math.min(uiMaxAgeSec, curveNav.maxAgeSec)
      : uiMaxAgeSec;
    const clockFloor = curveNav.isClockedCurveNav && curveNav.earliestClockSec != null
      ? Math.min(row.updated_at, aggregateObservedAt, curveNav.earliestClockSec)
      : Math.min(row.updated_at, aggregateObservedAt);
    prices.set(row.stablecoin_id, {
      ...row,
      observedAtSec: aggregateObservedAt,
      expiresAt: clockFloor + maxAgeSec,
    });
  }
  return prices;
}
