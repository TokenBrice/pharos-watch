import type { PegSummaryCoin } from "../types/peg";

/** Captured references only: token prices and nominal/static FX are not currency quotes. */
export interface RedemptionFiatReferenceContext {
  clockSec: number;
  pegDataById: Readonly<Record<string, Pick<PegSummaryCoin,
    "pegCurrency" | "pegReference" | "pegReferenceUnavailable"> | undefined>>;
}

export const REDEMPTION_FIAT_REFERENCE_MAX_AGE_SEC = 86_400;

export function resolveRedemptionFiatReference(
  currency: string,
  context?: RedemptionFiatReferenceContext,
): NonNullable<PegSummaryCoin["pegReference"]> | null {
  if (!context || !Number.isSafeInteger(context.clockSec) || context.clockSec <= 0) return null;
  let selected: NonNullable<PegSummaryCoin["pegReference"]> | null = null;
  let conflicting = false;
  for (const peg of Object.values(context.pegDataById)) {
    const reference = peg?.pegReference;
    if (peg?.pegCurrency !== currency || peg.pegReferenceUnavailable || reference?.source !== "fx" ||
        !Number.isFinite(reference.valueUsd) || reference.valueUsd <= 0 ||
        !Number.isSafeInteger(reference.asOf) || reference.asOf <= 0 || reference.asOf > context.clockSec ||
        context.clockSec - reference.asOf > REDEMPTION_FIAT_REFERENCE_MAX_AGE_SEC) continue;
    // Equal-clock conflicting quotes are not an admitted currency reference.
    if (selected?.asOf === reference.asOf && selected.valueUsd !== reference.valueUsd) conflicting = true;
    if (!selected || reference.asOf > selected.asOf) {
      selected = reference;
      conflicting = false;
    }
  }
  return conflicting ? null : selected;
}

export function resolveRedemptionFiatUsdRate(
  currency: string,
  context?: RedemptionFiatReferenceContext,
): number | null {
  return currency === "USD" ? 1 : resolveRedemptionFiatReference(currency, context)?.valueUsd ?? null;
}
