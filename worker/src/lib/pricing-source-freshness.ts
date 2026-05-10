import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import type { PriceObservedAtMode } from "@shared/types/core";

const MAX_FUTURE_PRICE_SOURCE_TIMESTAMP_SKEW_SEC = 10 * 60;

export type PricingSourceFreshnessRejectReason =
  | "unknown_source"
  | "missing_observed_at"
  | "invalid_observed_at"
  | "stale_observed_at"
  | "future_observed_at";

export interface PricingSourceFreshnessAccepted {
  accepted: true;
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
}

export interface PricingSourceFreshnessRejected {
  accepted: false;
  reason: PricingSourceFreshnessRejectReason;
  source: string;
  observedAt: number | null;
  ageSec?: number;
  maxAgeSec?: number;
  futureSkewSec?: number;
  maxFutureSkewSec?: number;
}

export type PricingSourceFreshnessDecision =
  | PricingSourceFreshnessAccepted
  | PricingSourceFreshnessRejected;

export interface ValidatePricingSourceFreshnessInput {
  source: string;
  observedAt?: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  nowSec?: number;
  requireObservedAt?: boolean;
  maxFutureSkewSec?: number;
}

function normalizeObservedAt(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function isInvalidObservedAt(value: number | null | undefined): boolean {
  return value != null && normalizeObservedAt(value) == null;
}

function resolveObservedAtMode(
  source: string,
  observedAt: number | null,
  observedAtMode: PriceObservedAtMode | null | undefined,
): PriceObservedAtMode | null {
  if (observedAtMode !== undefined) return observedAtMode;
  const entry = getPricingSourceRegistryEntry(source);
  if (observedAt != null && entry?.supportsUpstreamObservedAt) {
    return "upstream";
  }
  return entry?.defaultObservedAtMode ?? null;
}

export function validatePricingSourceFreshness(
  input: ValidatePricingSourceFreshnessInput,
): PricingSourceFreshnessDecision {
  const entry = getPricingSourceRegistryEntry(input.source);
  if (!entry) {
    return {
      accepted: false,
      reason: "unknown_source",
      source: input.source,
      observedAt: normalizeObservedAt(input.observedAt),
    };
  }

  if (isInvalidObservedAt(input.observedAt)) {
    return {
      accepted: false,
      reason: "invalid_observed_at",
      source: input.source,
      observedAt: null,
    };
  }

  const observedAt = normalizeObservedAt(input.observedAt);
  const observedAtMode = resolveObservedAtMode(input.source, observedAt, input.observedAtMode);
  const mustHaveObservedAt =
    !!input.requireObservedAt ||
    entry.requiresObservedAt ||
    entry.defaultObservedAtMode === "upstream";

  if (observedAt == null) {
    if (mustHaveObservedAt) {
      return {
        accepted: false,
        reason: "missing_observed_at",
        source: input.source,
        observedAt,
      };
    }
    return { accepted: true, observedAt, observedAtMode };
  }

  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const maxFutureSkewSec = input.maxFutureSkewSec ?? MAX_FUTURE_PRICE_SOURCE_TIMESTAMP_SKEW_SEC;
  if (observedAt > nowSec + maxFutureSkewSec) {
    return {
      accepted: false,
      reason: "future_observed_at",
      source: input.source,
      observedAt,
      futureSkewSec: observedAt - nowSec,
      maxFutureSkewSec,
    };
  }

  const maxAgeSec = entry.maxTrustedAgeSec;
  if (typeof maxAgeSec === "number" && Number.isFinite(maxAgeSec) && maxAgeSec > 0) {
    const ageSec = nowSec - observedAt;
    if (ageSec > maxAgeSec) {
      return {
        accepted: false,
        reason: "stale_observed_at",
        source: input.source,
        observedAt,
        ageSec,
        maxAgeSec,
      };
    }
  }

  return { accepted: true, observedAt, observedAtMode };
}

export function validateCompositePricingSourceFreshness(
  input: ValidatePricingSourceFreshnessInput,
): PricingSourceFreshnessDecision {
  const parts = splitCompositePriceSource(input.source);
  if (parts.length === 0) {
    return {
      accepted: false,
      reason: "unknown_source",
      source: input.source,
      observedAt: normalizeObservedAt(input.observedAt),
    };
  }

  let accepted: PricingSourceFreshnessAccepted | null = null;
  for (const part of parts) {
    const decision = validatePricingSourceFreshness({ ...input, source: part });
    if (!decision.accepted) return decision;
    accepted = decision;
  }

  return accepted ?? {
    accepted: true,
    observedAt: normalizeObservedAt(input.observedAt),
    observedAtMode: input.observedAtMode ?? null,
  };
}
