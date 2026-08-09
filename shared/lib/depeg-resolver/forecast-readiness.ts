import {
  DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
  DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
  DDR_FORECAST_READINESS_VERSION,
} from "../methodology-versions/depeg-resolver";
import { clamp, roundTo } from "../math";
import { DDR_INSUFFICIENT_LIVE_PRICE_REASON } from "./resolution";
import type {
  DdrCellState,
  DdrForecastReadiness,
  DdrForecastReadinessBackstop,
  DdrForecastReadinessComponent,
  DdrForecastReadinessComponentKey,
  DdrLockTrigger,
  DdrRow,
} from "../../types/depeg-resolver";

const OBSERVATION_FLOOR_SEC = 3600;
const FULL_OBSERVATION_SEC = 6 * 3600;

export type DdrForecastReadinessInput = Pick<
  DdrRow,
  "ageSec" | "currentDeviationBps" | "duration" | "resolution"
>;

function roundReadiness01(value: number): number {
  // Preserve the prior clamp01 semantics exactly: all non-finite inputs → 0
  // (shared clamp maps +Infinity → 1, which would diverge).
  return Number.isFinite(value) ? roundTo(clamp(value, 0, 1), 3) : 0;
}

function component(
  key: DdrForecastReadinessComponentKey,
  label: string,
  score: number,
  weight: number,
  reason: string,
): DdrForecastReadinessComponent {
  return { key, label, score: roundReadiness01(score), weight, reason };
}

function inputCoverageComponent(input: DdrForecastReadinessInput): DdrForecastReadinessComponent {
  const missing = [...(input.resolution.insufficientReasons ?? [])];
  if (input.currentDeviationBps == null && !missing.includes(DDR_INSUFFICIENT_LIVE_PRICE_REASON)) {
    missing.push(DDR_INSUFFICIENT_LIVE_PRICE_REASON);
  }

  if (missing.length === 0) {
    return component("input_coverage", "Input coverage", 1, 0.3, "Required forecast-readiness inputs are present.");
  }

  return component(
    "input_coverage",
    "Input coverage",
    Math.max(0, 1 - missing.length * 0.28),
    0.3,
    `Missing forecast-readiness inputs: ${missing.join("; ")}.`,
  );
}

function resolutionSignalComponent(input: DdrForecastReadinessInput): DdrForecastReadinessComponent {
  const factors = input.resolution.factors ?? [];
  const strongFactors = factors.filter((factor) => factor.severity === "strong" || factor.severity === "severe").length;
  const factorLift = Math.min(0.1, strongFactors * 0.025);

  switch (input.resolution.tier) {
    case "recovery_likely":
    case "recovery_unlikely":
      return component(
        "resolution_signal",
        "Resolution signal",
        0.9 + factorLift,
        0.25,
        input.resolution.tier === "recovery_likely"
          ? "Resolution outlook has a recoverable read with supporting anchors."
          : "Resolution outlook has a terminal-leaning read with fired kill signals.",
      );
    case "at_risk":
      return component(
        "resolution_signal",
        "Resolution signal",
        0.62 + Math.min(0.08, factors.length * 0.02),
        0.25,
        "Resolution outlook is mixed enough to keep the read provisional.",
      );
    case "insufficient_signal":
      return component(
        "resolution_signal",
        "Resolution signal",
        0.05,
        0.25,
        "Resolution outlook is blocked by insufficient signal.",
      );
  }
}

const CELL_STATE_SCORE: Record<DdrCellState, number> = {
  benchmarked: 1,
  thin_support: 0.65,
  no_comparable_closures: 0.35,
  chronic_tail: 0.55,
  unsupported: 0.15,
  data_issue: 0.05,
};

function durationSupportComponent(input: DdrForecastReadinessInput): DdrForecastReadinessComponent {
  const duration = input.duration;

  if (duration.suppressed) {
    if (duration.suppressedReason === "verdict_terminal") {
      return component(
        "duration_support",
        "Duration support",
        0.9,
        0.2,
        "Duration is intentionally suppressed for a terminal-leaning outlook.",
      );
    }
    if (duration.suppressedReason === "insufficient_signal") {
      return component(
        "duration_support",
        "Duration support",
        0.05,
        0.2,
        "Duration is suppressed because required signals are missing.",
      );
    }
    return component("duration_support", "Duration support", 0.35, 0.2, "Duration is suppressed for this row.");
  }

  if (duration.horizons.length === 0) {
    return component(
      "duration_support",
      "Duration support",
      0.25,
      0.2,
      "Duration estimate has no horizon cells.",
    );
  }

  const horizonScore = duration.horizons.reduce((sum, cell) => sum + CELL_STATE_SCORE[cell.state], 0) /
    duration.horizons.length;
  const hasBand = duration.medianSec != null && duration.iqrSec != null;
  const estimateShape = hasBand ? 1 : 0.55;
  const score = horizonScore * 0.75 + estimateShape * 0.25;

  return component(
    "duration_support",
    "Duration support",
    score,
    0.2,
    hasBand ? "Duration estimate has a supported median and band." : "Duration estimate is missing its median or band.",
  );
}

function observationMaturityComponent(input: DdrForecastReadinessInput): DdrForecastReadinessComponent {
  if (input.ageSec >= DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC) {
    return component(
      "observation_maturity",
      "Observation maturity",
      1,
      0.25,
      "Incident has reached the 72h forecast-readiness backstop.",
    );
  }
  if (input.ageSec < OBSERVATION_FLOOR_SEC) {
    return component(
      "observation_maturity",
      "Observation maturity",
      0,
      0.25,
      "Incident is still inside the first hour observation floor.",
    );
  }
  // Linear ramp between the first-hour floor and the full 6h observation point.
  const ratio = (input.ageSec - OBSERVATION_FLOOR_SEC) / (FULL_OBSERVATION_SEC - OBSERVATION_FLOOR_SEC);
  return component(
    "observation_maturity",
    "Observation maturity",
    ratio,
    0.25,
    ratio >= 1
      ? "Incident has accumulated enough observation time for a forecast-readiness read."
      : "Incident is still accumulating observation time toward the 6h forecast-readiness point.",
  );
}

export function meetsStrictEarlyLockReadiness(readiness: Pick<DdrForecastReadiness, "score">): boolean {
  return readiness.score > DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD;
}

export function forecastReadinessScore(input: DdrForecastReadinessInput): DdrForecastReadiness {
  const components = [
    inputCoverageComponent(input),
    resolutionSignalComponent(input),
    durationSupportComponent(input),
    observationMaturityComponent(input),
  ];
  const totalWeight = components.reduce((sum, entry) => sum + entry.weight, 0);
  const score = totalWeight === 0
    ? 0
    : roundReadiness01(components.reduce((sum, entry) => sum + entry.score * entry.weight, 0) / totalWeight);

  const readiness: DdrForecastReadiness = {
    version: DDR_FORECAST_READINESS_VERSION,
    score,
    threshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
    strictEarlyLockReady: false,
    reasons: components.map((entry) => entry.reason),
    components,
  };

  return {
    ...readiness,
    strictEarlyLockReady: meetsStrictEarlyLockReadiness(readiness),
  };
}

export function buildForecastReadinessBackstop(input: {
  startedAt: number;
  nowSec?: number | null;
}): DdrForecastReadinessBackstop {
  const backstopAt = input.startedAt + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC;
  return {
    version: DDR_FORECAST_READINESS_VERSION,
    delaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
    backstopAt,
    reached: input.nowSec != null ? input.nowSec >= backstopAt : false,
  };
}

export function forecastReadinessLockTrigger(input: {
  readiness: Pick<DdrForecastReadiness, "score">;
  backstop?: Pick<DdrForecastReadinessBackstop, "reached"> | null;
}): DdrLockTrigger {
  if (input.backstop?.reached === true) return "readiness_backstop";
  if (meetsStrictEarlyLockReadiness(input.readiness)) return "forecast_readiness";
  return "scheduled_24h";
}
