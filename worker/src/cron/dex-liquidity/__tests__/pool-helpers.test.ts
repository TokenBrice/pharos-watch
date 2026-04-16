import { describe, it, expect } from "vitest";
import { classifyPoolType, normalizeProtocol } from "../pool-helpers";

describe("normalizeProtocol", () => {
  it("collapses hyphenated PancakeSwap variants", () => {
    expect(normalizeProtocol("pancake-swap-v3")).toBe("pancakeswap");
    expect(normalizeProtocol("pancakeswap-v3")).toBe("pancakeswap");
    expect(normalizeProtocol("pancake_swap_v3")).toBe("pancakeswap");
  });
  it("collapses hyphenated Uniswap variants", () => {
    expect(normalizeProtocol("uni-v3")).toBe("uniswap-v3");
    expect(normalizeProtocol("uniswap-v3")).toBe("uniswap-v3");
  });
});

describe("classifyPoolType ordering", () => {
  it("classifies aerodrome-slipstream before the generic aerodrome branch", () => {
    expect(classifyPoolType("aerodrome-slipstream")).toBe("aerodrome-slipstream-5bp");
    expect(classifyPoolType("aerodrome-slipstream-base")).toBe("aerodrome-slipstream-5bp");
    expect(classifyPoolType("velodrome-slipstream")).toBe("velodrome-slipstream-5bp");
    expect(classifyPoolType("aerodrome")).toBe("aerodrome-volatile");
  });
});
