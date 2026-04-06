import { DAY_SECONDS } from "./time-constants";

const BPS_PER_UNIT = 10_000;

/** Abbreviate a number into tier suffixes (T/B/M/K) with configurable decimals and prefix. */
function abbreviateNumber(value: number, decimals: number, prefix = ""): string {
  if (!Number.isFinite(value)) return "N/A";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${sign}${prefix}${(abs / 1e12).toFixed(decimals)}T`;
  if (abs >= 1e9) return `${sign}${prefix}${(abs / 1e9).toFixed(decimals)}B`;
  if (abs >= 1e6) return `${sign}${prefix}${(abs / 1e6).toFixed(decimals)}M`;
  if (abs >= 1e3) return `${sign}${prefix}${(abs / 1e3).toFixed(decimals)}K`;
  return `${sign}${prefix}${abs.toFixed(decimals)}`;
}

export function formatCurrency(value: number, decimals = 2): string {
  return abbreviateNumber(value, decimals, "$");
}

export function abbreviateNumberParts(value: number): { short: number; suffix: string } {
  if (!Number.isFinite(value)) return { short: 0, suffix: "" };
  const abs = Math.abs(value);
  if (abs >= 1e12) return { short: value / 1e12, suffix: "T" };
  if (abs >= 1e9) return { short: value / 1e9, suffix: "B" };
  if (abs >= 1e6) return { short: value / 1e6, suffix: "M" };
  if (abs >= 1e3) return { short: value / 1e3, suffix: "K" };
  return { short: value, suffix: "" };
}

export function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  if (Math.abs(value) >= 1e12) return abbreviateNumber(value, 2, "$");
  if (Math.abs(value) >= 1e9) return abbreviateNumber(value, 2, "$");
  if (Math.abs(value) >= 1e6) return abbreviateNumber(value, 1, "$");
  if (Math.abs(value) >= 1e3) return abbreviateNumber(value, 0, "$");
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(0)}`;
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

const PEG_CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", CHF: "₣", BRL: "R$", RUB: "₽", JPY: "¥",
  IDR: "Rp", SGD: "S$", TRY: "₺", AUD: "A$", ZAR: "R",
  CAD: "C$", CNY: "¥", CNH: "¥", PHP: "₱", MXN: "MX$", UAH: "₴", ARS: "AR$",
  GOLD: "$", SILVER: "$", VAR: "$", OTHER: "$",
};

function formatPrice(price: number | null | undefined, symbol = "$", decimals = 4): string {
  if (price == null || typeof price !== "number" || isNaN(price)) return "N/A";
  return `${symbol}${price.toFixed(decimals)}`;
}

export function formatNativePrice(
  usdPrice: number | null | undefined,
  pegCurrency: string,
  pegRef: number,
  decimals = 4,
): string {
  if (usdPrice == null || typeof usdPrice !== "number" || isNaN(usdPrice)) return "N/A";
  const symbol = PEG_CURRENCY_SYMBOLS[pegCurrency] ?? "$";
  if (pegCurrency === "USD" || pegCurrency === "GOLD" || pegCurrency === "SILVER" || pegCurrency === "VAR" || pegCurrency === "OTHER") {
    return formatPrice(usdPrice, "$", decimals);
  }
  if (!pegRef || pegRef <= 0) return formatPrice(usdPrice, "$", decimals);
  return formatPrice(usdPrice / pegRef, symbol, decimals);
}

/** Format a basis-point value with a sign prefix, e.g. "+12 bps" or "-5 bps". */
export function formatBps(bps: number): string {
  const sign = bps >= 0 ? "+" : "";
  return `${sign}${bps} bps`;
}

/**
 * Compute peg deviation in basis points.
 * `pegValue` should be the USD price of one unit of the peg currency
 * (e.g. ~1.19 for EUR, ~1.30 for CHF, ~3200 for gold oz, 1 for USD).
 */
export function formatPegDeviation(price: number | null | undefined, pegValue = 1): string {
  if (price == null || typeof price !== "number" || isNaN(price)) return "N/A";
  if (pegValue === 0) return "N/A";
  // Deviation as basis points relative to peg: ((price / pegValue) - 1) * BPS_PER_UNIT
  const ratio = price / pegValue;
  const bps = Math.round((ratio - 1) * BPS_PER_UNIT);
  if (!Number.isFinite(bps)) return "N/A";
  return formatBps(bps);
}

export function formatPercentChange(current: number, previous: number): string {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return "N/A";
  const change = ((current - previous) / previous) * 100;
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

export function formatAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatTrackingSpanDays(days: number): string {
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

export function formatEventDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Format a duration between two epoch timestamps as a human-readable string.
 * Returns two-unit precision for clarity: "2d 5h", "14h 30m", "45m".
 * For very short durations: "< 1m". For ongoing events (null end): "Ongoing".
 */
export function formatDuration(startSec: number, endSec: number | null): string {
  if (endSec === null) return "Ongoing";
  const totalSeconds = endSec - startSec;
  if (totalSeconds < 0) return "N/A";
  if (totalSeconds < 60) return "< 1m";

  const days = Math.floor(totalSeconds / DAY_SECONDS);
  const hours = Math.floor((totalSeconds % DAY_SECONDS) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/** Format "YYYY-MM" death date as "Jan 2023" */
export function formatDeathDate(d: string): string {
  const [year, month] = d.split("-");
  if (!month) return year;
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return d;
  const date = new Date(y, m - 1);
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/** Convert seconds to a compact human-readable duration: "45s", "5m", "1h 30m", "2d". */
export function formatElapsedSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < DAY_SECONDS) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.floor(seconds / DAY_SECONDS)}d`;
}

/** Format an epoch-seconds timestamp as a relative time string ("just now", "5m ago", "2h ago"). */
export function timeAgo(epochSec: number): string {
  if (!Number.isFinite(epochSec)) return "N/A";
  const diffMin = Math.floor((Date.now() / 1000 - epochSec) / 60);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
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
  return `${getNetPrefix(value)}${formatCurrency(value, decimals)}`;
}

/** Format a percentage to fixed decimals with % suffix. Returns "-" for nullish. */
export function formatPercent(value: number | null | undefined, decimals = 2): string {
  return value != null ? `${value.toFixed(decimals)}%` : "-";
}

/** Format a signed percentage with +/- prefix and % suffix. Returns "-" for nullish. */
export function formatSignedPercent(value: number | null | undefined, decimals = 2): string {
  if (value == null) return "-";
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
  if (ratio == null) return "-";
  return `${(ratio * 100).toFixed(decimals)}%`;
}

/** Format a number as a percentage string for chart axes.
 *  Includes sign prefix for non-zero values. */
export function formatChartPercent(value: number, decimals = 1): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(decimals)}%`;
}

/** Format a 0-100 score to one decimal. Returns "-" for nullish values. */
export function formatScore(value: number | null | undefined): string {
  return value != null ? value.toFixed(1) : "-";
}

type ChartDateFormat = "short" | "month-year" | "compact" | "with-time" | "long" | "full";

/** Centralized date formatter for chart axes and tooltips. */
export function formatChartDate(
  timestamp: number | string,
  format: ChartDateFormat = "short",
): string {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return String(timestamp);
  switch (format) {
    case "short":
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
