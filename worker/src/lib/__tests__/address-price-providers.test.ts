import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import {
  buildAddressPriceTargets,
  collectAddressPriceProviderQuotes,
  isCoingeckoOnchainAddressEnabled,
  resolveFallbackChain,
} from "../address-price-providers";
import { runCoingeckoOnchainAddressProvider } from "../address-price-providers/coingecko-onchain";
import { finalizeAddressPriceDiagnosticAttempts } from "../address-price-providers/shared";
import { makeTarget, coingeckoResponse } from "./address-price-providers.test-support";

const LIVE_PROVIDER = "coingecko-onchain-address" as const;


afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("address price providers", () => {
  it("enables no provider when the allowlist is unset", () => {
    expect(isCoingeckoOnchainAddressEnabled({ cgApiKey: "cg" })).toBe(false);
  });

  it("retains only the explicitly allowlisted CoinGecko Onchain provider", () => {
    expect(isCoingeckoOnchainAddressEnabled({
      enabledProviders: "coingecko-onchain-address,dexpaprika-address,moralis-address",
      cgApiKey: "cg",
    })).toBe(true);
    expect(isCoingeckoOnchainAddressEnabled({
      enabledProviders: "coingecko-onchain-address",
    })).toBe(false);
    expect(isCoingeckoOnchainAddressEnabled({
      enabledProviders: "none",
      cgApiKey: "cg",
    })).toBe(false);
  });

  it("targets only missing or low-depth rows on CoinGecko-supported chains", () => {
    const targets = buildAddressPriceTargets({
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

    expect(targets).toMatchObject([{
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
      assets,
      previousAssetsById: new Map(assets.map((asset) => [asset.id, asset])),
      nowSec: 1_800_000_100,
    };

    expect(buildAddressPriceTargets({ ...shared, cohort: "coverage-refresh" })
      .map((target) => target.stablecoinId))
      .toEqual(["lane-owned", "no-price"]);
    // The hourly cohort still discovers a thin row whose fresh price comes from
    // somewhere else, because coverage depth rather than lifetime drives it.
    expect(buildAddressPriceTargets(shared).map((target) => target.stablecoinId))
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
      buildAddressPriceTargets({
        assets: [asset],
        cohort: "coverage-refresh",
        ...(hint ? { deploymentHints: new Map([[asset.id, hint]]) } : {}),
      }).map((target) => target.chain);

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
    const targets = buildAddressPriceTargets({
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
    });

    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ stablecoinId: "chain-hint", chain: "base", providerChainId: "base" }),
      expect.objectContaining({ stablecoinId: "bare-solana", chain: "solana", providerChainId: "solana" }),
    ]));
  });

  it("reports the live provider's empty and circuit-blocked branches", async () => {
    const empty = await collectAddressPriceProviderQuotes({
      targets: [],
      sourceAllowed: true,
      config: { cgApiKey: "cg" },
      nowSec: 1_800_000_000,
    });
    expect(empty.providerOutcome).toBe("success");
    expect(empty.diagnostics[0]?.stage).toBe("no-candidates");

    const blocked = await collectAddressPriceProviderQuotes({
      targets: [makeTarget()],
      sourceAllowed: false,
      config: { cgApiKey: "cg" },
      nowSec: 1_800_000_000,
    });
    expect(blocked.providerOutcome).toBe("neutral");
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
      targets: [target],
      sourceAllowed: true,
      config: { cgApiKey: "cg" },
      nowSec: 1_800_000_000,
    });

    expect(result.providerOutcome).toBe("success");
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

  it("tracks resolved and request-cap-skipped live targets through the adapter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const targets = Array.from({ length: 255 }, (_, i) => makeTarget({
      stablecoinId: `fixture-${i}`, address: `0x${i.toString(16).padStart(40, "0")}`,
    }));
    const fetch = mockFetch([{ match: () => true, respond: (request) => {
      const address = new URL(request.url).pathname.split("/tokens/multi/")[1]!.split(",")[0]!;
      return coingeckoResponse(address, "1", "75000");
    } }]);
    const pending = runCoingeckoOnchainAddressProvider(targets, "cg", undefined, 1_800_000_000, Date.now() + 60_000);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({ attemptedRequests: 5, successfulRequests: 5 });
    expect(result.diagnostics[0]?.assetAttempts?.[0]).toMatchObject({ result: "resolved", observedAt: 1_800_000_000 });
    const capped = result.diagnostics[result.diagnostics.length - 1]!;
    expect(capped.candidateCount).toBe(105);
    expect(capped.assetAttempts).toHaveLength(100);
    expect(capped.assetAttempts?.[0]).toMatchObject({ state: "skipped", skipReason: "request-cap", rejectionClass: "cap" });
  });

  it.each([
    ["404", 404, "unindexed", "success", "non-ok"],
    ["malformed JSON", 200, "{broken", "failure", "SyntaxError"],
    ["upstream failure", 500, "unavailable", "failure", "non-ok"],
  ])("preserves the outcome and failed asset evidence for %s", async (_label, status, body, outcome, errorClass) => {
    mockFetch([{ match: () => true, respond: () => new Response(body, { status }) }]);
    const result = await collectAddressPriceProviderQuotes({
      targets: [makeTarget()], sourceAllowed: true, config: { cgApiKey: "cg" }, nowSec: 1_800_000_000,
    });
    expect(result.providerOutcome).toBe(outcome);
    expect(result).toMatchObject({ attemptedRequests: 1, successfulRequests: 0 });
    expect(result.diagnostics[0]?.assetAttempts?.[0]).toMatchObject({ result: "failed", rejectionClass: errorClass });
  });

  it("keeps a deadline-skipped request neutral without attempting transport", async () => {
    const fetch = mockFetch([]);
    const result = await collectAddressPriceProviderQuotes({
      targets: [makeTarget()], sourceAllowed: true, config: { cgApiKey: "cg" }, nowSec: 1_800_000_000, budgetMs: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ providerOutcome: "neutral", attemptedRequests: 0, successfulRequests: 0 });
    expect(result.diagnostics[0]?.assetAttempts?.[0]).toMatchObject({ state: "skipped", skipReason: "deadline", rejectionClass: "timeout" });
  });

  it("marks unresolved attempts rejected from an exact shared provider rejection", () => {
    const target = makeTarget();
    const diagnostic = finalizeAddressPriceDiagnosticAttempts({
      source: LIVE_PROVIDER, stage: "primary", endpoint: "rejected", status: 200, ok: true, success: true,
      candidateCount: 1, rejectionReasonCounts: { "price-rejected": 1 },
      assetAttempts: [{ assetId: target.stablecoinId, adapter: LIVE_PROVIDER, source: LIVE_PROVIDER,
        chain: target.chain, target: target.address, state: "attempted", result: "unresolved", replaySafe: true }],
    }, []);
    expect(diagnostic.assetAttempts?.[0]).toMatchObject({ result: "rejected", rejectionClass: "price-rejected" });
  });

});
