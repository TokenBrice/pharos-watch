import type { StablecoinDetailResponse } from "../types/market";
import { StablecoinLiveSummarySchema, type StablecoinLiveSummary } from "../types/stablecoin-live-summary";
import { isObservedPrice } from "./pricing-source-policy";
import { admitSupplyBuckets, sumPegBucketsOrNull } from "./supply";

const DETAIL_BUCKET_MAX_BACKFILL_SEC = 86_400;

/** Nominal references never become observed display prices, regardless of transport. */
export function normalizeStablecoinLiveSummary(summary: StablecoinLiveSummary): StablecoinLiveSummary {
  return isObservedPrice(summary) ? summary : {
    ...summary,
    price: null,
    priceConfidence: null,
    priceUpdatedAt: null,
    priceObservedAt: null,
    ...(summary.priceSyncedAt !== undefined ? { priceSyncedAt: null } : {}),
    ...(summary.consensusSources !== undefined ? { consensusSources: [] } : {}),
    ...(summary.agreeSources !== undefined ? { agreeSources: [] } : {}),
  };
}

/** Newest sample at/before the target; gaps wider than a daily bucket are unavailable. */
function detailBucketsAt(
  detail: StablecoinDetailResponse,
  targetDate: number,
  field: "totalCirculatingUSD" | "totalCirculating",
): Record<string, number> {
  let chosen: Record<string, number> | undefined;
  let chosenDate = Number.NEGATIVE_INFINITY;
  for (const token of detail.tokens ?? []) {
    const date = token.date;
    if (date == null || date > targetDate) continue;
    if (targetDate - date > DETAIL_BUCKET_MAX_BACKFILL_SEC) continue;
    if (date > chosenDate) {
      chosenDate = date;
      chosen = token[field];
    }
  }
  return chosen ?? {};
}

/** Shared by browser, per-coin snapshot acquisition and cache-only bulk acquisition. */
export function projectStablecoinLiveSummary(detail: StablecoinDetailResponse): StablecoinLiveSummary {
  const datedTokens = (detail.tokens ?? []).filter(
    (token): token is typeof token & { date: number } => token.date != null,
  );
  const latest = datedTokens.reduce<(typeof datedTokens)[number] | undefined>(
    (candidate, token) => !candidate || token.date > candidate.date ? token : candidate,
    undefined,
  );
  const latestDate = latest?.date ?? null;
  // Canonical quarantine says current supply is unavailable: never back-fill it from provider history.
  const supplyUnavailable = detail.currentSupplyUnavailableReason != null;
  const hasCurrentSupply = !supplyUnavailable && admitSupplyBuckets(detail.currentCirculatingUSD).status === "observed";
  let circulating = supplyUnavailable ? {} : hasCurrentSupply ? detail.currentCirculatingUSD! : latest?.totalCirculatingUSD ?? {};
  // Older detail responses may have only native history. Never assume a $1 peg.
  if (!supplyUnavailable && admitSupplyBuckets(circulating).status !== "observed") {
    const native = latest?.totalCirculating;
    const price = isObservedPrice(detail) ? detail.price : null;
    circulating = native && admitSupplyBuckets(native).status === "observed" &&
      typeof price === "number" && Number.isFinite(price) && price > 0
      ? Object.fromEntries(Object.entries(native).map(([peg, amount]) => [peg, amount * price]))
      : {};
    if (admitSupplyBuckets(circulating).status !== "observed") circulating = {};
  }
  const supplyObservedAt = hasCurrentSupply ? detail.currentSupplyObservedAt ?? null : supplyUnavailable ? null : latestDate;
  const observedPrice = isObservedPrice(detail) ? detail.price : null;
  const currentUsd = sumPegBucketsOrNull(circulating);
  const derivedNative = hasCurrentSupply && currentUsd != null && typeof observedPrice === "number" &&
    Number.isFinite(observedPrice) && observedPrice > 0 ? currentUsd / observedPrice : null;
  const currentNative = supplyUnavailable ? null : hasCurrentSupply
    ? derivedNative != null && Number.isFinite(derivedNative) ? derivedNative : null
    : sumPegBucketsOrNull(latest?.totalCirculating);

  return normalizeStablecoinLiveSummary(StablecoinLiveSummarySchema.parse({
    price: detail.price ?? null,
    priceSource: detail.priceSource ?? null,
    priceConfidence: detail.priceConfidence ?? null,
    priceUpdatedAt: detail.priceUpdatedAt ?? null,
    priceObservedAt: detail.priceObservedAt ?? detail.priceUpdatedAt ?? null,
    priceObservedAtMode: detail.priceObservedAtMode,
    priceSyncedAt: detail.priceSyncedAt,
    ...(detail.nominalPriceReference ? { nominalPriceReference: detail.nominalPriceReference } : {}),
    consensusSources: detail.consensusSources,
    agreeSources: detail.agreeSources,
    supplyObservedAt,
    ...(supplyUnavailable || (hasCurrentSupply && detail.currentSupplyRestored === true) ? { supplyRestored: true } : {}),
    circulating,
    circulatingPrevDay: hasCurrentSupply ? detail.currentCirculatingPrevDayUSD ?? {}
      : latestDate == null ? {} : detailBucketsAt(detail, latestDate - 86_400, "totalCirculatingUSD"),
    circulatingPrevWeek: supplyObservedAt == null ? {} : detailBucketsAt(detail, supplyObservedAt - 7 * 86_400, "totalCirculatingUSD"),
    circulatingPrevMonth: supplyObservedAt == null ? {} : detailBucketsAt(detail, supplyObservedAt - 30 * 86_400, "totalCirculatingUSD"),
    nativeSupply: {
      current: currentNative,
      prevWeek: currentNative == null || supplyObservedAt == null
        ? null
        : sumPegBucketsOrNull(detailBucketsAt(detail, supplyObservedAt - 7 * 86_400, "totalCirculating")),
      prevMonth: currentNative == null || supplyObservedAt == null
        ? null
        : sumPegBucketsOrNull(detailBucketsAt(detail, supplyObservedAt - 30 * 86_400, "totalCirculating")),
    },
  }));
}
