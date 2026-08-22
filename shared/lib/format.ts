import { DAY_SECONDS, HOUR_SECONDS, SECONDS_PER_MINUTE } from "./time-constants";
import { BPS_PER_UNIT } from "./math";
import { isFiniteNumber } from "./type-guards";
import { formatRelativeAgeSeconds } from "./relative-time";
import { ratioToPercentage, relativeChangeRatio } from "./stats";
import { getPegTaxonomyByCurrency } from "./peg-taxonomy";

type CompactUsdTier = "trillion" | "billion" | "million" | "thousand" | "unit";

export interface CompactUsdFormatOptions {
  currencyPrefix?: string;
  decimals: Readonly<Record<CompactUsdTier, number>>;
  invalidFallback: string;
  maximumTier?: Exclude<CompactUsdTier, "unit">;
  signPosition?: "before-currency" | "after-currency";
  thousandSuffix?: "K" | "k";
}

const COMPACT_USD_TIERS = [
  { tier: "trillion", divisor: 1e12, suffix: "T" },
  { tier: "billion", divisor: 1e9, suffix: "B" },
  { tier: "million", divisor: 1e6, suffix: "M" },
  { tier: "thousand", divisor: 1e3, suffix: "K" },
] as const;

const DEFAULT_COMPACT_USD_OPTIONS: CompactUsdFormatOptions = {
  decimals: { trillion: 2, billion: 2, million: 1, thousand: 0, unit: 0 },
  invalidFallback: "N/A",
};

/** Canonical compact-USD renderer. Product-specific output differences are explicit options. */
function formatCompactUsdWithOptions(
  value: number,
  options: CompactUsdFormatOptions = DEFAULT_COMPACT_USD_OPTIONS,
): string {
  if (!Number.isFinite(value)) return options.invalidFallback;

  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const maximumTierIndex = options.maximumTier
    ? COMPACT_USD_TIERS.findIndex(({ tier }) => tier === options.maximumTier)
    : 0;
  const selected = COMPACT_USD_TIERS
    .slice(maximumTierIndex)
    .find(({ divisor }) => abs >= divisor);
  const tier: CompactUsdTier = selected?.tier ?? "unit";
  const scaled = selected ? abs / selected.divisor : abs;
  const suffix = selected?.tier === "thousand"
    ? (options.thousandSuffix ?? selected.suffix)
    : (selected?.suffix ?? "");
  const body = `${scaled.toFixed(options.decimals[tier])}${suffix}`;
  const currencyPrefix = options.currencyPrefix ?? "$";

  return options.signPosition === "after-currency"
    ? `${currencyPrefix}${sign}${body}`
    : `${sign}${currencyPrefix}${body}`;
}

function abbreviateNumber(value: number, decimals: number): string {
  return formatCompactUsdWithOptions(value, {
    currencyPrefix: "",
    decimals: { trillion: decimals, billion: decimals, million: decimals, thousand: decimals, unit: decimals },
    invalidFallback: "N/A",
  });
}

export function formatCurrency(value: number, decimals = 2): string {
  return formatCompactUsdWithOptions(value, {
    decimals: { trillion: decimals, billion: decimals, million: decimals, thousand: decimals, unit: decimals },
    invalidFallback: "N/A",
  });
}

export function abbreviateNumberParts(value: number): { short: number; suffix: string } {
  if (!Number.isFinite(value)) return { short: 0, suffix: "" };
  const abs = Math.abs(value);
  const selected = COMPACT_USD_TIERS.find(({ divisor }) => abs >= divisor);
  return selected
    ? { short: value / selected.divisor, suffix: selected.suffix }
    : { short: value, suffix: "" };
}

export function formatCompactUsd(value: number): string {
  return formatCompactUsdWithOptions(value);
}

export function formatCompactUsdShort(value: number): string {
  return formatCompactUsdWithOptions(value, {
    decimals: { trillion: 1, billion: 1, million: 1, thousand: 1, unit: 0 },
    invalidFallback: "N/A",
    maximumTier: "billion",
    signPosition: "after-currency",
  });
}

export function formatCompactUsdShortLowerK(value: number): string {
  return formatCompactUsdWithOptions(value, {
    decimals: { trillion: 1, billion: 1, million: 1, thousand: 0, unit: 0 },
    invalidFallback: "$0",
    maximumTier: "billion",
    signPosition: "after-currency",
    thousandSuffix: "k",
  });
}

/** Signed compact-USD: same tiered abbreviation as formatCompactUsd, with a leading + for positives. */
export function formatSignedCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  return `${value > 0 ? "+" : ""}${formatCompactUsd(value)}`;
}

export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/u, "")}k`;
  }
  return String(value);
}

function trimTrailingZeros(value: string): string {
  return value.replace(/(\.\d*?[1-9])0+$/u, "$1").replace(/\.0+$/u, "");
}

export function pegCurrencySymbol(pegCurrency: string): string {
  return getPegTaxonomyByCurrency(pegCurrency)?.symbol ?? "$";
}

export function formatPrice(price: number | null | undefined, symbol = "$", decimals = 4): string {
  if (!isFiniteNumber(price)) return "N/A";
  return `${symbol}${price.toFixed(decimals)}`;
}

/**
 * Format a USD price in the peg's native unit (e.g. gold ounces for XAUT).
 *
 * Null/unusable `pegRef` contract: fall back to the observed USD price with an
 * explicit "$" symbol — real data, clearly USD-labeled, never a fabricated
 * native-unit figure. Reference-derived surfaces (deviation, depeg signals,
 * peg scores) must fail closed at their own call sites instead; callers whose
 * cell IS the native conversion render "—" themselves (see
 * stablecoin-table-row-model.ts priceCell).
 */
export function formatNativePrice(
  usdPrice: number | null | undefined,
  pegCurrency: string,
  pegRef: number | null,
  decimals = 4,
): string {
  if (!isFiniteNumber(usdPrice)) return "N/A";
  const taxonomy = getPegTaxonomyByCurrency(pegCurrency);
  const symbol = taxonomy?.symbol ?? "$";
  if (taxonomy?.nativePriceUsesUsdSymbol === true) {
    return formatPrice(usdPrice, "$", decimals);
  }
  if (pegRef == null || !Number.isFinite(pegRef) || pegRef <= 0) return formatPrice(usdPrice, "$", decimals);
  return formatPrice(usdPrice / pegRef, symbol, decimals);
}

/** Format a basis-point value with a sign prefix, e.g. "+12 bps" or "-5 bps". */
export function formatBps(bps: number): string {
  if (!Number.isFinite(bps)) return "N/A";
  const sign = bps >= 0 ? "+" : "";
  return `${sign}${bps} bps`;
}

/**
 * Compute peg deviation in basis points.
 * `pegValue` should be the USD price of one unit of the peg currency
 * (e.g. ~1.19 for EUR, ~1.30 for CHF, ~3200 for gold oz, 1 for USD).
 */
export function formatPegDeviation(price: number | null | undefined, pegValue: number | null = 1): string {
  if (!isFiniteNumber(price)) return "N/A";
  if (pegValue == null || !Number.isFinite(pegValue) || pegValue === 0) return "N/A";
  // Deviation as basis points relative to peg: ((price / pegValue) - 1) * BPS_PER_UNIT
  const ratio = price / pegValue;
  const bps = Math.round((ratio - 1) * BPS_PER_UNIT);
  if (!Number.isFinite(bps)) return "N/A";
  return formatBps(bps);
}

export function formatPercentChange(current: number, previous: number): string {
  const changeRatio = relativeChangeRatio(current, previous);
  if (changeRatio == null) return "N/A";
  const change = ratioToPercentage(changeRatio);
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(2)}%`;
}

export function formatSupply(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  if (value < 1e3) return value.toFixed(0);
  return abbreviateNumber(value, 2);
}

export function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value)) return "N/A";

  const abs = Math.abs(value);
  if (abs >= 1e3) return abbreviateNumber(value, 2);
  if (abs >= 1) return trimTrailingZeros(value.toFixed(2));
  if (abs === 0) return "0";
  return trimTrailingZeros(value.toFixed(4));
}

export function formatAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 2) return address;
  return `${address.slice(0, head)}...${address.slice(-tail)}`;
}

export function slugifyId(value: string, options: { stripPunctuation?: boolean } = {}): string {
  const source = options.stripPunctuation ? value.replace(/[`"'()[\]{}]/g, "") : value;
  return source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function formatTrackingSpanDays(days: number): string {
  if (!Number.isFinite(days)) return "N/A";
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem > 0 ? `${years}y ${rem}mo` : `${years}y`;
}

export function formatTrackingSpanSeconds(seconds: number): string {
  return formatTrackingSpanDays(Math.floor(seconds / DAY_SECONDS));
}

/** Format an epoch-seconds timestamp as an ISO date string ("YYYY-MM-DD"). */
export function formatIsoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function formatEventDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "N/A";
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return "N/A";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Calendar-day formatters. `utc: true` pins the calendar day to UTC, which is
 * required whenever the source is a day-precision value (an ISO `YYYY-MM-DD`
 * string or a UTC-midnight timestamp) — formatting those in local time shifts
 * the rendered day by one west of Greenwich.
 */
export function formatShortDate(date: Date, options: { utc?: boolean } = {}): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(options.utc ? { timeZone: "UTC" } : {}),
  });
}

/** Long-form month variant of `formatShortDate` ("August 9, 2026"). */
export function formatLongDate(date: Date, options: { utc?: boolean } = {}): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    ...(options.utc ? { timeZone: "UTC" } : {}),
  });
}

/**
 * Join labels into a human-readable prose list ("A", "A and B", "A, B, and C").
 *
 * Pharos house style is the Oxford comma; pass `oxford: false` for the surfaces
 * that deliberately read without it. Callers own truncation and empty-list
 * fallbacks — this only joins what it is given.
 */
export function formatProseList(items: readonly string[], options: { oxford?: boolean } = {}): string {
  const { oxford = true } = options;
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}${oxford ? "," : ""} and ${items[items.length - 1]}`;
}

/** Named idiom for the off-by-one-proof day label ("Aug 9, 2026", always UTC). */
export function formatUtcDayLabel(date: Date): string {
  return formatShortDate(date, { utc: true });
}

/**
 * Format a duration between two epoch timestamps as a human-readable string.
 * Returns two-unit precision for clarity: "2d 5h", "14h 30m", "45m".
 * For very short durations: "< 1m". For ongoing events (null end): "Ongoing".
 */
export function formatDuration(startSec: number, endSec: number | null): string {
  if (endSec === null) return "Ongoing";
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return "N/A";
  const totalSeconds = endSec - startSec;
  if (totalSeconds < 0) return "N/A";
  if (totalSeconds < SECONDS_PER_MINUTE) return "< 1m";

  const days = Math.floor(totalSeconds / DAY_SECONDS);
  const hours = Math.floor((totalSeconds % DAY_SECONDS) / HOUR_SECONDS);
  const minutes = Math.floor((totalSeconds % HOUR_SECONDS) / SECONDS_PER_MINUTE);

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function formatYearMonthWithStyle(value: string, monthStyle: "long" | "short"): string | null {
  const match = /^(\d{4})-(\d{2})/.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return new Date(y, m - 1).toLocaleDateString("en-US", { month: monthStyle, year: "numeric" });
}

/**
 * Format a "YYYY-MM" partial date as the long-form prose month and year
 * (e.g. "2022-05" → "May 2022"). Locale-correct via Intl.DateTimeFormat.
 * Returns the raw value if the input does not match the expected pattern.
 */
export function formatYearMonth(yearMonth: string): string {
  return formatYearMonthWithStyle(yearMonth, "long") ?? yearMonth;
}

/** Format "YYYY-MM" death date as "Jan 2023" */
export function formatDeathDate(d: string): string {
  const [year, month] = d.split("-");
  if (!month) return year;
  return formatYearMonthWithStyle(d, "short") ?? d;
}

/**
 * Convert seconds to a compact human-readable duration: "45s", "5m", "1h 30m", "2d".
 * This intentionally keeps composite units; use formatRelativeAgeSeconds for single-unit relative ages.
 */
export function formatElapsedSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "N/A";
  if (seconds < SECONDS_PER_MINUTE) return `${Math.floor(seconds)}s`;
  if (seconds < HOUR_SECONDS) return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m`;
  if (seconds < DAY_SECONDS) {
    const h = Math.floor(seconds / HOUR_SECONDS);
    const m = Math.floor((seconds % HOUR_SECONDS) / SECONDS_PER_MINUTE);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.floor(seconds / DAY_SECONDS)}d`;
}

/** Format an epoch-seconds timestamp as a relative time string ("just now", "5m ago", "2h ago"). */
export function timeAgo(epochSec: number, nowSec = Date.now() / 1000): string {
  if (!Number.isFinite(epochSec)) return "N/A";
  return formatRelativeAgeSeconds(nowSec - epochSec, {
    suffix: "ago",
    nowLabel: "just now",
    nowThresholdSec: SECONDS_PER_MINUTE,
    rounding: "floor",
  });
}

/** Tailwind color class for net flow values (positive = green, negative = red) */
interface SignedColorOptions {
  positiveClass?: string;
  negativeClass?: string;
  zeroClass?: string;
  positiveInclusiveZero?: boolean;
}

export function getNetColor(value: number, options: SignedColorOptions = {}): string {
  const {
    positiveClass = "text-emerald-700 dark:text-emerald-400",
    negativeClass = "text-red-700 dark:text-red-400",
    zeroClass = "text-muted-foreground",
    positiveInclusiveZero = false,
  } = options;

  if (value > 0 || (positiveInclusiveZero && value === 0)) return positiveClass;
  if (value < 0) return negativeClass;
  return zeroClass;
}

/** Sign prefix for positive net flow values */
export function getNetPrefix(value: number): string {
  return value > 0 ? "+" : "";
}

export function formatSignedCurrency(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "N/A";
  return `${getNetPrefix(value)}${formatCurrency(value, decimals)}`;
}

const decimalFormatterCache = new Map<string, Intl.NumberFormat>();

/** Format a number with grouping separators and a fixed fraction-digit range, caching the
 *  underlying Intl.NumberFormat by digit range. Use instead of hand-rolled module-level formatters. */
export function formatDecimal(value: number, minimumFractionDigits = 2, maximumFractionDigits = 2): string {
  const cacheKey = `${minimumFractionDigits}:${maximumFractionDigits}`;
  let formatter = decimalFormatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", { minimumFractionDigits, maximumFractionDigits });
    decimalFormatterCache.set(cacheKey, formatter);
  }
  return formatter.format(value);
}

/** Format a percentage to fixed decimals with % suffix. Returns "-" for nullish. */
export function formatPercent(value: number | null | undefined, decimals = 2): string {
  return isFiniteNumber(value) ? `${value.toFixed(decimals)}%` : "-";
}

/** Format a signed percentage with +/- prefix and % suffix. Returns `nullFallback` (default "-") for nullish. */
export function formatSignedPercent(value: number | null | undefined, decimals = 2, nullFallback = "-"): string {
  if (!isFiniteNumber(value)) return nullFallback;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

/**
 * Format a ratio (0-1 scale) as a percentage string.
 * Multiplies by 100 internally — callers should NOT pre-multiply.
 */
export function formatPercentFromRatio(
  ratio: number | null | undefined,
  decimals = 2,
): string {
  if (!isFiniteNumber(ratio)) return "-";
  return `${(ratio * 100).toFixed(decimals)}%`;
}

/** Format a number as a percentage string for chart axes.
 *  Includes sign prefix for non-zero values. */
export function formatChartPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return "N/A";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(decimals)}%`;
}

/** Format a 0-100 score to one decimal. Returns "-" for nullish values. */
export function formatScore(
  value: number | null | undefined,
  options: { trimInteger?: boolean } = {},
): string {
  if (!isFiniteNumber(value)) return "-";
  return options.trimInteger && Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatScoreTrimmed(value: number | null | undefined): string {
  return formatScore(value, { trimInteger: true });
}

type ChartDateFormat = "short" | "short-year" | "month-year" | "compact" | "with-time" | "long" | "full";

/** Centralized date formatter for chart axes and tooltips. */
export function formatChartDate(
  timestamp: number | string,
  format: ChartDateFormat = "short",
): string {
  if (typeof timestamp === "number" && !Number.isFinite(timestamp)) return "N/A";
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return String(timestamp);
  switch (format) {
    case "short":
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    case "short-year":
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    case "month-year":
      return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    case "compact": {
      const month = d.toLocaleDateString("en-US", { month: "short" });
      const year = d.toLocaleDateString("en-US", { year: "2-digit" });
      return `${month} '${year}`;
    }
    case "with-time":
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        hour12: true,
      });
    case "long":
      return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    case "full":
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }
}

/**
 * Format a deviation in basis points as a percent string.
 * Returns "—" for non-finite or zero values.
 * Values ≥1000 bps (10%) use 1 decimal; smaller values use 2 decimals.
 */
export function formatDeviationBps(bps: number): string {
  if (!Number.isFinite(bps) || bps === 0) return "—";
  const magnitude = Math.abs(bps);
  return magnitude >= 1000
    ? `${(magnitude / 100).toFixed(1)}%`
    : `${(magnitude / 100).toFixed(2)}%`;
}
