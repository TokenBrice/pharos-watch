import { describe, expect, it } from "vitest";
import {
  formatCompactCount,
  formatDeathDate,
  formatNativePrice,
  formatTrackingSpanDays,
  formatTrackingSpanSeconds,
} from "@shared/lib/format";

describe("formatCompactCount", () => {
  it("formats large counts with a compact k suffix", () => {
    expect(formatCompactCount(1_500)).toBe("1.5k");
    expect(formatCompactCount(1_000)).toBe("1k");
    expect(formatCompactCount(999)).toBe("999");
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

  it("returns N/A for nullish or NaN values", () => {
    expect(formatNativePrice(null, "USD", 1)).toBe("N/A");
    expect(formatNativePrice(undefined, "EUR", 1.10)).toBe("N/A");
    expect(formatNativePrice(NaN, "USD", 1)).toBe("N/A");
  });

  it("falls back to USD formatting when pegRef is invalid", () => {
    expect(formatNativePrice(1.0001, "EUR", 0)).toBe("$1.0001");
    expect(formatNativePrice(1.0001, "EUR", -1)).toBe("$1.0001");
  });

  it("formats non-fiat pegs as USD", () => {
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
