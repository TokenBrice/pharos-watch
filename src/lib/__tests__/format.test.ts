import { describe, it, expect } from "vitest";
import {
  formatCurrency,
  formatBps,
  formatPegDeviation,
  formatPercentChange,
  formatSupply,
  formatAddress,
  formatDuration,
  formatNativePrice,
  formatDeathDate,
  formatDeathDateShort,
} from "@shared/lib/format";

// ---------------------------------------------------------------------------
// formatCurrency
// ---------------------------------------------------------------------------
describe("formatCurrency", () => {
  it("formats trillions", () => {
    expect(formatCurrency(1.5e12)).toBe("$1.50T");
    expect(formatCurrency(1e12)).toBe("$1.00T");
  });

  it("formats billions", () => {
    expect(formatCurrency(1.23e9)).toBe("$1.23B");
    expect(formatCurrency(1e9)).toBe("$1.00B");
  });

  it("formats millions", () => {
    expect(formatCurrency(456e6)).toBe("$456.00M");
    expect(formatCurrency(1e6)).toBe("$1.00M");
  });

  it("formats thousands", () => {
    expect(formatCurrency(1e3)).toBe("$1.00K");
    expect(formatCurrency(999_999)).toBe("$1000.00K");
  });

  it("formats small values", () => {
    expect(formatCurrency(0)).toBe("$0.00");
    expect(formatCurrency(500)).toBe("$500.00");
    expect(formatCurrency(999)).toBe("$999.00");
  });

  it("formats negative values", () => {
    expect(formatCurrency(-1.5e9)).toBe("-$1.50B");
    expect(formatCurrency(-500)).toBe("-$500.00");
  });

  it("returns N/A for NaN and Infinity", () => {
    expect(formatCurrency(NaN)).toBe("N/A");
    expect(formatCurrency(Infinity)).toBe("N/A");
    expect(formatCurrency(-Infinity)).toBe("N/A");
  });

  it("respects custom decimals", () => {
    expect(formatCurrency(1.23e9, 0)).toBe("$1B");
    expect(formatCurrency(1.23e9, 4)).toBe("$1.2300B");
  });

  // Boundary tests
  it("handles exact tier boundaries", () => {
    expect(formatCurrency(1_000)).toBe("$1.00K");
    expect(formatCurrency(1_000_000)).toBe("$1.00M");
    expect(formatCurrency(1_000_000_000)).toBe("$1.00B");
    expect(formatCurrency(1_000_000_000_000)).toBe("$1.00T");
  });
});

// ---------------------------------------------------------------------------
// formatBps
// ---------------------------------------------------------------------------
describe("formatBps", () => {
  it("formats positive bps with + sign", () => {
    expect(formatBps(12)).toBe("+12 bps");
  });

  it("formats negative bps", () => {
    expect(formatBps(-5)).toBe("-5 bps");
  });

  it("formats zero bps", () => {
    expect(formatBps(0)).toBe("+0 bps");
  });
});

// ---------------------------------------------------------------------------
// formatPegDeviation
// ---------------------------------------------------------------------------
describe("formatPegDeviation", () => {
  it("formats a price exactly at peg as +0 bps", () => {
    expect(formatPegDeviation(1.0)).toBe("+0 bps");
  });

  it("formats a price above peg", () => {
    expect(formatPegDeviation(1.001)).toBe("+10 bps");
  });

  it("formats a price below peg", () => {
    expect(formatPegDeviation(0.999)).toBe("-10 bps");
  });

  it("supports custom pegValue", () => {
    // EUR peg: USD price of 1 EUR ~= 1.10
    expect(formatPegDeviation(1.10, 1.10)).toBe("+0 bps");
    expect(formatPegDeviation(1.11, 1.10)).toBe("+91 bps");
  });

  it("returns N/A for null/undefined/NaN", () => {
    expect(formatPegDeviation(null)).toBe("N/A");
    expect(formatPegDeviation(undefined)).toBe("N/A");
    expect(formatPegDeviation(NaN)).toBe("N/A");
  });

  it("returns N/A when pegValue is 0", () => {
    expect(formatPegDeviation(1.0, 0)).toBe("N/A");
  });
});

// ---------------------------------------------------------------------------
// formatPercentChange
// ---------------------------------------------------------------------------
describe("formatPercentChange", () => {
  it("formats positive change", () => {
    expect(formatPercentChange(112.5, 100)).toBe("+12.50%");
  });

  it("formats negative change", () => {
    expect(formatPercentChange(90, 100)).toBe("-10.00%");
  });

  it("formats no change", () => {
    expect(formatPercentChange(100, 100)).toBe("+0.00%");
  });

  it("returns N/A when previous is 0 (div-by-zero)", () => {
    expect(formatPercentChange(100, 0)).toBe("N/A");
  });
});

// ---------------------------------------------------------------------------
// formatSupply
// ---------------------------------------------------------------------------
describe("formatSupply", () => {
  it("formats large supply values with tier suffixes", () => {
    expect(formatSupply(1.23e9)).toBe("1.23B");
    expect(formatSupply(456e6)).toBe("456.00M");
    expect(formatSupply(1e12)).toBe("1.00T");
  });

  it("formats thousands", () => {
    expect(formatSupply(1e3)).toBe("1.00K");
  });

  it("formats small numbers without suffix", () => {
    expect(formatSupply(500)).toBe("500");
    expect(formatSupply(0)).toBe("0");
  });

  it("returns N/A for NaN and Infinity", () => {
    expect(formatSupply(NaN)).toBe("N/A");
    expect(formatSupply(Infinity)).toBe("N/A");
    expect(formatSupply(-Infinity)).toBe("N/A");
  });
});

// ---------------------------------------------------------------------------
// formatAddress
// ---------------------------------------------------------------------------
describe("formatAddress", () => {
  it("truncates long addresses to 6+4 with ellipsis", () => {
    expect(formatAddress("0xab1234567890cdef1234567890cdef1234567890")).toBe(
      "0xab12...7890"
    );
  });

  it("returns short addresses unchanged", () => {
    expect(formatAddress("0x1234")).toBe("0x1234");
    expect(formatAddress("123456789012")).toBe("123456789012"); // exactly 12 chars
  });

  it("truncates addresses longer than 12 chars", () => {
    expect(formatAddress("1234567890123")).toBe("123456...0123");
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------
describe("formatDuration", () => {
  it('returns "Ongoing" when endSec is null', () => {
    expect(formatDuration(1000, null)).toBe("Ongoing");
  });

  it('returns "< 1m" for durations under 60 seconds', () => {
    expect(formatDuration(0, 30)).toBe("< 1m");
    expect(formatDuration(0, 59)).toBe("< 1m");
  });

  it("returns N/A for negative durations", () => {
    expect(formatDuration(100, 50)).toBe("N/A");
  });

  it("formats minutes only", () => {
    expect(formatDuration(0, 45 * 60)).toBe("45m");
  });

  it("formats exactly 1 hour", () => {
    expect(formatDuration(0, 3600)).toBe("1h");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(0, 14 * 3600 + 30 * 60)).toBe("14h 30m");
  });

  it("formats days and hours", () => {
    expect(formatDuration(0, 2 * 86400 + 5 * 3600)).toBe("2d 5h");
  });

  it("formats days without hours", () => {
    expect(formatDuration(0, 3 * 86400)).toBe("3d");
  });

  it("formats zero duration", () => {
    expect(formatDuration(100, 100)).toBe("< 1m");
  });
});

// ---------------------------------------------------------------------------
// formatNativePrice
// ---------------------------------------------------------------------------
describe("formatNativePrice", () => {
  it("formats USD-pegged price as USD", () => {
    expect(formatNativePrice(1.0001, "USD", 1)).toBe("$1.0001");
  });

  it("formats EUR-pegged price converting via pegRef", () => {
    // USD price 1.10, pegRef (1 EUR in USD) = 1.10 => native = 1.0000
    const result = formatNativePrice(1.10, "EUR", 1.10);
    // Should start with EUR symbol and end with 1.0000
    expect(result).toContain("1.0000");
    expect(result).not.toBe("N/A");
  });

  it("returns N/A for null/undefined/NaN", () => {
    expect(formatNativePrice(null, "USD", 1)).toBe("N/A");
    expect(formatNativePrice(undefined, "EUR", 1.10)).toBe("N/A");
    expect(formatNativePrice(NaN, "USD", 1)).toBe("N/A");
  });

  it("falls back to USD formatting when pegRef is 0 or negative", () => {
    expect(formatNativePrice(1.0001, "EUR", 0)).toBe("$1.0001");
    expect(formatNativePrice(1.0001, "EUR", -1)).toBe("$1.0001");
  });

  it("formats GOLD/SILVER/VAR/OTHER as USD", () => {
    expect(formatNativePrice(3200, "GOLD", 3200)).toBe("$3200.0000");
    expect(formatNativePrice(25, "SILVER", 25)).toBe("$25.0000");
    expect(formatNativePrice(1.0, "VAR", 1)).toBe("$1.0000");
    expect(formatNativePrice(1.0, "OTHER", 1)).toBe("$1.0000");
  });
});

// ---------------------------------------------------------------------------
// formatDeathDate
// ---------------------------------------------------------------------------
describe("formatDeathDate", () => {
  it('formats "YYYY-MM" as "Mon YYYY"', () => {
    expect(formatDeathDate("2023-01")).toBe("Jan 2023");
    expect(formatDeathDate("2024-12")).toBe("Dec 2024");
  });

  it("returns year only if no month", () => {
    expect(formatDeathDate("2023")).toBe("2023");
  });
});

// ---------------------------------------------------------------------------
// formatDeathDateShort
// ---------------------------------------------------------------------------
describe("formatDeathDateShort", () => {
  it("formats with short year", () => {
    // Node's toLocaleDateString with year: "2-digit" may or may not include an apostrophe
    const jan23 = formatDeathDateShort("2023-01");
    expect(jan23).toMatch(/^Jan.+23$/);
    const dec24 = formatDeathDateShort("2024-12");
    expect(dec24).toMatch(/^Dec.+24$/);
  });

  it("returns year only if no month", () => {
    expect(formatDeathDateShort("2023")).toBe("2023");
  });
});
