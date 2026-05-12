import { describe, expect, it } from "vitest";
import {
  buildAddressPriceTargetsByProvider,
  resolveEnabledAddressPriceProviders,
} from "../address-price-providers";

describe("address price providers", () => {
  it("auto-enables no-key providers plus configured key-backed providers", () => {
    expect(resolveEnabledAddressPriceProviders({
      moralisApiKey: "moralis",
      birdeyeApiKey: "birdeye",
    })).toEqual([
      "dexscreener-address",
      "dexpaprika-address",
      "geckoterminal-address",
      "moralis-address",
      "birdeye-address",
    ]);
  });

  it("honors explicit allowlists and skips providers with missing credentials", () => {
    expect(resolveEnabledAddressPriceProviders({
      enabledProviders: "moralis-address,dexpaprika-address,birdeye-address",
      moralisApiKey: "moralis",
    })).toEqual(["moralis-address", "dexpaprika-address"]);
    expect(resolveEnabledAddressPriceProviders({ enabledProviders: "none", moralisApiKey: "moralis" })).toEqual([]);
  });

  it("builds exact-address targets only for previous below-depth assets on supported provider chains", () => {
    const targets = buildAddressPriceTargetsByProvider({
      providers: ["dexpaprika-address", "moralis-address"],
      previousAssetsById: new Map([
        ["below", { id: "below", symbol: "BUSD", consensusSources: ["coingecko", "defillama-list"] }],
        ["covered", { id: "covered", symbol: "CUSD", consensusSources: ["a", "b", "c"] }],
      ]),
      assets: [
        {
          id: "below",
          symbol: "BUSD",
          address: "base:0x0000000000000000000000000000000000000001",
          chains: ["Base"],
          price: 1,
        },
        {
          id: "covered",
          symbol: "CUSD",
          address: "base:0x0000000000000000000000000000000000000002",
          chains: ["Base"],
          price: 1,
        },
      ],
    });

    expect(targets.get("dexpaprika-address")).toMatchObject([
      {
        stablecoinId: "below",
        chain: "base",
        providerChainId: "base",
        address: "0x0000000000000000000000000000000000000001",
      },
    ]);
    expect(targets.get("moralis-address")).toMatchObject([
      {
        stablecoinId: "below",
        chain: "base",
        providerChainId: "base",
      },
    ]);
  });

  it("keeps Birdeye targeting scoped to Solana deployments", () => {
    const targets = buildAddressPriceTargetsByProvider({
      providers: ["birdeye-address"],
      previousAssetsById: new Map([
        ["base-only", { id: "base-only", symbol: "BO", consensusSources: [] }],
        ["solana-only", { id: "solana-only", symbol: "SO", consensusSources: [] }],
      ]),
      assets: [
        {
          id: "base-only",
          symbol: "BO",
          address: "base:0x0000000000000000000000000000000000000001",
          chains: ["Base"],
          price: 1,
        },
        {
          id: "solana-only",
          symbol: "SO",
          address: "solana:So11111111111111111111111111111111111111112",
          chains: ["Solana"],
          price: 1,
        },
      ],
    });

    expect(targets.get("birdeye-address")).toMatchObject([
      {
        stablecoinId: "solana-only",
        chain: "solana",
        providerChainId: "solana",
        address: "So11111111111111111111111111111111111111112",
      },
    ]);
  });
});
