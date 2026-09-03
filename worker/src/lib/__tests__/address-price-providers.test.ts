import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import {
  buildAddressPriceTargetsByProvider,
  resolveEnabledAddressPriceProviders,
  resolveFallbackChain,
} from "../address-price-providers";
import { runCoingeckoOnchainAddressProvider } from "../address-price-providers/coingecko-onchain";
import type { AddressPriceTarget } from "../address-price-providers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("address price providers", () => {
  it("enables no provider when the allowlist is unset", () => {
    expect(resolveEnabledAddressPriceProviders({ cgApiKey: "cg" })).toEqual([]);
  });

  it("retains only the explicitly allowlisted CoinGecko Onchain provider", () => {
    expect(resolveEnabledAddressPriceProviders({
      enabledProviders: "coingecko-onchain-address,dexpaprika-address,moralis-address",
      cgApiKey: "cg",
    })).toEqual(["coingecko-onchain-address"]);
    expect(resolveEnabledAddressPriceProviders({
      enabledProviders: "coingecko-onchain-address",
    })).toEqual([]);
    expect(resolveEnabledAddressPriceProviders({
      enabledProviders: "none",
      cgApiKey: "cg",
    })).toEqual([]);
  });

  it("targets only missing or low-depth rows on CoinGecko-supported chains", () => {
    const targets = buildAddressPriceTargetsByProvider({
      providers: ["coingecko-onchain-address"],
      previousAssetsById: new Map([
        ["thin", { id: "thin", symbol: "THIN", consensusSources: ["coingecko", "defillama-list"] }],
        ["deep", { id: "deep", symbol: "DEEP", consensusSources: ["a", "b", "c"] }],
      ]),
      assets: [
        {
          id: "thin",
          symbol: "THIN",
          address: "base:0x0000000000000000000000000000000000000001",
          price: 1,
          priceSource: "coingecko+defillama-list",
          priceObservedAt: 1_800_000_000,
        },
        {
          id: "deep",
          symbol: "DEEP",
          address: "base:0x0000000000000000000000000000000000000002",
          price: 1,
          priceSource: "coingecko+defillama-list",
          priceObservedAt: 1_800_000_000,
        },
      ],
    });

    expect(targets.get("coingecko-onchain-address")).toMatchObject([{
      stablecoinId: "thin",
      chain: "base",
      providerChainId: "base",
      address: "0x0000000000000000000000000000000000000001",
    }]);
  });

  it("treats bare EVM fallback addresses as undecidable and non-EVM addresses as Solana", () => {
    expect(resolveFallbackChain("0x0000000000000000000000000000000000000001")).toBeNull();
    expect(resolveFallbackChain("So11111111111111111111111111111111111111112")).toBe("solana");
  });

  it("fetches the retained exact-address provider with local-fetch provenance", async () => {
    const target: AddressPriceTarget = {
      stablecoinId: "fixture-usd",
      symbol: "FUSD",
      chain: "base",
      providerChainId: "base",
      address: "0x0000000000000000000000000000000000000001",
      origin: "contracts",
      previousSourceDepth: 1,
      previousMissingGenerations: 0,
      alertEligibleMissingPrice: false,
      recentlyMissingPrice: false,
      missingPrice: false,
      expiresBeforeNextGeneration: false,
      circulatingUsd: 1_000_000,
    };
    const fetchMock = mockFetch([{
      match: () => true,
      respond: () => Response.json({
        data: [{
          attributes: {
            address: target.address,
            price_usd: "1.001",
            total_reserve_in_usd: "75000",
            volume_usd: { h24: "10000" },
          },
        }],
      }),
    }]);

    const result = await runCoingeckoOnchainAddressProvider(
      [target],
      "cg-key",
      undefined,
      1_800_000_000,
      Date.now() + 60_000,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.quotes).toEqual([expect.objectContaining({
      stablecoinId: "fixture-usd",
      source: "coingecko-onchain-address",
      priceUsd: 1.001,
      observedAt: 1_800_000_000,
      observedAtMode: "local_fetch",
    })]);
  });
});
