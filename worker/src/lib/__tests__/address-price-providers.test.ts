import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAddressPriceTargetsByProvider,
  resolveEnabledAddressPriceProviders,
} from "../address-price-providers";
import { runDexScreenerAddressProvider } from "../address-price-providers/dexscreener";
import type { AddressPriceTarget } from "../address-price-providers";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeDexScreenerTarget(index: number, overrides: Partial<AddressPriceTarget> = {}): AddressPriceTarget {
  return {
    stablecoinId: `coin-${index}`,
    symbol: "USD",
    chain: "base",
    providerChainId: "base",
    address: `0x${index.toString(16).padStart(40, "0")}`,
    origin: "contracts",
    previousSourceDepth: 1,
    missingPrice: false,
    circulatingUsd: 1_000_000 - index,
    ...overrides,
  };
}

describe("address price providers", () => {
  it("auto-enables no-key providers plus configured key-backed providers", () => {
    expect(resolveEnabledAddressPriceProviders({
      cgApiKey: "cg",
      moralisApiKey: "moralis",
      birdeyeApiKey: "birdeye",
    })).toEqual([
      "dexscreener-address",
      "dexpaprika-address",
      "coingecko-onchain-address",
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

  it("limits DexScreener address augmentation to one batch per run", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runDexScreenerAddressProvider(
      Array.from({ length: 60 }, (_, index) => makeDexScreenerTarget(index)),
      undefined,
      1_700_000_000,
      Date.now() + 60_000,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.attemptedRequests).toBe(1);
    expect(result.attemptedTargets).toBe(30);
    expect(result.successfulRequests).toBe(1);
  });

  it("does not continue DexScreener address batches after an upstream refusal", async () => {
    const fetchMock = vi.fn(async () => new Response("error code: 1015", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runDexScreenerAddressProvider(
      Array.from({ length: 60 }, (_, index) => makeDexScreenerTarget(index)),
      undefined,
      1_700_000_000,
      Date.now() + 60_000,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.successfulRequests).toBe(0);
    expect(result.diagnostics).toMatchObject([
      {
        source: "dexscreener-address",
        status: 429,
        success: false,
        rejectionReasonCounts: { "non-ok": 1 },
      },
    ]);
  });
});
