import { hasPublishedDeviation, resolveDisplayPegReference } from "@/lib/current-peg";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import type { PegSummaryCoin } from "@shared/types/peg";

type PegSummaryCoins = { values(): Iterable<PegSummaryCoin> };

/** A peer's admitted direct FX rate can value a NAV quote observed at the same time. */
export function getQuoteMatchedNavPriceReference(
  currency: string,
  quoteAt: number | null | undefined,
  coins: PegSummaryCoins | undefined,
): number | null {
  if (currency === "USD") return 1;
  if (!coins) return null;
  let legacyRate: number | null = null;
  let hasCurrencyEvidence = false;
  for (const coin of coins.values()) {
    const reference = coin.pegReference;
    const admission = coin.referenceAdmission;
    if (coin.pegCurrency !== currency) continue;
    if (!hasPublishedDeviation(coin)) {
      if (!coin.pegReferenceUnavailable && reference && reference.usdPerTroyOunce === undefined &&
          Number.isFinite(reference.valueUsd) && reference.valueUsd > 0) {
        legacyRate ??= reference.valueUsd;
      }
      continue;
    }
    hasCurrencyEvidence = true;
    if (quoteAt != null && Number.isSafeInteger(quoteAt) && quoteAt > 0
      && getPegTaxonomyByType(coin.pegType)?.currency === currency
      && coin.priceObservedAt === quoteAt
      && reference?.source === "fx" && reference.usdPerTroyOunce === undefined
      && admission?.status === "admitted" && admission.kind === "fx" && admission.reason === "live-reference"
      && admission.source !== "peer-median"
      && admission.quoteObservedAtSec === quoteAt && admission.referenceObservedAtSec === reference.asOf) {
      const rate = resolveDisplayPegReference(undefined, coin, currency);
      if (rate != null) return rate;
    }
  }
  return hasCurrencyEvidence ? null : legacyRate;
}

export function getNavPriceReference(
  pegCurrency: string | undefined,
  coins: PegSummaryCoins | undefined,
  quote?: { priceObservedAt?: number | null } | null,
): number | null {
  return getQuoteMatchedNavPriceReference(pegCurrency ?? "USD", quote?.priceObservedAt, coins);
}
