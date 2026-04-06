import { describe, expect, it } from "vitest";

import {
  abbreviateNumberParts,
  formatScore,
  formatChartDate,
  formatPercent,
  formatPercentFromRatio,
  formatSignedCurrency,
  formatSignedPercent,
  formatElapsedSeconds,
  formatCurrency,
  formatCompactCount,
  formatCompactUsd,
  formatBps,
  formatDeathDate,
  formatPegDeviation,
  formatNativePrice,
  formatPercentChange,
  formatSupply,
  formatTrackingSpanDays,
  formatTrackingSpanSeconds,
  formatTokenAmount,
  formatDuration,
  timeAgo,
  formatAddress,
} from "../format";

describe("formatScore", () => {
  it("formats to one decimal", () => expect(formatScore(72.456)).toBe("72.5"));
  it("handles zero", () => expect(formatScore(0)).toBe("0.0"));
  it("handles 100", () => expect(formatScore(100)).toBe("100.0"));
  it("returns dash for null", () => expect(formatScore(null)).toBe("-"));
  it("returns dash for undefined", () => expect(formatScore(undefined)).toBe("-"));
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
  it("handles non-zero start", () => {
    expect(formatDuration(1000, 1000 + 3600)).toBe("1h");
  });
});

describe("timeAgo", () => {
  it("returns 'just now' for recent timestamps", () => {
    const nowSec = Date.now() / 1000;
    expect(timeAgo(nowSec)).toBe("just now");
    expect(timeAgo(nowSec - 30)).toBe("just now");
  });
  it("returns minutes ago", () => {
    const nowSec = Date.now() / 1000;
    expect(timeAgo(nowSec - 5 * 60)).toBe("5m ago");
    expect(timeAgo(nowSec - 59 * 60)).toBe("59m ago");
  });
  it("returns hours ago", () => {
    const nowSec = Date.now() / 1000;
    expect(timeAgo(nowSec - 2 * 3600)).toBe("2h ago");
    expect(timeAgo(nowSec - 23 * 3600)).toBe("23h ago");
  });
  it("returns days ago", () => {
    const nowSec = Date.now() / 1000;
    expect(timeAgo(nowSec - 3 * 86400)).toBe("3d ago");
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
});

describe("formatTrackingSpanSeconds", () => {
  it("delegates to the shared day formatter", () => {
    expect(formatTrackingSpanSeconds(90 * 86400)).toBe("2mo");
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

  it("returns N/A for nullish or invalid values", () => {
    expect(formatNativePrice(null, "USD", 1)).toBe("N/A");
    expect(formatNativePrice(undefined, "EUR", 1.10)).toBe("N/A");
    expect(formatNativePrice(NaN, "USD", 1)).toBe("N/A");
  });

  it("falls back to USD formatting when pegRef is not positive", () => {
    expect(formatNativePrice(1.0001, "EUR", 0)).toBe("$1.0001");
    expect(formatNativePrice(1.0001, "EUR", -1)).toBe("$1.0001");
  });

  it("formats non-fiat peg families as USD", () => {
    expect(formatNativePrice(3200, "GOLD", 3200)).toBe("$3200.0000");
    expect(formatNativePrice(25, "SILVER", 25)).toBe("$25.0000");
    expect(formatNativePrice(1.0, "VAR", 1)).toBe("$1.0000");
    expect(formatNativePrice(1.0, "OTHER", 1)).toBe("$1.0000");
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
});
