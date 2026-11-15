import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { isReferenceDeviationHeld } from "@shared/lib/reference-market-hours";
import type { PegSummaryCoin } from "@shared/types/peg";
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
    && isReferenceDeviationHeld(pegCurrency, observedAtSec, deviationBps);
}

export interface CurrentDeviationRead {
  /** Null while held: every caller treats it as unavailable, sorting included. */
  deviationBps: number | null;
  /** The peg's reference market was closed when this row was read. */
  referenceMarketClosed: boolean;
}

/** The published current deviation with its closure reading, from one row and one clock. */
export function resolveCurrentDeviation(
  row: CurrentPriceRow | undefined,
  legacy: PegSummaryCoin | null | undefined,
  pegCurrency: string | null | undefined,
): CurrentDeviationRead {
  const current = resolveCurrentPeg(row, legacy);
  const published = (row && !hasObservedDisplayPrice(row)) || current?.pegReferenceUnavailable === true || current?.currentPriceUnavailable === true
    ? null : current?.currentDeviationBps ?? null;
  // The row's own clock first; a row with no clock still shares the sibling payload's observation time.
  const observedAtSec = resolvePriceObservedAtSec(current) ?? resolvePriceObservedAtSec(legacy);
  const referenceMarketClosed = isCurrentDeviationHeld(pegCurrency, observedAtSec, published);
  return { deviationBps: referenceMarketClosed ? null : published, referenceMarketClosed };
}
