import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import {
  parsePoolSymbols,
  classifyPoolType,
  getQualityMultiplier,
  getPairQuality,
  computePoolPairQuality,
  getTrackedContracts,
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

  it("normalizes known quote aliases", () => {
    expect(parsePoolSymbols("USDH-USD₮0")).toEqual(["USDH", "USDT"]);
    expect(parsePoolSymbols("HOLLAR / AUSDC")).toEqual(["HOLLAR", "USDC"]);
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

describe("pair-quality normalization", () => {
  it("treats trusted quote aliases like their canonical stablecoin", () => {
    expect(getPairQuality("USD₮0")).toBe(1);
    expect(getPairQuality("AUSDC")).toBe(1);
  });

  it("uses normalized quote aliases in pool pair quality", () => {
    expect(computePoolPairQuality(["HOLLAR", "AUSDT"], "HOLLAR")).toBe(1);
  });
});

describe("getTrackedContracts", () => {
  it("includes traded contract metadata alongside canonical deployments", () => {
    const usdt = TRACKED_STABLECOINS.find((meta) => meta.id === "usdt-tether");
    const trackedContracts = getTrackedContracts(usdt!);
    expect(
      trackedContracts.some(
        (contract) =>
          contract.chain === "optimism" &&
          contract.address.toLowerCase() === "0x01bff41798a0bcf287b996046ca68b395dbc1071",
      ),
    ).toBe(true);
  });
});
