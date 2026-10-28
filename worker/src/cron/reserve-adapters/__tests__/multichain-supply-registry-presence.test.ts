import { describe, expect, it, vi } from "vitest";
import { buildChainRpcs, DWELLIR_ONLY_REGISTRY_CHAINS } from "../../../lib/chain-registry";
import { aggregateMultichainErc20Supply, aggregateScopedLiabilitySupply, chainHasRpc, evaluateLiabilityCoverage } from "../multichain-supply";
import { makePorCoin } from "./chainlink-por.test-support";

const chains = ["ethereum", ...DWELLIR_ONLY_REGISTRY_CHAINS];
const coin = makePorCoin({ contracts: chains.map(chain => ({
  chain, address: "0x0000000000000000000000000000000000000001", decimals: 6,
})) });
const signal = new AbortController().signal;

describe("chainHasRpc", () => {
  it("keeps reviewed membership with and without admission while excluded chains stay supplemental", () => {
    const withoutKey = buildChainRpcs();
    const withKey = buildChainRpcs(undefined, undefined, { dwellirApiKey: "dwellir-test" });
    for (const chain of chains) {
      expect(chainHasRpc(chain, { chainRpcs: withoutKey }), chain).toBe(true);
      expect(chainHasRpc(chain, { chainRpcs: withKey }), chain).toBe(true);
    }
    for (const chain of ["hyperevm", "xdc", "flow", "chiliz", "lisk", "viction"]) {
      expect(chainHasRpc(chain, { chainRpcs: withoutKey }), chain).toBe(false);
      expect(chainHasRpc(chain, { chainRpcs: withKey }), chain).toBe(false);
    }
  });

  it("reads every promoted chain when admitted", async () => {
    const readEvmSupply = vi.fn(async () => 1n);
    const supply = await aggregateMultichainErc20Supply({
      coin, adapterKey: "test", signal, readEvmSupply,
      ctx: { chainRpcs: buildChainRpcs(undefined, undefined, { dwellirApiKey: "dwellir-test" }) },
    });
    expect(readEvmSupply).toHaveBeenCalledTimes(chains.length);
    expect(supply.contributions.map(row => row.chain)).toEqual(chains);
    expect(evaluateLiabilityCoverage({ supply, reserveObservedAt: 100 })).toMatchObject({
      supplyReadComplete: true, supplyCoverageComplete: true,
    });
  });

  it.each([false, true])("records required read failures instead of omissions (disabled=%s)", async disabled => {
    // Census-only Alchemy cannot silently replace a required registry route.
    const ctx = { chainRpcs: buildChainRpcs("alchemy-test", undefined, disabled ? {
      dwellirApiKey: "dwellir-test", dwellirRoutingDisabledChains: DWELLIR_ONLY_REGISTRY_CHAINS,
    } : undefined) };
    const readEvmSupply = vi.fn(async () => 1n);
    const supply = await aggregateMultichainErc20Supply({ coin, adapterKey: "test", signal, ctx, readEvmSupply });
    expect(readEvmSupply).toHaveBeenCalledTimes(1);
    expect(supply.omittedNoRpcChains).toEqual([]);
    expect(supply.omittedReadFailureChains).toEqual([...DWELLIR_ONLY_REGISTRY_CHAINS]);
    expect(evaluateLiabilityCoverage({ supply, reserveObservedAt: 100 })).toMatchObject({
      supplyReadComplete: false, supplyCoverageComplete: false,
      ratioUnavailableReason: "included-supply-read-failed",
      warnings: [expect.objectContaining({ code: "partial-supply-read-failure" })],
    });

    const readEvmToken = vi.fn(async () => ({ raw: 1n, decimals: 6n, observedAt: 100 }));
    const scoped = await aggregateScopedLiabilitySupply({
      coin, adapterKey: "test", signal, ctx, nowSec: 100, readEvmToken,
      scope: {
        basis: "issuer-native-supply", reviewedAt: "2026-10-28", evidenceRef: "https://example.com/test-scope",
        included: chains.map(chain => ({ chain, reader: "evm-erc20" as const })), excluded: [],
      },
    });
    expect(readEvmToken).toHaveBeenCalledTimes(1);
    expect(scoped.failedChains).toEqual([...DWELLIR_ONLY_REGISTRY_CHAINS].map(chain => ({
      chain, reason: "registry-rpc-unavailable",
    })));
    expect(evaluateLiabilityCoverage({ supply: scoped, reserveObservedAt: 100 })).toMatchObject({
      supplyReadComplete: false, supplyCoverageComplete: false, ratioUnavailableReason: "included-supply-read-failed",
    });
  });
});
