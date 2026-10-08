import { describe, expect, it } from "vitest";
import { calculateRawPercentageSumDeviation, normalizeSlicesWithDiagnostics, normalizeSlices, parsePositiveNumericLike, slicesFromValues, sourceKeySlug, valueUsdFromBigIntPrice, worseRisk } from "../slice-math";
import { accumulateBucketedExposure, classifyBucketedValues } from "../classification";
import type { ReserveSlice } from "@shared/types/core";

describe("parsePositiveNumericLike", () => {
  it("keeps decimal amount units without accepting radix text", () => {
    expect(parsePositiveNumericLike("0x10")).toBeNull();
    expect(parsePositiveNumericLike("0b10")).toBeNull();
    expect(parsePositiveNumericLike("0o10")).toBeNull();
    expect(parsePositiveNumericLike(".5")).toBe(0.5);
    expect(parsePositiveNumericLike("1.")).toBe(1);
    expect(parsePositiveNumericLike("+1.5e-2")).toBe(0.015);
    expect(parsePositiveNumericLike("1e309")).toBeNull();
  });

  it("retains the positive-only contract for observed zero, negative, and absent amounts", () => {
    for (const value of [0, "-0", "-0.5", null, undefined]) {
      expect(parsePositiveNumericLike(value)).toBeNull();
    }
  });
});

describe("calculateRawPercentageSumDeviation", () => {
  it.each([0, 0.5, 2, 2.01])("retains raw drift of %s percentage points in either direction", (deviation) => {
    expect(calculateRawPercentageSumDeviation([40, 60 - deviation])).toBeCloseTo(deviation, 12);
    expect(calculateRawPercentageSumDeviation([40, 60 + deviation])).toBeCloseTo(deviation, 12);
  });

  it("keeps zero and positive dust in the source census without normalization repair", () => {
    expect(calculateRawPercentageSumDeviation([0, 99, 0.000001])).toBeCloseTo(0.999999, 12);
    expect(calculateRawPercentageSumDeviation([])).toBe(100);
  });
});

describe("valueUsdFromBigIntPrice", () => {
  it("returns NaN for non-positive or non-finite prices", () => {
    expect(valueUsdFromBigIntPrice(1n, 18, 0)).toBeNaN();
    expect(valueUsdFromBigIntPrice(1n, 18, -1)).toBeNaN();
    expect(valueUsdFromBigIntPrice(1n, 18, Number.NaN)).toBeNaN();
    expect(valueUsdFromBigIntPrice(1n, 18, Number.POSITIVE_INFINITY)).toBeNaN();
  });

  it("computes USD for small balances using direct cast path", () => {
    // 1.5 ETH at $2000/ETH = $3000
    expect(valueUsdFromBigIntPrice(1_500_000_000_000_000_000n, 18, 2000)).toBe(3000);
  });

  it("preserves integer-dollar precision above Number.MAX_SAFE_INTEGER micros (~$9.007B)", () => {
    // 100B tokens at $1 = $100B in USD. That's 1e17 micros, well above MAX_SAFE_INTEGER (~9.007e15).
    // Raw value: 100_000_000_000 tokens with 18 decimals.
    const value = 100_000_000_000n * 10n ** 18n;
    const usd = valueUsdFromBigIntPrice(value, 18, 1);
    expect(usd).toBe(100_000_000_000);
  });

  it("keeps cent-level accuracy for $50B-scale positions", () => {
    // 50,000,000,001.23 USDC (6 decimals) at $1 should equal exactly that.
    // Raw: 50_000_000_001_230_000 micro-USDC (6 decimals).
    const raw = 50_000_000_001_230_000n;
    const usd = valueUsdFromBigIntPrice(raw, 6, 1);
    // usdMicros = 50_000_000_001_230_000 which exceeds MAX_SAFE_INTEGER (~9.007e15).
    expect(usd).toBeCloseTo(50_000_000_001.23, 2);
  });

  it("matches direct-cast result for amounts safely under MAX_SAFE_INTEGER", () => {
    // 1M tokens at $1500 => 1.5e9 USD = 1.5e15 micros, under MAX_SAFE.
    const value = 1_000_000n * 10n ** 18n;
    expect(valueUsdFromBigIntPrice(value, 18, 1500)).toBe(1_500_000_000);
  });

  it("returns 0 for zero balance regardless of decimals or price", () => {
    expect(valueUsdFromBigIntPrice(0n, 18, 1)).toBe(0);
    expect(valueUsdFromBigIntPrice(0n, 6, 100_000)).toBe(0);
    expect(valueUsdFromBigIntPrice(0n, 0, 1)).toBe(0);
  });

  it("handles decimals=0 (whole-unit token) without division-by-zero", () => {
    // 5 units at $1 = $5. Direct path.
    expect(valueUsdFromBigIntPrice(5n, 0, 1)).toBe(5);
  });

  it("returns NaN for invalid or out-of-bound decimals", () => {
    expect(valueUsdFromBigIntPrice(1n, -1, 1)).toBeNaN();
    expect(valueUsdFromBigIntPrice(1n, 1.5, 1)).toBeNaN();
    expect(valueUsdFromBigIntPrice(1n, 37, 1)).toBeNaN();
    expect(valueUsdFromBigIntPrice(1n, Number.MAX_SAFE_INTEGER + 1, 1)).toBeNaN();
  });

  it("returns price exactly when 1 whole token × price stays representable", () => {
    // 1_000_000n raw at 6 decimals = 1 token. At a Number.MAX_SAFE_INTEGER
    // price, USD = MAX_SAFE_INTEGER which is itself exactly representable.
    // This exercises the two-stage divide path at the upper representable edge
    // — both branches must converge on the same integer.
    const price = Number.MAX_SAFE_INTEGER;
    expect(valueUsdFromBigIntPrice(1_000_000n, 6, price)).toBe(price);
  });
});

describe("worseRisk", () => {
  it("retains the higher-risk exposure regardless of merge order", () => {
    expect(worseRisk("low", "high")).toBe("high");
    expect(worseRisk("high", "low")).toBe("high");
  });
});

describe("reserve identity and input integrity", () => {
  it("preserves positive sub-six-decimal shares and merges identical rows without repairing source drift", () => {
    const dust: ReserveSlice = { sourceKey: "dust", name: "Dust", risk: "low", coinId: "usdc-circle", depType: "collateral", pct: 1e-12 };
    const slices = normalizeSlices([
      { name: "Main", risk: "low", pct: 99 },
      dust,
      dust,
      { name: "Zero", risk: "low", pct: 0 },
    ], null);
    expect(slices.find((slice) => slice.sourceKey === "dust")?.pct).toBe(2e-12);
    expect(slices.find((slice) => slice.name === "Main")?.pct).toBe(99);
    expect(slices.find((slice) => slice.name === "Zero")).toBeUndefined();
    expect(() => normalizeSlices([{ ...dust, pct: -1 }], null)).toThrow(/invalid value/);
    expect(() => normalizeSlices([{ ...dust, pct: 80 }], null)).toThrow(/sum/);
  });

  it("preserves tiny positive values through bucket aggregation", () => {
    const values = [{ name: "Main", value: 1e9 }, { name: "Dust", value: 1e-6 }, { name: "Zero", value: 0 }];
    const slices = slicesFromValues(values.map((value) => ({ ...value, risk: "low" as const })), null);
    expect(slices.find((slice) => slice.name === "Dust")?.pct).toBe(1e-6 / (1e9 + 1e-6) * 100);
    expect(slices.find((slice) => slice.name === "Zero")).toBeUndefined();
    const classified = classifyBucketedValues({
      items: values,
      rules: [
        { key: "main", name: "Main", risk: "low", match: (item: typeof values[number]) => item.name === "Main" },
        { key: "dust", name: "Dust", risk: "low", match: (item: typeof values[number]) => item.name === "Dust" },
      ],
      getValue: (item) => item.value,
      getUnknownLabel: (item) => item.name,
      decimals: null,
    });
    expect(classified.slices.find((slice) => slice.name === "Dust")?.pct).toBe(1e-6 / (1e9 + 1e-6) * 100);
  });

  it("keeps every distinct scoring identity separate", () => {
    const base: ReserveSlice = { name: "Bond", risk: "low", pct: 50 };
    const identities: Partial<ReserveSlice>[] = [
      { sourceKey: "second" }, { assetClass: "public-credit" },
      { issuerOrObligor: "second issuer" }, { coinId: "usdc-circle" }, { depType: "wrapper" },
    ];
    for (const identity of identities) {
      expect(normalizeSlices([base, { ...base, ...identity }])).toEqual([base, { ...base, ...identity }]);
    }
  });

  it("retains source drift independently of repaired rounding", () => {
    const result = normalizeSlicesWithDiagnostics([{ name: "Cash", risk: "low", pct: 99 }]);
    expect(result.rawSumDeviation).toBe(1);
    expect(result.slices[0].pct).toBe(100);
  });

  it("rejects malformed exposure before either classifier can hide it", () => {
    for (const badValue of [NaN, Infinity, -100]) {
      const items = [100, badValue];
      expect(() => accumulateBucketedExposure({
        items, getValue: (value) => value, getBucket: () => "cash",
      })).toThrow(/invalid value/);
      expect(() => classifyBucketedValues({
        items, getValue: (value) => value, getUnknownLabel: String,
        rules: [{ key: "cash", name: "Cash", risk: "low", match: () => true }],
      })).toThrow(/invalid value/);
    }
  });
});

describe("sourceKeySlug", () => {
  it("folds provider labels into schema-valid sourceKey suffixes", () => {
    const schemaPattern = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._:/-]*$/;
    const cases: Array<[string, string]> = [
      ["Fraxswap V2 FRAX/FPIS", "fraxswap-v2-frax-fpis"],
      ["cowswap-fxSave", "cowswap-fxsave"],
      ["morpho-steakUSDCinfinifi", "morpho-steakusdcinfinifi"],
      ["a  b//c", "a-b-c"],
    ];
    for (const [raw, expected] of cases) {
      expect(sourceKeySlug(raw)).toBe(expected);
      expect(schemaPattern.test(`adapter:${sourceKeySlug(raw)}`)).toBe(true);
    }
  });
});
