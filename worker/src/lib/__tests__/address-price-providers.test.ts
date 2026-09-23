import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import {
  buildAddressPriceTargetsByProvider,
  collectAddressPriceProviderQuotes,
  resolveEnabledAddressPriceProviders,
  resolveFallbackChain,
} from "../address-price-providers";
import { runCoingeckoOnchainAddressProvider } from "../address-price-providers/coingecko-onchain";
import { makeTarget, coingeckoResponse } from "./address-price-providers.test-support";

const LIVE_PROVIDER = "coingecko-onchain-address" as const;


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

  it("refreshes the rows this lane prices before rows that only lost a price", () => {
    const assets = [
      {
        id: "lane-owned",
        symbol: "USDA",
        address: "berachain:0xff12470a969dd362eb6595ffb44c82c959fe9acc",
        price: 0.975,
        priceSource: "coingecko-onchain-address",
        priceConfidence: "fallback",
        priceObservedAt: 1_800_000_000,
      },
      {
        id: "priced-elsewhere",
        symbol: "THIN",
        address: "base:0x0000000000000000000000000000000000000001",
        price: 1,
        priceSource: "coingecko",
        priceObservedAt: 1_800_000_000,
      },
      {
        id: "no-price",
        symbol: "NONE",
        address: "base:0x0000000000000000000000000000000000000002",
        price: null,
      },
    ];
    const shared = {
      providers: [LIVE_PROVIDER] as const,
      assets,
      previousAssetsById: new Map(assets.map((asset) => [asset.id, asset])),
      nowSec: 1_800_000_100,
    };

    expect(buildAddressPriceTargetsByProvider({ ...shared, cohort: "coverage-refresh" })
      .get(LIVE_PROVIDER)?.map((target) => target.stablecoinId))
      .toEqual(["lane-owned", "no-price"]);
    // The hourly cohort still discovers a thin row whose fresh price comes from
    // somewhere else, because coverage depth rather than lifetime drives it.
    expect(buildAddressPriceTargetsByProvider(shared).get(LIVE_PROVIDER)?.map((target) => target.stablecoinId))
      .toEqual(expect.arrayContaining(["lane-owned", "priced-elsewhere", "no-price"]));
  });

  it("narrows a hinted row to its last successful deployment and ignores unknown hints", () => {
    const asset = {
      id: "lane-owned",
      symbol: "USDA",
      address: "0x0000000000000000000000000000000000000003",
      chains: ["ethereum", "base"],
      price: 0.975,
      priceSource: "coingecko-onchain-address",
      priceConfidence: "fallback",
      priceObservedAt: 1_800_000_000,
    };
    const targetChains = (hint?: { chain: string; address: string }) =>
      buildAddressPriceTargetsByProvider({
        providers: [LIVE_PROVIDER],
        assets: [asset],
        cohort: "coverage-refresh",
        ...(hint ? { deploymentHints: new Map([[asset.id, hint]]) } : {}),
      }).get(LIVE_PROVIDER)?.map((target) => target.chain);

    expect(targetChains()).toEqual(["base", "ethereum"]);
    expect(targetChains({ chain: "base", address: asset.address })).toEqual(["base"]);
    // A hint the canonical metadata no longer lists never invents a target.
    expect(targetChains({ chain: "solana", address: asset.address })).toEqual(["base", "ethereum"]);
    expect(targetChains({ chain: "base", address: "0x0000000000000000000000000000000000000004" }))
      .toEqual(["base", "ethereum"]);
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
      respond: () => coingeckoResponse(target.address, "1.001", "75000"),
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
      respond: () => coingeckoResponse(target.address, "1.001", "75000", "10000"),
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
  it("rejects an unreviewed CoinGecko quote without parseable liquidity", async () => {
    const target = makeTarget();
    mockFetch([{
      match: () => true,
      body: {
        data: [{
          attributes: {
            address: target.address,
            price_usd: "1.001",
          },
        }],
      },
    }]);

    const result = await runCoingeckoOnchainAddressProvider(
      [target],
      "cg-key",
      undefined,
      1_800_000_000,
      Date.now() + 60_000,
    );

    expect(result.quotes).toEqual([]);
    expect(result.rejectedTargets).toEqual({ "missing-liquidity": 1 });
  });

});
