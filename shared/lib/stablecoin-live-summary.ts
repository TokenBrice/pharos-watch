import type { StablecoinDetailResponse } from "../types/supply";
import { StablecoinLiveSummarySchema, type StablecoinLiveSummary } from "../types/stablecoin-live-summary";
import { isObservedPrice } from "./pricing-source-policy";
import { admitSupplyBuckets, projectUsdMarketCapBaselineBuckets, sumPegBucketsOrNull } from "./supply";
import { isAmbiguousSupplyPerimeterDay, isEarlierSupplyPerimeter } from "./supply-perimeter-changes";

const DETAIL_BUCKET_MAX_BACKFILL_SEC = 86_400;
const NATIVE_SUPPLY_BASELINE_SOURCES = new Set([
  "onchain-total-supply",
  "onchain-circulating-supply",
  "zephyr-scanner",
]);

/** Nominal references never become observed display prices, regardless of transport. */
export function normalizeStablecoinLiveSummary(summary: StablecoinLiveSummary): StablecoinLiveSummary {
  if (isObservedPrice(summary)) return summary;
  const { priceDerivation: _derivation, ...rest } = summary;
  return {
    ...rest,
    price: null,
    priceConfidence: null,
    priceUpdatedAt: null,
    priceObservedAt: null,
    ...(summary.priceSyncedAt !== undefined ? { priceSyncedAt: null } : {}),
    ...(summary.consensusSources !== undefined ? { consensusSources: [] } : {}),
    ...(summary.agreeSources !== undefined ? { agreeSources: [] } : {}),
  };
}

function admittedDetailBuckets(buckets: Record<string, number> | undefined): Record<string, number> {
  return admitSupplyBuckets(buckets).status === "observed" ? buckets! : {};
}

/** Newest sample at/before the target; gaps wider than a daily bucket are unavailable. */
function detailBucketsAt(
  detail: StablecoinDetailResponse,
  targetDate: number,
  field: "totalCirculatingUSD" | "totalCirculating",
  stablecoinId: string,
): Record<string, number> {
  let chosen: Record<string, number> | undefined;
  let chosenDate = Number.NEGATIVE_INFINITY;
  const scopedXaut = stablecoinId === "xaut-tether" && field === "totalCirculating";
  for (const token of detail.tokens ?? []) {
    if (scopedXaut && token.nativeSupplySource !== "onchain-circulating-supply") continue;
    const date = scopedXaut ? token.nativeSupplyObservedAt : token.date;
    if (typeof date !== "number" || !Number.isFinite(date) || date <= 0 || date > targetDate || isEarlierSupplyPerimeter(stablecoinId, date)) continue;
    if ((!scopedXaut && isAmbiguousSupplyPerimeterDay(stablecoinId, date)) || targetDate - date > DETAIL_BUCKET_MAX_BACKFILL_SEC) continue;
    if (date > chosenDate) {
      chosenDate = date;
      chosen = token[field];
    }
  }
  return admittedDetailBuckets(chosen);
}

/** Shared by the compact live endpoint, per-coin acquisition and cache-only bulk acquisition. */
export function projectStablecoinLiveSummary(detail: StablecoinDetailResponse, stablecoinId = ""): StablecoinLiveSummary {
  const datedTokens = (detail.tokens ?? []).filter(
    (token): token is typeof token & { date: number } => token.date != null,
  );
  const latest = datedTokens.reduce<(typeof datedTokens)[number] | undefined>(
    (candidate, token) => !candidate || token.date > candidate.date ? token : candidate,
    undefined,
  );
  const latestDate = latest?.date ?? null;
  const historyClock = detail.commodityHistoryObservedAt;
  const historyObservedAt = typeof historyClock === "number" && Number.isSafeInteger(historyClock) && historyClock > 0
    ? historyClock : latestDate;
  // An explicit unavailable current overlay must never back-fill from provider history.
  const supplyUnavailable = detail.currentSupplyUnavailableReason != null ||
    (detail.currentCirculatingUSD !== undefined && admitSupplyBuckets(detail.currentCirculatingUSD).status !== "observed");
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
  const supplyObservedAt = hasCurrentSupply ? detail.currentSupplyObservedAt ?? null : supplyUnavailable ? null : historyObservedAt;
  // A perimeter change applies only once the served generation has adopted it.
  if (isEarlierSupplyPerimeter(stablecoinId, supplyObservedAt ?? latestDate ?? Number.POSITIVE_INFINITY)) stablecoinId = "";
  let currentNative = detail.currentCirculatingNative;
  if (currentNative === undefined && !supplyUnavailable) {
    if (hasCurrentSupply) {
      const currentUsd = sumPegBucketsOrNull(circulating);
      const price = isObservedPrice(detail) ? detail.price : null;
      currentNative = currentUsd != null && price != null && price > 0 ? currentUsd / price : null;
    } else {
      currentNative = stablecoinId === "xaut-tether" ? null : sumPegBucketsOrNull(latest?.totalCirculating);
    }
  }
  if (supplyUnavailable || currentNative == null || !Number.isFinite(currentNative) || currentNative < 0) currentNative = null;
  const baselineAsset = { circulating, supplyChangeBaselines: detail.supplyChangeBaselines };
  const circulatingPrevWeek = supplyObservedAt == null ? {} : projectUsdMarketCapBaselineBuckets(
    baselineAsset, "week", hasCurrentSupply && detail.currentCirculatingPrevWeekUSD !== undefined
      ? admittedDetailBuckets(detail.currentCirculatingPrevWeekUSD)
      : detailBucketsAt(detail, supplyObservedAt - 7 * 86_400, "totalCirculatingUSD", stablecoinId),
  );
  const circulatingPrevMonth = supplyObservedAt == null ? {} : projectUsdMarketCapBaselineBuckets(
    baselineAsset, "month", hasCurrentSupply && detail.currentCirculatingPrevMonthUSD !== undefined
      ? admittedDetailBuckets(detail.currentCirculatingPrevMonthUSD)
      : detailBucketsAt(detail, supplyObservedAt - 30 * 86_400, "totalCirculatingUSD", stablecoinId),
  );
  // Provider token history still counts the chains a matched comparison perimeter excludes (Pricing v6.90), so
  // its prior quantity values the canonical prior bucket at the current quantity's own valuation.
  // Native on-chain/scanner supplies must compare against same-producer D1 baselines rather than provider history.
  const currentUsd = sumPegBucketsOrNull(circulating);
  const matchedPerimeter = hasCurrentSupply && detail.currentSupplyComparisonExcludedChains !== undefined;
  const usesNativeSupplyBaselines = hasCurrentSupply
    && typeof detail.currentSupplySource === "string"
    && NATIVE_SUPPLY_BASELINE_SOURCES.has(detail.currentSupplySource);
  const priorNative = (window: "week" | "month", prior: Record<string, number>, targetDate: number) => {
    if (usesNativeSupplyBaselines) {
      const baselineNative = detail.supplyChangeBaselines?.[window]?.circulatingNative;
      return typeof baselineNative === "number" && Number.isFinite(baselineNative) && baselineNative >= 0 ? baselineNative : null;
    }
    if (!matchedPerimeter) return sumPegBucketsOrNull(detailBucketsAt(detail, targetDate, "totalCirculating", stablecoinId));
    const priorUsd = sumPegBucketsOrNull(prior);
    return priorUsd == null || currentNative == null || currentUsd == null || currentUsd <= 0 ? null : priorUsd * currentNative / currentUsd;
  };

  return normalizeStablecoinLiveSummary(StablecoinLiveSummarySchema.parse({
    price: detail.price ?? null,
    priceSource: detail.priceSource ?? null,
    priceConfidence: detail.priceConfidence ?? null,
    priceUpdatedAt: detail.priceUpdatedAt ?? null,
    priceObservedAt: detail.priceObservedAt === undefined ? detail.priceUpdatedAt ?? null : detail.priceObservedAt,
    priceObservedAtMode: detail.priceObservedAtMode,
    priceSyncedAt: detail.priceSyncedAt,
    ...(detail.nominalPriceReference ? { nominalPriceReference: detail.nominalPriceReference } : {}),
    ...(detail.priceDerivation ? { priceDerivation: detail.priceDerivation } : {}),
    ...(detail.currentPeg ? { currentPeg: detail.currentPeg } : {}),
    consensusSources: detail.consensusSources,
    agreeSources: detail.agreeSources,
    supplyObservedAt,
    ...(supplyUnavailable || (hasCurrentSupply && detail.currentSupplyRestored === true) ? { supplyRestored: true } : {}),
    ...(hasCurrentSupply && detail.currentSupplyExcludedChains?.length ? { supplyExcludedChains: detail.currentSupplyExcludedChains } : {}),
    circulating,
    ...(detail.supplyChangeBaselines !== undefined ? { supplyChangeBaselines: detail.supplyChangeBaselines } : {}),
    circulatingPrevDay: supplyUnavailable ? {} : hasCurrentSupply ? admittedDetailBuckets(detail.currentCirculatingPrevDayUSD)
      : historyObservedAt == null ? {} : detailBucketsAt(detail, historyObservedAt - 86_400, "totalCirculatingUSD", stablecoinId),
    circulatingPrevWeek,
    circulatingPrevMonth,
    nativeSupply: {
      current: currentNative,
      prevWeek: currentNative == null || supplyObservedAt == null
        ? null
        : priorNative("week", circulatingPrevWeek, supplyObservedAt - 7 * 86_400),
      prevMonth: currentNative == null || supplyObservedAt == null
        ? null
        : priorNative("month", circulatingPrevMonth, supplyObservedAt - 30 * 86_400),
    },
  }));
}
