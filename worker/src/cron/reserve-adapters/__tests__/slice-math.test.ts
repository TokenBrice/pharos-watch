import { describe, expect, it } from "vitest";
import { valueUsdFromBigIntPrice } from "../slice-math";

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

  it("returns price exactly when 1 whole token × price stays representable", () => {
    // 1_000_000n raw at 6 decimals = 1 token. At a Number.MAX_SAFE_INTEGER
    // price, USD = MAX_SAFE_INTEGER which is itself exactly representable.
    // This exercises the two-stage divide path at the upper representable edge
    // — both branches must converge on the same integer.
    const price = Number.MAX_SAFE_INTEGER;
    expect(valueUsdFromBigIntPrice(1_000_000n, 6, price)).toBe(price);
  });
});
