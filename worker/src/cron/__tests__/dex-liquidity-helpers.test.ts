import { describe, it, expect } from "vitest";
import {
  parsePoolSymbols,
  classifyPoolType,
  getQualityMultiplier,
} from "../dex-liquidity/pool-helpers";

describe("parsePoolSymbols", () => {
  it("splits hyphenated pairs", () => {
    expect(parsePoolSymbols("USDT-USDC")).toEqual(["USDT", "USDC"]);
  });

  it("splits slash-separated pairs", () => {
    expect(parsePoolSymbols("USDT/USDC")).toEqual(["USDT", "USDC"]);
  });

  it("handles single token", () => {
    expect(parsePoolSymbols("USDT")).toEqual(["USDT"]);
  });

  it("handles triple pools", () => {
    const result = parsePoolSymbols("USDT-USDC-DAI");
    expect(result).toEqual(["USDT", "USDC", "DAI"]);
  });
});

describe("classifyPoolType", () => {
  it("classifies Curve pools", () => {
    expect(classifyPoolType("curve-dex")).toBe("curve-stableswap");
    expect(classifyPoolType("curve")).toBe("curve-stableswap");
  });

  it("classifies Uniswap V3 pools", () => {
    expect(classifyPoolType("uniswap-v3")).toBe("uniswap-v3-5bp");
  });

  it("classifies Balancer pools", () => {
    expect(classifyPoolType("balancer-stable")).toBe("balancer-stable");
    expect(classifyPoolType("balancer-v2")).toBe("balancer-weighted");
  });

  it("classifies Aerodrome pools", () => {
    expect(classifyPoolType("aerodrome")).toBe("aerodrome-volatile");
  });

  it("classifies Fluid DEX pools", () => {
    expect(classifyPoolType("fluid-dex")).toBe("fluid-dex");
  });

  it("returns generic for unknown projects", () => {
    expect(classifyPoolType("unknown-dex")).toBe("generic");
  });
});

describe("getQualityMultiplier", () => {
  it("returns a defined multiplier for generic pools", () => {
    const result = getQualityMultiplier("generic");
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it("returns higher multiplier for curve stableswap with high A", () => {
    const highA = getQualityMultiplier("curve-stableswap", 1500);
    const lowA = getQualityMultiplier("curve-stableswap", 100);
    expect(highA).toBeGreaterThan(lowA);
  });

  it("returns multiplier without curveA for non-curve types", () => {
    const result = getQualityMultiplier("uniswap-v3-5bp");
    expect(result).toBeGreaterThan(0);
  });
});
