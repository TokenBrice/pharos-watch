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

const MAX_DECIMALS = 36;
export const PCT_SUM_ERROR_TOLERANCE = 2;
const RATIO_SCALE = 1_000_000_000_000n;

export function worseRisk(a: ReserveSlice["risk"], b: ReserveSlice["risk"]): ReserveSlice["risk"] {
  return RISK_SEVERITY[a] >= RISK_SEVERITY[b] ? a : b;
}

interface UnknownExposureWarningOptions {
  code: string;
  message: string;
  unknownExposurePct: number;
  thresholdPct?: number;
}

export function parseBoundedDecimals(value: unknown): number | null {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(MAX_DECIMALS) ? Number(value) : null;
  }
  if (typeof value !== "number") return null;
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DECIMALS ? value : null;
}

export function validateDecimals(value: unknown, context = "token decimals"): number {
  const decimals = parseBoundedDecimals(value);
  if (decimals == null) {
    throw new Error(`${context} invalid: ${String(value)} (expected safe integer 0-${MAX_DECIMALS})`);
  }
  return decimals;
}

export function ratioFromRaw(numerator: bigint, denominator: bigint): number | undefined {
  if (denominator <= 0n) return undefined;
  if (numerator >= denominator) return 1;
  const ratio = Number((numerator * RATIO_SCALE) / denominator) / Number(RATIO_SCALE);
  return Number.isFinite(ratio) ? ratio : undefined;
}

export function assertFiniteNonNegativeReserveRows<Value>(
  values: readonly Value[],
  valueOf: (value: Value) => number,
  context: string,
): void {
  const invalidIndex = values.findIndex((value) => {
    const numeric = valueOf(value);
    return !Number.isFinite(numeric) || numeric < 0;
  });
  if (invalidIndex < 0) return;
  throw new Error(
    `${context} row ${invalidIndex + 1} has invalid value: ${String(valueOf(values[invalidIndex]!))}`,
  );
}

/**
 * Deduplicate and normalize reserve slices so percentages sum to exactly 100%.
 * Slices sharing the same (name, risk, coinId, depType, blacklistable) key are merged by summing pct.
 * After rounding, the largest slice absorbs any remainder to maintain the 100% invariant.
 * Returns slices sorted by pct descending.
 */
export function normalizeSlices(slices: ReserveSlice[], decimals = 1): ReserveSlice[] {
  assertFiniteNonNegativeReserveRows(slices, (slice) => slice.pct, "reserve percentages");
  const rawTotal = slices.reduce((sum, slice) => sum + slice.pct, 0);
  if (rawTotal > 0 && Math.abs(rawTotal - 100) > PCT_SUM_ERROR_TOLERANCE) {
    throw new Error(
      `reserve percentages sum to ${rawTotal.toFixed(1)}% (expected 100% ± ${PCT_SUM_ERROR_TOLERANCE}%)`,
    );
  }
  const factor = 10 ** decimals;
  const grouped = new Map<string, ReserveSlice>();

  for (const slice of slices) {
    if (slice.pct === 0) continue;
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
  // The raw-total check above bounds this correction to ordinary rounding
  // drift; the clamp remains defense-in-depth against arithmetic edge cases.
  normalized[maxIdx].pctUnits = Math.max(0, normalized[maxIdx].pctUnits + (100 * factor) - sumUnits);

  return normalized
    .map(({ pctUnits, ...slice }) => ({ ...slice, pct: pctUnits / factor }))
    .filter((slice) => slice.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}

export function valueUsdFromBigIntPrice(value: bigint, decimals: number, priceUsd: number): number {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return Number.NaN;
  }

  const safeDecimals = parseBoundedDecimals(decimals);
  if (safeDecimals == null) {
    return Number.NaN;
  }

  const priceMicros = BigInt(Math.round(priceUsd * 1_000_000));
  if (priceMicros <= 0n) {
    return Number.NaN;
  }

  const scale = 10n ** BigInt(safeDecimals);
  const usdMicros = (value * priceMicros + scale / 2n) / scale;
  // Above ~$9.007B the micros bigint exceeds Number.MAX_SAFE_INTEGER, so a
  // direct Number() cast loses precision in the integer-dollar part. Split into
  // dollars + sub-dollar micros so only the sub-dollar tail incurs rounding.
  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
  if (usdMicros < MAX_SAFE && usdMicros > -MAX_SAFE) {
    return Number(usdMicros) / 1_000_000;
  }
  const dollars = usdMicros / 1_000_000n;
  const remainder = usdMicros % 1_000_000n;
  return Number(dollars) + Number(remainder) / 1_000_000;
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
    sourceKey?: string;
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
  const context = options?.context ?? "reserve percentages";
  assertFiniteNonNegativeReserveRows(values, (value) => value.pct, context);
  const filtered = values.filter((value) => value.pct > 0);
  const total = filtered.reduce((acc, value) => acc + value.pct, 0);
  if (total <= 0) return [];

  const tolerancePct = options?.tolerancePct ?? 1.5;
  if (Math.abs(total - 100) > tolerancePct) {
    throw new Error(
      `${context} sum to ${total.toFixed(1)}% (expected 100% ± ${tolerancePct}%)`,
    );
  }

  return normalizeSlices(
    filtered.map((value) => ({
      ...(value.sourceKey ? { sourceKey: value.sourceKey } : {}),
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
    sourceKey?: string;
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
    assetClass?: ReserveSlice["assetClass"];
    issuerOrObligor?: string;
    blacklistable?: boolean;
  }>,
  decimals = 1,
): ReserveSlice[] {
  assertFiniteNonNegativeReserveRows(values, (value) => value.value, "reserve values");
  const filtered = values.filter((value) => value.value > 0);
  const total = filtered.reduce((acc, value) => acc + value.value, 0);
  if (!Number.isFinite(total)) {
    throw new Error("reserve values total is not finite");
  }
  if (total <= 0) return [];

  return normalizeSlices(filtered.map((value) => ({
    ...(value.sourceKey ? { sourceKey: value.sourceKey } : {}),
    name: value.name,
    pct: (value.value / total) * 100,
    risk: value.risk,
    ...(value.coinId ? { coinId: value.coinId } : {}),
    ...(value.depType ? { depType: value.depType } : {}),
    ...(value.assetClass ? { assetClass: value.assetClass } : {}),
    ...(value.issuerOrObligor ? { issuerOrObligor: value.issuerOrObligor } : {}),
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

interface CoverageShortfallWarningOptions {
  code: string;
  /** Renders the warning message from the coverage percentage pre-formatted to two decimals. */
  message: (coveragePct: string) => string;
  coverageRatio: number | null | undefined;
  thresholdRatio?: number;
}

export function buildCoverageShortfallWarnings({
  code,
  message,
  coverageRatio,
  thresholdRatio = 0.995,
}: CoverageShortfallWarningOptions): LiveReserveWarning[] {
  if (coverageRatio == null || coverageRatio >= thresholdRatio) {
    return [];
  }
  return [reserveDegradedWarning(code, message((coverageRatio * 100).toFixed(2)))];
}
