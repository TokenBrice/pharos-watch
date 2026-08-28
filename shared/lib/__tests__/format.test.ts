import { describe, expect, it } from "vitest";

import {
  abbreviateNumberParts,
  formatScore,
  formatChartDate,
  formatChartPercent,
  formatDecimal,
  formatPercent,
  formatPercentFromRatio,
  formatPrice,
  formatSignedCurrency,
  formatSignedPercent,
  formatElapsedSeconds,
  formatCurrency,
  formatCompactCount,
  formatCompactUsd,
  formatCompactUsdWithOptions,
  formatCompactUsdShort,
  formatCompactUsdShortLowerK,
  formatSignedCompactUsd,
  formatBps,
  formatDeathDate,
  formatEventDate,
  formatPegDeviation,
  formatYearMonth,
  formatNativePrice,
  pegCurrencySymbol,
  formatPercentChange,
  formatSupply,
  formatTrackingSpanDays,
  formatTrackingSpanSeconds,
  formatTokenAmount,
  formatDuration,
  timeAgo,
  formatAddress,
  formatScoreTrimmed,
  slugifyId,
} from "../format";
import {
  formatApproxDurationSeconds,
  formatRelativeAgeSeconds,
  formatRelativeDurationSeconds,
  formatRelativeTimeMs,
} from "../relative-time";

describe("formatScore", () => {
  it("formats to one decimal", () => expect(formatScore(72.456)).toBe("72.5"));
  it("handles zero", () => expect(formatScore(0)).toBe("0.0"));
  it("handles 100", () => expect(formatScore(100)).toBe("100.0"));
  it("can trim integer scores", () => {
    expect(formatScore(100, { trimInteger: true })).toBe("100");
    expect(formatScore(72.456, { trimInteger: true })).toBe("72.5");
    expect(formatScoreTrimmed(80)).toBe("80");
  });
  it("returns dash for null", () => expect(formatScore(null)).toBe("-"));
  it("returns dash for undefined", () => expect(formatScore(undefined)).toBe("-"));
  it("returns dash for non-finite values", () => {
    expect(formatScore(Infinity)).toBe("-");
    expect(formatScore(NaN)).toBe("-");
  });
});

describe("formatPercent", () => {
  it("formats positive value", () => {
    expect(formatPercent(12.345)).toBe("12.35%");
  });
  it("formats zero", () => {
    expect(formatPercent(0)).toBe("0.00%");
  });
  it("formats negative value", () => {
    expect(formatPercent(-5.1)).toBe("-5.10%");
  });
  it("respects custom decimals", () => {
    expect(formatPercent(12.345, 1)).toBe("12.3%");
  });
  it("returns dash for nullish", () => {
    expect(formatPercent(null)).toBe("-");
    expect(formatPercent(undefined)).toBe("-");
  });
  it("returns dash for non-finite values", () => {
    expect(formatPercent(Infinity)).toBe("-");
    expect(formatPercent(NaN)).toBe("-");
  });
});

describe("formatDecimal", () => {
  it("defaults to two fraction digits", () => {
    expect(formatDecimal(12.3)).toBe("12.30");
  });
  it("respects a custom digit range", () => {
    expect(formatDecimal(12.345, 1, 1)).toBe("12.3");
    expect(formatDecimal(5, 0, 2)).toBe("5");
  });
  it("adds grouping separators", () => {
    expect(formatDecimal(1234.5)).toBe("1,234.50");
  });
});

describe("formatSignedPercent", () => {
  it("adds + prefix for positive", () => {
    expect(formatSignedPercent(5.5)).toBe("+5.50%");
  });
  it("keeps - prefix for negative", () => {
    expect(formatSignedPercent(-3.2)).toBe("-3.20%");
  });
  it("formats zero without sign", () => {
    expect(formatSignedPercent(0)).toBe("0.00%");
  });
  it("returns dash for nullish", () => {
    expect(formatSignedPercent(null)).toBe("-");
  });
  it("returns fallback for non-finite values", () => {
    expect(formatSignedPercent(Infinity)).toBe("-");
    expect(formatSignedPercent(NaN, 2, "N/A")).toBe("N/A");
  });
});

describe("formatElapsedSeconds", () => {
  it("formats seconds", () => {
    expect(formatElapsedSeconds(45)).toBe("45s");
  });
  it("formats minutes", () => {
    expect(formatElapsedSeconds(300)).toBe("5m");
  });
  it("formats hours and minutes", () => {
    expect(formatElapsedSeconds(5400)).toBe("1h 30m");
  });
  it("formats hours without extra minutes", () => {
    expect(formatElapsedSeconds(7200)).toBe("2h");
  });
  it("formats days", () => {
    expect(formatElapsedSeconds(172800)).toBe("2d");
  });
  it("returns 0s for zero", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
  });
});

describe("formatChartDate", () => {
  const ts = new Date("2025-06-15T12:00:00Z").getTime();
  it("short format: month + day", () => {
    expect(formatChartDate(ts, "short")).toBe("Jun 15");
  });
  it("month-year format", () => {
    expect(formatChartDate(ts, "month-year")).toBe("Jun 2025");
  });
  it("compact format: month + 2-digit year", () => {
    expect(formatChartDate(ts, "compact")).toBe("Jun '25");
  });
  it("with-time format: month + day + hour", () => {
    const result = formatChartDate(ts, "with-time");
    expect(result).toMatch(/Jun 15/);
    expect(result).toMatch(/\d{1,2}\s*(AM|PM)/i);
  });
});

describe("formatCurrency", () => {
  it("formats trillions", () => expect(formatCurrency(1.5e12)).toBe("$1.50T"));
  it("formats billions", () => expect(formatCurrency(2.345e9)).toBe("$2.35B"));
  it("formats millions", () => expect(formatCurrency(7.891e6)).toBe("$7.89M"));
  it("formats thousands", () => expect(formatCurrency(42_500)).toBe("$42.50K"));
  it("formats small values", () => expect(formatCurrency(123.456)).toBe("$123.46"));
  it("formats zero", () => expect(formatCurrency(0)).toBe("$0.00"));
  it("formats negative values", () => expect(formatCurrency(-3e9)).toBe("-$3.00B"));
  it("returns N/A for NaN", () => expect(formatCurrency(NaN)).toBe("N/A"));
  it("returns N/A for Infinity", () => expect(formatCurrency(Infinity)).toBe("N/A"));
  it("respects custom decimals", () => expect(formatCurrency(1.2345e9, 3)).toBe("$1.234B"));
});

describe("formatCompactUsdWithOptions", () => {
  const profile = {
    decimals: { trillion: 1, billion: 1, million: 1, thousand: 0, unit: 0 },
    invalidFallback: "n/a",
    trimTrailingZeros: true,
    useGrouping: true,
  } as const;

  it("pins tier, unit, sign, and invalid output bytes", () => {
    expect(formatCompactUsdWithOptions(1_250_000_000_000, profile)).toBe("$1.3T");
    expect(formatCompactUsdWithOptions(2_000_000_000, profile)).toBe("$2B");
    expect(formatCompactUsdWithOptions(3_500_000, profile)).toBe("$3.5M");
    expect(formatCompactUsdWithOptions(4_200, profile)).toBe("$4K");
    expect(formatCompactUsdWithOptions(999, profile)).toBe("$999");
    expect(formatCompactUsdWithOptions(-2_500_000, profile)).toBe("-$2.5M");
    expect(formatCompactUsdWithOptions(null, profile)).toBe("n/a");
    expect(formatCompactUsdWithOptions(Infinity, profile)).toBe("n/a");
  });

  it("supports capped tiers, lowercase k, and explicit sign placement", () => {
    expect(formatCompactUsdWithOptions(1_250_000_000_000, {
      ...profile,
      maximumTier: "billion",
    })).toBe("$1,250B");
    expect(formatCompactUsdWithOptions(12_500, {
      ...profile,
      thousandSuffix: "k",
    })).toBe("$13k");
    expect(formatCompactUsdWithOptions(-2_000_000, {
      ...profile,
      signPosition: "after-currency",
    })).toBe("$-2M");
  });
});

describe("formatSignedCurrency", () => {
  it("adds a plus sign for positive values", () => {
    expect(formatSignedCurrency(1.25e9)).toBe("+$1.25B");
  });

  it("preserves the negative sign for negative values", () => {
    expect(formatSignedCurrency(-250_000_000)).toBe("-$250.00M");
  });

  it("does not add a sign for zero", () => {
    expect(formatSignedCurrency(0)).toBe("$0.00");
  });

  it("returns N/A for non-finite values", () => {
    expect(formatSignedCurrency(Infinity)).toBe("N/A");
    expect(formatSignedCurrency(NaN)).toBe("N/A");
  });
});

describe("formatCompactUsd", () => {
  it("formats trillions with 2 decimals", () => expect(formatCompactUsd(1.567e12)).toBe("$1.57T"));
  it("formats billions with 2 decimals", () => expect(formatCompactUsd(4.321e9)).toBe("$4.32B"));
  it("formats millions with 1 decimal", () => expect(formatCompactUsd(8.76e6)).toBe("$8.8M"));
  it("formats thousands with 0 decimals", () => expect(formatCompactUsd(12_345)).toBe("$12K"));
  it("formats sub-thousand with 0 decimals", () => expect(formatCompactUsd(999)).toBe("$999"));
  it("formats zero", () => expect(formatCompactUsd(0)).toBe("$0"));
  it("formats negative billion", () => expect(formatCompactUsd(-2.5e9)).toBe("-$2.50B"));
  it("formats negative sub-thousand", () => expect(formatCompactUsd(-42)).toBe("-$42"));
  it("returns N/A for NaN", () => expect(formatCompactUsd(NaN)).toBe("N/A"));
  it("returns N/A for Infinity", () => expect(formatCompactUsd(Infinity)).toBe("N/A"));
});

describe("formatCompactUsdShort", () => {
  it("formats billions, millions, and thousands with one decimal", () => {
    expect(formatCompactUsdShort(4.321e9)).toBe("$4.3B");
    expect(formatCompactUsdShort(8.76e6)).toBe("$8.8M");
    expect(formatCompactUsdShort(12_345)).toBe("$12.3K");
    expect(formatCompactUsdShort(1_000)).toBe("$1.0K");
  });

  it("rounds sub-thousand values without decimals", () => {
    expect(formatCompactUsdShort(999)).toBe("$999");
    expect(formatCompactUsdShort(999.6)).toBe("$1000");
    expect(formatCompactUsdShort(0)).toBe("$0");
  });

  it("preserves the existing short-surface negative sign placement", () => {
    expect(formatCompactUsdShort(-2.5e9)).toBe("$-2.5B");
    expect(formatCompactUsdShort(-42)).toBe("$-42");
  });

  it("returns N/A for non-finite values", () => {
    expect(formatCompactUsdShort(NaN)).toBe("N/A");
    expect(formatCompactUsdShort(Infinity)).toBe("N/A");
  });
});

describe("formatCompactUsdShortLowerK", () => {
  it("keeps one decimal for B/M and rounds thousands to a lowercase k", () => {
    expect(formatCompactUsdShortLowerK(4.321e9)).toBe("$4.3B");
    expect(formatCompactUsdShortLowerK(8.76e6)).toBe("$8.8M");
    expect(formatCompactUsdShortLowerK(12_345)).toBe("$12k");
    expect(formatCompactUsdShortLowerK(1_000)).toBe("$1k");
  });

  it("rounds sub-thousand values without a suffix", () => {
    expect(formatCompactUsdShortLowerK(999)).toBe("$999");
    expect(formatCompactUsdShortLowerK(0)).toBe("$0");
  });

  it("returns $0 for non-finite values", () => {
    expect(formatCompactUsdShortLowerK(NaN)).toBe("$0");
    expect(formatCompactUsdShortLowerK(Infinity)).toBe("$0");
  });
});

describe("formatSignedCompactUsd", () => {
  it("prefixes a + for positive values and reuses formatCompactUsd tiers", () => {
    expect(formatSignedCompactUsd(2.5e9)).toBe("+$2.50B");
    expect(formatSignedCompactUsd(8.76e6)).toBe("+$8.8M");
    expect(formatSignedCompactUsd(12_345)).toBe("+$12K");
  });

  it("renders negative values with the abbreviateNumber minus sign", () => {
    expect(formatSignedCompactUsd(-2.5e9)).toBe("-$2.50B");
    expect(formatSignedCompactUsd(-42)).toBe("-$42");
  });

  it("does not prefix zero", () => {
    expect(formatSignedCompactUsd(0)).toBe("$0");
  });

  it("returns N/A for non-finite values", () => {
    expect(formatSignedCompactUsd(NaN)).toBe("N/A");
  });
});

describe("formatCompactCount", () => {
  it("formats large counts with a compact k suffix", () => {
    expect(formatCompactCount(1_500)).toBe("1.5k");
    expect(formatCompactCount(1_000)).toBe("1k");
    expect(formatCompactCount(999)).toBe("999");
  });
});

describe("abbreviateNumberParts", () => {
  it("returns value/suffix pairs for large magnitudes", () => {
    expect(abbreviateNumberParts(1.5e9)).toEqual({ short: 1.5, suffix: "B" });
    expect(abbreviateNumberParts(42_000)).toEqual({ short: 42, suffix: "K" });
  });

  it("returns the raw value for small magnitudes", () => {
    expect(abbreviateNumberParts(12)).toEqual({ short: 12, suffix: "" });
  });
});

describe("formatBps", () => {
  it("formats positive bps with + sign", () => expect(formatBps(12)).toBe("+12 bps"));
  it("formats negative bps with - sign", () => expect(formatBps(-5)).toBe("-5 bps"));
  it("formats zero with + sign", () => expect(formatBps(0)).toBe("+0 bps"));
  it("passes through non-integer values as-is", () => expect(formatBps(3.7)).toBe("+3.7 bps"));
  it("returns N/A for non-finite values", () => {
    expect(formatBps(Infinity)).toBe("N/A");
    expect(formatBps(NaN)).toBe("N/A");
  });
});

describe("formatPegDeviation", () => {
  it("returns +0 bps for on-peg (price equals pegValue)", () => {
    expect(formatPegDeviation(1.0, 1.0)).toBe("+0 bps");
  });
  it("returns positive bps when price above peg", () => {
    // (1.005 / 1.0 - 1) * 10000 = 50
    expect(formatPegDeviation(1.005, 1.0)).toBe("+50 bps");
  });
  it("returns negative bps when price below peg", () => {
    // (0.995 / 1.0 - 1) * 10000 = -50
    expect(formatPegDeviation(0.995, 1.0)).toBe("-50 bps");
  });
  it("handles non-USD peg values", () => {
    // EUR peg: price 1.19, pegValue 1.19 => on-peg
    expect(formatPegDeviation(1.19, 1.19)).toBe("+0 bps");
    // Slightly off: (1.20 / 1.19 - 1) * 10000 = ~84
    expect(formatPegDeviation(1.20, 1.19)).toBe("+84 bps");
  });
  it("defaults pegValue to 1 (USD)", () => {
    expect(formatPegDeviation(1.001)).toBe("+10 bps");
  });
  it("returns N/A for null price", () => expect(formatPegDeviation(null)).toBe("N/A"));
  it("returns N/A for undefined price", () => expect(formatPegDeviation(undefined)).toBe("N/A"));
  it("returns N/A for NaN price", () => expect(formatPegDeviation(NaN)).toBe("N/A"));
  it("returns N/A for zero pegValue", () => expect(formatPegDeviation(1.0, 0)).toBe("N/A"));
  it("returns N/A for non-finite inputs", () => {
    expect(formatPegDeviation(Infinity)).toBe("N/A");
    expect(formatPegDeviation(1.0, Infinity)).toBe("N/A");
  });
});

describe("formatPercentChange", () => {
  it("formats positive change", () => {
    expect(formatPercentChange(110, 100)).toBe("+10.00%");
  });
  it("formats negative change", () => {
    expect(formatPercentChange(90, 100)).toBe("-10.00%");
  });
  it("formats zero change", () => {
    expect(formatPercentChange(100, 100)).toBe("+0.00%");
  });
  it("returns N/A for division by zero (previous=0)", () => {
    expect(formatPercentChange(100, 0)).toBe("N/A");
  });
  it("returns N/A for NaN current", () => {
    expect(formatPercentChange(NaN, 100)).toBe("N/A");
  });
  it("returns N/A for Infinity previous", () => {
    expect(formatPercentChange(100, Infinity)).toBe("N/A");
  });
});

describe("formatSupply", () => {
  it("formats trillions", () => expect(formatSupply(2.5e12)).toBe("2.50T"));
  it("formats billions", () => expect(formatSupply(1.23e9)).toBe("1.23B"));
  it("formats millions", () => expect(formatSupply(4.56e6)).toBe("4.56M"));
  it("formats thousands", () => expect(formatSupply(7890)).toBe("7.89K"));
  it("formats sub-thousand with 0 decimals", () => expect(formatSupply(999)).toBe("999"));
  it("formats small values without abbreviation", () => expect(formatSupply(42)).toBe("42"));
  it("formats zero", () => expect(formatSupply(0)).toBe("0"));
  it("returns N/A for NaN", () => expect(formatSupply(NaN)).toBe("N/A"));
  it("returns N/A for Infinity", () => expect(formatSupply(Infinity)).toBe("N/A"));
  it("boundary: exactly 1000 gets abbreviated", () => expect(formatSupply(1000)).toBe("1.00K"));
});

describe("formatTokenAmount", () => {
  it("abbreviates values >= 1000", () => {
    expect(formatTokenAmount(12_345)).toBe("12.35K");
    expect(formatTokenAmount(5e6)).toBe("5.00M");
  });
  it("formats values >= 1 with 2 decimals, trimming trailing zeros", () => {
    expect(formatTokenAmount(5.50)).toBe("5.5");
    expect(formatTokenAmount(3.00)).toBe("3");
    expect(formatTokenAmount(7.89)).toBe("7.89");
  });
  it("returns '0' for zero", () => {
    expect(formatTokenAmount(0)).toBe("0");
  });
  it("formats sub-1 values with 4 decimals, trimming trailing zeros", () => {
    expect(formatTokenAmount(0.1234)).toBe("0.1234");
    expect(formatTokenAmount(0.5)).toBe("0.5");
    expect(formatTokenAmount(0.0010)).toBe("0.001");
  });
  it("handles negative values >= 1", () => {
    expect(formatTokenAmount(-5.10)).toBe("-5.1");
  });
  it("handles negative values >= 1000", () => {
    expect(formatTokenAmount(-2500)).toBe("-2.50K");
  });
  it("returns N/A for NaN", () => expect(formatTokenAmount(NaN)).toBe("N/A"));
  it("returns N/A for Infinity", () => expect(formatTokenAmount(Infinity)).toBe("N/A"));
});

describe("formatDuration", () => {
  it("formats days and hours", () => {
    // 2d 5h = 2*86400 + 5*3600 = 190800 seconds
    expect(formatDuration(0, 190800)).toBe("2d 5h");
  });
  it("formats days without hours", () => {
    expect(formatDuration(0, 172800)).toBe("2d");
  });
  it("formats hours and minutes", () => {
    // 14h 30m = 14*3600 + 30*60 = 52200 seconds
    expect(formatDuration(0, 52200)).toBe("14h 30m");
  });
  it("formats hours without minutes", () => {
    expect(formatDuration(0, 7200)).toBe("2h");
  });
  it("formats minutes only", () => {
    expect(formatDuration(0, 2700)).toBe("45m");
  });
  it("returns '< 1m' for sub-minute durations", () => {
    expect(formatDuration(0, 30)).toBe("< 1m");
    expect(formatDuration(0, 59)).toBe("< 1m");
  });
  it("returns 'Ongoing' for null end", () => {
    expect(formatDuration(1000, null)).toBe("Ongoing");
  });
  it("returns 'N/A' for negative duration", () => {
    expect(formatDuration(100, 50)).toBe("N/A");
  });
  it("returns 'N/A' for non-finite durations", () => {
    expect(formatDuration(Infinity, 50)).toBe("N/A");
    expect(formatDuration(0, Infinity)).toBe("N/A");
  });
  it("handles non-zero start", () => {
    expect(formatDuration(1000, 1000 + 3600)).toBe("1h");
  });
});

describe("timeAgo", () => {
  const nowSec = 1_700_000_000;
  it("returns 'just now' for recent timestamps", () => {
    expect(timeAgo(nowSec, nowSec)).toBe("just now");
    expect(timeAgo(nowSec - 30, nowSec)).toBe("just now");
  });
  it("returns minutes ago", () => {
    expect(timeAgo(nowSec - 5 * 60, nowSec)).toBe("5m ago");
    expect(timeAgo(nowSec - 59 * 60, nowSec)).toBe("59m ago");
  });
  it("returns hours ago", () => {
    expect(timeAgo(nowSec - 2 * 3600, nowSec)).toBe("2h ago");
    expect(timeAgo(nowSec - 23 * 3600, nowSec)).toBe("23h ago");
  });
  it("returns days ago", () => {
    expect(timeAgo(nowSec - 3 * 86400, nowSec)).toBe("3d ago");
  });
  it("returns N/A for NaN", () => {
    expect(timeAgo(NaN)).toBe("N/A");
  });
  it("returns N/A for Infinity", () => {
    expect(timeAgo(Infinity)).toBe("N/A");
  });
});

describe("formatPercentFromRatio", () => {
  it("formats a ratio as a percentage", () => {
    expect(formatPercentFromRatio(0.1234)).toBe("12.34%");
    expect(formatPercentFromRatio(1)).toBe("100.00%");
    expect(formatPercentFromRatio(0)).toBe("0.00%");
  });
  it("respects decimal precision", () => {
    expect(formatPercentFromRatio(0.1234, 1)).toBe("12.3%");
    expect(formatPercentFromRatio(0.1234, 0)).toBe("12%");
  });
  it("returns dash for nullish", () => {
    expect(formatPercentFromRatio(null)).toBe("-");
    expect(formatPercentFromRatio(undefined)).toBe("-");
  });
  it("returns dash for non-finite values", () => {
    expect(formatPercentFromRatio(Infinity)).toBe("-");
    expect(formatPercentFromRatio(NaN)).toBe("-");
  });
});

describe("formatAddress", () => {
  it("truncates long addresses", () => {
    expect(formatAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234...5678");
  });
  it("returns short addresses unchanged", () => {
    expect(formatAddress("0x12345678")).toBe("0x12345678");
    expect(formatAddress("abc")).toBe("abc");
  });
  it("returns 12-char addresses unchanged (boundary)", () => {
    expect(formatAddress("123456789012")).toBe("123456789012");
  });
  it("truncates 13-char addresses", () => {
    expect(formatAddress("1234567890123")).toBe("123456...0123");
  });
});

describe("slugifyId", () => {
  it("normalizes text into DOM-safe ids", () => {
    expect(slugifyId("Safety Score v6.92")).toBe("safety-score-v6-92");
  });

  it("can strip punctuation before separator normalization", () => {
    expect(slugifyId("foo(bar)", { stripPunctuation: true })).toBe("foobar");
    expect(slugifyId("foo(bar)")).toBe("foo-bar");
  });
});

describe("formatTrackingSpanDays", () => {
  it("formats day-only spans", () => {
    expect(formatTrackingSpanDays(15)).toBe("15d");
  });

  it("formats month spans using the shared 30.44-day rollup", () => {
    expect(formatTrackingSpanDays(90)).toBe("2mo");
  });

  it("formats multi-year spans with remaining months", () => {
    expect(formatTrackingSpanDays(820)).toBe("2y 2mo");
    expect(formatTrackingSpanDays(731)).toBe("2y");
  });

  it("returns N/A for non-finite spans", () => {
    expect(formatTrackingSpanDays(Infinity)).toBe("N/A");
    expect(formatTrackingSpanDays(NaN)).toBe("N/A");
  });
});

describe("formatTrackingSpanSeconds", () => {
  it("delegates to the shared day formatter", () => {
    expect(formatTrackingSpanSeconds(90 * 86400)).toBe("2mo");
  });

  it("returns N/A for non-finite seconds", () => {
    expect(formatTrackingSpanSeconds(Infinity)).toBe("N/A");
    expect(formatTrackingSpanSeconds(NaN)).toBe("N/A");
  });
});

describe("pegCurrencySymbol", () => {
  it("returns distinct symbols for supported non-USD fiat peg badges", () => {
    expect(pegCurrencySymbol("KRW")).toBe("₩");
    expect(pegCurrencySymbol("INR")).toBe("₹");
    expect(pegCurrencySymbol("MYR")).toBe("RM");
    expect(pegCurrencySymbol("HKD")).toBe("HK$");
    expect(pegCurrencySymbol("VND")).toBe("₫");
  });

  it("falls back to USD for unknown peg currency values", () => {
    expect(pegCurrencySymbol("UNKNOWN")).toBe("$");
  });
});

describe("formatNativePrice", () => {
  it("formats USD-pegged price as USD", () => {
    expect(formatNativePrice(1.0001, "USD", 1)).toBe("$1.0001");
  });

  it("formats EUR-pegged price converting via pegRef", () => {
    const result = formatNativePrice(1.10, "EUR", 1.10);
    expect(result).toContain("1.0000");
    expect(result).not.toBe("N/A");
  });

  it("formats supported non-USD fiat pegs with their native symbols", () => {
    expect(formatNativePrice(1300, "KRW", 1300)).toBe("₩1.0000");
    expect(formatNativePrice(83, "INR", 83)).toBe("₹1.0000");
    expect(formatNativePrice(4.7, "MYR", 4.7)).toBe("RM1.0000");
    expect(formatNativePrice(7.8, "HKD", 7.8)).toBe("HK$1.0000");
    expect(formatNativePrice(25000, "VND", 25000)).toBe("₫1.0000");
  });

  it("returns N/A for nullish or invalid values", () => {
    expect(formatNativePrice(null, "USD", 1)).toBe("N/A");
    expect(formatNativePrice(undefined, "EUR", 1.10)).toBe("N/A");
    expect(formatNativePrice(NaN, "USD", 1)).toBe("N/A");
    expect(formatNativePrice(Infinity, "USD", 1)).toBe("N/A");
  });

  it("falls back to USD formatting when pegRef is not positive", () => {
    expect(formatNativePrice(1.0001, "EUR", 0)).toBe("$1.0001");
    expect(formatNativePrice(1.0001, "EUR", -1)).toBe("$1.0001");
    expect(formatNativePrice(1.0001, "EUR", Infinity)).toBe("$1.0001");
  });

  it("formats non-fiat peg families as USD", () => {
    expect(formatNativePrice(3200, "GOLD", 3200)).toBe("$3200.0000");
    expect(formatNativePrice(25, "SILVER", 25)).toBe("$25.0000");
    expect(formatNativePrice(1.0, "VAR", 1)).toBe("$1.0000");
    expect(formatNativePrice(1.0, "OTHER", 1)).toBe("$1.0000");
  });
});

describe("non-finite formatter fallbacks", () => {
  it("does not leak Infinity or NaN from direct number formatters", () => {
    const outputs = [
      formatPrice(Infinity),
      formatChartPercent(Infinity),
      formatChartDate(Infinity),
      formatEventDate(Infinity),
      formatElapsedSeconds(Infinity),
    ];

    expect(outputs).not.toContain("Infinity");
    expect(outputs).not.toContain("NaN");
    expect(outputs).toEqual(["N/A", "N/A", "N/A", "N/A", "N/A"]);
  });
});

describe("formatRelativeTimeMs", () => {
  const now = 1_700_000_000_000; // fixed reference point
  it("returns seconds ago for sub-minute age", () => {
    expect(formatRelativeTimeMs(now - 30_000, { now })).toBe("30s ago");
  });
  it("clamps minimum age to 1s", () => {
    expect(formatRelativeTimeMs(now, { now })).toBe("1s ago");
    expect(formatRelativeTimeMs(now + 5_000, { now })).toBe("1s ago");
  });
  it("returns minutes ago for sub-hour age", () => {
    expect(formatRelativeTimeMs(now - 5 * 60_000, { now })).toBe("5m ago");
    expect(formatRelativeTimeMs(now - 59 * 60_000, { now })).toBe("59m ago");
  });
  it("returns hours ago for sub-day age", () => {
    expect(formatRelativeTimeMs(now - 2 * 3_600_000, { now })).toBe("2h ago");
    expect(formatRelativeTimeMs(now - 23 * 3_600_000, { now })).toBe("23h ago");
  });
  it("returns days ago for multi-day age", () => {
    expect(formatRelativeTimeMs(now - 3 * 86_400_000, { now })).toBe("3d ago");
  });
});

describe("relative duration helpers", () => {
  it("formats relative age with configurable floor and suffix labels", () => {
    expect(formatRelativeAgeSeconds(45, { nowLabel: "fresh", suffix: "old" })).toBe("fresh");
    expect(formatRelativeAgeSeconds(90, { nowLabel: "fresh", nowThresholdSec: 90, suffix: "old", rounding: "round" })).toBe("2m old");
    expect(formatRelativeAgeSeconds(3 * 3600, { suffix: "old" })).toBe("3h old");
  });

  it("supports max-day buckets and suffix-free durations", () => {
    expect(formatRelativeAgeSeconds(31 * 86_400, { maxDays: 30 })).toBe(">30d ago");
    expect(formatRelativeDurationSeconds(45, { nowLabel: "less than 1 min" })).toBe("less than 1 min");
    expect(formatRelativeDurationSeconds(60 * 60, { unitStyle: "short", rounding: "round", dayThresholdSec: 48 * 3600 })).toBe("1 h");
    expect(formatRelativeDurationSeconds(89 * 60, { unitStyle: "short", rounding: "round", dayThresholdSec: 48 * 3600 })).toBe("1 h");
    expect(formatRelativeDurationSeconds(90 * 60, { unitStyle: "short", rounding: "round", dayThresholdSec: 48 * 3600 })).toBe("2 h");
  });

  it("formats approximate depeg durations in compact and long styles", () => {
    expect(formatApproxDurationSeconds(90 * 60)).toBe("1.5h");
    expect(formatApproxDurationSeconds(90 * 60, { style: "long" })).toBe("1.5 hr");
    expect(formatApproxDurationSeconds(3 * 86_400, { style: "long" })).toBe("3.0 days");
    expect(formatApproxDurationSeconds(Number.NaN, { invalidFallback: "—" })).toBe("—");
  });
});

describe("formatDeathDate", () => {
  it('formats "YYYY-MM" as "Mon YYYY"', () => {
    expect(formatDeathDate("2023-01")).toBe("Jan 2023");
    expect(formatDeathDate("2024-12")).toBe("Dec 2024");
  });

  it("returns year only if no month", () => {
    expect(formatDeathDate("2023")).toBe("2023");
  });

  it("preserves malformed month fallbacks", () => {
    expect(formatDeathDate("2023-13")).toBe("2023-13");
    expect(formatYearMonth("2023-13")).toBe("2023-13");
    expect(formatYearMonth("not-a-month")).toBe("not-a-month");
  });
});
