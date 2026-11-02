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
    for (const chain of ["hyperevm", "xdc", "flow", "chiliz", "viction"]) {
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

describe("scoped liability registry supply", () => {
  const registryCoin = makePorCoin({ contracts: [{
    chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6,
  }] });
  const registry = {
    url: "https://api.utilities.digitalasset.com/api/token-standard/v0/registrars/1220b::1220bab043849b986b52bc6271edf1ae962bab03d9f0c0713f071732d2278386bd02/registry/metadata/v1/instruments/USD1",
    registrarParty: "1220b::1220bab043849b986b52bc6271edf1ae962bab03d9f0c0713f071732d2278386bd02",
    instrumentId: "USD1",
    symbol: "USD1",
    decimals: 10,
    maxSupplyAgeSec: 604800,
  };
  const registryScope = {
    basis: "issuer-native-supply" as const,
    reviewedAt: "2026-11-02",
    evidenceRef: "KPMG August 2026 Note A footnote 3; CIP-56 registry metadata",
    included: [
      { chain: "ethereum", reader: "evm-erc20" as const },
      { chain: "canton", reader: "cip56-registry" as const, registry },
    ],
    excluded: [],
  };
  const readEvmToken = vi.fn(async () => ({ raw: 1_000_000n, decimals: 6n, observedAt: 100 }));

  it("reads an external CIP-56 registry deployment and publishes its provenance", async () => {
    const readRegistrySupply = vi.fn(async () => ({
      raw: 1_239_859_800_019n,
      decimals: 10,
      observedAt: 100,
      asOf: "2026-10-30T14:22:07.742Z",
    }));

    const supply = await aggregateScopedLiabilitySupply({
      coin: registryCoin, scope: registryScope, adapterKey: "test", signal, nowSec: 100,
      readEvmToken, readRegistrySupply,
    });

    expect(readRegistrySupply).toHaveBeenCalledWith(registry, { signal, nowSec: 100, ctx: undefined });
    expect(supply.failedChains).toEqual([]);
    expect(supply.contributions).toEqual([
      expect.objectContaining({ chain: "ethereum", raw: 1_000_000n }),
      expect.objectContaining({
        chain: "canton",
        tokenAddress: `${registry.registrarParty}:USD1`,
        raw: 1_239_859_800_019n,
        decimals: 10,
        observedAt: 100,
        provenance: {
          sourceUrl: registry.url,
          basis: expect.stringContaining("CIP-56"),
          asOf: "2026-10-30T14:22:07.742Z",
        },
      }),
    ]);
    const coverage = evaluateLiabilityCoverage({ supply, reserveObservedAt: 100 });
    expect(coverage).toMatchObject({
      supplyReadComplete: true,
      supplyCoverageComplete: true,
      metadata: {
        liabilityScope: { includedChains: ["ethereum", "canton"] },
        liabilitySupplyProvenance: [{
          chain: "canton",
          sourceUrl: registry.url,
          basis: expect.stringContaining("CIP-56"),
          asOf: "2026-10-30T14:22:07.742Z",
        }],
      },
    });
  });

  it("withholds the ratio when the registry read fails or is stale", async () => {
    const readRegistrySupply = vi.fn(async () => {
      throw new Error("CIP-56 registry totalSupplyAsOf is 604801s old (max 604800s)");
    });

    const supply = await aggregateScopedLiabilitySupply({
      coin: registryCoin, scope: registryScope, adapterKey: "test", signal, nowSec: 604_901,
      readEvmToken, readRegistrySupply,
    });

    expect(supply.failedChains).toEqual([{
      chain: "canton", reason: "CIP-56 registry totalSupplyAsOf is 604801s old (max 604800s)",
    }]);
    expect(evaluateLiabilityCoverage({ supply, reserveObservedAt: 100 })).toMatchObject({
      supplyReadComplete: false,
      supplyCoverageComplete: false,
      ratioUnavailableReason: "included-supply-read-failed",
    });
  });

  it("rejects a CIP-56 registry reader on a catalog deployment", async () => {
    const readRegistrySupply = vi.fn();
    readEvmToken.mockClear();
    const twoChainCoin = makePorCoin({ contracts: [
      { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 },
      { chain: "bsc", address: "0x0000000000000000000000000000000000000002", decimals: 6 },
    ] });

    const supply = await aggregateScopedLiabilitySupply({
      coin: twoChainCoin,
      scope: {
        ...registryScope,
        included: [
          { chain: "ethereum", reader: "evm-erc20" },
          { chain: "bsc", reader: "cip56-registry", registry },
        ],
      },
      adapterKey: "test", signal, nowSec: 100, readEvmToken, readRegistrySupply,
    });

    expect(readRegistrySupply).not.toHaveBeenCalled();
    expect(readEvmToken).toHaveBeenCalledTimes(1);
    expect(supply.unclassifiedChains).toEqual(["bsc"]);
    expect(supply.failedChains).toEqual([{
      chain: "bsc", reason: "cip56-registry reader requires a non-catalog deployment with a registry source",
    }]);
    expect(evaluateLiabilityCoverage({ supply, reserveObservedAt: 100 })).toMatchObject({
      supplyCoverageComplete: false,
      ratioUnavailableReason: "liability-scope-unclassified-chain",
    });
  });
});
