import { hasPublishedDeviation, readDeviationProjection, relativeBps } from "@shared/lib/depeg-signals";
export { hasPublishedDeviation } from "@shared/lib/depeg-signals";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { isLegacyReferenceDeviationHeld } from "@shared/lib/reference-market-hours";
import { currentAdmissionUnavailableReason } from "@shared/lib/reference-admission";
import { formatUsdPriceAdaptive } from "@shared/lib/format";
import { formatNativePrice, pegCurrencySymbol } from "@shared/lib/peg-format";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { CurrentPeg } from "@shared/types/current-peg";
import type { AdmittedDeviationBps, ReferenceAdmission } from "@shared/types/reference-admission";
import type { StablecoinData } from "@shared/types/supply";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";

type CurrentPriceRow = StablecoinData | StablecoinLiveSummary;

/** Any published row carrying its own price observation clock. */
type PriceClockRow = { priceObservedAt?: number | null; priceUpdatedAt?: number | null };

/** Observed low/fallback quotes still have a deviation; confidence describes its evidence. */
export function hasObservedDisplayPrice(row: Pick<CurrentPriceRow, "price" | "priceSource" | "priceObservedAtMode">): boolean {
  return isObservedPrice(row) && typeof row.price === "number" && Number.isFinite(row.price) && row.price > 0;
}

/** Only absent fields use the legacy second payload; published nulls remain unavailable. */
export function resolveCurrentPeg(row: CurrentPriceRow | undefined, legacy?: PegSummaryCoin | null, nowMs = Date.now()) {
  if (!row?.currentPeg) return legacy;
  const expiresAt = row.currentPeg.dexPriceCheckExpiresAt;
  return {
    ...row, ...row.currentPeg,
    dexPriceCheck: expiresAt != null && Number.isFinite(expiresAt) && nowMs < expiresAt * 1000
      ? row.currentPeg.dexPriceCheck : null,
  };
}

export function resolveCurrentDeviationBps(
  row: CurrentPriceRow | undefined,
  legacy: PegSummaryCoin | null | undefined,
  pegCurrency: string | null | undefined,
): number | null {
  return resolveCurrentDeviation(row, legacy, pegCurrency).deviationBps;
}

/** A row's own price observation time (Unix seconds), never the reader's receipt clock. */
export function resolvePriceObservedAtSec(row: PriceClockRow | null | undefined): number | null {
  const at = row?.priceObservedAt ?? row?.priceUpdatedAt;
  return typeof at === "number" && Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * A published current deviation read while the peg's reference market is shut (FX and spot
 * metals trade 24/5) compares a trading token with a repeated close, so it is held: weekend
 * drift is not a depeg. A move at the severe band or beyond stays live; a missing deviation is
 * an absence, never a closure, so it is not held; an undated row cannot be placed in a closure
 * either. Static HTML and the hydrated client read the same data clock.
 */
export function isCurrentDeviationHeld(
  pegCurrency: string | null | undefined,
  observedAtSec: number | null | undefined,
  deviationBps: number | null | undefined,
): boolean {
  return typeof deviationBps === "number"
    && Number.isFinite(deviationBps)
    && observedAtSec != null
    && Number.isFinite(observedAtSec)
    && observedAtSec > 0
    && isLegacyReferenceDeviationHeld(pegCurrency, observedAtSec, deviationBps);
}

interface PublishedReferenceRead extends PriceClockRow {
  price?: number | null;
  pegReference?: CurrentPeg["pegReference"];
  currentDeviationBps?: number | null;
  admittedDeviationBps?: AdmittedDeviationBps;
  referenceAdmission?: ReferenceAdmission | null;
  pegReferenceUnavailable?: boolean;
  currentPriceUnavailable?: boolean;
}

function canBorrowPublishedReference(row: CurrentPriceRow, summary: PegSummaryCoin): boolean {
  const quoteAt = row.priceObservedAt;
  const admission = summary.referenceAdmission;
  return hasObservedDisplayPrice(row) && (!("id" in row) || row.id === summary.id)
    && row.price === summary.price && quoteAt != null && quoteAt > 0 && quoteAt === summary.priceObservedAt
    && (admission == null || quoteAt === admission.quoteObservedAtSec);
}

export interface CurrentDeviationRead {
  deviationBps: number | null;
  referenceNote: string | null;
}

export function referenceAdmissionNote(admission: ReferenceAdmission | null | undefined): string | null {
  if (admission?.status === "held-closed-session") return "Reference market closed";
  if (admission?.status === "stale-reference") return "Reference not yet updated";
  return null;
}

/** Only a publication without a verdict uses the legacy calendar. */
export function readUnroundedPublishedDeviation(
  pegCurrency: string | null | undefined,
  current: PublishedReferenceRead | null | undefined,
  legacyClock?: PriceClockRow | null,
  nowSec?: number,
): CurrentDeviationRead {
  const admission = current?.referenceAdmission;
  const projection = readDeviationProjection(current, pegCurrency === "USD", current?.priceObservedAt);
  if (projection !== undefined) {
    if (admission && admission.quoteObservedAtSec !== current?.priceObservedAt) {
      return { deviationBps: null, referenceNote: null };
    }
    if (nowSec != null && admission?.status === "admitted" && pegCurrency && pegCurrency !== "USD") {
      const reason = currentAdmissionUnavailableReason(admission, pegCurrency, current?.priceObservedAt, nowSec);
      if (reason) {
        return { deviationBps: null, referenceNote: reason === "reference-market-closed"
          ? "Reference market closed" : "Reference not yet updated" };
      }
    }
    return {
      deviationBps: projection,
      referenceNote: referenceAdmissionNote(admission),
    };
  }
  const published = current?.pegReferenceUnavailable || current?.currentPriceUnavailable
    ? null : current?.currentDeviationBps ?? null;
  const price = current?.price;
  const reference = current?.pegReference?.valueUsd;
  const raw = published != null && pegCurrency !== "USD" && price != null && reference != null
    ? relativeBps(price, reference)?.rawBps ?? published : published;
  const observedAtSec = resolvePriceObservedAtSec(current) ?? resolvePriceObservedAtSec(legacyClock);
  const held = isCurrentDeviationHeld(pegCurrency, observedAtSec, raw);
  return {
    deviationBps: held || !Number.isFinite(published) ? null : published,
    referenceNote: held ? "Reference market closed" : null,
  };
}

export function readPublishedDeviation(
  pegCurrency: string | null | undefined,
  current: PublishedReferenceRead | null | undefined,
  legacyClock?: PriceClockRow | null,
  nowSec?: number,
): CurrentDeviationRead {
  const read = readUnroundedPublishedDeviation(pegCurrency, current, legacyClock, nowSec);
  return read.deviationBps == null || !hasPublishedDeviation(current) ? read : { ...read, deviationBps: Math.round(read.deviationBps) };
}

export function resolveQuoteReference(row: CurrentPriceRow | undefined, summary: PegSummaryCoin | null | undefined) {
  const published = row?.currentPeg?.referenceAdmission;
  const refreshed = summary?.referenceAdmission;
  if (row && summary && published?.status === "admitted" && refreshed && refreshed.status !== "admitted" &&
      refreshed.decisionAtSec > published.decisionAtSec && canBorrowPublishedReference(row, summary)) {
    return summary;
  }
  // During cutover the list can carry a legacy block even when peg-summary has a verdict.
  if (row && !row.currentPeg?.currentPriceUnavailable && !row.currentPeg?.pegReferenceUnavailable &&
      !hasPublishedDeviation(row.currentPeg) && summary && hasPublishedDeviation(summary)) {
    return canBorrowPublishedReference(row, summary) ? summary : null;
  }
  return resolveCurrentPeg(row, summary);
}

/** The published current deviation with its closure reading, from one row and one clock. */
export function resolveCurrentDeviation(
  row: CurrentPriceRow | undefined,
  legacy: PegSummaryCoin | null | undefined,
  pegCurrency: string | null | undefined,
): CurrentDeviationRead {
  const nowSec = row ? Math.floor(Date.now() / 1000) : undefined;
  const read = readPublishedDeviation(pegCurrency, resolveQuoteReference(row, legacy), legacy, nowSec);
  return row && !hasObservedDisplayPrice(row) ? { ...read, deviationBps: null } : read;
}

export function resolveDisplayPegReference(
  row: CurrentPriceRow | undefined,
  legacy: PegSummaryCoin | null | undefined,
  pegCurrency: string,
): number | null {
  const current = resolveQuoteReference(row, legacy);
  if (!current || current.pegReferenceUnavailable || current.currentPriceUnavailable) return null;
  const reference = current.pegReference?.valueUsd;
  if (reference == null || !Number.isFinite(reference) || reference <= 0) return null;
  if (hasPublishedDeviation(current)) {
    if (current.referenceAdmission && current.referenceAdmission.referenceObservedAtSec !== current.pegReference?.asOf) return null;
    const nowSec = row ? Math.floor(Date.now() / 1000) : undefined;
    return readPublishedDeviation(pegCurrency, current, undefined, nowSec).deviationBps == null ? null : reference;
  }
  const observedAtSec = resolvePriceObservedAtSec(row) ?? resolvePriceObservedAtSec(current);
  const { deviationBps, referenceNote } = readPublishedDeviation(pegCurrency, current);
  return referenceNote || (observedAtSec != null && isLegacyReferenceDeviationHeld(pegCurrency, observedAtSec, deviationBps ?? NaN))
    ? null : reference;
}

export function formatObservedPrice(
  usdPrice: number | null | undefined,
  currency: string,
  reference: number | null,
  decimals = 4,
): string {
  return usdPrice != null && Number.isFinite(usdPrice) && usdPrice > 0 && usdPrice < 0.01
    && (pegCurrencySymbol(currency) === "$" || reference == null)
    ? `$${formatUsdPriceAdaptive(usdPrice)}`
    : formatNativePrice(usdPrice, currency, reference, decimals);
}

export function formatComparisonPrice(
  row: StablecoinData,
  currency: string,
  navReference?: number | null,
  pegSummary?: PegSummaryCoin | null,
): string {
  if (!hasObservedDisplayPrice(row)) return "N/A";
  const reference = navReference === undefined ? resolveDisplayPegReference(row, pegSummary, currency) : navReference;
  return formatObservedPrice(row.price, currency, reference);
}
