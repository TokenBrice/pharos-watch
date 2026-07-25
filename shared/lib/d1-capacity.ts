import type {
  D1CapacityAssessment,
  D1CapacityGrowthWindow,
  D1CapacityGrowthWindowKey,
  D1CapacityThresholdState,
} from "../types/status/d1-capacity";

export const D1_PAID_MAX_DATABASE_SIZE_BYTES = 10_000_000_000;
export const D1_CAPACITY_FORECAST_WINDOW_SEC = 30 * 24 * 60 * 60;
const D1_CAPACITY_MIN_FORECAST_SPAN_SEC = 24 * 60 * 60;
const D1_CAPACITY_WINDOW_MIN_SPAN_RATIO = 0.9;
const D1_CAPACITY_MIN_REGRESSION_SPAN_SEC = 6 * 60 * 60;

export interface D1CapacityObservation {
  observedAt: number;
  databaseSizeBytes: number;
}

export function getD1CapacityImpactStatus(
  state: D1CapacityThresholdState,
): "healthy" | "degraded" | "stale" {
  if (state === "critical") return "stale";
  if (state === "warning") return "degraded";
  return "healthy";
}

const THRESHOLDS = [60, 75, 90, 100] as const;
const SECONDS_PER_DAY = 86_400;
const GROWTH_WINDOWS: ReadonlyArray<{
  window: D1CapacityGrowthWindowKey;
  windowSeconds: number;
}> = [
  { window: "24h", windowSeconds: 24 * 60 * 60 },
  { window: "72h", windowSeconds: 72 * 60 * 60 },
  { window: "7d", windowSeconds: 7 * 24 * 60 * 60 },
  { window: "30d", windowSeconds: D1_CAPACITY_FORECAST_WINDOW_SEC },
];

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function round(value: number, decimalPlaces: number): number {
  const scale = 10 ** decimalPlaces;
  return Math.round(value * scale) / scale;
}

function thresholdState(utilizationPercent: number): D1CapacityThresholdState {
  if (utilizationPercent >= 90) return "critical";
  if (utilizationPercent >= 75) return "warning";
  if (utilizationPercent >= 60) return "watch";
  return "normal";
}

function crossedThreshold(utilizationPercent: number): 60 | 75 | 90 | null {
  if (utilizationPercent >= 90) return 90;
  if (utilizationPercent >= 75) return 75;
  if (utilizationPercent >= 60) return 60;
  return null;
}

function nextThreshold(utilizationPercent: number): 60 | 75 | 90 | 100 | null {
  return THRESHOLDS.find((threshold) => utilizationPercent < threshold) ?? null;
}

function normalizeObservations(
  observations: readonly D1CapacityObservation[],
  current: D1CapacityObservation,
): D1CapacityObservation[] {
  const cutoff = current.observedAt - D1_CAPACITY_FORECAST_WINDOW_SEC;
  const byTimestamp = new Map<number, D1CapacityObservation>();
  for (const observation of [...observations, current]) {
    if (
      !Number.isInteger(observation.observedAt)
      || observation.observedAt < cutoff
      || observation.observedAt > current.observedAt
      || !finiteNonNegative(observation.databaseSizeBytes)
    ) {
      continue;
    }
    byTimestamp.set(observation.observedAt, observation);
  }
  return [...byTimestamp.values()].sort((a, b) => a.observedAt - b.observedAt);
}

function linearGrowthBytesPerDay(
  observations: readonly D1CapacityObservation[],
  minimumSpanSec = D1_CAPACITY_MIN_FORECAST_SPAN_SEC,
): number | null {
  if (observations.length < 3) return null;
  const firstObservedAt = observations[0]!.observedAt;
  const spanSec = observations[observations.length - 1]!.observedAt - firstObservedAt;
  if (spanSec < minimumSpanSec) return null;

  const points = observations.map((observation) => ({
    day: (observation.observedAt - firstObservedAt) / SECONDS_PER_DAY,
    bytes: observation.databaseSizeBytes,
  }));
  const meanDay = points.reduce((sum, point) => sum + point.day, 0) / points.length;
  const meanBytes = points.reduce((sum, point) => sum + point.bytes, 0) / points.length;
  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    const dayDelta = point.day - meanDay;
    covariance += dayDelta * (point.bytes - meanBytes);
    variance += dayDelta * dayDelta;
  }
  if (variance <= 0) return null;
  const slope = covariance / variance;
  return Number.isFinite(slope) ? Math.round(slope) : null;
}

function assessGrowthWindow(
  normalized: readonly D1CapacityObservation[],
  currentObservedAt: number,
  definition: (typeof GROWTH_WINDOWS)[number],
): D1CapacityGrowthWindow {
  const observations = normalized.filter(
    (observation) => observation.observedAt >= currentObservedAt - definition.windowSeconds,
  );
  const spanSec = observations.length > 1
    ? observations[observations.length - 1]!.observedAt - observations[0]!.observedAt
    : 0;
  // Hourly samples rarely land on the exact window boundary. A 90% tolerance
  // keeps the 24h regression usable while every wider window still requires at
  // least a full day of evidence.
  const requiredSpanSec = definition.windowSeconds * D1_CAPACITY_WINDOW_MIN_SPAN_RATIO;
  const minimumRegressionSpanSec = Math.min(
    D1_CAPACITY_MIN_REGRESSION_SPAN_SEC,
    definition.windowSeconds * D1_CAPACITY_WINDOW_MIN_SPAN_RATIO,
  );
  const growthBytesPerDay = linearGrowthBytesPerDay(observations, minimumRegressionSpanSec);
  return {
    window: definition.window,
    windowSeconds: definition.windowSeconds,
    sampleCount: observations.length,
    spanHours: round(spanSec / 3600, 1),
    valid: growthBytesPerDay != null && spanSec >= requiredSpanSec,
    growthBytesPerDay,
  };
}

function forecastAt(
  observedAt: number,
  currentSizeBytes: number,
  targetSizeBytes: number,
  growthBytesPerDay: number,
): number | null {
  if (growthBytesPerDay <= 0 || targetSizeBytes <= currentSizeBytes) return null;
  const days = (targetSizeBytes - currentSizeBytes) / growthBytesPerDay;
  if (!Number.isFinite(days) || days < 0) return null;
  return Math.round(observedAt + days * SECONDS_PER_DAY);
}

export function assessD1Capacity(
  current: D1CapacityObservation,
  observations: readonly D1CapacityObservation[] = [],
  maximumSizeBytes = D1_PAID_MAX_DATABASE_SIZE_BYTES,
): D1CapacityAssessment {
  if (!Number.isInteger(current.observedAt) || current.observedAt < 0) {
    throw new RangeError("D1 capacity observedAt must be a non-negative integer epoch timestamp");
  }
  if (!finiteNonNegative(current.databaseSizeBytes)) {
    throw new RangeError("D1 capacity databaseSizeBytes must be finite and non-negative");
  }
  if (!Number.isFinite(maximumSizeBytes) || maximumSizeBytes <= 0) {
    throw new RangeError("D1 capacity maximumSizeBytes must be finite and positive");
  }

  const normalized = normalizeObservations(observations, current);
  const utilizationRatio = current.databaseSizeBytes / maximumSizeBytes;
  const utilizationPercent = round(utilizationRatio * 100, 2);
  const nextThresholdPercent = nextThreshold(utilizationPercent);
  const growthWindows = GROWTH_WINDOWS.map((definition) => (
    assessGrowthWindow(normalized, current.observedAt, definition)
  ));
  const conservativeWindow = growthWindows.find((window) => window.valid) ?? null;
  const rawGrowth = conservativeWindow?.growthBytesPerDay ?? null;
  const forecastBasis = rawGrowth == null
    ? "insufficient-history"
    : rawGrowth <= 0
      ? "non-growing"
      : "linear-window";
  const growthBytesPerDay = forecastBasis === "linear-window" ? rawGrowth : null;
  const nextThresholdAt = growthBytesPerDay != null && nextThresholdPercent != null
    ? forecastAt(
        current.observedAt,
        current.databaseSizeBytes,
        maximumSizeBytes * (nextThresholdPercent / 100),
        growthBytesPerDay,
      )
    : null;
  const exhaustionAt = growthBytesPerDay != null
    ? forecastAt(current.observedAt, current.databaseSizeBytes, maximumSizeBytes, growthBytesPerDay)
    : null;
  const forecastSpanHours = conservativeWindow?.spanHours ?? (
    normalized.length > 1
      ? round((normalized[normalized.length - 1]!.observedAt - normalized[0]!.observedAt) / 3600, 1)
      : 0
  );

  return {
    observedAt: current.observedAt,
    databaseSizeBytes: current.databaseSizeBytes,
    maximumSizeBytes,
    utilizationRatio: round(utilizationRatio, 6),
    utilizationPercent,
    thresholdState: thresholdState(utilizationPercent),
    crossedThresholdPercent: crossedThreshold(utilizationPercent),
    nextThresholdPercent,
    sampleCount: conservativeWindow?.sampleCount ?? normalized.length,
    forecastBasis,
    forecastSpanHours,
    growthBytesPerDay,
    nextThresholdAt,
    exhaustionAt,
    daysUntilExhaustion: exhaustionAt == null
      ? null
      : round((exhaustionAt - current.observedAt) / SECONDS_PER_DAY, 1),
    growthWindows,
    conservativeWindow: conservativeWindow?.window ?? null,
  };
}
