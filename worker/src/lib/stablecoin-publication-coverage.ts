import { isMentoMarketClosed, mostRecentMentoClosureEnd, resolveMentoFxMarketReopen } from "@shared/lib/reference-market-hours";
export { resolveMentoFxMarketReopen } from "@shared/lib/reference-market-hours";
import { STABLECOIN_PUBLICATION_WAIVERS, STABLECOIN_PRICE_GAP_REVIEWS, STABLECOIN_MARKET_HOURS_CALENDARS, type StablecoinPublicationWaiver, type StablecoinPriceGapReview } from "./stablecoin-publication-reviews";
export { STABLECOIN_PUBLICATION_WAIVERS, STABLECOIN_PRICE_GAP_REVIEWS, STABLECOIN_MARKET_HOURS_CALENDARS } from "./stablecoin-publication-reviews";
export type { StablecoinPublicationWaiver, StablecoinPriceGapReview } from "./stablecoin-publication-reviews";
import { logWorkerEventArgs } from "./structured-log";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { getOnchainSupplyHoldReason } from "@shared/lib/onchain-supply-probe";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { numberValue } from "@shared/lib/type-guards";
import { ActivePriceCoverageHealthSchema } from "@shared/types/status/core";
import { NominalPriceReferenceSchema, type NominalPriceReference } from "@shared/types/price";
import { STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC, hasActivePriceGapMarketCapEvidence } from "@shared/lib/status-thresholds";
import type {
  ActivePriceCoverageGap,
  ActivePriceCoverageGapAcknowledgement,
  ActivePriceCoverageScheduledClosure,
  ActivePriceCoverageHealth,
} from "@shared/types/status";
import { parseJsonObject } from "./json-parse";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { HOUR_SECONDS } from "@shared/lib/time-constants";

export const ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS = 2;

/**
 * Priced-cohort collapse at the producer (2026-11-01). Breadth grading is
 * downstream and slow: a run that loses a tenth of its priced active cohort
 * against the previous generation publishes as `ok` while `/status` stays green
 * below the 5% breadth share for two generations. `sync-stablecoins` therefore
 * degrades such a run with `stablecoin-price-coverage-collapse`. The baseline
 * floor keeps a two-asset cohort from turning one miss into a named collapse;
 * an empty priced cohort degrades regardless of baseline.
 */
export const STABLECOIN_ACTIVE_PRICE_COVERAGE_COLLAPSE = {
  relativeDrop: 0.1,
  minBaselinePricedCount: 10,
} as const;

const MAX_VALID_DATE_SECONDS = 8_640_000_000_000;

const ACTIVE_STABLECOIN_SYMBOL_BY_ID = new Map(
  WORKER_ACTIVE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin.symbol] as const),
);

export interface StablecoinPublicationCoverage {
  complete: boolean;
  expectedActiveCount: number;
  presentActiveCount: number;
  waivedActiveCount: number;
  missingActiveIds: string[];
  waivedActiveIds: string[];
  expiredWaiverIds: string[];
  invalidWaiverIds: string[];
}

export interface StablecoinPriceCoverageAsset {
  id: string;
  symbol?: string | null;
  price?: number | null;
  priceSource?: string | null;
  priceConfidence?: string | null;
  priceObservedAt?: number | null;
  priceObservedAtMode?: string | null;
  priceUpdatedAt?: number | null;
  nominalPriceReference?: NominalPriceReference | null;
  circulating?: Record<string, number> | null;
  supplyObservedAt?: number | null;
}

export type MissingActivePriceDetail = ActivePriceCoverageGap & {
  /** First missing publication's generation clock for reviewed market-hours assets. */
  firstMissingAt?: number;
};

/** The writer has measured current counts; only prior-generation continuity
 * can be unknown. The public reader also represents unavailable current data. */
export type StablecoinActivePriceCoverage = {
  [Key in Exclude<keyof ActivePriceCoverageHealth,
    "status" | "observedAt" | "unavailableReason" | "missingActiveAssets" | "maxConsecutiveMissingGenerations" | "nominalReferenceMarketCapUsd" | "affectedMarketCapUsd">]-?: NonNullable<ActivePriceCoverageHealth[Key]>;
} & {
  complete: boolean;
  evaluatedAt?: number;
  missingActiveAssets: MissingActivePriceDetail[];
  maxConsecutiveMissingGenerations: ActivePriceCoverageHealth["maxConsecutiveMissingGenerations"];
  nominalReferenceMarketCapUsd: number | null;
  affectedMarketCapUsd: number | null;
};

export interface PreviousStablecoinActivePriceCoverage {
  missingActiveIds: string[];
  missingActiveAssets: MissingActivePriceDetail[];
  /** Prior generation's priced and expected active counts; null when unreadable. */
  pricedActiveCount?: number | null;
  expectedActiveCount?: number | null;
  observedAt?: number | null;
  unavailableReason?: "previous-coverage-read-failed" | "previous-coverage-malformed";
}

export interface StablecoinActivePriceCoverageOptions {
  previousCoverage?: PreviousStablecoinActivePriceCoverage | null;
  previousAcceptedAssetsById?: ReadonlyMap<string, StablecoinPriceCoverageAsset>;
  /** Evaluation clock; defaults to now. Acknowledgement is always recomputed
   * from the registry at evaluation time, never trusted from persisted state. */
  nowSec?: number;
  priceGapReviews?: readonly StablecoinPriceGapReview[];
}

export type PersistedMissingActivePriceState = readonly [
  stablecoinId: string,
  consecutiveMissingGenerations: number | null,
  lastAcceptedPrice: number | null,
  lastAcceptedSource: string | null,
  lastAcceptedObservedAt: number | null,
  rejectionReason: string,
  streakUnavailableReason?: MissingActivePriceDetail["streakUnavailableReason"],
  lastKnownMarketCapUsd?: number | null,
  lastKnownMarketCapObservedAt?: number | null,
  lastKnownMarketCapSource?: MissingActivePriceDetail["lastKnownMarketCapSource"],
  marketCapUsd?: number | null,
  firstMissingAt?: number,
];

export interface CompactedStablecoinActivePriceCoverage extends StablecoinActivePriceCoverage {
  missingActiveAssetsTruncated: number;
  missingActiveState: PersistedMissingActivePriceState[];
}

export interface ResolvedStablecoinPublicationWaivers {
  activeById: ReadonlyMap<string, StablecoinPublicationWaiver>;
  expiredWaiverIds: string[];
  invalidWaiverIds: string[];
}



type StablecoinMarketHoursCalendar = {
  calendarId: string;
  owner: string;
  reviewReason: string;
  sources: readonly string[];
  reviewedAt: number;
  reviewDeadline: number;
  assets: readonly { stablecoinId: string; lane: string }[];
};

export function resolveStablecoinMarketHours(
  expectedActiveIds: readonly string[],
  nowSec: number,
  calendars: readonly StablecoinMarketHoursCalendar[] = STABLECOIN_MARKET_HOURS_CALENDARS,
): {
  closedById: ReadonlyMap<string, ActivePriceCoverageScheduledClosure>;
  alertSuppressedIds: ReadonlySet<string>;
  closureWindow: { start: number; end: number } | null;
  expiredCalendarIds: string[];
  invalidCalendarIds: string[];
} {
  const closedById = new Map<string, ActivePriceCoverageScheduledClosure>();
  const alertSuppressedIds = new Set<string>();
  const expiredCalendarIds = new Set<string>();
  const invalidCalendarIds = new Set<string>();
  const activeIds = new Set(expectedActiveIds);
  const reopen = validReviewSeconds(nowSec) ? resolveMentoFxMarketReopen(nowSec) : null;
  const lastReopen = reopen == null && validReviewSeconds(nowSec) ? mostRecentMentoClosureEnd(nowSec) : null;
  const reopeningGate = lastReopen != null
    && nowSec - lastReopen < ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS * CRON_INTERVALS["sync-stablecoins"];
  const closureEnd = reopen ?? (reopeningGate ? lastReopen : null);
  let closureWindow: { start: number; end: number } | null = null;
  if (closureEnd != null) {
    let start = Math.floor(Math.min(nowSec, closureEnd - 1) / HOUR_SECONDS) * HOUR_SECONDS;
    while (isMentoMarketClosed(start - 1)) start -= HOUR_SECONDS;
    closureWindow = { start, end: closureEnd };
  }
  for (const calendar of calendars) {
    if (!calendar.assets.some((asset) => activeIds.has(asset.stablecoinId))) continue;
    if (!validReviewSeconds(nowSec) || calendar.calendarId !== "mento-fx"
      || !isNonEmpty(calendar.owner) || !isNonEmpty(calendar.reviewReason)
      || !calendar.sources.length || !calendar.sources.every(isHttpsSource)
      || !validReviewSeconds(calendar.reviewedAt) || !validReviewSeconds(calendar.reviewDeadline)
      || calendar.reviewedAt > nowSec || calendar.reviewDeadline <= calendar.reviewedAt
      || calendar.assets.some((asset) => !isNonEmpty(asset.lane))) {
      invalidCalendarIds.add(calendar.calendarId);
      continue;
    }
    if (calendar.reviewDeadline <= nowSec) {
      expiredCalendarIds.add(calendar.calendarId);
      continue;
    }
    for (const asset of calendar.assets) {
      if (!activeIds.has(asset.stablecoinId)) continue;
      if (closureWindow) alertSuppressedIds.add(asset.stablecoinId);
      if (reopen == null) continue;
      closedById.set(asset.stablecoinId, {
        calendarId: calendar.calendarId,
        reason: "market-closed",
        lane: asset.lane,
        owner: calendar.owner,
        reviewReason: calendar.reviewReason,
        sources: [...calendar.sources],
        reviewedAt: calendar.reviewedAt,
        reviewDeadline: calendar.reviewDeadline,
      });
    }
  }
  return { closedById, alertSuppressedIds, closureWindow,
    expiredCalendarIds: [...expiredCalendarIds].sort(), invalidCalendarIds: [...invalidCalendarIds].sort() };
}

export function isScheduledClosureGap(
  marketHours: ReturnType<typeof resolveStablecoinMarketHours>,
  stablecoinId: string,
  firstMissingAt: number | undefined,
): boolean {
  const { closureWindow } = marketHours;
  return closureWindow != null && firstMissingAt != null
    && firstMissingAt >= closureWindow.start && firstMissingAt < closureWindow.end
    && marketHours.alertSuppressedIds.has(stablecoinId);
}

export function resolveStablecoinScheduledPriceClosures(
  expectedActiveIds: readonly string[],
  nowSec: number,
  calendars: readonly StablecoinMarketHoursCalendar[] = STABLECOIN_MARKET_HOURS_CALENDARS,
): ReadonlyMap<string, ActivePriceCoverageScheduledClosure> {
  return resolveStablecoinMarketHours(expectedActiveIds, nowSec, calendars).closedById;
}

export interface ResolvedStablecoinPriceGapReviews {
  activeById: ReadonlyMap<string, StablecoinPriceGapReview>;
  expiredGapReviewIds: string[];
  invalidGapReviewIds: string[];
}

function isHttpsSource(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/\S+$/.test(value.trim());
}

/** Reviews fail closed on invalid identity, provenance, or dates; a review
 * dated after the evaluation clock is invalid evidence. Expiry is evaluated
 * against the current clock, never persisted acknowledgement state. */
function validReviewSeconds(value: number): boolean {
  return Number.isFinite(value)
    && value > 0
    && Math.abs(value) <= MAX_VALID_DATE_SECONDS;
}

export function resolveStablecoinPriceGapReviews(
  expectedActiveIds: readonly string[],
  nowSec: number,
  reviews: readonly StablecoinPriceGapReview[] = STABLECOIN_PRICE_GAP_REVIEWS,
): ResolvedStablecoinPriceGapReviews {
  const activeIds = new Set(expectedActiveIds);
  const activeById = new Map<string, StablecoinPriceGapReview>();
  const expiredGapReviewIds = new Set<string>();
  const invalidGapReviewIds = new Set<string>();

  for (const review of reviews) {
    if (
      !activeIds.has(review.stablecoinId)
      || !isNonEmpty(review.owner)
      || !isNonEmpty(review.reason)
      || !Array.isArray(review.sources)
      || review.sources.length < 1
      || !review.sources.every((source) => isHttpsSource(source))
      || !validReviewSeconds(review.reviewedAt)
      || !validReviewSeconds(review.expiresAt)
      || review.expiresAt <= review.reviewedAt
      || review.reviewedAt > nowSec
    ) {
      invalidGapReviewIds.add(review.stablecoinId);
      continue;
    }
    if (review.expiresAt <= nowSec) {
      expiredGapReviewIds.add(review.stablecoinId);
      continue;
    }
    activeById.set(review.stablecoinId, review);
  }

  return {
    activeById,
    expiredGapReviewIds: [...expiredGapReviewIds].sort(),
    invalidGapReviewIds: [...invalidGapReviewIds].sort(),
  };
}

function acknowledgementFromReview(
  review: StablecoinPriceGapReview,
): ActivePriceCoverageGapAcknowledgement {
  return {
    owner: review.owner,
    reason: review.reason,
    sources: review.sources,
    reviewedAt: review.reviewedAt,
    expiresAt: review.expiresAt,
  };
}

function activePriceGapReviewForId(
  stablecoinId: string,
  nowSec: number,
): StablecoinPriceGapReview | null {
  return resolveStablecoinPriceGapReviews(WORKER_ACTIVE_IDS, nowSec).activeById.get(stablecoinId) ?? null;
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

export function resolveStablecoinPublicationWaivers(
  expectedActiveIds: readonly string[],
  nowSec: number,
  waivers: readonly StablecoinPublicationWaiver[],
): ResolvedStablecoinPublicationWaivers {
  const activeIds = new Set(expectedActiveIds);
  const activeById = new Map<string, StablecoinPublicationWaiver>();
  const expiredWaiverIds = new Set<string>();
  const invalidWaiverIds = new Set<string>();

  for (const waiver of waivers) {
    if (
      !activeIds.has(waiver.stablecoinId)
      || !isNonEmpty(waiver.owner)
      || !isNonEmpty(waiver.reason)
      || !Number.isFinite(waiver.expiresAt)
      || waiver.expiresAt <= 0
    ) {
      invalidWaiverIds.add(waiver.stablecoinId);
      continue;
    }
    if (waiver.expiresAt <= nowSec) {
      expiredWaiverIds.add(waiver.stablecoinId);
      continue;
    }
    activeById.set(waiver.stablecoinId, waiver);
  }

  return {
    activeById,
    expiredWaiverIds: [...expiredWaiverIds].sort(),
    invalidWaiverIds: [...invalidWaiverIds].sort(),
  };
}

export function selectAppliedStablecoinPublicationWaivers(
  waivedActiveIds: readonly string[],
  resolvedWaivers: ResolvedStablecoinPublicationWaivers,
): StablecoinPublicationWaiver[] {
  return waivedActiveIds.map((stablecoinId) => {
    const waiver = resolvedWaivers.activeById.get(stablecoinId);
    if (!waiver) {
      throw new Error(`Missing resolved publication waiver for ${stablecoinId}`);
    }
    return waiver;
  });
}

export function evaluateStablecoinPublicationCoverage(
  publishedIds: Iterable<string>,
  nowSec: number = Math.floor(Date.now() / 1000),
  waivers: readonly StablecoinPublicationWaiver[] = STABLECOIN_PUBLICATION_WAIVERS,
  expectedActiveIds: readonly string[] = WORKER_ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id),
): StablecoinPublicationCoverage {
  const presentIds = new Set(publishedIds);
  const resolvedWaivers = resolveStablecoinPublicationWaivers(expectedActiveIds, nowSec, waivers);

  const missingActiveIds: string[] = [];
  const waivedActiveIds: string[] = [];
  let presentActiveCount = 0;
  for (const stablecoinId of expectedActiveIds) {
    if (presentIds.has(stablecoinId)) {
      presentActiveCount++;
    } else if (resolvedWaivers.activeById.has(stablecoinId)) {
      waivedActiveIds.push(stablecoinId);
    } else {
      missingActiveIds.push(stablecoinId);
    }
  }

  return {
    complete: missingActiveIds.length === 0,
    expectedActiveCount: expectedActiveIds.length,
    presentActiveCount,
    waivedActiveCount: waivedActiveIds.length,
    missingActiveIds,
    waivedActiveIds,
    expiredWaiverIds: resolvedWaivers.expiredWaiverIds,
    invalidWaiverIds: resolvedWaivers.invalidWaiverIds,
  };
}

/** Absent active assets are unavailable, never zero, and every downstream job
 * handles them per asset. A gap under 1% of the expected active set is routine
 * upstream churn; up to 10% jobs still run but report the gap; above 10% it is a
 * systemic upstream failure and downstream jobs fail closed. */
export const STABLECOIN_PUBLICATION_GAP_ROUTINE_MAX_SHARE = 0.01;
export const STABLECOIN_PUBLICATION_GAP_TOLERATED_MAX_SHARE = 0.1;

export type StablecoinPublicationGapBand = "none" | "routine" | "elevated" | "systemic";

export function classifyStablecoinPublicationGap(
  coverage: Pick<StablecoinPublicationCoverage, "expectedActiveCount" | "missingActiveIds">,
): StablecoinPublicationGapBand {
  const missingCount = coverage.missingActiveIds.length;
  if (missingCount === 0) return "none";
  if (coverage.expectedActiveCount <= 0) return "systemic";
  const missingShare = missingCount / coverage.expectedActiveCount;
  if (missingShare > STABLECOIN_PUBLICATION_GAP_TOLERATED_MAX_SHARE) return "systemic";
  return missingShare < STABLECOIN_PUBLICATION_GAP_ROUTINE_MAX_SHARE ? "routine" : "elevated";
}

function positiveFiniteNumberOrNull(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function dateSecondsOrNull(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed != null && Math.abs(parsed) <= MAX_VALID_DATE_SECONDS ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function priceRejectionReason(asset: StablecoinPriceCoverageAsset | undefined): string {
  if (!asset) return "active-row-missing";
  if (!isObservedPrice(asset)) return "non-observed-price";
  if (asset.price == null) return "no-accepted-price";
  if (typeof asset.price !== "number" || !Number.isFinite(asset.price)) return "invalid-price";
  if (asset.price <= 0) return "non-positive-price";
  return "price-not-accepted";
}

function acceptedObservation(asset: StablecoinPriceCoverageAsset | undefined): {
  price: number;
  source: string | null;
  observedAt: number | null;
} | null {
  const price = positiveFiniteNumberOrNull(asset?.price);
  if (!asset || !isObservedPrice(asset) || price == null) return null;
  return {
    price,
    source: stringOrNull(asset?.priceSource),
    observedAt: dateSecondsOrNull(asset?.priceObservedAt ?? asset?.priceUpdatedAt),
  };
}

const WORKER_ACTIVE_IDS = WORKER_ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id);
const MARKET_HOURS_ASSET_IDS = new Set<string>(
  STABLECOIN_MARKET_HOURS_CALENDARS.flatMap((calendar) => calendar.assets.map((asset) => asset.stablecoinId)),
);

interface MissingActivePriceParseOptions {
  nowSec?: number;
  observedAt?: number;
  reviewsById?: ReadonlyMap<string, StablecoinPriceGapReview>;
  marketHours?: ReturnType<typeof resolveStablecoinMarketHours>;
}

export function parseMissingActivePriceDetail(
  value: unknown,
  options: MissingActivePriceParseOptions = {},
): MissingActivePriceDetail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.stablecoinId !== "string") return null;
  const streak = numberValue(entry.consecutiveMissingGenerations);
  const consecutiveMissingGenerations = streak != null && Number.isInteger(streak) && streak >= 1 ? streak : null;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const currentPrice = numberValue(entry.currentPrice);
  const priced = currentPrice != null && currentPrice > 0;
  // Registry truth at read time: a persisted acknowledgement is never trusted,
  // so a registry edit or an expired review takes effect immediately.
  const review = priced ? null
    : options.reviewsById
      ? options.reviewsById.get(entry.stablecoinId) ?? null
      : activePriceGapReviewForId(entry.stablecoinId, nowSec);
  const observedAt = options.observedAt ?? nowSec;
  const gapStart = entry.firstMissingAt;
  const firstMissingAt = !priced && consecutiveMissingGenerations != null && MARKET_HOURS_ASSET_IDS.has(entry.stablecoinId)
    && typeof gapStart === "number" && Number.isSafeInteger(gapStart)
    && validReviewSeconds(gapStart) && gapStart <= Math.min(observedAt, nowSec) ? gapStart : undefined;
  const marketHours = options.marketHours ?? resolveStablecoinMarketHours([entry.stablecoinId], nowSec);
  const closureGap = isScheduledClosureGap(marketHours, entry.stablecoinId, firstMissingAt);
  const scheduledClosure = closureGap ? marketHours.closedById.get(entry.stablecoinId) ?? null : null;
  return {
    stablecoinId: entry.stablecoinId,
    symbol: stringOrNull(entry.symbol) ?? entry.stablecoinId,
    marketCapUsd: numberValue(entry.marketCapUsd),
    lastKnownMarketCapUsd: numberValue(entry.lastKnownMarketCapUsd),
    lastKnownMarketCapObservedAt: dateSecondsOrNull(entry.lastKnownMarketCapObservedAt),
    lastKnownMarketCapSource: entry.lastKnownMarketCapSource === "publication" || entry.lastKnownMarketCapSource === "supply_history"
      ? entry.lastKnownMarketCapSource : null,
    currentPrice,
    currentSource: stringOrNull(entry.currentSource),
    currentObservedAt: dateSecondsOrNull(entry.currentObservedAt),
    currentConfidence: stringOrNull(entry.currentConfidence),
    consecutiveMissingGenerations,
    ...(firstMissingAt === undefined ? {} : { firstMissingAt }),
    streakUnavailableReason: consecutiveMissingGenerations == null
      ? entry.streakUnavailableReason === "previous-coverage-read-failed"
        ? "previous-coverage-read-failed" : "previous-coverage-malformed"
      : null,
    lastAcceptedPrice: positiveFiniteNumberOrNull(entry.lastAcceptedPrice),
    lastAcceptedSource: stringOrNull(entry.lastAcceptedSource),
    lastAcceptedObservedAt: dateSecondsOrNull(entry.lastAcceptedObservedAt),
    rejectionReason: stringOrNull(entry.rejectionReason) ?? "no-accepted-price",
    scheduledClosure,
    alertEligible: !priced && review == null && !closureGap
      && (consecutiveMissingGenerations == null
        || consecutiveMissingGenerations >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS),
    acknowledgedGap: review == null || scheduledClosure != null ? null : acknowledgementFromReview(review),
  };
}

export function parsePersistedMissingActivePriceState(
  value: unknown,
  options: MissingActivePriceParseOptions = {},
): MissingActivePriceDetail | null {
  if (!Array.isArray(value)) return null;
  const fields: readonly unknown[] = value;
  if (fields.length < 6 || typeof fields[0] !== "string") return null;
  return parseMissingActivePriceDetail({
    stablecoinId: fields[0],
    symbol: ACTIVE_STABLECOIN_SYMBOL_BY_ID.get(fields[0]) ?? fields[0],
    consecutiveMissingGenerations: fields[1],
    lastAcceptedPrice: fields[2],
    lastAcceptedSource: fields[3],
    lastAcceptedObservedAt: fields[4],
    rejectionReason: fields[5],
    streakUnavailableReason: fields[6],
    lastKnownMarketCapUsd: fields[7],
    lastKnownMarketCapObservedAt: fields[8],
    lastKnownMarketCapSource: fields[9],
    marketCapUsd: fields[10],
    firstMissingAt: fields[11],
    currentPrice: null,
  }, options);
}

/** Compact continuity fills absent details; the last verbose entry wins. */
export function parseMissingActivePriceDetailsById(
  coverage: Record<string, unknown>,
  options: Parameters<typeof parseMissingActivePriceDetail>[1] = {},
): Map<string, MissingActivePriceDetail> {
  const evaluatedAt = coverage.evaluatedAt;
  // The cron wrapper can start before coverage is evaluated. Validate the
  // persisted onset against that generation's evaluation clock when available.
  if (options.observedAt != null && typeof evaluatedAt === "number" && Number.isSafeInteger(evaluatedAt)
    && evaluatedAt >= options.observedAt && evaluatedAt <= (options.nowSec ?? options.observedAt)) {
    options = { ...options, observedAt: evaluatedAt };
  }
  const detailsById = new Map<string, MissingActivePriceDetail>();
  if (Array.isArray(coverage.missingActiveState)) {
    for (const value of coverage.missingActiveState.slice(0, WORKER_ACTIVE_IDS.length)) {
      const detail = parsePersistedMissingActivePriceState(value, options);
      if (detail) detailsById.set(detail.stablecoinId, detail);
    }
  }
  if (Array.isArray(coverage.missingActiveAssets)) {
    for (const value of coverage.missingActiveAssets) {
      const detail = parseMissingActivePriceDetail(value, options);
      if (detail) detailsById.set(detail.stablecoinId, detail);
    }
  }
  return detailsById;
}

function parsePreviousCoverageMetadata(
  metadataJson: string,
  observedAt: number,
  nowSec: number,
): PreviousStablecoinActivePriceCoverage | null {
  try {
    const metadata = parseJsonObject(metadataJson, { onFailure: () => undefined });
    if (!metadata) return null;
    const rawCoverage = metadata.activePriceCoverage;
    if (!rawCoverage || typeof rawCoverage !== "object" || Array.isArray(rawCoverage)) return null;
    const coverage = rawCoverage as Record<string, unknown>;
    // Unknown source labels are unavailable provenance, not a malformed streak.
    // Normalize before the shared enum guard, matching the detail parser below.
    if (Array.isArray(coverage.missingActiveAssets)) {
      for (const value of coverage.missingActiveAssets) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        if (entry.lastKnownMarketCapSource != null
          && entry.lastKnownMarketCapSource !== "publication" && entry.lastKnownMarketCapSource !== "supply_history") {
          entry.lastKnownMarketCapSource = null;
        }
      }
    }
    if (!ActivePriceCoverageHealthSchema.safeParse({
      ...coverage, status: coverage.complete === true ? "complete" : "incomplete", observedAt: null,
    }).success) return null;
    const parseOptions = {
      nowSec,
      observedAt,
      reviewsById: resolveStablecoinPriceGapReviews(WORKER_ACTIVE_IDS, nowSec).activeById,
    };
    const missingActiveIds = Array.isArray(coverage.missingActiveIds)
      ? coverage.missingActiveIds
          .filter((id): id is string => typeof id === "string")
          .slice(0, WORKER_ACTIVE_STABLECOINS.length)
      : [];
    const detailsById = parseMissingActivePriceDetailsById(coverage, parseOptions);
    const missingActiveAssets = missingActiveIds
      .map((stablecoinId) => detailsById.get(stablecoinId))
      .filter((detail): detail is MissingActivePriceDetail => detail != null);
    if (missingActiveAssets.length !== missingActiveIds.length) return null;
    return {
      missingActiveIds,
      missingActiveAssets,
      // Persisted coverage is schema-admitted above; the priced cohort is the
      // collapse baseline the next run compares against.
      expectedActiveCount: numberValue(coverage.expectedActiveCount),
      pricedActiveCount: numberValue(coverage.pricedActiveCount),
    };
  } catch {
    return null;
  }
}

function boundedStateString(value: string | null): string | null {
  return value == null ? null : value.slice(0, 40);
}

export function compactStablecoinActivePriceCoverage(
  coverage: StablecoinActivePriceCoverage,
  retainedDetailCount: number,
): CompactedStablecoinActivePriceCoverage {
  return {
    ...coverage,
    missingActiveAssets: coverage.missingActiveAssets.slice(0, retainedDetailCount),
    missingActiveAssetsTruncated: Math.max(0, coverage.missingActiveAssets.length - retainedDetailCount),
    missingActiveState: coverage.missingActiveAssets.map((detail): PersistedMissingActivePriceState => {
      const state = [
        detail.stablecoinId,
        detail.consecutiveMissingGenerations,
        detail.lastAcceptedPrice,
        boundedStateString(detail.lastAcceptedSource),
        detail.lastAcceptedObservedAt,
        boundedStateString(detail.rejectionReason) ?? "no-accepted-price",
        detail.streakUnavailableReason ?? null,
        detail.lastKnownMarketCapUsd ?? null,
        detail.lastKnownMarketCapObservedAt ?? null,
        detail.lastKnownMarketCapSource ?? null,
        detail.marketCapUsd,
      ] satisfies PersistedMissingActivePriceState;
      return detail.firstMissingAt === undefined ? state : [...state, detail.firstMissingAt];
    }),
  };
}

/** Reads the latest earlier published generation that persisted active price
 * coverage. Rows without this report (for example, aborted/no-write attempts)
 * do not reset a real publication-gap streak. */
export async function loadPreviousStablecoinActivePriceCoverage(
  db: D1Database,
  beforeStartedAt: number,
): Promise<
  | { status: "ok"; coverage: PreviousStablecoinActivePriceCoverage }
  | { status: "missing" }
  | { status: "read-error"; reason: NonNullable<PreviousStablecoinActivePriceCoverage["unavailableReason"]> }
> {
  try {
    const row = await db.prepare(
      `SELECT metadata, started_at
         FROM cron_runs
        WHERE job = 'sync-stablecoins'
          AND started_at < ?
          AND metadata IS NOT NULL
          AND metadata LIKE '%"activePriceCoverage"%'
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    ).bind(beforeStartedAt).first<{ metadata: string; started_at: number }>();
    if (!row) return { status: "missing" };
    const coverage = parsePreviousCoverageMetadata(row.metadata, row.started_at, beforeStartedAt);
    return coverage ? { status: "ok", coverage: { ...coverage, observedAt: row.started_at } }
      : { status: "read-error", reason: "previous-coverage-malformed" };
  } catch (error) {
    logWorkerEventArgs("lib", "warn", "[sync-stablecoins] Failed to load previous active price coverage:", error);
    return { status: "read-error", reason: "previous-coverage-read-failed" };
  }
}

/** Producer-only bootstrap for already absent rows. One bounded existing-history read;
 * never a price replacement, new supply publication, or request-path dependency. */
export async function seedAbsentActivePriceCoverageMarketCaps(
  db: D1Database,
  coverage: StablecoinActivePriceCoverage,
  nowSec: number,
): Promise<void> {
  const gaps = coverage.missingActiveAssets.filter((gap) =>
    gap.rejectionReason === "active-row-missing" && !getOnchainSupplyHoldReason(gap.stablecoinId)
      && !hasActivePriceGapMarketCapEvidence(gap, nowSec),
  );
  if (gaps.length === 0) return;
  try {
    const rows = await db.prepare(`
      WITH absent AS (SELECT value AS stablecoin_id FROM json_each(?))
      SELECT h.stablecoin_id, h.snapshot_date, h.circulating_usd
      FROM absent
      JOIN supply_history h ON h.stablecoin_id = absent.stablecoin_id
        AND h.snapshot_date = (
          SELECT MAX(snapshot_date) FROM supply_history
          WHERE stablecoin_id = absent.stablecoin_id AND snapshot_date BETWEEN ? AND ?
        )
      LIMIT ?`).bind(
      JSON.stringify(gaps.map((gap) => gap.stablecoinId)),
      nowSec - STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC, nowSec, gaps.length,
    ).all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();
    if (!rows.success) throw new Error("supply-history-cap-read-failed");
    const gapsById = new Map(gaps.map((gap) => [gap.stablecoinId, gap]));
    for (const row of rows.results ?? []) {
      const gap = gapsById.get(row.stablecoin_id);
      if (!gap || !Number.isFinite(row.circulating_usd) || row.circulating_usd < 0
        || !Number.isFinite(row.snapshot_date) || row.snapshot_date <= 0
        || row.snapshot_date > nowSec || nowSec - row.snapshot_date > STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC) continue;
      gap.lastKnownMarketCapUsd = row.circulating_usd;
      gap.lastKnownMarketCapObservedAt = row.snapshot_date;
      gap.lastKnownMarketCapSource = "supply_history";
    }
  } catch (error) {
    logWorkerEventArgs("lib", "warn", "[sync-stablecoins] Failed to seed absent-row market-cap evidence:", error);
  }
}

/** Price coverage is intentionally independent of row publication coverage.
 * A published active row with a null, zero, negative, or non-finite price is
 * still a public data-quality failure, but it must not block cache publication. */
export function evaluateStablecoinActivePriceCoverage(
  assets: Iterable<StablecoinPriceCoverageAsset>,
  expectedActiveIds: readonly string[] = WORKER_ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id),
  options: StablecoinActivePriceCoverageOptions = {},
): StablecoinActivePriceCoverage {
  const assetsById = new Map<string, StablecoinPriceCoverageAsset>();
  for (const asset of assets) {
    assetsById.set(asset.id, asset);
  }

  const pricedActiveIds: string[] = [];
  const nominalReferenceIds: string[] = [];
  const missingActiveIds: string[] = [];
  const missingActiveAssets: MissingActivePriceDetail[] = [];
  const alertEligibleIds: string[] = [];
  const acknowledgedGapIds: string[] = [];
  const scheduledClosureGapIds: string[] = [];
  const previousMissingIds = new Set(options.previousCoverage?.missingActiveIds ?? []);
  const previousMissingDetailsById = new Map(
    (options.previousCoverage?.missingActiveAssets ?? []).map((detail) => [detail.stablecoinId, detail] as const),
  );
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const resolvedReviews = resolveStablecoinPriceGapReviews(
    expectedActiveIds,
    nowSec,
    options.priceGapReviews,
  );
  const marketHours = resolveStablecoinMarketHours(expectedActiveIds, nowSec);
  let presentActiveCount = 0;
  let affectedMarketCapUsd: number | null = 0;
  let nominalReferenceMarketCapUsd: number | null = 0;
  let maxConsecutiveMissingGenerations: number | null = 0;

  for (const stablecoinId of expectedActiveIds) {
    const asset = assetsById.get(stablecoinId);
    if (asset) presentActiveCount++;

    const currentPrice = asset && isObservedPrice(asset) ? numberValue(asset.price) : null;
    if (currentPrice != null && currentPrice > 0) {
      pricedActiveIds.push(stablecoinId);
      continue;
    }

    const marketCapUsd = getCirculatingRawOrNull(asset);
    if (NominalPriceReferenceSchema.safeParse(asset?.nominalPriceReference).success) {
      nominalReferenceIds.push(stablecoinId);
      nominalReferenceMarketCapUsd = nominalReferenceMarketCapUsd == null || marketCapUsd == null
        ? null : nominalReferenceMarketCapUsd + marketCapUsd;
      continue;
    }
    affectedMarketCapUsd = affectedMarketCapUsd == null || marketCapUsd == null
      ? null : affectedMarketCapUsd + marketCapUsd;
    const previousDetail = previousMissingDetailsById.get(stablecoinId);
    const previousStreak = options.previousCoverage?.unavailableReason
      ? null
      : previousMissingIds.has(stablecoinId)
        ? previousDetail?.consecutiveMissingGenerations ?? null
        : 0;
    const consecutiveMissingGenerations = previousStreak == null ? null : previousStreak + 1;
    const firstMissingAt = previousStreak != null && MARKET_HOURS_ASSET_IDS.has(stablecoinId)
      ? consecutiveMissingGenerations === 1 ? nowSec : previousDetail?.firstMissingAt
      : undefined;
    const previousAccepted = acceptedObservation(options.previousAcceptedAssetsById?.get(stablecoinId));
    const previousAsset = options.previousAcceptedAssetsById?.get(stablecoinId);
    // A reviewed supply hold withholds prior packets too: no retained last-known cap.
    const supplyHeld = getOnchainSupplyHoldReason(stablecoinId) != null;
    const capDetail = supplyHeld ? undefined : previousDetail;
    const previousCap = supplyHeld ? null : getCirculatingRawOrNull(previousAsset);
    const lastKnownMarketCapUsd = marketCapUsd ?? previousCap
      ?? capDetail?.lastKnownMarketCapUsd ?? capDetail?.marketCapUsd ?? null;
    const lastKnownMarketCapObservedAt = marketCapUsd != null
      ? dateSecondsOrNull(asset?.supplyObservedAt) ?? nowSec
      : previousCap != null
        ? dateSecondsOrNull(previousAsset?.supplyObservedAt)
        : capDetail?.lastKnownMarketCapUsd != null
          ? capDetail.lastKnownMarketCapObservedAt ?? null
          : capDetail?.marketCapUsd != null ? options.previousCoverage?.observedAt ?? null : null;
    const lastKnownMarketCapSource = marketCapUsd != null || previousCap != null
      ? "publication" : capDetail?.lastKnownMarketCapSource
        ?? (capDetail?.marketCapUsd != null ? "publication" : null);
    const lastAcceptedPrice = previousAccepted?.price ?? previousDetail?.lastAcceptedPrice ?? null;
    const lastAcceptedSource = previousAccepted?.source ?? previousDetail?.lastAcceptedSource ?? null;
    const lastAcceptedObservedAt = previousAccepted?.observedAt ?? previousDetail?.lastAcceptedObservedAt ?? null;
    const closureGap = isScheduledClosureGap(marketHours, stablecoinId, firstMissingAt);
    const scheduledClosure = closureGap ? marketHours.closedById.get(stablecoinId) ?? null : null;
    if (scheduledClosure) scheduledClosureGapIds.push(stablecoinId);
    const acknowledgedReview = scheduledClosure ? null : resolvedReviews.activeById.get(stablecoinId) ?? null;
    if (acknowledgedReview) acknowledgedGapIds.push(stablecoinId);
    const alertEligible = acknowledgedReview == null && !closureGap
      && (consecutiveMissingGenerations == null || consecutiveMissingGenerations >= ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS);
    if (alertEligible) alertEligibleIds.push(stablecoinId);
    maxConsecutiveMissingGenerations = maxConsecutiveMissingGenerations == null || consecutiveMissingGenerations == null
      ? null : Math.max(maxConsecutiveMissingGenerations, consecutiveMissingGenerations);
    missingActiveIds.push(stablecoinId);
    missingActiveAssets.push({
      stablecoinId,
      symbol: stringOrNull(asset?.symbol)
        ?? ACTIVE_STABLECOIN_SYMBOL_BY_ID.get(stablecoinId)
        ?? stablecoinId,
      marketCapUsd,
      lastKnownMarketCapUsd,
      lastKnownMarketCapObservedAt,
      lastKnownMarketCapSource,
      currentPrice,
      currentSource: typeof asset?.priceSource === "string" ? asset.priceSource : null,
      currentObservedAt: dateSecondsOrNull(asset?.priceObservedAt ?? asset?.priceUpdatedAt),
      currentConfidence: typeof asset?.priceConfidence === "string" ? asset.priceConfidence : null,
      consecutiveMissingGenerations,
      ...(firstMissingAt === undefined ? {} : { firstMissingAt }),
      streakUnavailableReason: consecutiveMissingGenerations == null
        ? options.previousCoverage?.unavailableReason ?? previousDetail?.streakUnavailableReason ?? "previous-coverage-malformed"
        : null,
      lastAcceptedPrice,
      lastAcceptedSource,
      lastAcceptedObservedAt,
      rejectionReason: priceRejectionReason(asset),
      alertEligible,
      scheduledClosure,
      acknowledgedGap: acknowledgedReview == null ? null : acknowledgementFromReview(acknowledgedReview),
    });
  }

  return {
    complete: missingActiveIds.length === 0,
    evaluatedAt: nowSec,
    expectedActiveCount: expectedActiveIds.length,
    presentActiveCount,
    pricedActiveCount: pricedActiveIds.length,
    missingPriceCount: missingActiveIds.length,
    nominalReferenceCount: nominalReferenceIds.length,
    nominalReferenceMarketCapUsd,
    nominalReferenceIds,
    nominalReferenceReason: "reviewed-nominal-reference",
    pricedActiveIds,
    missingActiveIds,
    affectedMarketCapUsd,
    missingActiveAssets,
    alertEligibleCount: alertEligibleIds.length,
    alertEligibleIds,
    scheduledClosureGapIds,
    acknowledgedGapIds,
    acknowledgedGapCount: acknowledgedGapIds.length,
    expiredMarketHoursCalendarIds: marketHours.expiredCalendarIds,
    invalidMarketHoursCalendarIds: marketHours.invalidCalendarIds,
    expiredGapReviewIds: resolvedReviews.expiredGapReviewIds,
    invalidGapReviewIds: resolvedReviews.invalidGapReviewIds,
    maxConsecutiveMissingGenerations,
  };
}
