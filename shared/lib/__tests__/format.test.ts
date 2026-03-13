import { describe, expect, it } from "vitest";

import { formatScore, formatApy, formatChartDate, formatPercent, formatSignedPercent, formatElapsedSeconds } from "../format";

describe("formatScore", () => {
  it("formats to one decimal", () => expect(formatScore(72.456)).toBe("72.5"));
  it("handles zero", () => expect(formatScore(0)).toBe("0.0"));
  it("handles 100", () => expect(formatScore(100)).toBe("100.0"));
  it("returns dash for null", () => expect(formatScore(null)).toBe("-"));
  it("returns dash for undefined", () => expect(formatScore(undefined)).toBe("-"));
});

describe("formatApy", () => {
  it("formats to two decimals with %", () => expect(formatApy(4.567)).toBe("4.57%"));
  it("handles zero", () => expect(formatApy(0)).toBe("0.00%"));
  it("handles negative", () => expect(formatApy(-1.5)).toBe("-1.50%"));
  it("returns dash for null", () => expect(formatApy(null)).toBe("-"));
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
