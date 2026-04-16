import type { ReserveSlice } from "@shared/types/core";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
import { reserveDegradedWarning, reserveInfoWarning } from "./warnings";
export { decimalNumberFromBigInt, decimalStringFromBigInt } from "../../lib/bigint";

const RISK_SEVERITY: Record<ReserveSlice["risk"], number> = {
  "very-low": 0,
  low: 1,
  medium: 2,
  high: 3,
  "very-high": 4,
};

export function worseRisk(a: ReserveSlice["risk"], b: ReserveSlice["risk"]): ReserveSlice["risk"] {
  return RISK_SEVERITY[a] >= RISK_SEVERITY[b] ? a : b;
}

interface UnknownExposureWarningOptions {
  code: string;
  message: string;
  unknownExposurePct: number;
  thresholdPct?: number;
}

/**
 * Deduplicate and normalize reserve slices so percentages sum to exactly 100%.
 * Slices sharing the same (name, risk, coinId, depType, blacklistable) key are merged by summing pct.
 * After rounding, the largest slice absorbs any remainder to maintain the 100% invariant.
 * Returns slices sorted by pct descending.
 */
export function normalizeSlices(slices: ReserveSlice[], decimals = 1): ReserveSlice[] {
  const factor = 10 ** decimals;
  const grouped = new Map<string, ReserveSlice>();

  for (const slice of slices) {
    if (!Number.isFinite(slice.pct) || slice.pct <= 0) continue;
    const key = [
      slice.name,
      slice.risk,
      slice.coinId ?? "",
      slice.depType ?? "",
      slice.blacklistable == null ? "" : String(slice.blacklistable),
    ].join("|");
    const existing = grouped.get(key);
    if (existing) {
      existing.pct += slice.pct;
      if (slice.blacklistable != null) {
        existing.blacklistable = Boolean(existing.blacklistable) || slice.blacklistable;
      }
    } else {
      grouped.set(key, { ...slice });
    }
  }

  const normalized = Array.from(grouped.values())
    .map((slice) => ({ ...slice, pctUnits: Math.round(slice.pct * factor) }))
    .filter((slice) => slice.pctUnits > 0);

  if (normalized.length === 0) return [];

  const sumUnits = normalized.reduce((acc, slice) => acc + slice.pctUnits, 0);
  const maxIdx = normalized.reduce(
    (maxIndex, slice, index, arr) => (slice.pctUnits > arr[maxIndex].pctUnits ? index : maxIndex),
    0,
  );
  // Clamp negative remainder so a wildly-oversummed upstream (e.g. 300%) can't
  // push the largest slice below zero. Validation catches the gross deviation
  // upstream; this is defense-in-depth.
  normalized[maxIdx].pctUnits += Math.max(0, (100 * factor) - sumUnits);

  return normalized
    .map(({ pctUnits, ...slice }) => ({ ...slice, pct: pctUnits / factor }))
    .filter((slice) => slice.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}

export function valueUsdFromBigIntPrice(value: bigint, decimals: number, priceUsd: number): number {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return Number.NaN;
  }

  const priceMicros = BigInt(Math.round(priceUsd * 1_000_000));
  if (priceMicros <= 0n) {
    return Number.NaN;
  }

  const scale = 10n ** BigInt(decimals);
  const usdMicros = (value * priceMicros + scale / 2n) / scale;
  return Number(usdMicros) / 1_000_000;
}

export function parsePositiveNumericLike(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

export function slicesFromPercentages(
  values: Array<{
    pct: number;
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
    blacklistable?: boolean;
  }>,
  options?: {
    decimals?: number;
    tolerancePct?: number;
    context?: string;
  },
): ReserveSlice[] {
  const filtered = values.filter((value) => Number.isFinite(value.pct) && value.pct > 0);
  const total = filtered.reduce((acc, value) => acc + value.pct, 0);
  if (total <= 0) return [];

  const tolerancePct = options?.tolerancePct ?? 1.5;
  if (Math.abs(total - 100) > tolerancePct) {
    throw new Error(
      `${options?.context ?? "reserve percentages"} sum to ${total.toFixed(1)}% (expected 100% ± ${tolerancePct}%)`,
    );
  }

  return normalizeSlices(
    filtered.map((value) => ({
      name: value.name,
      pct: value.pct,
      risk: value.risk,
      ...(value.coinId ? { coinId: value.coinId } : {}),
      ...(value.depType ? { depType: value.depType } : {}),
      ...(value.blacklistable != null ? { blacklistable: value.blacklistable } : {}),
    })),
    options?.decimals ?? 1,
  );
}

/**
 * Convert absolute values into percentage-based ReserveSlice[].
 * Filters out zero-value entries, calculates pct relative to total, and normalizes
 * so percentages sum to 100%. Used by adapters that receive dollar amounts from APIs.
 */
export function slicesFromValues(
  values: Array<{
    value: number;
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
    blacklistable?: boolean;
  }>,
  decimals = 1,
): ReserveSlice[] {
  const filtered = values.filter((value) => Number.isFinite(value.value) && value.value > 0);
  const total = filtered.reduce((acc, value) => acc + value.value, 0);
  if (total <= 0) return [];

  return normalizeSlices(filtered.map((value) => ({
    name: value.name,
    pct: (value.value / total) * 100,
    risk: value.risk,
    ...(value.coinId ? { coinId: value.coinId } : {}),
    ...(value.depType ? { depType: value.depType } : {}),
    ...(value.blacklistable != null ? { blacklistable: value.blacklistable } : {}),
  })), decimals);
}

export function buildBucketSlices<Bucket extends string>(
  bucketTotals: ReadonlyMap<Bucket, number>,
  values: Array<{
    name: string;
    risk: ReserveSlice["risk"];
    bucket?: Bucket;
    value?: number;
    coinId?: string;
    depType?: ReserveSlice["depType"];
    blacklistable?: boolean;
  }>,
  immediateRedeemableBucket: Bucket,
  decimals = 1,
): { slices: ReserveSlice[]; immediateRedeemableUsd: number } {
  const immediateRedeemableUsd = bucketTotals.get(immediateRedeemableBucket) ?? 0;

  return {
    slices: slicesFromValues(
      values.map((value) => ({
        ...value,
        value: value.value ?? (value.bucket ? bucketTotals.get(value.bucket) ?? 0 : 0),
      })),
      decimals,
    ),
    immediateRedeemableUsd,
  };
}

export function isReserveRisk(value: unknown): value is ReserveSlice["risk"] {
  return value === "very-low"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "very-high";
}

export function computeUnknownExposurePct(unknownValue: number, totalValue: number): number {
  if (!Number.isFinite(unknownValue) || unknownValue <= 0 || !Number.isFinite(totalValue) || totalValue <= 0) {
    return 0;
  }
  return (unknownValue / totalValue) * 100;
}

export function buildUnknownExposureWarning({
  code,
  message,
  unknownExposurePct,
  thresholdPct = 5,
}: UnknownExposureWarningOptions): LiveReserveWarning {
  const roundedPct = unknownExposurePct.toFixed(2);
  const fullMessage = `${message} (${roundedPct}% of reserves)`;
  return unknownExposurePct >= thresholdPct
    ? reserveDegradedWarning(code, fullMessage)
    : reserveInfoWarning(code, fullMessage);
}
