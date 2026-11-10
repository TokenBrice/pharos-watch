import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";

type CurrentPriceRow = StablecoinData | StablecoinLiveSummary;

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

export function resolveCurrentDeviationBps(row: CurrentPriceRow | undefined, legacy?: PegSummaryCoin | null): number | null {
  const current = resolveCurrentPeg(row, legacy);
  return (row && !hasObservedDisplayPrice(row)) || current?.pegReferenceUnavailable === true || current?.currentPriceUnavailable === true
    ? null : current?.currentDeviationBps ?? null;
}
