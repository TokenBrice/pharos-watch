import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import {
  buildAddressPriceTargetsByProvider,
  collectAddressPriceProviderQuotes,
  resolveEnabledAddressPriceProviders,
  resolveFallbackChain,
} from "../address-price-providers";
import { runCoingeckoOnchainAddressProvider } from "../address-price-providers/coingecko-onchain";
import type { AddressPriceTarget } from "../address-price-providers";

const LIVE_PROVIDER = "coingecko-onchain-address" as const;

function makeTarget(overrides: Partial<AddressPriceTarget> = {}): AddressPriceTarget {
  return {
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
    ...overrides,
  };
}

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

  it("builds targets from explicit chain hints and bare Solana addresses", () => {
    const targets = buildAddressPriceTargetsByProvider({
      providers: [LIVE_PROVIDER],
      assets: [
        {
          id: "chain-hint",
          symbol: "CHAIN",
          address: "0x0000000000000000000000000000000000000003",
          chains: ["Base"],
        },
        {
          id: "bare-solana",
          symbol: "SOL",
          address: "So11111111111111111111111111111111111111112",
        },
      ],
    }).get(LIVE_PROVIDER);

    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ stablecoinId: "chain-hint", chain: "base", providerChainId: "base" }),
      expect.objectContaining({ stablecoinId: "bare-solana", chain: "solana", providerChainId: "solana" }),
    ]));
  });

  it("reports the live provider's empty and circuit-blocked branches", async () => {
    const empty = await collectAddressPriceProviderQuotes({
      targetsByProvider: new Map(),
      providers: [LIVE_PROVIDER],
      sourceAllowed: { [LIVE_PROVIDER]: true },
      config: { cgApiKey: "cg" },
      nowSec: 1_800_000_000,
    });
    expect(empty.providerOutcomes.get(LIVE_PROVIDER)).toBe("success");
    expect(empty.diagnostics[0]?.stage).toBe("no-candidates");

    const blocked = await collectAddressPriceProviderQuotes({
      targetsByProvider: new Map([[LIVE_PROVIDER, [makeTarget()]]]),
      providers: [LIVE_PROVIDER],
      sourceAllowed: { [LIVE_PROVIDER]: false },
      config: { cgApiKey: "cg" },
      nowSec: 1_800_000_000,
    });
    expect(blocked.providerOutcomes.get(LIVE_PROVIDER)).toBe("neutral");
    expect(blocked.diagnostics[0]?.assetAttempts?.[0]).toMatchObject({
      state: "skipped",
      skipReason: "circuit-open",
    });
  });

  it("collects successful quotes through the live single-provider path", async () => {
    const target = makeTarget();
    mockFetch([{
      match: () => true,
      respond: () => Response.json({
        data: [{
          attributes: {
            address: target.address,
            price_usd: "1.001",
            total_reserve_in_usd: "75000",
          },
        }],
      }),
    }]);

    const result = await collectAddressPriceProviderQuotes({
      targetsByProvider: new Map([[LIVE_PROVIDER, [target]]]),
      providers: [LIVE_PROVIDER],
      sourceAllowed: { [LIVE_PROVIDER]: true },
      config: { cgApiKey: "cg" },
      nowSec: 1_800_000_000,
    });

    expect(result.providerOutcomes.get(LIVE_PROVIDER)).toBe("success");
    expect(result.quotesByStablecoinId.get(target.stablecoinId)).toEqual([
      expect.objectContaining({ source: LIVE_PROVIDER, priceUsd: 1.001 }),
    ]);
  });

  it("fetches the retained exact-address provider with local-fetch provenance", async () => {
    const target = makeTarget();
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
