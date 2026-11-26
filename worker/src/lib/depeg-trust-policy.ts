import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, DEX_FRESHNESS_SEC, DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD, DEX_PROTOCOL_SOURCE_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { getPrimaryPriceAgeSec, getPrimaryTrustSources, type PrimaryPriceTrustInput } from "@shared/lib/depeg-primary-trust";
export { classifyPrimaryDepegTrust } from "@shared/lib/depeg-primary-trust";
import { DEX_PRICE_CHECK_FRESHNESS_SEC, DEX_PRICE_CHECK_UI_MIN_TVL_USD } from "./dex-cron-constants";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { getDexPriceSourceEntries } from "@shared/lib/dex-price-sources";
import {
  CURVE_NAV_SPOT_QUOTE_POLICY,
  CURVE_NAV_SPOT_QUOTE_POLICY_ID,
} from "../cron/dex-liquidity/types";
export { getDexPriceSourceEntries } from "@shared/lib/dex-price-sources";

export type DexPriceTrustTier = "ui" | "depeg";

export interface DexTrustPolicy {
  maxAgeSec: number;
  minTvlUsd: number;
}

// Moved to shared so display surfaces (frontend hero, peg-analytics) share
// the detection engine's peg-reference gate; re-exported below for existing
// worker call sites.
export { isAuthoritativeDepegPegReference } from "@shared/lib/peg-reference-trust";

export type OffchainDepegConfirmerKey = "coingecko-confirm";

export function resolveDepegSourceFamily(sourceKey: string | null | undefined): string | null {
  if (!sourceKey) return null;
  const normalized = sourceKey.trim().toLowerCase();
  if (!normalized) return null;
  const compositeParts = normalizePricingSourceKeys(normalized);
  if (compositeParts.length > 1) {
    const families = compositeParts
      .map((part) => resolveDepegSourceFamily(part))
      .filter((family): family is string => !!family);
    return [...new Set(families)].join("+") || null;
  }

  // Unregistered historical alias; registered families belong to the pricing registry.
  if (normalized === "dexscreener") {
    return "fallback:dexscreener";
  }

  return getPricingSourceRegistryEntry(normalized)?.depegSourceFamily ?? normalized;
}

export function getPrimaryDepegSourceFamilies(
  input: Pick<PrimaryPriceTrustInput, "agreeSources" | "priceSource">,
): Set<string> {
  const families = new Set<string>();
  for (const source of getPrimaryTrustSources(input)) {
    const family = resolveDepegSourceFamily(source);
    if (family) families.add(family);
  }
  return families;
}

export function getFreshIndependentPrimarySourceFamilies(
  input: PrimaryPriceTrustInput,
  nowSec: number,
  excludedFamily: string,
): Set<string> {
  if (
    !isObservedPrice(input) ||
    input.price == null ||
    !Number.isFinite(input.price) ||
    input.price <= 0 ||
    input.priceSource === "cached" ||
    (input.priceConfidence !== "single-source" && input.priceConfidence !== "high") ||
    getPrimaryPriceAgeSec(input, nowSec) > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC
  ) {
    return new Set();
  }

  return new Set(
    [...getPrimaryDepegSourceFamilies(input)].filter(
      (family) => family !== excludedFamily && !family.startsWith("fallback:"),
    ),
  );
}

export function chooseIndependentOffchainDepegConfirmer(
  input: Pick<PrimaryPriceTrustInput, "agreeSources" | "priceSource">,
): OffchainDepegConfirmerKey | null {
  const primaryFamilies = getPrimaryDepegSourceFamilies(input);
  if (!primaryFamilies.has("coingecko")) return "coingecko-confirm";
  return null;
}

export function getDexTrustPolicy(tier: DexPriceTrustTier): DexTrustPolicy {
  if (tier === "ui") {
    return {
      maxAgeSec: DEX_PRICE_CHECK_FRESHNESS_SEC,
      minTvlUsd: DEX_PRICE_CHECK_UI_MIN_TVL_USD,
    };
  }

  return {
    maxAgeSec: DEX_FRESHNESS_SEC,
    minTvlUsd: DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
  };
}

function isPositiveSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseDexPricePayload(input: unknown): unknown {
  if (typeof input !== "string") return input ?? null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function isClockedCurveNavPayload(payload: unknown): payload is Record<string, unknown> {
  return (
    payload != null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).quotePolicy === CURVE_NAV_SPOT_QUOTE_POLICY_ID
  );
}

export type ClockedCurveNavPayloadReason = "invalid-timestamp" | "future-timestamp" | "capture-stale" | "stale-price";

export function validateClockedCurveNavCaptureRecord(
  entry: unknown,
  options: {
    nowSec: number;
    effectivePublishedAtSec?: number | null;
    publicationUpdatedAt?: number | null;
    aggregateObservedAt?: number | null;
  },
): {
  reason: ClockedCurveNavPayloadReason | null;
  earliestClockSec: number | null;
  poolId: string | null;
} {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { reason: "invalid-timestamp", earliestClockSec: null, poolId: null };
  }
  const record = entry as Record<string, unknown>;
  const poolId = typeof record.poolId === "string" && record.poolId.trim().length > 0 ? record.poolId : null;
  if (
    poolId == null ||
    typeof record.blockHash !== "string" || !record.blockHash.trim() ||
    typeof record.sourceGenerationId !== "string" || !record.sourceGenerationId.trim() ||
    (record.admissionMode !== "sole-venue" && record.admissionMode !== "corroborated") ||
    !isPositiveSafeTimestamp(options.nowSec) ||
    !isPositiveSafeTimestamp(record.blockNumber) ||
    !isPositiveSafeTimestamp(record.poolRatioObservedAt) ||
    !isPositiveSafeTimestamp(record.quoteMarkObservedAt) ||
    !isPositiveSafeTimestamp(record.captureEvaluatedAtSec)
  ) {
    return { reason: "invalid-timestamp", earliestClockSec: null, poolId };
  }
  const earliestClockSec = Math.min(record.poolRatioObservedAt, record.quoteMarkObservedAt);
  const { nowSec, effectivePublishedAtSec, publicationUpdatedAt, aggregateObservedAt } = options;
  if (
    record.poolRatioObservedAt > nowSec ||
    record.quoteMarkObservedAt > nowSec ||
    record.captureEvaluatedAtSec > nowSec ||
    record.poolRatioObservedAt > record.captureEvaluatedAtSec ||
    (effectivePublishedAtSec != null && record.captureEvaluatedAtSec > effectivePublishedAtSec)
  ) {
    return { reason: "future-timestamp", earliestClockSec, poolId };
  }
  if (aggregateObservedAt != null && aggregateObservedAt > earliestClockSec) {
    return { reason: "invalid-timestamp", earliestClockSec, poolId };
  }
  if (
    record.captureEvaluatedAtSec - record.poolRatioObservedAt > CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec ||
    (effectivePublishedAtSec != null &&
      effectivePublishedAtSec - record.poolRatioObservedAt > CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec) ||
    (publicationUpdatedAt != null &&
      publicationUpdatedAt - record.poolRatioObservedAt > CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec)
  ) {
    return { reason: "capture-stale", earliestClockSec, poolId };
  }
  if (
    nowSec - record.poolRatioObservedAt >= CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec ||
    nowSec - record.quoteMarkObservedAt >= CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec
  ) {
    return { reason: "stale-price", earliestClockSec, poolId };
  }
  return { reason: null, earliestClockSec, poolId };
}

export interface ClockedCurveNavPayloadAssessment {
  isClockedCurveNav: boolean;
  maxAgeSec: number | null;
  reason: ClockedCurveNavPayloadReason | null;
  earliestClockSec: number | null;
  quotePublishedAtSec: number | null;
  poolIds: string[];
}

/**
 * Single authority (R5) for clocked Curve StableSwap-NG active-NAV payload
 * freshness and capture validation across API, peg-summary, depeg, and DEWS readers.
 */
export function assessClockedCurveNavPayload(
  payload: unknown,
  options: {
    nowSec: number;
    publicationUpdatedAt?: number | null;
    aggregateObservedAt?: number | null;
  },
): ClockedCurveNavPayloadAssessment {
  if (!isClockedCurveNavPayload(payload)) {
    return {
      isClockedCurveNav: false,
      maxAgeSec: null,
      reason: null,
      earliestClockSec: null,
      quotePublishedAtSec: null,
      poolIds: [],
    };
  }
  const maxAgeSec = CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec;
  const rawCaptures = Array.isArray(payload.quoteCaptures) ? payload.quoteCaptures : [];
  const poolIds: string[] = [];
  for (const entry of rawCaptures) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const id = (entry as Record<string, unknown>).poolId;
      if (typeof id === "string" && id.trim().length > 0) poolIds.push(id);
    }
  }
  const fail = (reason: ClockedCurveNavPayloadReason, quotePublishedAtSec: number | null = null): ClockedCurveNavPayloadAssessment => ({
    isClockedCurveNav: true,
    maxAgeSec,
    reason,
    earliestClockSec: null,
    quotePublishedAtSec,
    poolIds,
  });

  if (!isPositiveSafeTimestamp(options.nowSec) || payload.quoteMaxAgeSec !== maxAgeSec) {
    return fail("invalid-timestamp");
  }
  const hasPublicationUpdatedAt = options.publicationUpdatedAt !== undefined;
  const publicationUpdatedAt = options.publicationUpdatedAt ?? null;
  let readStale = false;
  if (hasPublicationUpdatedAt) {
    if (!isPositiveSafeTimestamp(publicationUpdatedAt)) return fail("invalid-timestamp");
    if (publicationUpdatedAt > options.nowSec) return fail("future-timestamp");
    if (options.nowSec - publicationUpdatedAt >= maxAgeSec) readStale = true;
  }

  let quotePublishedAtSec: number | null = null;
  if (payload.quotePublishedAtSec !== undefined) {
    if (!isPositiveSafeTimestamp(payload.quotePublishedAtSec)) return fail("invalid-timestamp");
    if (payload.quotePublishedAtSec > options.nowSec) return fail("future-timestamp");
    if (publicationUpdatedAt != null && payload.quotePublishedAtSec < publicationUpdatedAt) {
      return fail("invalid-timestamp");
    }
    if (options.nowSec - payload.quotePublishedAtSec >= maxAgeSec) readStale = true;
    quotePublishedAtSec = payload.quotePublishedAtSec;
  }

  if (rawCaptures.length === 0) {
    return fail("invalid-timestamp", quotePublishedAtSec);
  }
  const effectivePublishedAtSec = quotePublishedAtSec ?? publicationUpdatedAt;
  let earliestClockSec = publicationUpdatedAt ?? Infinity;
  if (options.aggregateObservedAt != null && isPositiveSafeTimestamp(options.aggregateObservedAt)) {
    earliestClockSec = Math.min(earliestClockSec, options.aggregateObservedAt);
  }

  for (const entry of rawCaptures) {
    const capture = validateClockedCurveNavCaptureRecord(entry, {
      nowSec: options.nowSec,
      effectivePublishedAtSec,
      publicationUpdatedAt,
      aggregateObservedAt: options.aggregateObservedAt ?? null,
    });
    if (capture.reason != null) {
      if (capture.reason === "stale-price") {
        readStale = true;
      } else {
        return fail(capture.reason, quotePublishedAtSec);
      }
    }
    if (capture.earliestClockSec != null) {
      earliestClockSec = Math.min(earliestClockSec, capture.earliestClockSec);
    }
  }

  if (readStale) {
    return fail("stale-price", quotePublishedAtSec);
  }

  return {
    isClockedCurveNav: true,
    maxAgeSec,
    reason: null,
    earliestClockSec: Number.isFinite(earliestClockSec) ? earliestClockSec : null,
    quotePublishedAtSec,
    poolIds,
  };
}

function mapCurveNavReasonToRejectionReason(
  reason: ClockedCurveNavPayloadReason,
): string {
  if (reason === "future-timestamp") return "aggregate-clock-future";
  if (reason === "stale-price" || reason === "capture-stale") return "aggregate-clock-stale";
  return "aggregate-clock-invalid";
}

/** Single R5 mapping from clocked Curve NAV payload verdicts to API `dexPriceUnavailableReason`. */
export function mapClockedCurveNavReasonToApiUnavailableReason(
  reason: ClockedCurveNavPayloadReason,
): "invalid-timestamp" | "future-timestamp" | "stale-price" {
  if (reason === "future-timestamp") return "future-timestamp";
  if (reason === "stale-price" || reason === "capture-stale") return "stale-price";
  return "invalid-timestamp";
}

export function isTrustedDexPriceRow(
  row: Pick<{ updated_at: number; source_total_tvl: number }, "updated_at" | "source_total_tvl"> & {
    aggregateObservedAt?: number | null;
    price_sources_json?: string | null;
    pricePayload?: unknown;
  },
  nowSec: number,
  tier: DexPriceTrustTier,
): boolean {
  if (!Number.isSafeInteger(row.updated_at) || row.updated_at <= 0 || row.updated_at > nowSec) return false;
  if (!Number.isFinite(row.source_total_tvl) || row.source_total_tvl < 0) return false;

  const policy = getDexTrustPolicy(tier);
  const payload = row.pricePayload !== undefined ? row.pricePayload : parseDexPricePayload(row.price_sources_json);
  const curveNav = assessClockedCurveNavPayload(payload, {
    nowSec,
    publicationUpdatedAt: row.updated_at,
    ...(row.aggregateObservedAt !== undefined ? { aggregateObservedAt: row.aggregateObservedAt } : {}),
  });
  const maxAgeSec = curveNav.isClockedCurveNav && curveNav.maxAgeSec != null
    ? Math.min(policy.maxAgeSec, curveNav.maxAgeSec)
    : policy.maxAgeSec;
  if (curveNav.isClockedCurveNav && curveNav.reason != null) return false;
  return (nowSec - row.updated_at) < maxAgeSec && row.source_total_tvl >= policy.minTvlUsd;
}

export type DexAggregateClockReason = "aggregate-clock-unavailable" | "aggregate-clock-invalid" | "aggregate-clock-future";
export interface DexAggregateClock {
  aggregateObservedAt: number | null;
  aggregateClockReason: DexAggregateClockReason | null;
}

/** Every repeated clock and the optional independent header must validate. */
export function getDexAggregateObservedAt(payload: unknown, nowSec: number, purpose: "affirmative" | "display" = "affirmative"): DexAggregateClock {
  const sources = getDexPriceSourceEntries(payload, purpose);
  const unavailable: DexAggregateClock = { aggregateObservedAt: null, aggregateClockReason: "aggregate-clock-unavailable" };
  if (sources == null) return unavailable;
  const contributors = Array.isArray(payload) ? sources : [payload, ...sources];
  if (contributors.length === 0) return unavailable;
  let oldest = Infinity;
  for (const source of contributors) {
    if (source == null || typeof source !== "object" || !("aggregateObservedAt" in source)) return unavailable;
    const clock = purpose === "display" && source.aggregateObservedAt === null && "displayAggregateObservedAt" in source
      ? source.displayAggregateObservedAt : source.aggregateObservedAt;
    if (clock == null) return unavailable;
    if (typeof clock !== "number" || !Number.isFinite(clock) || clock <= 0) {
      return { aggregateObservedAt: null, aggregateClockReason: "aggregate-clock-invalid" };
    }
    if (clock > nowSec) return { aggregateObservedAt: null, aggregateClockReason: "aggregate-clock-future" };
    oldest = Math.min(oldest, clock);
  }
  if (purpose === "affirmative" && isClockedCurveNavPayload(payload)) {
    const assessment = assessClockedCurveNavPayload(payload, {
      nowSec,
      aggregateObservedAt: oldest,
    });
    if (assessment.reason === "future-timestamp") {
      return { aggregateObservedAt: null, aggregateClockReason: "aggregate-clock-future" };
    }
    if (assessment.reason === "invalid-timestamp") {
      return { aggregateObservedAt: null, aggregateClockReason: "aggregate-clock-invalid" };
    }
    // Both "capture-stale" and "stale-price" are staleness rejections handled
    // uniformly as "aggregate-clock-stale" / "stale-price" by trust admission.
  }
  return { aggregateObservedAt: oldest, aggregateClockReason: null };
}

export function readDexAggregateObservedAt(json: string | null | undefined, nowSec: number): number | null {
  try {
    return getDexAggregateObservedAt(JSON.parse(json ?? "null"), nowSec).aggregateObservedAt;
  } catch {
    return null;
  }
}

export function getDexAggregateRejectionReason(
  row: {
    updated_at: number;
    source_total_tvl: number;
    aggregateObservedAt?: number | null;
    aggregateClockReason?: DexAggregateClockReason | null;
    price_sources_json?: string | null;
    pricePayload?: unknown;
  },
  nowSec: number,
  tier: DexPriceTrustTier,
): string | null {
  const policy = getDexTrustPolicy(tier);
  const payload = row.pricePayload !== undefined ? row.pricePayload : parseDexPricePayload(row.price_sources_json);
  const clockedCurveNav = isClockedCurveNavPayload(payload);
  const maxAgeSec = clockedCurveNav
    ? Math.min(policy.maxAgeSec, CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec)
    : policy.maxAgeSec;
  const minTvlUsd = policy.minTvlUsd;
  if (!Number.isSafeInteger(row.updated_at) || row.updated_at <= 0) return "publication-invalid";
  if (row.updated_at > nowSec) return "publication-future";
  if (nowSec - row.updated_at >= maxAgeSec) return "publication-stale";
  if (!Number.isFinite(row.source_total_tvl) || row.source_total_tvl < 0) return "tvl-invalid";
  if (row.source_total_tvl < minTvlUsd) return "insufficient-tvl";
  if (row.aggregateClockReason) return row.aggregateClockReason;
  const clock = row.aggregateObservedAt;
  if (clock == null) return "aggregate-clock-unavailable";
  if (typeof clock !== "number" || !Number.isFinite(clock) || clock <= 0) return "aggregate-clock-invalid";
  if (clock > nowSec) return "aggregate-clock-future";
  if (nowSec - clock >= maxAgeSec) return "aggregate-clock-stale";
  if (clockedCurveNav) {
    const assessment = assessClockedCurveNavPayload(payload, {
      nowSec,
      publicationUpdatedAt: row.updated_at,
      aggregateObservedAt: clock,
    });
    if (assessment.reason != null) return mapCurveNavReasonToRejectionReason(assessment.reason);
  }
  return null;
}

/** Publication/TVL alone remains available for conservative vetoes. */
export function isAffirmativeDexPriceRow(
  row: Parameters<typeof getDexAggregateRejectionReason>[0],
  nowSec: number,
  tier: DexPriceTrustTier,
): boolean {
  return getDexAggregateRejectionReason(row, nowSec, tier) == null;
}

export function isFreshDexPoolObservation(observedAt: number | null | undefined, nowSec: number): observedAt is number {
  return observedAt != null && Number.isSafeInteger(observedAt) && observedAt > 0 &&
    observedAt <= nowSec && nowSec - observedAt <= DEX_PROTOCOL_SOURCE_FRESHNESS_SEC;
}

export function hasFreshMultiSourcePrimaryAgreement(
  input: PrimaryPriceTrustInput,
  nowSec: number,
): boolean {
  if (!isObservedPrice(input) || input.price == null || !Number.isFinite(input.price) || input.price <= 0) {
    return false;
  }

  if (
    input.priceSource === "cached" ||
    input.priceConfidence === "fallback" ||
    input.priceConfidence === "low" ||
    getPrimaryPriceAgeSec(input, nowSec) > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC
  ) {
    return false;
  }

  if (input.priceConfidence !== "high") {
    return false;
  }

  const sourceFamilies = getPrimaryDepegSourceFamilies(input);
  if (sourceFamilies.size < 2) {
    return false;
  }

  return [...sourceFamilies].some((family) => !family.startsWith("fallback:"));
}
