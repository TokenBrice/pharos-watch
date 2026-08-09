import { DAY_SECONDS, HOUR_SECONDS, SECONDS_PER_MINUTE } from "./time-constants";

type RelativeUnitStyle = "compact" | "short" | "long";
type RelativeRounding = "floor" | "round";

export interface RelativeAgeFormatOptions {
  suffix?: "ago" | "old" | "";
  unitStyle?: RelativeUnitStyle;
  rounding?: RelativeRounding;
  nowLabel?: string;
  nowThresholdSec?: number;
  dayThresholdSec?: number;
  maxDays?: number;
  invalidFallback?: string;
  secondsMin?: number;
}

function roundValue(value: number, rounding: RelativeRounding): number {
  return rounding === "round" ? Math.round(value) : Math.floor(value);
}

function unitLabel(unit: "second" | "minute" | "hour" | "day", value: number, style: RelativeUnitStyle): string {
  if (style === "compact") {
    if (unit === "second") return "s";
    if (unit === "minute") return "m";
    if (unit === "hour") return "h";
    return "d";
  }
  if (style === "short") {
    if (unit === "second") return "sec";
    if (unit === "minute") return "min";
    if (unit === "hour") return "h";
    return "d";
  }
  if (unit === "second") return value === 1 ? "second" : "seconds";
  if (unit === "minute") return value === 1 ? "minute" : "minutes";
  if (unit === "hour") return value === 1 ? "hour" : "hours";
  return value === 1 ? "day" : "days";
}

function joinValueUnit(value: number, unit: "second" | "minute" | "hour" | "day", style: RelativeUnitStyle): string {
  const separator = style === "compact" ? "" : " ";
  return `${value}${separator}${unitLabel(unit, value, style)}`;
}

function appendSuffix(label: string, suffix: "ago" | "old" | ""): string {
  return suffix ? `${label} ${suffix}` : label;
}

export function formatRelativeAgeSeconds(ageSeconds: number, options: RelativeAgeFormatOptions = {}): string {
  const {
    suffix = "ago",
    unitStyle = "compact",
    rounding = "floor",
    nowLabel,
    nowThresholdSec = SECONDS_PER_MINUTE,
    dayThresholdSec = DAY_SECONDS,
    maxDays,
    invalidFallback = "N/A",
    secondsMin = 0,
  } = options;
  if (!Number.isFinite(ageSeconds)) return invalidFallback;
  const safeSeconds = Math.max(0, ageSeconds);
  if (nowLabel != null && safeSeconds < nowThresholdSec) return nowLabel;

  if (safeSeconds < SECONDS_PER_MINUTE) {
    return appendSuffix(joinValueUnit(Math.max(secondsMin, Math.floor(safeSeconds)), "second", unitStyle), suffix);
  }
  if (safeSeconds < HOUR_SECONDS) {
    return appendSuffix(joinValueUnit(Math.max(1, roundValue(safeSeconds / SECONDS_PER_MINUTE, rounding)), "minute", unitStyle), suffix);
  }
  if (safeSeconds < dayThresholdSec) {
    return appendSuffix(joinValueUnit(Math.max(1, roundValue(safeSeconds / HOUR_SECONDS, rounding)), "hour", unitStyle), suffix);
  }

  const days = Math.max(1, roundValue(safeSeconds / DAY_SECONDS, rounding));
  if (maxDays != null && days > maxDays) {
    return appendSuffix(`>${joinValueUnit(maxDays, "day", unitStyle)}`, suffix);
  }
  return appendSuffix(joinValueUnit(days, "day", unitStyle), suffix);
}

export function formatRelativeDurationSeconds(
  seconds: number,
  options: Omit<RelativeAgeFormatOptions, "suffix"> & { suffix?: RelativeAgeFormatOptions["suffix"] } = {},
): string {
  return formatRelativeAgeSeconds(seconds, { suffix: "", ...options });
}

export function formatApproxDurationSeconds(
  seconds: number,
  options: { style?: "compact" | "long"; invalidFallback?: string } = {},
): string {
  const { style = "compact", invalidFallback = "N/A" } = options;
  if (!Number.isFinite(seconds) || seconds < 0) return invalidFallback;

  if (style === "long") {
    if (seconds < SECONDS_PER_MINUTE) return `${Math.max(1, Math.round(seconds))}s`;
    const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
    if (minutes < 60) return `${minutes} min`;
    const hours = minutes / 60;
    if (hours < 24) return `${hours.toFixed(1)} hr`;
    return `${(hours / 24).toFixed(1)} days`;
  }

  if (seconds < HOUR_SECONDS) return `${Math.max(1, Math.round(seconds / SECONDS_PER_MINUTE))}m`;
  if (seconds < DAY_SECONDS) {
    const hours = seconds / HOUR_SECONDS;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  const days = seconds / DAY_SECONDS;
  return `${Number.isInteger(days) ? days : days.toFixed(1)}d`;
}

/**
 * Render a configured duration at its largest *whole* natural unit:
 * `86_400 -> "1d"`, `3_600 -> "1h"`, `5_400 -> "90m"`, `45 -> "45s"`.
 *
 * Unlike `formatApproxDurationSeconds` this never rounds into a fractional unit,
 * so a configured threshold reads back exactly as it was configured (a 90-minute
 * bound stays `"90m"` instead of becoming `"1.5h"`). Pass `minUnit: "minute"`
 * for surfaces where sub-minute precision is noise; sub-minute values then round
 * up into minutes.
 */
export function formatWholeUnitDurationSeconds(
  seconds: number,
  options: { minUnit?: "second" | "minute" } = {},
): string {
  if (seconds % DAY_SECONDS === 0) return `${seconds / DAY_SECONDS}d`;
  if (seconds % HOUR_SECONDS === 0) return `${seconds / HOUR_SECONDS}h`;
  if (options.minUnit === "minute") return `${Math.round(seconds / SECONDS_PER_MINUTE)}m`;
  if (seconds % SECONDS_PER_MINUTE === 0) return `${seconds / SECONDS_PER_MINUTE}m`;
  return `${seconds}s`;
}

/**
 * Format a millisecond timestamp as a relative time string ("1s ago", "5m ago", "2h ago", "3d ago").
 * Accepts an optional `now` override (ms) for deterministic testing.
 * Pass `withSuffix: false` to get a short token ("1s", "5m", "2h", "3d") for column-style displays.
 */
export function formatRelativeTimeMs(tsMs: number, opts?: { now?: number; withSuffix?: boolean }): string {
  const ageSec = Math.max(1, Math.floor(((opts?.now ?? Date.now()) - tsMs) / 1000));
  return formatRelativeAgeSeconds(ageSec, {
    suffix: opts?.withSuffix === false ? "" : "ago",
    rounding: "round",
    secondsMin: 1,
  });
}
