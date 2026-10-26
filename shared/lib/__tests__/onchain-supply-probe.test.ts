import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { resolveChainId } from "../../types/chain-identity";
import {
  CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS,
  CURATED_AGGREGATE_ESCROW_RESIDUALS,
  CURATED_AGGREGATE_EXCLUDED_REPRESENTATIONS,
  getOnchainSupplyHoldReason,
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

  it.each(["movement", "aptos"])("validates %s metadata addresses without conflating reader families", (chain) => {
    for (const address of ["0x1", `0x${"a".repeat(64)}`]) {
      expect(onchainSupplyProbeFamily({ chain, address, decimals: 6 })).toBe(chain);
    }
    for (const address of ["0x", "0xnot-hex", `0x${"1".repeat(65)}`]) {
      expect(onchainSupplyProbeFamily({ chain, address, decimals: 6 })).toBeNull();
    }
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
  it.each([
    { id: "usyc-hashnote", chains: ["ethereum", "bsc", "solana", "arc"], zero: ["arc"] },
    { id: "jtrsy-anemoy", chains: ["ethereum", "base", "arbitrum", "avalanche", "plume", "bsc", "monad", "solana", "pharos"], zero: ["solana"] },
    { id: "nopal-nest", chains: ["ethereum", "plume", "bsc", "solana", "plasma", "worldchain", "avalanche", "arc", "monad", "robinhood"], zero: ["plasma"] },
    { id: "acred-apollo-securitize", chains: ["aptos", "avalanche", "ethereum", "ink", "polygon", "sei", "solana"], zero: [] },
    { id: "brsrv-blackrock", chains: ["ethereum", "tempo", "solana"], zero: ["tempo", "solana"] },
    { id: "syrupusdg-maple", chains: ["ethereum", "robinhood", "arbitrum", "ink", "solana"], zero: ["ink", "solana"], canonical: "ethereum" },
    { id: "strusd-tori", chains: ["ethereum", "monad", "pharos"], zero: [], canonical: "ethereum" },
    { id: "susdat-saturn", chains: ["ethereum", "bsc", "monad"], zero: [], canonical: "ethereum" },
    { id: "wsrusd-reservoir", chains: ["ethereum", "base", "berachain", "sonic", "arbitrum", "bsc", "avalanche", "unichain", "plume", "sei", "worldchain", "katana", "hyperevm", "linea", "monad", "pharos", "solana", "plasma", "megaeth", "tempo", "xdc"], zero: ["megaeth"], canonical: "ethereum" },
    { id: "brlv-crown", chains: ["base", "ethereum", "tempo"], zero: ["ethereum", "tempo"] },
    { id: "chfau-allunity", chains: ["ethereum", "polygon", "base", "tempo", "solana", "arc"], zero: ["ethereum", "polygon", "base", "tempo", "solana", "arc"] },
    { id: "susn-noon", chains: ["ethereum", "zksync", "sophon", "starknet", "hyperevm", "base", "citrea", "berachain", "tac"], zero: [], canonical: "ethereum" },
    { id: "apyusd-apyx", chains: ["ethereum", "base", "bsc", "solana"], zero: [], canonical: "ethereum" },
    { id: "susdai-usd-ai", chains: ["arbitrum", "ethereum", "base", "plasma", "solana", "arc"], zero: [] },
    { id: "reusd-re-protocol", chains: ["ethereum", "avalanche", "arbitrum", "base", "bsc", "ink", "plasma", "katana", "tempo", "solana", "berachain", "monad", "sei", "megaeth", "tempo"], zero: ["berachain", "megaeth"] },
  ])("requires the complete reviewed NAV roster and accounting policy for $id", ({ id, chains, zero, canonical }) => {
    const meta = TRACKED_META_BY_ID.get(id)!;
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(meta);
    expect(selected?.map(({ config }) => config.chain)).toEqual(chains);
    expect(selected?.map(({ contract }) => contract).sort((a, b) => a.chain.localeCompare(b.chain)))
      .toEqual([...meta.contracts!].sort((a, b) => a.chain.localeCompare(b.chain)));
    expect(selected?.filter(({ config }) => config.allowZeroSupply).map(({ config }) => config.chain)).toEqual(zero);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[id]).toBe(canonical);
    expect(hasRuntimeOnchainSupplyPath(meta)).toBe(true);
    for (const missing of meta.contracts!) {
      expect(selectCuratedAggregateOnchainSupplyProbeContracts({
        ...meta, contracts: meta.contracts!.filter((contract) => contract !== missing),
      })).toBeNull();
    }
  });

  it.each(["stac-securitize", "ylds-figure", "sfrxusd-frax"])(
    "keeps %s aggregate supply unavailable until its complete perimeter is reviewed",
    (id) => expect(selectCuratedAggregateOnchainSupplyProbeContracts(TRACKED_META_BY_ID.get(id)!)).toBeNull(),
  );

  it("counts JAAA's native EVM registers once and conserves exact escrowed representations", () => {
    const meta = TRACKED_META_BY_ID.get("jaaa-janus-henderson-anemoy")!;
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(meta)!;
    expect(selected.map(({ contract }) => contract.chain))
      .toEqual(["ethereum", "base", "bsc", "avalanche", "monad", "arbitrum", "pharos", "xlayer", "arc"]);
    expect(selected.filter(({ config }) => config.allowZeroSupply).map(({ contract }) => contract.chain))
      .toEqual(["pharos", "xlayer", "arc"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[meta.id]).toBeUndefined();
    const excluded = CURATED_AGGREGATE_EXCLUDED_REPRESENTATIONS[meta.id];
    expect(excluded).toEqual([
      { chain: "solana", address: "AAAJXeGjpKu7W3X4QTSU4pm1Wbj4G2LPcdg7A6xJLLyG", canonicalChain: "ethereum" },
      { chain: "stellar", address: "CDV6U7OEVY6KUEJ4WNS63AYB6RFU3BAE7AZJOQ7LPH447C6NWUXEZZSO", canonicalChain: "ethereum" },
    ]);
    expect(selected.length + excluded.length).toBe(meta.contracts!.length);
    for (const missing of meta.contracts!) {
      expect(selectCuratedAggregateOnchainSupplyProbeContracts({
        ...meta, contracts: meta.contracts!.filter((contract) => contract !== missing),
      })).toBeNull();
    }
    expect(selectCuratedAggregateOnchainSupplyProbeContracts({
      ...meta, contracts: meta.contracts!.map((contract) => contract.chain === "solana"
        ? { ...contract, address: "So11111111111111111111111111111111111111112" } : contract),
    })).toBeNull();
  });

  it("selects both reUSD Tempo stocks by identity and refuses a third unreviewed register", () => {
    const meta = TRACKED_META_BY_ID.get("reusd-re-protocol")!;
    expect(selectCuratedAggregateOnchainSupplyProbeContracts(meta)!
      .filter(({ contract }) => contract.chain === "tempo").map(({ contract }) => contract.address))
      .toEqual(["0x20c000000000000000000000e09a4cfec804f102", "0x20c000000000000000000000383a23bacb546ab9"]);
    expect(selectCuratedAggregateOnchainSupplyProbeContracts({
      ...meta, contracts: [...meta.contracts!, { chain: "tempo", address: "0x20c0000000000000000000000000000000000001", decimals: 6 }],
    })).toBeNull();
  });

  it("refuses ambiguous same-chain registers without an exact reviewed address", () => {
    const meta = TRACKED_META_BY_ID.get("strusd-tori")!;
    expect(selectCuratedAggregateOnchainSupplyProbeContracts({
      ...meta, contracts: [...meta.contracts!, { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 18 }],
    })).toBeNull();
  });

  it("keeps unprobed strUSD representations in a noncanonical CCIP escrow residual", () => {
    const residual = CURATED_AGGREGATE_ESCROW_RESIDUALS["strusd-tori"];
    expect(residual?.escrowAddress).toBe("0xb12e0794fb2191672ba7a1811edc9713c8c2c38b");
    expect(resolveChainId(residual!.unattributedChainLabel)).toBeNull();
  });

  it.each([
    { id: "apyusd-apyx", escrow: "0x0f1bac2ea0311130da778c1ca287204338739f73" },
    { id: "susn-noon", escrow: "0xe24a3dc889621612422a64e6388927901608b91d" },
  ])("keeps $id custody beyond observed satellites unattributed", ({ id, escrow }) => {
    const residual = CURATED_AGGREGATE_ESCROW_RESIDUALS[id];
    expect(residual?.escrowAddress).toBe(escrow);
    expect(resolveChainId(residual!.unattributedChainLabel)).toBeNull();
  });

  it("requires all four Open USD deployments for its zero-list-supply repair", () => {
    const meta = TRACKED_META_BY_ID.get("ousd-open-standard")!;
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(meta);
    expect(selected?.map(({ contract }) => contract.chain)).toEqual(["tempo", "ethereum", "base", "solana"]);
    expect(selected?.map(({ contract }) => contract.decimals)).toEqual([6, 6, 6, 6]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[meta.id]).toBeUndefined();
    expect(selectCuratedAggregateOnchainSupplyProbeContracts({
      ...meta,
      contracts: meta.contracts?.filter(({ chain }) => chain !== "solana"),
    })).toBeNull();
  });

  it("admits savUSD's full registry only with its explicit CCIP residual policy", () => {
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(TRACKED_META_BY_ID.get("savusd-avant")!);
    expect(selected).toHaveLength(10);
    expect(CURATED_AGGREGATE_ESCROW_RESIDUALS["savusd-avant"]?.escrowAddress)
      .toBe("0x8fcc42c414e29e8e3dbfa1628cf45e8ed80c999d");
    expect(resolveChainId(CURATED_AGGREGATE_ESCROW_RESIDUALS["savusd-avant"]!.unattributedChainLabel)).toBeNull();
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

  it.each([
    ["pgold-pleasing", "https://api.zan.top/public/pharos-mainnet", "https://pharos.drpc.org"],
    ["syzusd-yuzu", "https://api.zan.top/public/pharos-mainnet", undefined],
  ])("keeps %s primary and fallback overrides ahead of shared defaults", (id, primary, fallback) => {
    const config = selectCuratedAggregateOnchainSupplyProbeContracts(
      TRACKED_META_BY_ID.get(id!)!,
    )?.find(({ config }) => config.chain === "pharos")?.config;
    expect(config?.rpcUrl).toBe(primary);
    expect(config?.fallbackRpcUrl).toBe(fallback);
  });

  it.each([
    { id: "yusd-yieldfi", chains: ["ethereum", "arbitrum", "base", "optimism", "sonic", "plume", "katana", "bsc", "avalanche", "plasma"] },
    { id: "savusd-avant", chains: ["avalanche", "ethereum", "linea", "plasma", "berachain", "bsc", "monad", "katana", "megaeth", "sei"],
      canonical: "avalanche", zero: ["katana"], endpoints: { megaeth: "https://mainnet.megaeth.com/rpc" } },
    { id: "cusdo-openeden", chains: ["ethereum", "base", "bsc", "solana", "klaytn"], mint: "BnANu5CtUogLqcvBNByJuwaRvRxNtVuDcAytwjsUUtqs" },
    { id: "iauon-ondo", chains: ["ethereum", "bsc", "solana", "hyperevm"],
      mint: "M77ZvkZ8zW5udRbuJCbuwSwavRa7bGAZYMTwru8ondo", zero: ["hyperevm"] },
    { id: "susdai-usd-ai", chains: ["arbitrum", "ethereum", "base", "plasma", "solana", "arc"], mint: "sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE" },
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
    { id: "syrupusdc-maple", chains: ["ethereum", "base", "arbitrum", "solana", "ink", "monad", "robinhood", "tempo", "arc"],
      canonical: "ethereum", mint: "AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj", endpoints: { monad: "https://rpc.monad.xyz" } },
    { id: "witry-brix", chains: ["ethereum", "megaeth"], canonical: "ethereum" },
    { id: "usd3-reserve-protocol", chains: ["ethereum", "base"], canonical: "ethereum" },
    { id: "brlv-crown", chains: ["base", "ethereum", "tempo"], zero: ["ethereum", "tempo"],
      endpoints: { base: undefined, ethereum: undefined, tempo: "https://rpc.tempo.xyz" } },
    { id: "syzusd-yuzu", chains: ["plasma", "ethereum", "monad", "hyperevm", "sei", "pharos", "berachain", "aptos", "base"], canonical: "plasma",
      zero: ["hyperevm", "base"],
      endpoints: { plasma: "https://rpc.plasma.to", monad: "https://rpc.monad.xyz" } },
    { id: "idrt-rupiah-token", chains: ["ethereum", "bsc", "polygon", "harmony"],
      zero: ["harmony"], endpoints: { harmony: "https://api.harmony.one" },
      fallback: { harmony: "https://api.s0.t.hmny.io" } },
    { id: "ntbill-nest", chains: ["ethereum", "plume", "arbitrum", "bsc", "solana"],
      mint: "2sA2jW9e8EYJkLFpq9hkhxfVUQBwVGJwq6iP4TmTKrL4", zeroFlags: [undefined, undefined, true, true, undefined],
      endpoints: { plume: "https://rpc.plume.org" } },
    { id: "susdc-spark-v1", chains: ["ethereum", "arbitrum", "base", "optimism", "unichain"],
      zeroFlags: [true, true, true, true, true], endpoints: { unichain: "https://mainnet.unichain.org" } },

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

  // Shape: Theo's second OFT mesh. thUSD conserves its global supply in the
  // Ethereum totalSupply (the OFTAdapter escrows every remote representation),
  // so the aggregate reallocates the Stable and Arbitrum legs out of the
  // Ethereum bucket while CoinGecko still reports a zero market cap.
  it("reallocates thUSD including its Stable and Arbitrum legs", () => {
    const oft = "0x9aa9aa0530a6af70ee7bc47cf1240100f514b065";
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: "0xa3fe5c7596024e6811e14f029937d5bd8ae485b3", decimals: 6 },
      { chain: "stable", address: oft, decimals: 6 },
      { chain: "arbitrum", address: oft, decimals: 6 },
    ], "thusd-theo"));

    const chains = selected?.map((entry) => entry.config.chain) ?? [];
    expect(chains).toEqual(["ethereum", "stable", "arbitrum"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["thusd-theo"]).toBe("ethereum");
    expect(hasRuntimeOnchainSupplyPath(makeMeta([
      { chain: "ethereum", address: "0xa3fe5c7596024e6811e14f029937d5bd8ae485b3", decimals: 6 },
      { chain: "stable", address: oft, decimals: 6 },
      { chain: "arbitrum", address: oft, decimals: 6 },
    ], "thusd-theo"))).toBe(true);
    // Stable is absent from the worker RPC registry, so the leg pins endpoints.
    expect(selected?.find((entry) => entry.config.chain === "stable")?.config.rpcUrl).toBe("https://rpc.stable.xyz");
  });

  it.each([
    {
      id: "uscc-superstate",
      contracts: [
        { chain: "ethereum", address: "0x14d60e7fdc0d71d8611742720e4c50e7a974020c", decimals: 6 },
        { chain: "plume", address: "0x4c21b7577c8fe8b0b0669165ee7c8f67fa1454cf", decimals: 6 },
        { chain: "solana", address: "BTRR3sj1Bn2ZjuemgbeQ6SCtf84iXS81CS7UDTSxUCaK", decimals: 6 },
      ],
    },
    {
      id: "pyusdx-moonpay",
      contracts: ["ethereum", "arbitrum", "monad", "base", "0g"].map((chain) => ({
        chain, address: "0xebdb0942ce16386ab90718c7bd10c91cdb66b14d", decimals: 6,
      })),
    },
    {
      id: "fiusd-sygnum",
      contracts: [
        { chain: "zksync", address: "0x2ab105a3ead22731082b790ca9a00d9a3a7627f9", decimals: 2 },
        { chain: "arbitrum", address: "0xcded6b899edba762d793f44ed295248049440e1e", decimals: 2 },
      ],
    },
  ])("requires every reviewed native deployment for $id", ({ id, contracts }) => {
    const meta = makeMeta([...contracts].reverse(), id);
    expect(selectCuratedAggregateOnchainSupplyProbeContracts(meta)?.map((entry) => entry.contract))
      .toEqual(contracts);
    expect(hasRuntimeOnchainSupplyPath(meta)).toBe(true);
    for (const missing of contracts) {
      expect(selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta(
        contracts.filter((contract) => contract !== missing), id,
      ))).toBeNull();
    }
    expect(selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      ...contracts,
      { chain: "base", address: "0x1111111111111111111111111111111111111111", decimals: 6 },
    ], id))).toBeNull();
  });

  it("cannot silently omit the reviewed 0G PYUSDx native deployment", () => {
    const meta = TRACKED_META_BY_ID.get("pyusdx-moonpay")!;
    expect(hasRuntimeOnchainSupplyPath(meta)).toBe(true);
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(meta);
    expect(selected?.map((entry) => entry.config.chain))
      .toEqual(["ethereum", "arbitrum", "monad", "base", "0g"]);
    expect(selected?.[4]?.config).toMatchObject({
      rpcUrl: "https://evmrpc.0g.ai", allowZeroSupply: true,
    });
    const incompleteMeta = { ...meta, contracts: meta.contracts!.filter((contract) => contract.chain !== "0g") };
    expect(selectCuratedAggregateOnchainSupplyProbeContracts(incompleteMeta)).toBeNull();
    expect(hasRuntimeOnchainSupplyPath(incompleteMeta)).toBe(false);
  });

  it("keeps sFRAX's verified Solana identity but publishes a configured economic-float refusal", () => {
    const meta = TRACKED_META_BY_ID.get("sfrax-frax")!;
    expect(meta.contracts).toContainEqual({
      chain: "solana", address: "DnVyztLHnDyTqL3xfPYF9Uqpgrhcxphn6e31sVAwtg6K", decimals: 9,
    });
    expect(meta.contracts).toHaveLength(10);
    expect(getOnchainSupplyHoldReason(meta.id)).toBe("economic-float-unreconciled");
    expect(selectCuratedAggregateOnchainSupplyProbeContracts(meta)).toBeNull();
    expect(selectSingleOnchainSupplyProbeContract(meta)).toBeNull();
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS[meta.id]).toBeUndefined();
    expect(CURATED_AGGREGATE_ESCROW_RESIDUALS[meta.id]).toBeUndefined();
    // Admission means a configured unavailable-row producer, not permission to
    // call native gross shares or prefunded representations economic float.
    expect(hasRuntimeOnchainSupplyPath(meta)).toBe(true);
    for (const contract of meta.contracts!) {
      const partial = { ...meta, contracts: [contract] };
      expect(selectCuratedAggregateOnchainSupplyProbeContracts(partial)).toBeNull();
      expect(selectSingleOnchainSupplyProbeContract(partial)).toBeNull();
      expect(getOnchainSupplyHoldReason(partial.id)).toBe("economic-float-unreconciled");
    }
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

  it("resolves the summed mRe7YIELD and conserved sUSN Starknet legs", () => {
    const mre7 = selectCuratedAggregateOnchainSupplyProbeContracts(makeMeta([
      { chain: "ethereum", address: "0x87c9053c819bb28e0d73d33059e1b3da80afb0cf", decimals: 18 },
      { chain: "tac", address: "0x0a72ed3c34352ab2dd912b30f2252638c873d6f0", decimals: 18 },
      { chain: "etherlink", address: "0x733d504435a49fc8c4e9759e756c2846c92f0160", decimals: 18 },
      {
        chain: "starknet",
        address: "0x04be8945e61dc3e19ebadd1579a6bd53b262f51ba89e6f8b0c4bc9a7e3c633fc",
        decimals: 18,
      },
    ], "mre7yield-midas"));

    expect(mre7?.map((entry) => entry.config.chain)).toEqual(["ethereum", "etherlink", "starknet", "tac"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["mre7yield-midas"]).toBeUndefined();
    expect(mre7?.find((entry) => entry.config.chain === "etherlink")?.config.rpcUrl)
      .toBe("https://node.mainnet.etherlink.com");
    // The Starknet reader carries its own endpoints, so the leg pins none.
    expect(mre7?.find((entry) => entry.config.chain === "starknet")?.config.rpcUrl).toBeUndefined();

    const susn = selectCuratedAggregateOnchainSupplyProbeContracts(TRACKED_META_BY_ID.get("susn-noon")!);

    expect(susn?.map((entry) => entry.config.chain)).toEqual(["ethereum", "zksync", "sophon", "starknet", "hyperevm", "base", "citrea", "berachain", "tac"]);
    expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["susn-noon"]).toBe("ethereum");
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


it.each(["mre7yield-midas", "cusdo-openeden", "syzusd-yuzu", "susdc-spark", "syrupusdc-maple", "susdt-spark", "susds-sky", "sdai-sky"])("covers every supply-reviewed deployment for %s and rejects a missing leg", (id) => {
  const meta = TRACKED_META_BY_ID.get(id)!;
  const selected = selectCuratedAggregateOnchainSupplyProbeContracts(meta)!;
  expect(selected.map(({ contract }) => `${contract.chain}:${contract.address}`).sort()).toEqual(
    meta.contracts!.map((contract) => `${contract.chain}:${contract.address}`).sort(),
  );
  for (const { contract } of selected) {
    expect(selectCuratedAggregateOnchainSupplyProbeContracts({ ...meta, contracts: meta.contracts!.filter((entry) => entry !== contract) })).toBeNull();
  }
});


it("fails a canonical roster closed on an unselected registered deployment unless a residual policy records the remainder", () => {
  const unselected = { chain: "polygon", address: "0x0000000000000000000000000000000000000001", decimals: 6 };
  const susds = TRACKED_META_BY_ID.get("susds-sky")!;
  expect(CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS["susds-sky"]).toBe("ethereum");
  expect(CURATED_AGGREGATE_ESCROW_RESIDUALS["susds-sky"]).toBeUndefined();
  expect(selectCuratedAggregateOnchainSupplyProbeContracts({
    ...susds,
    contracts: [...susds.contracts!, unselected],
  })).toBeNull();

  // The explicit unattributed-residual policy is what keeps a canonical roster
  // with unprobed registered deployments publishable.
  const susde = TRACKED_META_BY_ID.get("susde-ethena")!;
  expect(CURATED_AGGREGATE_ESCROW_RESIDUALS["susde-ethena"]).toBeDefined();
  expect(selectCuratedAggregateOnchainSupplyProbeContracts({
    ...susde,
    contracts: [...susde.contracts!, unselected],
  })).not.toBeNull();
});

it("keeps every tracked curated roster either complete or explicitly excused across the whole registry", () => {
  for (const meta of TRACKED_META_BY_ID.values()) {
    const selected = selectCuratedAggregateOnchainSupplyProbeContracts(meta);
    if (selected == null) continue;
    expect(new Set(selected.map(({ contract }) => `${contract.chain}:${contract.address}`)).size).toBe(selected.length);
    const unselectedCount = meta.contracts?.filter(
      (contract) => !selected.some((entry) => entry.contract === contract),
    ).length ?? 0;
    expect(
      unselectedCount === 0 || CURATED_AGGREGATE_ESCROW_RESIDUALS[meta.id] != null
        || unselectedCount === CURATED_AGGREGATE_EXCLUDED_REPRESENTATIONS[meta.id]?.length,
      `${meta.id} publishes a curated roster with ${unselectedCount} unselected registered deployments and no reviewed accounting exclusion`,
    ).toBe(true);
  }
});

it("does not publish cNGN destination float as a global on-chain total without Bantu accounting", () => {
  expect(selectCuratedAggregateOnchainSupplyProbeContracts(TRACKED_META_BY_ID.get("cngn-compliant-naira")!)).toBeNull();
});


it("fails a summed aggregate closed when the registry adds a deployment before probe review", () => {
  const meta = TRACKED_META_BY_ID.get("mre7yield-midas")!;
  expect(selectCuratedAggregateOnchainSupplyProbeContracts({
    ...meta,
    contracts: [...meta.contracts!, { chain: "optimism", address: "0x0000000000000000000000000000000000000001", decimals: 18 }],
  })).toBeNull();
});

it.each(["hlscope-hamilton-lane", "vnxau-vnx", "dgld-gold-token-sa", "jpym-mento"])(
  "withholds the incomplete summed roster for %s until every tracked deployment has reviewed accounting", (id) => {
    expect(selectCuratedAggregateOnchainSupplyProbeContracts(TRACKED_META_BY_ID.get(id)!)).toBeNull();
  },
);
