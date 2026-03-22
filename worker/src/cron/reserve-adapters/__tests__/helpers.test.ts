import { describe, expect, it } from "vitest";
import { getAdapterTimeout, isReserveRisk, normalizeSlices, slicesFromValues } from "../helpers";
import type { LiveReservesConfig, ReserveSlice } from "@shared/types";

describe("normalizeSlices", () => {
  it("rounds to integers by default and adjusts largest to sum to 100", () => {
    const slices: ReserveSlice[] = [
      { name: "A", pct: 33.3, risk: "low" },
      { name: "B", pct: 33.3, risk: "medium" },
      { name: "C", pct: 33.3, risk: "high" },
    ];
    const result = normalizeSlices(slices);
    const sum = result.reduce((acc, s) => acc + s.pct, 0);
    expect(sum).toBe(100);
    expect(result[0].pct).toBe(34);
  });

  it("rounds to 1 decimal place when decimals=1", () => {
    const slices: ReserveSlice[] = [
      { name: "A", pct: 33.33, risk: "low" },
      { name: "B", pct: 33.33, risk: "medium" },
      { name: "C", pct: 33.33, risk: "high" },
    ];
    const result = normalizeSlices(slices, 1);
    const sum = result.reduce((acc, s) => acc + s.pct, 0);
    expect(sum).toBeCloseTo(100.0, 1);
  });

  it("deduplicates slices with the same name|risk|coinId|depType key", () => {
    const slices: ReserveSlice[] = [
      { name: "USDC", pct: 30, risk: "low", coinId: "usd-coin" },
      { name: "USDC", pct: 20, risk: "low", coinId: "usd-coin" },
      { name: "T-Bills", pct: 50, risk: "very-low" },
    ];
    const result = normalizeSlices(slices);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.name === "USDC")?.pct).toBe(50);
    expect(result.find((s) => s.name === "T-Bills")?.pct).toBe(50);
  });

  it("filters zero and negative slices", () => {
    const slices: ReserveSlice[] = [
      { name: "A", pct: 0, risk: "low" },
      { name: "B", pct: -5, risk: "medium" },
      { name: "C", pct: 100, risk: "high" },
    ];
    const result = normalizeSlices(slices);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("C");
    expect(result[0].pct).toBe(100);
  });

  it("returns empty for empty input", () => {
    expect(normalizeSlices([])).toEqual([]);
  });

  it("sorts descending by pct", () => {
    const slices: ReserveSlice[] = [
      { name: "Small", pct: 10, risk: "low" },
      { name: "Large", pct: 60, risk: "medium" },
      { name: "Mid", pct: 30, risk: "high" },
    ];
    const result = normalizeSlices(slices);
    expect(result.map((s) => s.name)).toEqual(["Large", "Mid", "Small"]);
  });
});

describe("slicesFromValues", () => {
  it("converts values to percentage slices summing to 100", () => {
    const result = slicesFromValues([
      { value: 700, name: "A", risk: "low" },
      { value: 300, name: "B", risk: "medium" },
    ]);
    expect(result.find((s) => s.name === "A")?.pct).toBe(70);
    expect(result.find((s) => s.name === "B")?.pct).toBe(30);
    const sum = result.reduce((acc, s) => acc + s.pct, 0);
    expect(sum).toBe(100);
  });

  it("filters zero and negative values", () => {
    const result = slicesFromValues([
      { value: 0, name: "Zero", risk: "low" },
      { value: -10, name: "Neg", risk: "medium" },
      { value: 100, name: "Valid", risk: "high" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Valid");
    expect(result[0].pct).toBe(100);
  });

  it("returns empty for all-zero input", () => {
    const result = slicesFromValues([
      { value: 0, name: "A", risk: "low" },
      { value: 0, name: "B", risk: "medium" },
    ]);
    expect(result).toEqual([]);
  });

  it("preserves coinId and depType", () => {
    const result = slicesFromValues([
      { value: 50, name: "USDC", risk: "low", coinId: "usd-coin", depType: "collateral" },
      { value: 50, name: "DAI", risk: "medium", coinId: "dai" },
    ]);
    const usdc = result.find((s) => s.name === "USDC");
    expect(usdc?.coinId).toBe("usd-coin");
    expect(usdc?.depType).toBe("collateral");
    const dai = result.find((s) => s.name === "DAI");
    expect(dai?.coinId).toBe("dai");
    expect(dai?.depType).toBeUndefined();
  });

  it("rounds to 1 decimal by default (three equal values sum to 100.0)", () => {
    const result = slicesFromValues([
      { value: 100, name: "A", risk: "low" },
      { value: 100, name: "B", risk: "medium" },
      { value: 100, name: "C", risk: "high" },
    ]);
    const sum = result.reduce((acc, s) => acc + s.pct, 0);
    expect(sum).toBeCloseTo(100.0, 1);
  });
});

describe("isReserveRisk", () => {
  it("returns true for all 5 valid risk values", () => {
    expect(isReserveRisk("very-low")).toBe(true);
    expect(isReserveRisk("low")).toBe(true);
    expect(isReserveRisk("medium")).toBe(true);
    expect(isReserveRisk("high")).toBe(true);
    expect(isReserveRisk("very-high")).toBe(true);
  });

  it("returns false for invalid values", () => {
    expect(isReserveRisk("lo")).toBe(false);
    expect(isReserveRisk("")).toBe(false);
    expect(isReserveRisk(null)).toBe(false);
    expect(isReserveRisk(undefined)).toBe(false);
    expect(isReserveRisk(42)).toBe(false);
  });
});

describe("getAdapterTimeout", () => {
  const baseConfig = {
    adapter: "single-asset",
    version: 1,
    semantics: "single-asset" as const,
    inputs: { primary: { kind: "http-json" as const, url: "https://example.com" } },
  } satisfies LiveReservesConfig;

  it("returns params.timeoutMs when set", () => {
    expect(getAdapterTimeout({ ...baseConfig, params: { timeoutMs: 15_000 } })).toBe(15_000);
  });

  it("returns fallback when params.timeoutMs is not set", () => {
    expect(getAdapterTimeout(baseConfig, 12_000)).toBe(12_000);
  });

  it("returns default 10s when no fallback specified", () => {
    expect(getAdapterTimeout(baseConfig)).toBe(10_000);
  });

  it("ignores non-positive or oversized timeoutMs", () => {
    expect(getAdapterTimeout({ ...baseConfig, params: { timeoutMs: -1 } })).toBe(10_000);
    expect(getAdapterTimeout({ ...baseConfig, params: { timeoutMs: 60_000 } })).toBe(10_000);
    expect(getAdapterTimeout({ ...baseConfig, params: { timeoutMs: 0 } })).toBe(10_000);
  });

  it("ignores non-numeric timeoutMs", () => {
    expect(getAdapterTimeout({ ...baseConfig, params: { timeoutMs: "fast" } })).toBe(10_000);
  });
});
