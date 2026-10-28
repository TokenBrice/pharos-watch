import { describe, expect, it } from "vitest";
import { MINT_BURN_CONFIG_SPECS } from "../mint-burn-contracts-data";
import { isCanonicalMintBurnPair } from "../mint-burn-canonical-chain";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { buildChainRpcs, getRpcAuth } from "../chain-registry";
import { mintBurnRpcEndpoints } from "../mint-burn-pipeline/rpc";
import { DWELLIR_CHAINS } from "@shared/lib/dwellir-chains";

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

  it("inventories finality capabilities and header authentication for every enabled issuance chain", () => {
    const chainRpcs = buildChainRpcs("alchemy-test", undefined, { dwellirApiKey: "dwellir-test" });
    const chains = new Set(MINT_BURN_CONFIGS.filter(config => config.enabled !== false).map(config => config.chain.chainId));
    expect(chains.size).toBeGreaterThan(0);
    for (const chain of chains) {
      const endpoints = mintBurnRpcEndpoints(chain, "alchemy-test", chainRpcs);
      if (chain === "tron") {
        expect(endpoints).toEqual([]); // Solidified native-reader admission is tested separately.
        continue;
      }
      expect(endpoints.length, `${chain} needs admitted log/finality endpoints`).toBeGreaterThan(0);
      expect(endpoints.some(endpoint => !endpoint.finalizedTagUnsupported), `${chain} lacks a finalized-tag authority`).toBe(true);
      for (const endpoint of endpoints) {
        expect(endpoint.keyed).toBe(true);
        const auth = getRpcAuth(endpoint.url);
        expect(auth?.provider).toBe(endpoint.operator);
        expect(new URL(endpoint.url).search).toBe("");
        if (endpoint.operator === "dwellir") {
          const capability = DWELLIR_CHAINS.find(entry => entry.chainId === chain)!;
          expect(endpoint.finalizedTagUnsupported).toBe(capability.finalizedTagUnsupported);
          expect(endpoint.logsHistory).toEqual(capability.logsHistory);
          expect(endpoint.stateHistory).toBe(capability.stateHistory);
          expect(auth?.headers["X-Api-Key"]).toBe("dwellir-test");
        } else {
          expect(endpoint.operator).toBe("alchemy");
          expect(auth?.headers.Authorization).toBe("Bearer alchemy-test");
        }
      }
    }
  });
});
