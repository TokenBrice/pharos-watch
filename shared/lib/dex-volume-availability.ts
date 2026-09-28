/**
 * DEX measured-volume availability and the DEC-19 LiquidityScore activity
 * contract (docs/dex-liquidity.md § "Measured volume availability").
 *
 * One availability calculation serves producers (window summaries), storage
 * readers (legacy vs recorded rows) and views. Rules:
 * - A complete window (every retained contributing pool measured in budget)
 *   publishes its sum; a genuine measured zero stays an observed zero.
 * - Partial, missing, stale or unknown windows publish no measured total. The
 *   in-budget observations that were present are labelled `partialGrossUsd`.
 * - Volume activity is scored only from a complete 24h window. Otherwise the
 *   component is unavailable and the composite LiquidityScore is not rated:
 *   no renormalization, no denominator shrink, no estimated activity.
 */
import { clampScore } from "./math";
import { LIQUIDITY_SCORE_WEIGHTS, type LiquidityScoreComponentKey } from "./liquidity-score-weights";
import {
  DexVolumeAvailabilityRecordSchema,
  type DexPoolVolumeStatus,
  type DexVolumeAvailability,
  type DexVolumeAvailabilityReason,
  type DexVolumeAvailabilityRecord,
  type DexVolumeCompleteness,
  type DexVolumeWindow,
} from "../types/market";

const DEX_VOLUME_WINDOW_SEC = {
  "24h": 86_400,
  "7d": 604_800,
} as const satisfies Record<DexVolumeWindow, number>;

/** One pool's provider rolling-window reading. */
export interface DexPoolVolumeObservationInput {
  /** Null, undefined, non-finite or negative values are not observations. */
  volumeUsd: number | null | undefined;
  /** Observation clock; without it the reading's window cannot be established. */
  observedAtSec: number | null | undefined;
}

/**
 * Evaluation clock for a window summary. The freshness budget is owned by the
 * producer and echoed into the availability record so the verdict names it.
 */
interface DexVolumeWindowClock {
  asOfSec: number;
  maxObservationAgeSec: number;
}

function isObservedVolume(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isEpochSec(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Exact budget boundary is eligible (`age <= maxObservationAgeSec`). */
export function classifyDexPoolVolumeObservation(
  observation: DexPoolVolumeObservationInput,
  clock: DexVolumeWindowClock,
): DexPoolVolumeStatus {
  if (!isObservedVolume(observation.volumeUsd)) return "missing";
  const observedAtSec = observation.observedAtSec;
  // A clock later than the evaluation clock cannot prove the reading's window.
  if (!isEpochSec(observedAtSec) || observedAtSec > clock.asOfSec) return "missing";
  return clock.asOfSec - observedAtSec <= clock.maxObservationAgeSec ? "measured" : "stale";
}

function unavailableReason(missing: number, stale: number): DexVolumeAvailabilityReason | null {
  if (missing > 0 && stale > 0) return "pool-observations-missing-and-stale";
  if (missing > 0) return "pool-observations-missing";
  if (stale > 0) return "pool-observations-stale";
  return null;
}

function windowCompleteness(measured: number, missing: number, stale: number): DexVolumeCompleteness {
  if (missing === 0 && stale === 0) return "complete";
  if (measured > 0) return "partial";
  return missing > 0 ? "missing" : "stale";
}

interface DexVolumeWindowSummary {
  /** Full-window measured sum; null unless every contributing pool was measured. */
  measuredUsd: number | null;
  availability: DexVolumeAvailability;
}

/**
 * Summarize one window over the COMPLETE retained contributing pool set (not a
 * visible top-N projection). An empty pool set is vacuously complete at zero.
 */
export function summarizeDexVolumeWindow(
  observations: readonly DexPoolVolumeObservationInput[],
  window: DexVolumeWindow,
  clock: DexVolumeWindowClock,
): DexVolumeWindowSummary {
  let measured = 0;
  let missing = 0;
  let stale = 0;
  let measuredSum = 0;
  let oldestObservedAtSec: number | null = null;
  let newestObservedAtSec: number | null = null;
  for (const observation of observations) {
    const status = classifyDexPoolVolumeObservation(observation, clock);
    if (status === "missing") {
      missing += 1;
      continue;
    }
    const observedAtSec = observation.observedAtSec as number;
    if (oldestObservedAtSec == null || observedAtSec < oldestObservedAtSec) oldestObservedAtSec = observedAtSec;
    if (newestObservedAtSec == null || observedAtSec > newestObservedAtSec) newestObservedAtSec = observedAtSec;
    if (status === "stale") {
      stale += 1;
      continue;
    }
    measured += 1;
    measuredSum += observation.volumeUsd as number;
  }
  const completeness = windowCompleteness(measured, missing, stale);
  return {
    measuredUsd: completeness === "complete" ? measuredSum : null,
    availability: {
      completeness,
      reason: unavailableReason(missing, stale),
      partialGrossUsd: measured > 0 ? measuredSum : null,
      measuredPoolCount: measured,
      missingPoolCount: missing,
      stalePoolCount: stale,
      windowSec: DEX_VOLUME_WINDOW_SEC[window],
      asOfSec: clock.asOfSec,
      maxObservationAgeSec: clock.maxObservationAgeSec,
      oldestObservedAtSec,
      newestObservedAtSec,
    },
  };
}

function unreadableAvailability(window: DexVolumeWindow): DexVolumeAvailability {
  return {
    completeness: "unknown",
    reason: "availability-record-unreadable",
    partialGrossUsd: null,
    measuredPoolCount: null,
    missingPoolCount: null,
    stalePoolCount: null,
    windowSec: DEX_VOLUME_WINDOW_SEC[window],
    asOfSec: null,
    maxObservationAgeSec: null,
    oldestObservedAtSec: null,
    newestObservedAtSec: null,
  };
}

type ParsedDexVolumeAvailabilityRecord =
  | { status: "absent" }
  | { status: "unreadable" }
  | { status: "recorded"; record: DexVolumeAvailabilityRecord };

/** Parse the stored `volume_availability_json` column. NULL marks a legacy row. */
export function parseDexVolumeAvailabilityRecord(json: string | null | undefined): ParsedDexVolumeAvailabilityRecord {
  if (json == null) return { status: "absent" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { status: "unreadable" };
  }
  const parsed = DexVolumeAvailabilityRecordSchema.safeParse(raw);
  return parsed.success ? { status: "recorded", record: parsed.data } : { status: "unreadable" };
}

interface StoredDexVolumeWindow {
  /** Public measured total for the window. */
  measuredUsd: number | null;
  /** Omitted for legacy rows, whose completeness was never recorded. */
  availability?: DexVolumeAvailability;
}

/**
 * Storage read contract. The NOT NULL legacy volume column holds the complete
 * measured sum when the record says `complete`; for any other recorded state it
 * is never published as measured. Legacy rows (no record) keep their historical
 * number as unknown-completeness data, gated only by `legacyMeasured` (the
 * pre-existing 7d measurement marker). An unreadable record publishes nothing.
 */
export function readStoredDexVolumeWindow(
  storedUsd: number | null | undefined,
  record: ParsedDexVolumeAvailabilityRecord,
  window: DexVolumeWindow,
  legacyMeasured = true,
): StoredDexVolumeWindow {
  const stored = isObservedVolume(storedUsd) ? storedUsd : null;
  if (record.status === "absent") {
    return { measuredUsd: legacyMeasured ? stored : null };
  }
  const availability = record.status === "recorded" ? record.record[window] : undefined;
  if (!availability) {
    return { measuredUsd: null, availability: unreadableAvailability(window) };
  }
  return {
    measuredUsd: availability.completeness === "complete" ? stored : null,
    availability,
  };
}

type DexVolumeViewStatus = "measured" | "legacy-unknown" | "unavailable";

export interface DexVolumeView {
  status: DexVolumeViewStatus;
  /** Measured (or legacy) total; null whenever no measured statistic exists. */
  valueUsd: number | null;
  /** Labelled lower-bound sum of present in-budget observations. */
  partialGrossUsd: number | null;
  completeness: DexVolumeCompleteness;
  reason: DexVolumeAvailabilityReason | null;
}

/**
 * Consumer interpretation of a published window: accepts legacy numeric
 * payloads (no availability → `unknown` completeness, never labelled measured)
 * and DEC-19 nullable/partial payloads.
 */
export function resolveDexVolumeView(
  valueUsd: number | null | undefined,
  availability: DexVolumeAvailability | null | undefined,
): DexVolumeView {
  const value = typeof valueUsd === "number" && Number.isFinite(valueUsd) ? valueUsd : null;
  if (availability == null) {
    return {
      status: value == null ? "unavailable" : "legacy-unknown",
      valueUsd: value,
      partialGrossUsd: null,
      completeness: "unknown",
      reason: "legacy-completeness-unrecorded",
    };
  }
  if (availability.completeness === "complete" && value != null) {
    return { status: "measured", valueUsd: value, partialGrossUsd: availability.partialGrossUsd, completeness: "complete", reason: null };
  }
  return {
    status: "unavailable",
    valueUsd: null,
    partialGrossUsd: availability.partialGrossUsd,
    completeness: availability.completeness,
    reason: availability.reason ?? "availability-record-unreadable",
  };
}

/** Volume/TVL ratio for display and sorting; null when volume is unavailable. */
export function dexVolumeToTvlRatio(volumeUsd: number | null | undefined, tvlUsd: number): number | null {
  if (typeof volumeUsd !== "number" || !Number.isFinite(volumeUsd)) return null;
  return tvlUsd > 0 ? volumeUsd / tvlUsd : 0;
}

// ── DEC-19 LiquidityScore contract ───────────────────────────────────────────

/** Existing log-scale activity formula: 38 × (log10(V/T) + 3), clamped to 0–100. */
export function computeVolumeActivityScore(volume24hUsd: number, totalTvlUsd: number): number {
  const vtRatio = totalTvlUsd > 0 ? volume24hUsd / totalTvlUsd : 0;
  return vtRatio <= 0 ? 0 : clampScore(38 * (Math.log10(vtRatio) + 3));
}

type VolumeActivityUnavailableReason =
  | "activity-partial"
  | "activity-missing"
  | "activity-stale"
  | "activity-completeness-unknown";

type VolumeActivityComponent =
  | { status: "measured"; score: number }
  | { status: "unavailable"; score: null; reason: VolumeActivityUnavailableReason };

const ACTIVITY_UNAVAILABLE_REASON: Record<Exclude<DexVolumeCompleteness, "complete">, VolumeActivityUnavailableReason> = {
  partial: "activity-partial",
  missing: "activity-missing",
  stale: "activity-stale",
  unknown: "activity-completeness-unknown",
};

/** Required activity is the 24h window; 7d volume is display-only. */
export function resolveVolumeActivityComponent(input: {
  measuredVolume24hUsd: number | null | undefined;
  completeness: DexVolumeCompleteness;
  totalTvlUsd: number;
}): VolumeActivityComponent {
  if (input.completeness !== "complete") {
    return { status: "unavailable", score: null, reason: ACTIVITY_UNAVAILABLE_REASON[input.completeness] };
  }
  if (!isObservedVolume(input.measuredVolume24hUsd)) {
    return { status: "unavailable", score: null, reason: "activity-missing" };
  }
  return { status: "measured", score: computeVolumeActivityScore(input.measuredVolume24hUsd, input.totalTvlUsd) };
}

type OtherComponentKey = Exclude<LiquidityScoreComponentKey, "volumeActivity">;

type LiquidityScoreComponentInputs = Record<OtherComponentKey, number> & {
  volumeActivity: VolumeActivityComponent;
};

type LiquidityCompositeResult =
  | { status: "rated"; score: number; components: Record<LiquidityScoreComponentKey, number> }
  | {
      status: "not-rated";
      score: null;
      reason: "volume-activity-unavailable";
      activityReason: VolumeActivityUnavailableReason;
      components: Record<OtherComponentKey, number> & { volumeActivity: null };
    };

/**
 * Weighted composite over the fixed full weight table. An unavailable activity
 * component makes the composite NR; valid components stay displayable. The
 * denominator never shrinks and activity is never estimated.
 */
export function composeLiquidityScore(inputs: LiquidityScoreComponentInputs): LiquidityCompositeResult {
  const others = {
    tvlDepth: Math.round(inputs.tvlDepth),
    poolQuality: Math.round(inputs.poolQuality),
    durability: Math.round(inputs.durability),
    pairDiversity: Math.round(inputs.pairDiversity),
  };
  const activity = inputs.volumeActivity;
  if (activity.status === "unavailable") {
    return {
      status: "not-rated",
      score: null,
      reason: "volume-activity-unavailable",
      activityReason: activity.reason,
      components: { ...others, volumeActivity: null },
    };
  }
  let raw = 0;
  for (const { key, weight } of LIQUIDITY_SCORE_WEIGHTS) {
    raw += (key === "volumeActivity" ? activity.score : inputs[key]) * weight;
  }
  return {
    status: "rated",
    score: clampScore(Math.round(raw)),
    components: { ...others, volumeActivity: Math.round(activity.score) },
  };
}
