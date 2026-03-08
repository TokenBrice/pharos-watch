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
  // Deviation as basis points relative to peg: ((price / pegValue) - 1) * 10000
  const ratio = price / pegValue;
  const bps = Math.round((ratio - 1) * 10000);
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

export function formatAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
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

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
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
  const date = new Date(Number(year), Number(month) - 1);
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
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

/** Format "YYYY-MM" death date as "Jan '23" (short year) */
export function formatDeathDateShort(d: string): string {
  const [year, month] = d.split("-");
  if (!month) return year;
  const dt = new Date(Number(year), Number(month) - 1);
  return dt.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

/** Tailwind color class for net flow values (positive = green, negative = red) */
export function getNetColor(value: number): string {
  if (value > 0) return "text-emerald-700 dark:text-emerald-400";
  if (value < 0) return "text-red-700 dark:text-red-400";
  return "text-muted-foreground";
}

/** Sign prefix for positive net flow values */
export function getNetPrefix(value: number): string {
  return value > 0 ? "+" : "";
}

/** Format a 0-100 score to one decimal. Returns "-" for nullish values. */
export function formatScore(value: number | null | undefined): string {
  return value != null ? value.toFixed(1) : "-";
}

/** Format an APY percentage to two decimals with % suffix. Returns "-" for nullish. */
export function formatApy(value: number | null | undefined): string {
  return value != null ? `${value.toFixed(2)}%` : "-";
}

type ChartDateFormat = "short" | "month-year" | "compact" | "with-time";

/** Centralized date formatter for chart axes and tooltips. */
export function formatChartDate(
  timestamp: number | string,
  format: ChartDateFormat = "short",
): string {
  const d = new Date(timestamp);
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
  }
}
