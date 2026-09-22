import { describe, expect, it } from "vitest";
import { MINT_BURN_CONFIG_SPECS } from "../mint-burn-contracts-data";
import { isCanonicalMintBurnPair } from "../mint-burn-canonical-chain";

const NON_ETHEREUM_CANONICAL_CHAIN_EXCEPTIONS: Record<string, string> = {};

describe("isCanonicalMintBurnPair", () => {
  it("USDai canonical chain is arbitrum", () => {
    expect(isCanonicalMintBurnPair("usdai-usd-ai", "arbitrum")).toBe(true);
    expect(isCanonicalMintBurnPair("usdai-usd-ai", "ethereum")).toBe(false);
  });

  it("maps every configured non-Ethereum-only stablecoin to a canonical chain", () => {
    const chainIdsByStablecoin = new Map<string, Set<string>>();
    for (const spec of MINT_BURN_CONFIG_SPECS) {
      const chainIds = chainIdsByStablecoin.get(spec.stablecoinId) ?? new Set<string>();
      chainIds.add(spec.chain.chainId);
      chainIdsByStablecoin.set(spec.stablecoinId, chainIds);
    }

    for (const [stablecoinId, chainIds] of chainIdsByStablecoin) {
      if (chainIds.has("ethereum") || stablecoinId in NON_ETHEREUM_CANONICAL_CHAIN_EXCEPTIONS) continue;
      expect(
        [...chainIds].some((chainId) => isCanonicalMintBurnPair(stablecoinId, chainId)),
        `${stablecoinId} needs a canonical-chain mapping or documented exception`,
      ).toBe(true);
    }
  });

  it("defaults to ethereum for unspecified coins", () => {
    expect(isCanonicalMintBurnPair("usdc-circle", "ethereum")).toBe(true);
    expect(isCanonicalMintBurnPair("usdc-circle", "arbitrum")).toBe(false);
  });

  it("handles unknown stablecoin ID gracefully", () => {
    expect(isCanonicalMintBurnPair("nonexistent", "ethereum")).toBe(true);
  });
});
