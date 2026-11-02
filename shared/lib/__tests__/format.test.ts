import { describe, expect, it } from "vitest";

import {
  abbreviateNumberParts,
  formatScore,
  roundForDisplay,
  formatChartDate,
  formatChartPercent,
  formatPercent,
  formatCoverageRatio,
  formatPegOccupancy,
  formatPercentFromRatio,
  formatPrice,
  formatSignedCurrency,
  formatSignedPercent,
  formatElapsedSeconds,
  formatCurrency,
  formatCompactCount,
  formatCompactUsd,
  formatCompactUsdOrSubDollar,
  formatCompactUsdWithOptions,
  formatCompactUsdShort,
  formatCompactUsdShortLowerK,
  formatDexPricingAuditUsd,
  formatSafetyMapUsd,
  formatV9PresentationUsd,
  formatSignedCompactUsd,
  formatBps,
  formatEventDate,
  formatNativePrice,
  formatUsdPriceAdaptive,
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
} from "../format";
import {
  formatApproxDurationSeconds,
  formatRelativeAgeSeconds,
  formatRelativeDurationSeconds,
  formatRelativeTimeMs,
  formatWholeUnitDurationSeconds,
} from "../relative-time";

describe("formatWholeUnitDurationSeconds", () => {
  it.each([
    [0, "0d"],
    [1, "1m"],
    [29, "1m"],
    [30, "1m"],
    [59, "1m"],
    [60, "1m"],
    [5_400, "90m"],
    [3_600, "1h"],
    [86_400, "1d"],
  ] as const)("preserves minimum-minute and natural units for %ss", (seconds, expected) => {
    expect(formatWholeUnitDurationSeconds(seconds, { minUnit: "minute" })).toBe(expected);
  });
});

describe("formatScore", () => {
  it("formats to one decimal", () => expect(formatScore(72.456)).toBe("72.5"));
  it("can trim integer scores", () => {
    expect(formatScore(100, { trimInteger: true })).toBe("100");
    expect(formatScore(72.456, { trimInteger: true })).toBe("72.5");
    expect(formatScoreTrimmed(80)).toBe("80");
  });
  it("returns dash for null", () => expect(formatScore(null)).toBe("-"));
  it("returns dash for non-finite values", () => {
    expect(formatScore(Infinity)).toBe("-");
    expect(formatScore(NaN)).toBe("-");
  });
});

describe("formatPercent", () => {
  it.each([
    [12.345, undefined, "12.35%"],
    [0, undefined, "0.00%"],
    [-5.1, undefined, "-5.10%"],
    [12.345, 1, "12.3%"],
  ])("formats %s with decimals %s as %s", (value, decimals, expected) => {
    expect(formatPercent(value, decimals)).toBe(expected);
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

describe("formatCoverageRatio", () => {
  it.each([
    [1, "100.0%"],
    [0.99996, "<100%"],
    [0.999, "99.9%"],
    [0.9, "90.0%"],
    [0, "0.0%"],
  ])("formats coverage ratio %s as %s", (value, expected) => {
    expect(formatCoverageRatio(value)).toBe(expected);
  });

  it.each([null, undefined, NaN, Infinity, -Infinity])("preserves unavailable coverage %s", (value) => {
    expect(formatCoverageRatio(value)).toBe("-");
  });
});

describe("formatPegOccupancy", () => {
  it.each([
    [100, 1, "100.0%"],
    [100, 2, "100.00%"],
    [99.996, 1, "<100%"],
    [99.996, 2, "<100%"],
    [99.99, 1, "<100%"],
    [99.99, 2, "99.99%"],
    [99.96, 1, "<100%"],
    [99.96, 2, "99.96%"],
    [99.9, 1, "99.9%"],
    [0, 1, "0.0%"],
    [0, 2, "0.00%"],
    [0.001, 1, "0.0%"],
    [0.01, 2, "0.01%"],
  ])("formats occupancy %s with precision %s as %s", (value, decimals, expected) => {
    expect(formatPegOccupancy(value, decimals)).toBe(expected);
  });

  it.each([null, undefined, NaN, Infinity, -Infinity])("preserves unavailable occupancy %s", (value) => {
    expect(formatPegOccupancy(value)).toBe("-");
  });
});

describe("formatSignedPercent", () => {
  it.each([
    [5.5, "+5.50%"],
    [-3.2, "-3.20%"],
    [0, "0.00%"],
    [-0, "0.00%"],
    [0.001, "0.00%"],
    [-0.001, "0.00%"],
    [-0.0049, "0.00%"],
    [0.0049, "0.00%"],
    [-0.0051, "-0.01%"],
    [0.0051, "+0.01%"],
    [null, "-"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatSignedPercent(value)).toBe(expected);
  });
  it("rounds before choosing the sign at one decimal", () => {
    expect(formatSignedPercent(-0.04, 1)).toBe("0.0%");
    expect(formatSignedPercent(-0.06, 1)).toBe("-0.1%");
    expect(formatSignedPercent(0.06, 1)).toBe("+0.1%");
  });
  it("returns fallback for non-finite values", () => {
    expect(formatSignedPercent(Infinity)).toBe("-");
    expect(formatSignedPercent(NaN, 2, "N/A")).toBe("N/A");
  });
});

describe("formatElapsedSeconds", () => {
  it.each([
    [45, "45s"],
    [300, "5m"],
    [5400, "1h 30m"],
    [7200, "2h"],
    [172800, "2d"],
    [0, "0s"],
  ])("formats %s seconds as %s", (value, expected) => {
    expect(formatElapsedSeconds(value)).toBe(expected);
  });
});

describe("formatCurrency", () => {
  it("formats millions", () => expect(formatCurrency(7.891e6)).toBe("$7.89M"));
  it("formats small values", () => expect(formatCurrency(123.456)).toBe("$123.46"));
  it("formats negative values", () => expect(formatCurrency(-3e9)).toBe("-$3.00B"));
  it("returns N/A for NaN", () => expect(formatCurrency(NaN)).toBe("N/A"));
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
  it.each([
    [1.25e9, "+$1.25B"],
    [-250_000_000, "-$250.00M"],
    [0, "$0.00"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatSignedCurrency(value)).toBe(expected);
  });

  it("returns N/A for non-finite values", () => {
    expect(formatSignedCurrency(Infinity)).toBe("N/A");
    expect(formatSignedCurrency(NaN)).toBe("N/A");
  });
});

describe.each<{
  name: string;
  format: (value: number) => string;
  cases: [string, [number, string][]][];
}>([
  {
    name: "formatCompactUsd", format: formatCompactUsd,
    cases: [
      ["formats billions with 2 decimals", [[4.321e9, "$4.32B"]]],
      ["formats millions with 1 decimal", [[8.76e6, "$8.8M"]]],
      ["formats thousands with 0 decimals", [[12_345, "$12K"]]],
      ["formats sub-thousand with 0 decimals", [[999, "$999"]]],
      ["formats negative billion", [[-2.5e9, "-$2.50B"]]],
      ["returns N/A for NaN", [[NaN, "N/A"]]],
    ],
  },
  {
    name: "formatCompactUsdShort", format: formatCompactUsdShort,
    cases: [
      ["formats billions, millions, and thousands with one decimal", [[4.321e9, "$4.3B"], [8.76e6, "$8.8M"], [12_345, "$12.3K"], [1_000, "$1.0K"]]],
      ["preserves the existing short-surface negative sign placement", [[-2.5e9, "$-2.5B"], [-42, "$-42"]]],
      ["returns N/A for non-finite values", [[NaN, "N/A"], [Infinity, "N/A"]]],
    ],
  },
  {
    name: "formatCompactUsdShortLowerK", format: formatCompactUsdShortLowerK,
    cases: [
      ["keeps one decimal for B/M and rounds thousands to a lowercase k", [[4.321e9, "$4.3B"], [8.76e6, "$8.8M"], [12_345, "$12k"], [1_000, "$1k"]]],
      ["returns N/A for non-finite values", [[NaN, "N/A"], [Infinity, "N/A"]]],
    ],
  },
  {
    name: "formatSignedCompactUsd", format: formatSignedCompactUsd,
    cases: [
      ["prefixes a + for positive values and reuses formatCompactUsd tiers", [[2.5e9, "+$2.50B"], [8.76e6, "+$8.8M"], [12_345, "+$12K"]]],
      ["renders negative values with the abbreviateNumber minus sign", [[-2.5e9, "-$2.50B"], [-42, "-$42"]]],
      ["does not prefix zero", [[0, "$0"]]],
      ["returns N/A for non-finite values", [[NaN, "N/A"]]],
    ],
  },
  {
    name: "formatCompactCount", format: formatCompactCount,
    cases: [
      ["formats large counts with a compact k suffix", [[1_500, "1.5k"], [1_000, "1k"], [999, "999"]]],
    ],
  },
  {
    name: "formatSupply", format: formatSupply,
    cases: [
      ["formats millions", [[4.56e6, "4.56M"]]],
      ["formats sub-thousand with 0 decimals", [[999, "999"]]],
      ["formats zero", [[0, "0"]]],
      ["returns N/A for NaN", [[NaN, "N/A"]]],
      ["boundary: exactly 1000 gets abbreviated", [[1000, "1.00K"]]],
    ],
  },
  {
    name: "formatTokenAmount", format: formatTokenAmount,
    cases: [
      ["abbreviates values >= 1000", [[12_345, "12.35K"], [5e6, "5.00M"]]],
      ["formats values >= 1 with 2 decimals, trimming trailing zeros", [[5.50, "5.5"], [3.00, "3"], [7.89, "7.89"]]],
      ["returns '0' for zero", [[0, "0"]]],
      ["formats sub-1 values with 4 decimals, trimming trailing zeros", [[0.1234, "0.1234"], [0.5, "0.5"], [0.0010, "0.001"]]],
      ["handles negative values >= 1", [[-5.10, "-5.1"]]],
      ["returns N/A for NaN", [[NaN, "N/A"]]],
    ],
  },
])("$name", ({ format, cases }) => {
  it.each(cases)("%s", (_, values) => {
    for (const [value, expected] of values) {
      expect(format(value)).toBe(expected);
    }
  });
});

describe.each([
  [formatCurrency, "$0.00", "-$2.50M"],
  [formatCompactUsd, "$0", "-$2.5M"],
  [formatCompactUsdShort, "$0", "$-2.5M"],
  [formatCompactUsdShortLowerK, "$0", "$-2.5M"],
  [formatSignedCompactUsd, "$0", "-$2.5M"],
  [formatCompactCount, "0", "-2500k"],
  [formatDexPricingAuditUsd, "$0", "$-2.50M"],
  [formatSafetyMapUsd, "$0K", "$-2500K"],
  [formatV9PresentationUsd, "$0", "$-2,500,000"],
] as const)("compact availability for %s", (format, zero, negative) => {
  it.each([NaN, Infinity, -Infinity])("marks %s unavailable without inventing zero", (value) => {
    expect(format(value)).toBe("N/A");
  });
  it("preserves measured zero and signed-negative presentation", () => {
    expect(format(0)).toBe(zero);
    expect(format(-2_500_000)).toBe(negative);
  });
});

describe("abbreviateNumberParts", () => {
  it("returns value/suffix pairs for large magnitudes", () => {
    expect(abbreviateNumberParts(1.5e9)).toEqual({ short: 1.5, suffix: "B" });
    expect(abbreviateNumberParts(42_000)).toEqual({ short: 42, suffix: "K" });
  });

  it("returns the raw value for small magnitudes", () => {
    expect(abbreviateNumberParts(12)).toEqual({ short: 12, suffix: "" });
    expect(abbreviateNumberParts(0)).toEqual({ short: 0, suffix: "" });
    expect(abbreviateNumberParts(-2_500_000)).toEqual({ short: -2.5, suffix: "M" });
  });

  it.each([NaN, Infinity, -Infinity])("keeps invalid parts %s unavailable", (value) => {
    expect(abbreviateNumberParts(value)).toBeNull();
  });
});

describe("formatBps", () => {
  it.each([
    ["formats positive bps with + sign", [[12, "+12 bps"]]],
    ["formats negative bps with - sign", [[-5, "-5 bps"]]],
    ["formats zero with + sign", [[0, "+0 bps"]]],
    ["returns N/A for non-finite values", [[Infinity, "N/A"], [NaN, "N/A"]]],
  ] as const)("%s", (_, values) => {
    for (const [value, expected] of values) {
      expect(formatBps(value)).toBe(expected);
    }
  });
});


describe("roundForDisplay", () => {
  it("normalizes signed zero and keeps ordinary values", () => {
    expect(Object.is(roundForDisplay(-0.001, 2), 0)).toBe(true);
    expect(Object.is(roundForDisplay(-0, 2), 0)).toBe(true);
    expect(roundForDisplay(-1.234, 2)).toBe(-1.23);
    expect(roundForDisplay(1.236, 2)).toBe(1.24);
  });
});

describe("formatPercentChange", () => {
  it.each([
    [110, 100, "+10.00%"],
    [90, 100, "-10.00%"],
    [100, 100, "0.00%"],
    [99.999, 100, "0.00%"],
    [100.001, 100, "0.00%"],
    [0, 100, "-100.00%"],
    [100, 0, "N/A"],
    [NaN, 100, "N/A"],
    [100, Infinity, "N/A"],
  ])("formats current %s against previous %s as %s", (current, previous, expected) => {
    expect(formatPercentChange(current, previous)).toBe(expected);
  });
});


describe("formatDuration", () => {
  it.each([
    ["formats days and hours", [[0, 190800, "2d 5h"]]],
    ["formats hours and minutes", [[0, 52200, "14h 30m"]]],
    ["formats minutes only", [[0, 2700, "45m"]]],
    ["returns '< 1m' for sub-minute durations", [[0, 30, "< 1m"], [0, 59, "< 1m"]]],
    ["returns 'Ongoing' for null end", [[1000, null, "Ongoing"]]],
    ["returns 'N/A' for negative duration", [[100, 50, "N/A"]]],
    ["returns 'N/A' for non-finite durations", [[Infinity, 50, "N/A"], [0, Infinity, "N/A"]]],
  ] as const)("%s", (_, values) => {
    for (const [start, end, expected] of values) {
      expect(formatDuration(start, end)).toBe(expected);
    }
  });
});

describe("timeAgo", () => {
  const nowSec = 1_700_000_000;
  it.each([
    ["returns 'just now' for recent timestamps", [[nowSec, "just now"], [nowSec - 30, "just now"]]],
    ["returns minutes ago", [[nowSec - 5 * 60, "5m ago"], [nowSec - 59 * 60, "59m ago"]]],
    ["returns hours ago", [[nowSec - 2 * 3600, "2h ago"], [nowSec - 23 * 3600, "23h ago"]]],
    ["returns days ago", [[nowSec - 3 * 86400, "3d ago"]]],
  ] as const)("%s", (_, values) => {
    for (const [timestamp, expected] of values) {
      expect(timeAgo(timestamp, nowSec)).toBe(expected);
    }
  });
  it("returns N/A for NaN", () => {
    expect(timeAgo(NaN)).toBe("N/A");
  });
});

describe("formatPercentFromRatio", () => {
  it("formats a ratio as a percentage", () => {
    expect(formatPercentFromRatio(0.1234)).toBe("12.34%");
    expect(formatPercentFromRatio(1)).toBe("100.00%");
    expect(formatPercentFromRatio(0)).toBe("0.00%");
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

  it.each([
    [29, "29d"],
    [30, "30d"],
    [30.439, "30.439d"],
    [30.44, "1mo"],
    [31, "1mo"],
  ])("keeps %s days below a full rollup month in day units", (days, expected) => {
    expect(formatTrackingSpanDays(days)).toBe(expected);
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
  it.each([
    [29 * 86400, "29d"],
    [30 * 86400, "30d"],
    [30.44 * 86400, "30d"],
    [31 * 86400 - 1, "30d"],
    [31 * 86400, "1mo"],
    [731 * 86400, "2y"],
    [820 * 86400, "2y 2mo"],
  ])("floors %s seconds to full days before the month transition", (seconds, expected) => {
    expect(formatTrackingSpanSeconds(seconds)).toBe(expected);
  });

  it("returns N/A for non-finite seconds", () => {
    expect(formatTrackingSpanSeconds(Infinity)).toBe("N/A");
    expect(formatTrackingSpanSeconds(NaN)).toBe("N/A");
  });
});

describe("pegCurrencySymbol", () => {
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

describe("formatUsdPriceAdaptive", () => {
  it("keeps sub-cent USD prices from rounding to a wrong display", () => {
    expect(formatUsdPriceAdaptive(0.0000553)).toBe("0.0000553");
    expect(formatUsdPriceAdaptive(0.0000499)).toBe("0.0000499");
    expect(formatUsdPriceAdaptive(0.0003159)).toBe("0.000316");
    expect(formatUsdPriceAdaptive(0.0010367)).toBe("0.001037");
  });

  it("keeps the established four-decimal display at and above a cent", () => {
    expect(formatUsdPriceAdaptive(1.0002)).toBe("1.0002");
    expect(formatUsdPriceAdaptive(0.089)).toBe("0.0890");
  });

  it("returns N/A for nullish or invalid values", () => {
    expect(formatUsdPriceAdaptive(null)).toBe("N/A");
    expect(formatUsdPriceAdaptive(undefined)).toBe("N/A");
    expect(formatUsdPriceAdaptive(NaN)).toBe("N/A");
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

  it("keeps a positive sub-dollar supply visible instead of rounding it to $0", () => {
    expect(formatCompactUsdOrSubDollar(0.2309)).toBe("<$1");
    expect(formatCompactUsdOrSubDollar(0.999)).toBe("<$1");
    expect(formatCompactUsdOrSubDollar(0)).toBe("$0");
    expect(formatCompactUsdOrSubDollar(1)).toBe("$1");
    expect(formatCompactUsdOrSubDollar(71_571_257.67)).toBe("$71.6M");
    expect(formatCompactUsdOrSubDollar(Number.NaN)).toBe("N/A");
  });
});

