import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import { resolveChainId } from "@shared/lib/chains";
import {
  CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS,
  CURATED_AGGREGATE_ESCROW_RESIDUALS,
  hasRuntimeOnchainSupplyPath,
  isZephyrScannerSupplyId,
  onchainSupplyProbeFamily,
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

  // Platform extension: non-EVM legs must be able to join a fail-closed
  // aggregate instead of poisoning it for the whole asset.
  it("accepts Starknet felts and ICP canister ids and reports their reader family", () => {
    const starknet = {
      chain: "starknet",
      address: "0x04be8945e61dc3e19ebadd1579a6bd53b262f51ba89e6f8b0c4bc9a7e3c633fc",
      decimals: 18,
    };
    const icp = { chain: "icp", address: "6c7su-kiaaa-aaaar-qaira-cai", decimals: 8 };

    expect(onchainSupplyProbeFamily(starknet)).toBe("starknet");
    expect(onchainSupplyProbeFamily(icp)).toBe("icp");
    expect(onchainSupplyProbeFamily({ chain: "ethereum", address: `0x${"1".repeat(40)}`, decimals: 6 })).toBe("evm");
    expect(onchainSupplyProbeFamily({
      chain: "solana",
      address: "So11111111111111111111111111111111111111112",
      decimals: 6,
    })).toBe("solana");
  });

  it("rejects malformed Starknet and ICP addresses", () => {
    expect(supportsOnchainSupplyProbe({ chain: "starknet", address: "0xnot-a-felt", decimals: 18 })).toBe(false);
    expect(supportsOnchainSupplyProbe({ chain: "starknet", address: `0x${"1".repeat(65)}`, decimals: 18 }))
      .toBe(false);
    // Self-authenticating (user) principals are longer than a canister id.
    expect(supportsOnchainSupplyProbe({
      chain: "icp",
      address: "thrhh-hnmzu-kjquw-6ebmf-vdhed-yf2ry-avwy7-2jrrm-byg34-zoqaz-wqe",
      decimals: 8,
    })).toBe(false);
    expect(supportsOnchainSupplyProbe({
      chain: "icp",
      address: "0x0000000000000000000000000000000000000001",
      decimals: 8,
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

  // Shape: locally backed per-chain vaults / burn-mint satellites with a Solana
  // leg. Nothing escrows anything, so the legs sum and no canonical entry exists.
  it("sums per-chain vault aggregates that include a Solana leg", () => {
    const cusdo = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: "0xad55aebc9b8c03fc43cd9f62260391c13c23e7c0", decimals: 18 },
      { chain: "base", address: "0x83db73ef5192de4b6a4c92bd0141ba1a0dc87c65", decimals: 18 },
      { chain: "bsc", address: "0x64748ea3e31d0b7916f0ff91b017b9f404ded8ef", decimals: 18 },
      { chain: "solana", address: "BnANu5CtUogLqcvBNByJuwaRvRxNtVuDcAytwjsUUtqs", decimals: 6 },
    ], "cusdo-openeden"));

    expect(cusdo?.map((entry) => entry.config.chain)).toEqual(["ethereum", "base", "bsc", "solana"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["cusdo-openeden"]).toBeUndefined();

    const iauon = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: "0x4f0ca3df1c2e6b943cf82e649d576ffe7b2fabcf", decimals: 18 },
      { chain: "bsc", address: "0xcb2a0f46f67dc4c58a316f1c008edef5c2311795", decimals: 18 },
      { chain: "solana", address: "M77ZvkZ8zW5udRbuJCbuwSwavRa7bGAZYMTwru8ondo", decimals: 9 },
      { chain: "hyperevm", address: "0x83b01ac9e2d1632a70dd1c813c5b8edf29cd707f", decimals: 18 },
    ], "iauon-ondo"));

    expect(iauon?.map((entry) => entry.config.chain)).toEqual(["ethereum", "bsc", "solana", "hyperevm"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["iauon-ondo"]).toBeUndefined();
    // The reviewed HyperEVM deployment is live with zero supply today.
    expect(iauon?.find((entry) => entry.config.chain === "hyperevm")?.config.allowZeroSupply).toBe(true);

    // Same shape, same rule: these ids must resolve without a canonical entry.
    for (const [id, chains] of [
      ["susdai-usd-ai", ["arbitrum", "ethereum", "base", "plasma"]],
      ["syusd-aegis", ["ethereum", "bsc"]],
      ["slvon-ondo", ["ethereum", "bsc", "solana", "hyperevm"]],
      ["mhyper-midas", ["ethereum", "monad", "plasma", "katana"]],
    ] as const) {
      const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta(
        chains.map((chain, index) => ({
          chain,
          address: chain === "solana"
            ? "M77ZvkZ8zW5udRbuJCbuwSwavRa7bGAZYMTwru8ondo"
            : `0x${String(index + 1).padStart(40, "0")}`,
          decimals: 18,
        })),
        id,
      ));

      expect(selected?.map((entry) => entry.config.chain)).toEqual([...chains]);
      expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[id]).toBeUndefined();
    }
  });

  // Shape: reviewed remote deployments that only ever hold seed dust. Every one
  // of them has to tolerate a zero read or a single burn fails the aggregate.
  it("keeps sDOLA's dust-only representation legs zero-tolerant", () => {
    const chains = ["ethereum", "base", "optimism", "arbitrum", "berachain"];
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta(
      chains.map((chain, index) => ({ chain, address: `0x${String(index + 1).padStart(40, "0")}`, decimals: 18 })),
      "sdola-inverse-finance",
    ));

    expect(selected?.map((entry) => entry.config.chain)).toEqual(chains);
    expect(selected?.map((entry) => entry.config.allowZeroSupply)).toEqual([undefined, true, true, true, true]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["sdola-inverse-finance"]).toBeUndefined();
  });

  // Shape: single-deployment assets configured purely so the aggregate lane
  // publishes a per-chain row. The reviewed lock/mint escrows the underlying
  // asset, not the tracked token, so there is nothing to reallocate.
  it("admits single-deployment Solana assets as one-leg curated aggregates", () => {
    for (const [id, mint] of [
      ["usdk-kast", "usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX"],
      ["xo-exodus", "xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y"],
    ] as const) {
      const meta = makeMeta([{ chain: "solana", address: mint, decimals: 6 }], id);
      const selected = selectCuratedAggregateOnchainSupplyProbeContracts(meta);

      expect(selected?.map((entry) => entry.config.chain)).toEqual(["solana"]);
      expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[id]).toBeUndefined();
      expect(hasRuntimeOnchainSupplyPath(meta)).toBe(true);
    }
  });

  // Shape: canonical-chain lockbox (LayerZero OFT Adapter or CCIP LockRelease
  // pool) whose totalSupply already contains every remote mint.
  it("reallocates canonical Ethereum lockbox totals instead of summing representations", () => {
    const srusd = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: "0x738d1115b90efa71ae468f1287fc864775e23a31", decimals: 18 },
      { chain: "berachain", address: "0x5475611dffb8ef4d697ae39df9395513b6e947d7", decimals: 18 },
    ], "srusd-reservoir"));

    expect(srusd?.map((entry) => entry.config.chain)).toEqual(["ethereum", "berachain"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["srusd-reservoir"]).toBe("ethereum");

    const krwqChains = ["ethereum", "base", "polygon", "fraxtal", "codex", "morph-l2"];
    const krwq = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta(
      krwqChains.map((chain, index) => ({ chain, address: `0x${String(index + 1).padStart(40, "0")}`, decimals: 18 })),
      "krwq-iq",
    ));

    expect(krwq?.map((entry) => entry.config.chain)).toEqual(krwqChains);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["krwq-iq"]).toBe("ethereum");
    expect(krwq?.find((entry) => entry.config.chain === "codex")?.config.allowZeroSupply).toBe(true);
    expect(krwq?.find((entry) => entry.config.chain === "fraxtal")?.config.rpcUrl).toBe("https://rpc.frax.com");

    const syrup = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: "0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d", decimals: 6 },
      { chain: "plasma", address: "0xc4374775489cb9c56003bf2c9b12495fc64f0771", decimals: 6 },
      { chain: "bsc", address: "0x8e9d4cea39299323fe8eda678cad449718556c4e", decimals: 6 },
      { chain: "mantle", address: "0x051665f2455116e929b9972c36d23070f5054ce0", decimals: 6 },
      { chain: "ink", address: "0x8a76fe7fa6da27f85a626c5c53730b38d13603d7", decimals: 6 },
    ], "syrupusdt-maple"));

    expect(syrup?.map((entry) => entry.config.chain)).toEqual(["ethereum", "plasma", "bsc", "mantle", "ink"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["syrupusdt-maple"]).toBe("ethereum");
    expect(syrup?.find((entry) => entry.config.chain === "ink")?.config.rpcUrl).toBe("https://rpc-gel.inkonchain.com");

    // Same shape: the Ethereum escrow holds the whole MegaETH float.
    const witry = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: "0xe346c29b5b60ef870b9724c57ccfbbc631e47dee", decimals: 18 },
      { chain: "megaeth", address: "0x15b271d9012b5820fc42b1c495b4c1e206547de5", decimals: 18 },
    ], "witry-brix"));

    expect(witry?.map((entry) => entry.config.chain)).toEqual(["ethereum", "megaeth"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["witry-brix"]).toBe("ethereum");
  });

  // Shape variant: a reallocating mesh whose Stable-chain representation became
  // a tracked deployment, so it now reallocates out of the Ethereum bucket
  // instead of hiding inside it.
  it("reallocates thBILL including its Stable-chain leg", () => {
    const oft = "0xfdd22ce6d1f66bc0ec89b20bf16ccb6670f55a5a";
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: "0x5fa487bca6158c64046b2813623e20755091da0b", decimals: 6 },
      { chain: "arbitrum", address: oft, decimals: 6 },
      { chain: "base", address: oft, decimals: 6 },
      { chain: "hyperevm", address: oft, decimals: 6 },
      { chain: "stable", address: oft, decimals: 6 },
    ], "thbill-theo"));

    const chains = selected?.map((entry) => entry.config.chain) ?? [];
    expect(chains).toEqual(["ethereum", "arbitrum", "base", "hyperevm", "stable"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["thbill-theo"]).toBe("ethereum");
    expect(selected?.find((entry) => entry.config.chain === "base")?.config.allowZeroSupply).toBe(true);
    // Stable is absent from the worker RPC registry, so the leg pins endpoints.
    expect(selected?.find((entry) => entry.config.chain === "stable")?.config.rpcUrl).toBe("https://rpc.stable.xyz");
  });

  // Shape: Centrifuge V3 burn/mint share bridge. Every reviewed deployment is
  // configured, including two that read exactly zero today - the Solana leg only
  // became configurable once allowZeroSupply started governing Solana reads.
  it("sums every reviewed ACRDX deployment including its zero-supply legs", () => {
    const share = "0x9477724bb54ad5417de8baff29e59df3fb4da74f";
    const spoke = "0x2fabf1c784b8583d63c00c5c9c0377d8cf1a3245";
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: share, decimals: 18 },
      { chain: "plume", address: share, decimals: 18 },
      { chain: "monad", address: spoke, decimals: 18 },
      { chain: "base", address: share, decimals: 18 },
      { chain: "optimism", address: spoke, decimals: 18 },
      { chain: "solana", address: "ACDR3LGFrMuDZSDRyJjncFCzo5c8xkQxhWx4im4Vmq8G", decimals: 6 },
    ], "acrdx-anemoy-apollo"));

    expect(selected?.map((entry) => entry.config.chain)).toEqual([
      "ethereum",
      "plume",
      "monad",
      "optimism",
      "base",
      "solana",
    ]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["acrdx-anemoy-apollo"]).toBeUndefined();
    expect(selected?.find((entry) => entry.config.chain === "base")?.config.allowZeroSupply).toBe(true);
    expect(selected?.find((entry) => entry.config.chain === "solana")?.config.allowZeroSupply).toBe(true);
    // Optimism is in the worker chain registry, so it needs no pinned endpoint.
    expect(selected?.find((entry) => entry.config.chain === "optimism")?.config.rpcUrl).toBeUndefined();
  });

  // Shape: non-EVM native leg. Omnity escrows GLDT inside an ICP canister, so
  // the ledger total already contains the EVM float and is reallocated.
  it("reallocates GLDT's canonical ICP ledger across its Omnity EVM legs", () => {
    const evm = "0x86856814e74456893cfc8946bedcbb472b5fa856";
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: evm, decimals: 8 },
      { chain: "base", address: evm, decimals: 8 },
      { chain: "arbitrum", address: evm, decimals: 8 },
      { chain: "icp", address: "6c7su-kiaaa-aaaar-qaira-cai", decimals: 8 },
    ], "gldt-gold-dao"));

    expect(selected?.map((entry) => entry.config.chain)).toEqual(["icp", "ethereum", "base", "arbitrum"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["gldt-gold-dao"]).toBe("icp");
    // Arbitrum is a reviewed deployment that currently reads exactly zero.
    expect(selected?.find((entry) => entry.config.chain === "arbitrum")?.config.allowZeroSupply).toBe(true);
  });

  // Shape: Starknet legs on two assets served by one adapter. Neither escrows
  // the others, so the reviewed deployments sum.
  it("resolves the Starknet legs of mRe7YIELD and sUSN as summed aggregates", () => {
    const mre7 = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: "0x87c9053c819bb28e0d73d33059e1b3da80afb0cf", decimals: 18 },
      { chain: "etherlink", address: "0x733d504435a49fc8c4e9759e756c2846c92f0160", decimals: 18 },
      {
        chain: "starknet",
        address: "0x04be8945e61dc3e19ebadd1579a6bd53b262f51ba89e6f8b0c4bc9a7e3c633fc",
        decimals: 18,
      },
    ], "mre7yield-midas"));

    expect(mre7?.map((entry) => entry.config.chain)).toEqual(["ethereum", "etherlink", "starknet"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["mre7yield-midas"]).toBeUndefined();
    expect(mre7?.find((entry) => entry.config.chain === "etherlink")?.config.rpcUrl)
      .toBe("https://node.mainnet.etherlink.com");
    // The Starknet reader carries its own endpoints, so the leg pins none.
    expect(mre7?.find((entry) => entry.config.chain === "starknet")?.config.rpcUrl).toBeUndefined();

    const susn = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: "0xe24a3dc889621612422a64e6388927901608b91d", decimals: 18 },
      { chain: "zksync", address: "0xb6a09d426861c63722aa0b333a9ce5d5a9b04c4f", decimals: 18 },
      { chain: "sophon", address: "0xb87dbe27db932bacaaa96478443b6519d52c5004", decimals: 18 },
      {
        chain: "starknet",
        address: "0x02411565ef1a14decfbe83d2e987cced918cd752508a3d9c55deb67148d14d17",
        decimals: 18,
      },
    ], "susn-noon"));

    expect(susn?.map((entry) => entry.config.chain)).toEqual(["ethereum", "zksync", "sophon", "starknet"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["susn-noon"]).toBeUndefined();
    expect(susn?.find((entry) => entry.config.chain === "sophon")?.config.rpcUrl).toBe("https://rpc.sophon.xyz");
  });

  it("keeps sUSDe's unattributed escrow label outside the canonical chain registry", () => {
    const residual = CURATED_AGGREGATE_ESCROW_RESIDUALS["susde-ethena"];

    expect(residual?.escrowAddress).toBe("0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2");
    // The label must not canonicalize, or the remainder would be credited to a
    // real chain instead of the V9 unmatched-chain-label pool.
    expect(resolveChainId(residual!.unattributedChainLabel)).toBeNull();
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["susde-ethena"]).toBe("ethereum");
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
