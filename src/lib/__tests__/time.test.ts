import { describe, expect, it } from "vitest";
import { toTimestampMs } from "../time";

describe("toTimestampMs", () => {
  it("scales epoch seconds to milliseconds", () => {
    expect(toTimestampMs(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("passes through epoch milliseconds unchanged", () => {
    expect(toTimestampMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("parses numeric strings as epoch seconds", () => {
    expect(toTimestampMs("1700000000")).toBe(1_700_000_000_000);
  });

  it("keeps the 10^10 unit boundary and accepts signed/decimal numeric text", () => {
    expect(toTimestampMs(9_999_999_999)).toBe(9_999_999_999_000);
    expect(toTimestampMs(10_000_000_000)).toBe(10_000_000_000);
    expect(toTimestampMs("-1.5")).toBe(-1_500);
    expect(toTimestampMs("+1700000000")).toBe(1_700_000_000_000);
  });

  it("parses ISO date strings", () => {
    expect(toTimestampMs("2023-11-14T22:13:20.000Z")).toBe(1_700_000_000_000);
  });

  it("returns NaN for unparseable values", () => {
    expect(toTimestampMs("not-a-date")).toBeNaN();
    expect(toTimestampMs(null)).toBeNaN();
    expect(toTimestampMs(undefined)).toBeNaN();
    expect(toTimestampMs("")).toBeNaN();
  });
});
