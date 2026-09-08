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

  it.each([
    { id: "yusd-yieldfi", chains: ["ethereum", "arbitrum", "base", "optimism", "sonic", "plume", "katana", "bsc", "avalanche", "plasma"] },
    { id: "savusd-avant", chains: ["avalanche", "ethereum", "linea", "plasma", "berachain", "bsc", "monad", "katana", "megaeth", "sei"],
      canonical: "avalanche", zero: ["katana"], endpoints: { megaeth: "https://mainnet.megaeth.com/rpc" } },
    { id: "cusdo-openeden", chains: ["ethereum", "base", "bsc", "solana"], mint: "BnANu5CtUogLqcvBNByJuwaRvRxNtVuDcAytwjsUUtqs" },
    { id: "iauon-ondo", chains: ["ethereum", "bsc", "solana", "hyperevm"],
      mint: "M77ZvkZ8zW5udRbuJCbuwSwavRa7bGAZYMTwru8ondo", zero: ["hyperevm"] },
    { id: "susdai-usd-ai", chains: ["arbitrum", "ethereum", "base", "plasma"] },
    { id: "syusd-aegis", chains: ["ethereum", "bsc"] },
    { id: "slvon-ondo", chains: ["ethereum", "bsc", "solana", "hyperevm"], mint: "M77ZvkZ8zW5udRbuJCbuwSwavRa7bGAZYMTwru8ondo" },
    { id: "mhyper-midas", chains: ["ethereum", "monad", "plasma", "katana"] },
    { id: "sdola-inverse-finance", chains: ["ethereum", "base", "optimism", "arbitrum", "berachain"],
      zeroFlags: [undefined, true, true, true, true] },
    { id: "usdk-kast", chains: ["solana"], mint: "usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX", runtime: true },
    { id: "xo-exodus", chains: ["solana"], mint: "xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y", runtime: true },
    { id: "srusd-reservoir", chains: ["ethereum", "berachain"], canonical: "ethereum" },
    { id: "krwq-iq", chains: ["ethereum", "base", "polygon", "fraxtal", "codex", "morph-l2"],
      canonical: "ethereum", zero: ["codex"], endpoints: { fraxtal: "https://rpc.frax.com" } },
    { id: "syrupusdt-maple", chains: ["ethereum", "plasma", "bsc", "mantle", "ink"],
      canonical: "ethereum", endpoints: { ink: "https://rpc-gel.inkonchain.com" } },
    { id: "syrupusdc-maple", chains: ["ethereum", "base", "arbitrum", "solana", "ink", "monad", "robinhood", "tempo"],
      canonical: "ethereum", mint: "AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj", endpoints: { monad: "https://rpc.monad.xyz" } },
    { id: "witry-brix", chains: ["ethereum", "megaeth"], canonical: "ethereum" },
    { id: "brlv-crown", chains: ["base", "ethereum"], zero: ["ethereum"],
      endpoints: { base: undefined, ethereum: undefined } },
    { id: "syzusd-yuzu", chains: ["plasma", "ethereum", "monad"], canonical: "plasma",
      zeroFlags: [undefined, undefined, undefined],
      endpoints: { plasma: "https://rpc.plasma.to", monad: "https://rpc.monad.xyz" } },
    { id: "idrt-rupiah-token", chains: ["ethereum", "bsc", "polygon", "harmony"],
      zero: ["harmony"], endpoints: { harmony: "https://api.harmony.one" },
      fallback: { harmony: "https://api.s0.t.hmny.io" } },
    { id: "ntbill-nest", chains: ["ethereum", "plume", "arbitrum", "bsc", "solana"],
      mint: "2sA2jW9e8EYJkLFpq9hkhxfVUQBwVGJwq6iP4TmTKrL4", zeroFlags: [undefined, undefined, true, true, undefined],
      endpoints: { plume: "https://rpc.plume.org" } },
    { id: "cngn-compliant-naira", chains: ["base", "bsc", "celo", "solana", "ethereum", "polygon"],
      mint: "3jiqwBQVRC5zRwHyqvnkQurebJ5RNxg3F5fXMwaxgkv8", zero: ["ethereum", "polygon"], endpoints: { celo: undefined } },
  ])("selects reviewed aggregate policy for $id", ({ id, chains, canonical, mint, zero, zeroFlags, endpoints, fallback, runtime }) => {
    const contracts = chains.map((chain, index) => ({
      chain,
      address: chain === "solana" ? mint! : `0x${String(index + 1).padStart(40, "0")}`,
      decimals: chain === "solana" ? 6 : 18,
    }));
    const meta = makeMeta([...contracts].reverse(), id);
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(meta);
    expect(selected?.map((entry) => entry.contract)).toEqual(contracts);
    expect(selected?.map((entry) => entry.config.chain)).toEqual(chains);
    // Undefined means independent issuance; a canonical chain identifies escrow reallocation policy.
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[id]).toBe(canonical);
    for (const chain of zero ?? []) {
      expect(selected?.find((entry) => entry.config.chain === chain)?.config.allowZeroSupply).toBe(true);
    }
    if (zeroFlags) expect(selected?.map((entry) => entry.config.allowZeroSupply)).toEqual(zeroFlags);
    for (const [chain, rpcUrl] of Object.entries(endpoints ?? {})) {
      expect(selected?.find((entry) => entry.config.chain === chain)?.config.rpcUrl).toBe(rpcUrl);
    }
    for (const [chain, rpcUrl] of Object.entries(fallback ?? {})) {
      expect(selected?.find((entry) => entry.config.chain === chain)?.config.fallbackRpcUrl).toBe(rpcUrl);
    }
    if (runtime) expect(hasRuntimeOnchainSupplyPath(meta)).toBe(true);
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


  // The whole probe must fail closed: drop any one reviewed leg and the asset
  // resolves to null rather than publishing a partial per-chain split.
  it("refuses every ODR-E4 aggregate when a reviewed leg is missing", () => {
    const cases = [
      ["brlv-crown", [{ chain: "base", address: "0xd2047ebdb205ee6862b69ae9fb3501652cc97d36", decimals: 18 }]],
      ["syzusd-yuzu", [{ chain: "plasma", address: "0xc8a8df9b210243c55d31c73090f06787ad0a1bf6", decimals: 18 }]],
      ["idrt-rupiah-token", [{ chain: "ethereum", address: "0x998ffe1e43facffb941dc337dd0468d52ba5b48a", decimals: 2 }]],
      ["ntbill-nest", [{ chain: "plume", address: "0xe72fe64840f4ef80e3ec73a1c749491b5c938cb9", decimals: 6 }]],
      ["cngn-compliant-naira", [{ chain: "base", address: "0x46c85152bfe9f96829aa94755d9f915f9b10ef5f", decimals: 6 }]],
    ] as const;

    for (const [id, contracts] of cases) {
      expect(selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([...contracts], id))).toBeNull();
    }
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
