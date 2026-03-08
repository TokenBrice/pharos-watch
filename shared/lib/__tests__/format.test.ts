import { describe, expect, it } from "vitest";

import { formatScore, formatApy, formatChartDate } from "../format";

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
