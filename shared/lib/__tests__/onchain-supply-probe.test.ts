import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import {
  hasRuntimeOnchainSupplyPath,
  isZephyrScannerSupplyId,
  selectCuratedAggregateOnchainSupplyProbeContracts,
  selectSingleOnchainSupplyProbeContract,
  selectSupplementalOnchainSupplyProbeContract,
  supportsOnchainSupplyProbe,
} from "@shared/lib/onchain-supply-probe";

function makeMeta(contracts: StablecoinMeta["contracts"], id = "test-stablecoin"): StablecoinMeta {
  return {
    id,
    name: "Test Stablecoin",
    symbol: "TEST",
    detailProvider: "coingecko",
    contracts,
    flags: {
      pegCurrency: "USD",
      backing: "rwa-backed",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
  } as StablecoinMeta;
}

describe("supportsOnchainSupplyProbe", () => {
  it("accepts strict EVM addresses and Solana addresses", () => {
    expect(supportsOnchainSupplyProbe({
      chain: "ethereum",
      address: "0x0000000000000000000000000000000000000001",
      decimals: 6,
    })).toBe(true);
    expect(supportsOnchainSupplyProbe({
      chain: "solana",
      address: "So11111111111111111111111111111111111111112",
      decimals: 6,
    })).toBe(true);
  });

  it("rejects malformed EVM, Tron, Stellar, and unknown-chain contracts", () => {
    expect(supportsOnchainSupplyProbe({ chain: "ethereum", address: "0xnot-an-address", decimals: 6 })).toBe(false);
    expect(supportsOnchainSupplyProbe({ chain: "tron", address: "TY7copxkSQZBym6eTGMEdrqPHaNNsmjxKe", decimals: 6 }))
      .toBe(false);
    expect(supportsOnchainSupplyProbe({ chain: "stellar", address: "TEST.STELLAR", decimals: 7 })).toBe(false);
    expect(supportsOnchainSupplyProbe({
      chain: "unknown",
      address: "0x0000000000000000000000000000000000000001",
      decimals: 18,
    })).toBe(false);
  });
});

describe("selectSingleOnchainSupplyProbeContract", () => {
  it("returns one supported contract", () => {
    const contract = { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 };

    expect(selectSingleOnchainSupplyProbeContract(makeMeta([contract]))).toBe(contract);
  });

  it("rejects multiple contracts to avoid partial global supply", () => {
    expect(selectSingleOnchainSupplyProbeContract(makeMeta([
      { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 },
      { chain: "bsc", address: "0x0000000000000000000000000000000000000002", decimals: 6 },
    ]))).toBeNull();
    expect(selectSingleOnchainSupplyProbeContract(makeMeta([
      { chain: "tron", address: "TY7copxkSQZBym6eTGMEdrqPHaNNsmjxKe", decimals: 6 },
      { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 },
    ]))).toBeNull();
  });
});

describe("curated on-chain supply paths", () => {
  it("allows curated single-chain supplemental assets to select the configured chain", () => {
    const ethereumContract = { chain: "ethereum", address: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d", decimals: 6 };
    const avalancheContract = { chain: "avalanche", address: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d", decimals: 6 };

    expect(selectSupplementalOnchainSupplyProbeContract(makeMeta([
      ethereumContract,
      avalancheContract,
    ], "susdc-spark"))).toBe(ethereumContract);
  });

  it("resolves configured aggregate chains only when every chain is present and supported", () => {
    const ethereumContract = { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 };
    const sonicContract = { chain: "sonic", address: "0x0000000000000000000000000000000000000002", decimals: 6 };
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      ethereumContract,
      sonicContract,
    ], "ftusd-flying-tulip"));

    expect(selected?.map((entry) => entry.contract)).toEqual([ethereumContract, sonicContract]);
    expect(selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      ethereumContract,
    ], "ftusd-flying-tulip"))).toBeNull();
  });

  it("resolves CHFAU's reviewed native deployments with zero-supply legs allowed", () => {
    const ethereumContract = { chain: "ethereum", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 };
    const polygonContract = { chain: "polygon", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 };
    const baseContract = { chain: "base", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 };
    const tempoContract = { chain: "tempo", address: "0x20c00000000000000000000042109aef2f8b28e1", decimals: 6 };
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      ethereumContract,
      polygonContract,
      baseContract,
      tempoContract,
    ], "chfau-allunity"));

    expect(selected?.map((entry) => entry.contract)).toEqual([
      ethereumContract,
      polygonContract,
      baseContract,
      tempoContract,
    ]);
    expect(selected?.map((entry) => entry.config.allowZeroSupply)).toEqual([true, true, true, true]);
  });

  it("resolves DUSD's canonical Ethereum and Ink NTT representation path", () => {
    const ethereumContract = {
      chain: "ethereum",
      address: "0x1e33e98af620f1d563fcd3cfd3c75ace841204ef",
      decimals: 18,
    };
    const inkContract = {
      chain: "ink",
      address: "0xa95c8ff7be2a1c898fe01b90fdc9621e8ea5c9fc",
      decimals: 18,
    };
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      ethereumContract,
      inkContract,
    ], "dusd-dialectic"));

    expect(selected?.map((entry) => entry.contract)).toEqual([ethereumContract, inkContract]);
    expect(selected?.map((entry) => entry.config.chain)).toEqual(["ethereum", "ink"]);
    expect(selected?.[1]?.config.rpcUrl).toBe("https://rpc-gel.inkonchain.com");
  });

});

describe("hasRuntimeOnchainSupplyPath", () => {
  it("admits Zephyr Scanner assets", () => {
    expect(isZephyrScannerSupplyId("zsd-zephyr-protocol")).toBe(true);
    expect(hasRuntimeOnchainSupplyPath(makeMeta([], "zys-zephyr-protocol"))).toBe(true);
  });

  it("does not admit mixed Ethereum and Tron assets without a curated aggregate path", () => {
    expect(hasRuntimeOnchainSupplyPath(makeMeta([
      { chain: "ethereum", address: "0x95c2e7cbc7ae370e28160bd04297c53f96d092b4", decimals: 6 },
      { chain: "tron", address: "TY7copxkSQZBym6eTGMEdrqPHaNNsmjxKe", decimals: 6 },
    ], "mmxn-moneta-digital"))).toBe(false);
  });
});
