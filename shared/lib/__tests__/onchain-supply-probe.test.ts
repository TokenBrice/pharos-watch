import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import {
  CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS,
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

  it("resolves apyUSD's reviewed CCIP burn/mint deployments", () => {
    const ethereumContract = {
      chain: "ethereum",
      address: "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a",
      decimals: 18,
    };
    const baseContract = {
      chain: "base",
      address: "0x2c271ddf484ac0386d216eb7eb9ff02d4dc0f6aa",
      decimals: 18,
    };
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      ethereumContract,
      baseContract,
    ], "apyusd-apyx"));

    expect(selected?.map((entry) => entry.contract)).toEqual([ethereumContract, baseContract]);
    expect(selected?.map((entry) => entry.config.chain)).toEqual(["ethereum", "base"]);
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

  it("resolves sUSDe's probeable LayerZero OFT legs and leaves TON and Aptos unconfigured", () => {
    const oft = "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2";
    const oftChains = [
      "plasma", "linea", "fraxtal", "hyperevm", "berachain", "zircuit", "metis", "xlayer",
      "base", "bsc", "morph-l2", "scroll", "kava", "swellchain", "mode", "mantle",
      "arbitrum", "manta", "blast", "optimism", "avalanche",
    ];
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: "0x9d39a5de30e57443bff2a8307a4256c8797a3497", decimals: 18 },
      ...oftChains.map((chain) => ({ chain, address: oft, decimals: 18 })),
      { chain: "zksync", address: "0xad17da2f6ac76746ef261e835c50b2651ce36da8", decimals: 18 },
      { chain: "solana", address: "Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN", decimals: 9 },
      { chain: "ton", address: "EQDQ5UUyPHrLcQJlPAczd_fjxn8SLrlNQwolBznxCdSlfQwr", decimals: 6 },
      {
        chain: "aptos",
        address: "0xb30a694a344edee467d9f82330bbe7c3b89f440a1ecd2da1f3bca266560fce69",
        decimals: 6,
      },
    ], "susde-ethena"));

    const chains = selected?.map((entry) => entry.config.chain) ?? [];
    expect(chains).toHaveLength(24);
    expect(chains[0]).toBe("ethereum");
    expect(chains).not.toContain("ton");
    expect(chains).not.toContain("aptos");
    expect(selected?.find((entry) => entry.config.chain === "plasma")?.config.rpcUrl)
      .toBe("https://rpc.plasma.to");
    expect(selected?.find((entry) => entry.config.chain === "xlayer")?.config.allowZeroSupply).toBe(true);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["susde-ethena"]).toBe("ethereum");
  });

  it("resolves yUSD's reviewed OFT burn/mint deployments as a summed aggregate", () => {
    const chains = [
      "ethereum",
      "arbitrum",
      "base",
      "optimism",
      "sonic",
      "plume",
      "katana",
      "bsc",
      "avalanche",
      "plasma",
    ];
    const contracts = chains.map((chain) => ({
      chain,
      address:
        chain === "ethereum"
          ? "0x19ebd191f7a24ece672ba13a302212b5ef7f35cb"
          : "0x4772d2e014f9fc3a820c444e3313968e9a5c8121",
      decimals: 18,
    }));
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta(contracts, "yusd-yieldfi"));

    expect(selected?.map((entry) => entry.config.chain)).toEqual(chains);
    // Burn/mint on every remote: no canonical leg escrows the others.
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["yusd-yieldfi"]).toBeUndefined();
  });

  it("reallocates savUSD's canonical Avalanche vault instead of summing CCIP representations", () => {
    const chains = [
      "avalanche",
      "ethereum",
      "linea",
      "plasma",
      "berachain",
      "bsc",
      "monad",
      "katana",
      "megaeth",
      "sei",
    ];
    const contracts = chains.map((chain, index) => ({
      chain,
      address: `0x${String(index + 1).padStart(40, "0")}`,
      decimals: 18,
    }));
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta(contracts, "savusd-avant"));

    expect(selected?.map((entry) => entry.config.chain)).toEqual(chains);
    // The Avalanche CCIP LockRelease pool escrows every destination mint, so the
    // canonical total must be reallocated rather than added to.
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["savusd-avant"]).toBe("avalanche");
    expect(selected?.find((entry) => entry.config.chain === "katana")?.config.allowZeroSupply).toBe(true);
    expect(selected?.find((entry) => entry.config.chain === "megaeth")?.config.rpcUrl).toBe(
      "https://mainnet.megaeth.com/rpc",
    );
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
