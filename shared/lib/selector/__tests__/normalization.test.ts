import { describe, expect, it } from "vitest";
import {
  bluechip,
  excessApyConcave,
  hhiToDiversity,
  identity,
  invert100,
  pegYieldScore,
  sourceRiskInverted,
  supplyLog,
  yieldVariance,
} from "../normalization";

describe("identity", () => {
  it("passes 72 through", () => expect(identity(72)).toBe(72));
  it("null → null", () => expect(identity(null)).toBeNull());
  it("clamps negatives to 0", () => expect(identity(-5)).toBe(0));
  it("clamps >100 to 100", () => expect(identity(125)).toBe(100));
});

describe("invert100", () => {
  it("30 → 70", () => expect(invert100(30)).toBe(70));
  it("120 → 0 (clamped)", () => expect(invert100(120)).toBe(0));
  it("null → null", () => expect(invert100(null)).toBeNull());
});

describe("pegYieldScore", () => {
  it("clamps PYS above 100", () => expect(pegYieldScore(112)).toBe(100));
  it("null → null", () => expect(pegYieldScore(null)).toBeNull());
});

describe("excessApyConcave", () => {
  it("0 excess → 0", () => expect(excessApyConcave(0)).toBe(0));
  it("2 excess → ~50", () => expect(excessApyConcave(2)).toBeCloseTo(50, 0));
  it("8+ excess → 100", () => {
    expect(excessApyConcave(8)).toBeCloseTo(100, 0);
    expect(excessApyConcave(12)).toBe(100);
  });
  it("negative excess → 0", () => expect(excessApyConcave(-3)).toBe(0));
  it("null → null", () => expect(excessApyConcave(null)).toBeNull());
});

describe("yieldVariance", () => {
  it("0 variance → 100", () => expect(yieldVariance(0)).toBe(100));
  it("2 variance → 50", () => expect(yieldVariance(2)).toBe(50));
  it("4+ → 0", () => expect(yieldVariance(5)).toBe(0));
  it("null → null", () => expect(yieldVariance(null)).toBeNull());
});

describe("sourceRiskInverted", () => {
  it("null → neutral 50", () => expect(sourceRiskInverted(null)).toBe(50));
  it("30 → 70", () => expect(sourceRiskInverted(30)).toBe(70));
  it("80 → 20", () => expect(sourceRiskInverted(80)).toBe(20));
});

describe("supplyLog", () => {
  it("$50B → 100", () => expect(supplyLog(50_000_000_000)).toBe(100));
  // log10(1e9)/log10(5e10) ≈ 0.841 → 84.1
  it("$1B ≈ 84", () => expect(supplyLog(1_000_000_000)).toBeCloseTo(84, 0));
  it("$0 → 0 (log of 1 floor)", () => expect(supplyLog(0)).toBe(0));
  it("null → null", () => expect(supplyLog(null)).toBeNull());

  it("$50B anchor sensitivity: known supply distribution", () => {
    // Document the known property called out in plan §3.3 / 02-data-engine §3.4.
    expect(supplyLog(50_000_000_000)).toBe(100);
    // $10M / $50B → log10(1e7)/log10(5e10) ≈ 0.654 → 65.4
    expect(supplyLog(10_000_000)).toBeCloseTo(65, 0);
  });
});

describe("bluechip ladder", () => {
  it("A → 95", () => expect(bluechip("A")).toBe(95));
  it("A+ → 100", () => expect(bluechip("A+")).toBe(100));
  it("D → 40", () => expect(bluechip("D")).toBe(40));
  it("F → 10", () => expect(bluechip("F")).toBe(10));
  it("null → null", () => expect(bluechip(null)).toBeNull());
});

describe("hhiToDiversity", () => {
  it("hhi=0.25 → 75", () => expect(hhiToDiversity(0.25)).toBe(75));
  it("hhi=1 (mono-DEX) → 0", () => expect(hhiToDiversity(1)).toBe(0));
  it("null → null", () => expect(hhiToDiversity(null)).toBeNull());
});
