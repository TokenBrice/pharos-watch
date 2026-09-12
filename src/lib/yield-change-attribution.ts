/**
 * Per-coin "Why this APY changed" attribution.
 *
 * Given a ranking row, its 30-day APY history, and the source-switch ledger, classify
 * the largest 30-day APY move into one of:
 *
 *   - "source-switch"      — caused by the canonical source switching mid-window
 *   - "organic"            — APY drifted at the source level with no switch
 *   - "mixed"              — both a source switch and an organic move overlap
 *   - "insufficient-data"  — no significant move detected or too little history
 *
 * Priority order (decision tree):
 *
 *   1. If the BE-provided decisionLedger reports a source switch whose
 *      |apy30dDeltaFromPrevious| ≥ {@link SOURCE_SWITCH_DELTA_THRESHOLD_PP}
 *      (in percentage points) and the switch falls inside the 30d window, treat
 *      attribution as "source-switch" with high confidence. The switch
 *      timestamp comes from the ledger when provided; otherwise it is derived
 *      client-side from history points carrying `sourceSwitch` (B35), and a
 *      switch with no observable timestamp inside the fetched history is not
 *      treated as recent.
 *
 *   2. Otherwise, if the largest move exceeds {@link ORGANIC_DELTA_THRESHOLD_PP}
 *      (in percentage points) and no source switch is reported, attribute it to
 *      "organic". Confidence is "high" when yield stability is strong (≥0.75),
 *      "medium" when moderate (≥0.5), "low" otherwise.
 *
 *   3. If a recent source switch overlaps with an organic-sized move (largest
 *      delta ≥ {@link ORGANIC_DELTA_THRESHOLD_PP}), attribute it to "mixed" with
 *      low confidence.
 *
 * The function NEVER throws. Missing decisionLedger, missing history points,
 * and sparse history all degrade gracefully to lower-confidence paths or
 * "insufficient-data".
 *
 * APY values are interpreted as already-percent-scaled (i.e. 5.2 means 5.20%).
 * This matches the rest of the yield pipeline where `apy`, `apy30d`, etc. are
 * stored in percent units.
 */

import type { YieldHistoryPoint } from "@shared/types";

/** Source switch impact must move 30d APY by at least this many percentage points to be considered material. */
export const SOURCE_SWITCH_DELTA_THRESHOLD_PP = 0.5;
/** The largest 30d single-day APY move must exceed this (in pp) to attribute to organic drift. */
export const ORGANIC_DELTA_THRESHOLD_PP = 1.0;

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

export type YieldChangeAttribution =
  | "source-switch"
  | "organic"
  | "mixed"
  | "insufficient-data";

export type YieldChangeAttributionConfidence = "high" | "medium" | "low";

export interface YieldChangeAttributionDecisionLedger {
  sourceSwitch: boolean;
  apy30dDeltaFromPrevious?: number | null;
  previousBestSourceKey?: string | null;
  /** Optional human-readable label for the previous source. */
  previousSourceLabel?: string | null;
  /** Optional ISO ms timestamp of when the switch happened. Used to confirm recency. */
  switchedAtMs?: number | null;
}

export interface YieldChangeAttributionInput {
  history: YieldHistoryPoint[];
  decisionLedger?: YieldChangeAttributionDecisionLedger | null;
  /** Stability ratio in 0-1 range from the ranking. Used to tune organic-attribution confidence. */
  yieldStability?: number | null;
  /** "Now" override for tests. Defaults to Date.now(). */
  nowMs?: number;
}

export interface YieldChangeAttributionResult {
  largestDelta: { value: number; ts: number } | null;
  attribution: YieldChangeAttribution;
  sourceSwitchDetail?: {
    previousSourceKey: string;
    previousSourceLabel?: string;
    apy30dDelta: number;
  };
  confidence: YieldChangeAttributionConfidence;
  headline: string;
}

interface NormalisedHistoryPoint {
  ts: number;
  apy: number;
  /** Raw history fields needed to derive the switch timestamp client-side (B35). */
  sourceSwitch: boolean;
  sourceKey: string | null;
  yieldSource: string | null;
}

function normaliseHistory(history: YieldHistoryPoint[]): NormalisedHistoryPoint[] {
  const result: NormalisedHistoryPoint[] = [];
  for (const point of history) {
    const ts =
      typeof point.date === "number"
        ? point.date < 10_000_000_000
          ? point.date * 1000
          : point.date
        : Date.parse(point.date);
    if (!Number.isFinite(ts)) continue;
    if (!Number.isFinite(point.apy)) continue;
    result.push({
      ts,
      apy: point.apy,
      sourceSwitch: point.sourceSwitch ?? false,
      sourceKey: point.sourceKey ?? null,
      yieldSource: point.yieldSource ?? null,
    });
  }
  result.sort((a, b) => a.ts - b.ts);
  return result;
}
/**
 * Largest day-over-day APY move inside the window. Recent history is hourly
 * (`yield-history-policy` keeps 30 days of hourly points), so the raw array's
 * adjacent entries are hour-over-hour noise; thresholds expressed in
 * percentage points *per day* are applied to one close per UTC day instead.
 */
function findLargestDailyDelta(
  history: NormalisedHistoryPoint[],
  windowStartMs: number,
): { value: number; ts: number } | null {
  const dailyCloses = new Map<number, NormalisedHistoryPoint>();
  for (const point of history) {
    // Require BOTH endpoints inside the window so the delta represents a within-window event.
    if (point.ts < windowStartMs) continue;
    const dayBucket = Math.floor(point.ts / DAY_MS);
    const close = dailyCloses.get(dayBucket);
    if (!close || point.ts >= close.ts) dailyCloses.set(dayBucket, point);
  }
  const closes = [...dailyCloses.values()].sort((a, b) => a.ts - b.ts);
  let best: { value: number; ts: number } | null = null;
  for (let i = 1; i < closes.length; i++) {
    const current = closes[i]!;
    const prior = closes[i - 1]!;
    const delta = current.apy - prior.apy;
    if (!best || Math.abs(delta) > Math.abs(best.value)) {
      best = { value: delta, ts: current.ts };
    }
  }
  return best;
}

interface DerivedSwitchContext {
  switchedAtMs: number;
  previousSourceKey: string | null;
  previousSourceLabel: string | null;
}

/**
 * The public decision ledger carries no switch timestamp, so derive one from
 * the history points the worker flags with `sourceSwitch` (latest one wins).
 * The point adjacent before it supplies the previous source identity.
 */
function deriveSwitchContext(history: NormalisedHistoryPoint[]): DerivedSwitchContext | null {
  let switchIndex = -1;
  for (let i = 0; i < history.length; i++) {
    if (history[i]!.sourceSwitch) switchIndex = i;
  }
  if (switchIndex === -1) return null;
  const prior = switchIndex > 0 ? history[switchIndex - 1]! : null;
  return {
    switchedAtMs: history[switchIndex]!.ts,
    previousSourceKey: prior?.sourceKey ?? null,
    previousSourceLabel: prior?.yieldSource ?? null,
  };
}

function daysAgo(ts: number, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - ts) / (24 * 60 * 60 * 1000)));
}

function formatPp(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(1)}pp`;
}

function formatSourceSwitchHeadline(detail: {
  previousSourceKey: string;
  previousSourceLabel?: string;
  apy30dDelta: number;
}, largestDelta: { value: number; ts: number } | null, nowMs: number): string {
  const previous = detail.previousSourceLabel ?? detail.previousSourceKey;
  if (largestDelta) {
    return `${formatPp(largestDelta.value)} APY ${daysAgo(largestDelta.ts, nowMs)}d ago — source switched from ${previous} (${formatPp(detail.apy30dDelta)} impact).`;
  }
  return `Source switched from ${previous} (${formatPp(detail.apy30dDelta)} impact on 30d APY).`;
}

function formatOrganicHeadline(
  largestDelta: { value: number; ts: number },
  yieldStability: number | null | undefined,
  nowMs: number,
): string {
  if (yieldStability != null) {
    const stabilityPct = Math.round(yieldStability * 100);
    return `${formatPp(largestDelta.value)} APY ${daysAgo(largestDelta.ts, nowMs)}d ago — organic drift; stability ${stabilityPct}%.`;
  }
  return `${formatPp(largestDelta.value)} APY ${daysAgo(largestDelta.ts, nowMs)}d ago — organic drift at the source level.`;
}

function chooseOrganicConfidence(
  yieldStability: number | null | undefined,
): YieldChangeAttributionConfidence {
  if (yieldStability == null) return "medium";
  if (yieldStability >= 0.75) return "high";
  if (yieldStability >= 0.5) return "medium";
  return "low";
}

function isRecentSwitch(switchedAtMs: number | null | undefined, windowStartMs: number, nowMs: number): boolean {
  // No timestamp anywhere (ledger omitted it and no history point carries
  // `sourceSwitch`) means the switch was NOT observed inside the fetched
  // window — recency must not be assumed (B35).
  if (switchedAtMs == null) return false;
  return switchedAtMs >= windowStartMs && switchedAtMs <= nowMs;
}

/**
 * Classify the largest 30d APY move into a single attribution category. See file-level
 * docblock for threshold values and priority order.
 */
export function classifyApyChange(input: YieldChangeAttributionInput): YieldChangeAttributionResult {
  const nowMs = input.nowMs ?? Date.now();
  const windowStartMs = nowMs - THIRTY_DAYS_MS;
  const history = normaliseHistory(input.history);
  const largestDelta = findLargestDailyDelta(history, windowStartMs);
  const ledger = input.decisionLedger ?? null;
  const stability = input.yieldStability ?? null;
  const switchContext = deriveSwitchContext(history);
  const switchedAtMs = ledger?.switchedAtMs ?? switchContext?.switchedAtMs ?? null;

  // Step 1: high-confidence source-switch attribution from BE ledger.
  if (
    ledger?.sourceSwitch === true &&
    typeof ledger.apy30dDeltaFromPrevious === "number" &&
    Math.abs(ledger.apy30dDeltaFromPrevious) >= SOURCE_SWITCH_DELTA_THRESHOLD_PP &&
    isRecentSwitch(switchedAtMs, windowStartMs, nowMs)
  ) {
    const detail = {
      previousSourceKey:
        ledger.previousBestSourceKey ?? switchContext?.previousSourceKey ?? "previous source",
      previousSourceLabel: ledger.previousSourceLabel ?? switchContext?.previousSourceLabel ?? undefined,
      apy30dDelta: ledger.apy30dDeltaFromPrevious,
    };
    // If we ALSO have an organic-sized drift in the window, flag as mixed (lower confidence).
    if (largestDelta && Math.abs(largestDelta.value) >= ORGANIC_DELTA_THRESHOLD_PP) {
      // If the largest move correlates with the switch timing (same calendar day), keep source-switch.
      const overlapsSwitch =
        switchedAtMs != null && Math.abs(largestDelta.ts - switchedAtMs) <= 24 * 60 * 60 * 1000;
      if (!overlapsSwitch) {
        return {
          largestDelta,
          attribution: "mixed",
          sourceSwitchDetail: detail,
          confidence: "low",
          headline: "Multiple drivers overlap; see source-switch trail and history.",
        };
      }
    }
    return {
      largestDelta,
      attribution: "source-switch",
      sourceSwitchDetail: detail,
      confidence: "high",
      headline: formatSourceSwitchHeadline(detail, largestDelta, nowMs),
    };
  }

  // Step 2/4: history-driven attribution.
  if (!largestDelta) {
    return {
      largestDelta: null,
      attribution: "insufficient-data",
      confidence: "low",
      headline: "Not enough data to attribute the latest move.",
    };
  }

  // Step 2: organic drift attribution.
  if (Math.abs(largestDelta.value) > ORGANIC_DELTA_THRESHOLD_PP) {
    return {
      largestDelta,
      attribution: "organic",
      confidence: chooseOrganicConfidence(stability),
      headline: formatOrganicHeadline(largestDelta, stability, nowMs),
    };
  }

  // Step 4: nothing significant.
  return {
    largestDelta,
    attribution: "insufficient-data",
    confidence: "low",
    headline: "Not enough data to attribute the latest move.",
  };
}
