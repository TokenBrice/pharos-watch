export function formatCurrency(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "N/A";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(decimals)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(decimals)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(decimals)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(decimals)}K`;
  return `${sign}$${abs.toFixed(decimals)}`;
}

const PEG_CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", CHF: "₣", BRL: "R$", RUB: "₽", JPY: "¥",
  GOLD: "$", VAR: "$", OTHER: "$",
};

function formatPrice(price: number | null | undefined, symbol = "$"): string {
  if (price == null || typeof price !== "number" || isNaN(price)) return "N/A";
  return `${symbol}${price.toFixed(4)}`;
}

export function formatNativePrice(
  usdPrice: number | null | undefined,
  pegCurrency: string,
  pegRef: number,
): string {
  if (usdPrice == null || typeof usdPrice !== "number" || isNaN(usdPrice)) return "N/A";
  const symbol = PEG_CURRENCY_SYMBOLS[pegCurrency] ?? "$";
  if (pegCurrency === "USD" || pegCurrency === "GOLD" || pegCurrency === "VAR" || pegCurrency === "OTHER") {
    return formatPrice(usdPrice);
  }
  if (!pegRef || pegRef <= 0) return formatPrice(usdPrice);
  return formatPrice(usdPrice / pegRef, symbol);
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
  const sign = bps >= 0 ? "+" : "";
  return `${sign}${bps} bps`;
}

export function formatPercentChange(current: number, previous: number): string {
  if (previous === 0) return "N/A";
  const change = ((current - previous) / previous) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(2)}%`;
}

export function formatSupply(value: number): string {
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(0);
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

export function formatPegStability(pct: number): string {
  return `${pct.toFixed(2)}%`;
}

export function formatWorstDeviation(bps: number): string {
  const sign = bps >= 0 ? "+" : "";
  return `${sign}${bps} bps`;
}

/**
 * Format a duration between two epoch timestamps as a human-readable string.
 * Returns two-unit precision for clarity: "2d 5h", "14h 30m", "45m".
 * For very short durations: "< 1m". For ongoing events (null end): "Ongoing".
 */
export function formatDuration(startSec: number, endSec: number | null): string {
  if (endSec === null) return "Ongoing";
  const totalSeconds = endSec - startSec;
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

/** Format "YYYY-MM" death date as "Jan '23" (short year) */
export function formatDeathDateShort(d: string): string {
  const [year, month] = d.split("-");
  if (!month) return year;
  const dt = new Date(Number(year), Number(month) - 1);
  return dt.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

