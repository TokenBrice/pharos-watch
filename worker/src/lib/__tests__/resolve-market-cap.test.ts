import { describe, it, expect } from "vitest";
import { resolveMarketCap } from "../resolve-market-cap";

describe("resolveMarketCap", () => {
  it("returns cgMcap when values agree within threshold", () => {
    // supply=3.7M oz × $97.95/oz = ~$364.4M computed, cgMcap=$364M (within 20%)
    expect(resolveMarketCap(364_000_000, 3_721_963, 97.95)).toBe(364_000_000);
  });

  it("returns computed when cgMcap is frozen/corrupt (KAG scenario)", () => {
    // Real case: supply=3.7M, price=$97.95, cgMcap frozen at $16.4M (~95% divergence)
    const result = resolveMarketCap(16_405_596, 3_721_963, 97.95);
    expect(result).toBeCloseTo(3_721_963 * 97.95, -3);
  });

  it("returns computed when cgMcap is undefined", () => {
    expect(resolveMarketCap(undefined, 3_721_963, 97.95)).toBeCloseTo(
      3_721_963 * 97.95,
      -3
    );
  });

  it("returns cgMcap when circulatingSupply is undefined", () => {
    expect(resolveMarketCap(364_000_000, undefined, 97.95)).toBe(364_000_000);
  });

  it("returns 0 when both cgMcap and circulatingSupply are undefined", () => {
    expect(resolveMarketCap(undefined, undefined, 97.95)).toBe(0);
  });

  it("returns cgMcap when price is zero (cannot compute)", () => {
    expect(resolveMarketCap(364_000_000, 3_721_963, 0)).toBe(364_000_000);
  });

  it("respects the divergenceThreshold parameter", () => {
    // 8% divergence: within 20% default → use cgMcap; above 5% custom → use computed
    const cgMcap = 100_000;
    const supply = 1_000;
    const price = 108; // computed = 108_000, divergence ≈ 8%
    expect(resolveMarketCap(cgMcap, supply, price, 0.20)).toBe(cgMcap);
    expect(resolveMarketCap(cgMcap, supply, price, 0.05)).toBeCloseTo(108_000, -3);
  });

  it("returns 0 when cgMcap is zero and no supply provided", () => {
    expect(resolveMarketCap(0, undefined, 97.95)).toBe(0);
  });
});
