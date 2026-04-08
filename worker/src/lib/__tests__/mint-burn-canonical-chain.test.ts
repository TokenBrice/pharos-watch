import { describe, expect, it } from "vitest";
import { isCanonicalMintBurnPair } from "../mint-burn-canonical-chain";

describe("isCanonicalMintBurnPair", () => {
  it("USDai canonical chain is arbitrum", () => {
    expect(isCanonicalMintBurnPair("usdai-usd-ai", "arbitrum")).toBe(true);
    expect(isCanonicalMintBurnPair("usdai-usd-ai", "ethereum")).toBe(false);
  });

  it("defaults to ethereum for unspecified coins", () => {
    expect(isCanonicalMintBurnPair("usdc-circle", "ethereum")).toBe(true);
    expect(isCanonicalMintBurnPair("usdc-circle", "arbitrum")).toBe(false);
  });

  it("handles unknown stablecoin ID gracefully", () => {
    expect(isCanonicalMintBurnPair("nonexistent", "ethereum")).toBe(true);
  });
});
