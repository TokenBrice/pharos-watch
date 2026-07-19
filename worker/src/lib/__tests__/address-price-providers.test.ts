import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAddressPriceTargetsByProvider,
  collectAddressPriceProviderQuotes,
  resolveEnabledAddressPriceProviders,
  resolveFallbackChain,
  rotateAddressPriceTargets,
} from "../address-price-providers";
import { runAlchemyAddressProvider } from "../address-price-providers/alchemy";
import { runBirdeyeAddressProvider } from "../address-price-providers/birdeye";
import { runCoingeckoOnchainAddressProvider } from "../address-price-providers/coingecko-onchain";
import { runDexPaprikaAddressProvider } from "../address-price-providers/dexpaprika";
import { runDexScreenerAddressProvider } from "../address-price-providers/dexscreener";
import { emptyProviderResult } from "../address-price-providers/shared";
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
    previousMissingGenerations: 0,
    alertEligibleMissingPrice: false,
    recentlyMissingPrice: false,
    missingPrice: false,
    expiresBeforeNextGeneration: false,
    circulatingUsd: 1_000_000 - index,
    ...overrides,
  };
}

const PUBLISHABLE_PRICE_META = {
  priceSource: "coingecko",
  priceObservedAt: 1_800_000_000,
} as const;

describe("address price providers", () => {
  it("auto-enables the stable no-key provider plus configured key-backed providers", () => {
    expect(resolveEnabledAddressPriceProviders({
      cgApiKey: "cg",
      moralisApiKey: "moralis",
      birdeyeApiKey: "birdeye",
    })).toEqual([
      "dexpaprika-address",
      "coingecko-onchain-address",
      "moralis-address",
      "birdeye-address",
    ]);
  });

  it("treats bare 0x fallback addresses as undecidable and solana otherwise", () => {
    expect(resolveFallbackChain("0x0000000000000000000000000000000000000001")).toBeNull();
    expect(resolveFallbackChain("So11111111111111111111111111111111111111112")).toBe("solana");
  });

  it("honors explicit allowlists, including DexScreener opt-in, and skips providers with missing credentials", () => {
    expect(resolveEnabledAddressPriceProviders({
      enabledProviders: "dexscreener-address,moralis-address,dexpaprika-address,birdeye-address",
      moralisApiKey: "moralis",
    })).toEqual(["dexscreener-address", "moralis-address", "dexpaprika-address"]);
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
          ...PUBLISHABLE_PRICE_META,
        },
        {
          id: "covered",
          symbol: "CUSD",
          address: "base:0x0000000000000000000000000000000000000002",
          chains: ["Base"],
          price: 1,
          ...PUBLISHABLE_PRICE_META,
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

  it("skips bare 0x asset addresses when no chain or deployment metadata exists", () => {
    const targets = buildAddressPriceTargetsByProvider({
      providers: ["dexpaprika-address", "moralis-address"],
      assets: [
        {
          id: "bare-evm-unknown-chain",
          symbol: "B0X",
          address: "0x0000000000000000000000000000000000000001",
          price: 0,
        },
      ],
    });

    expect(targets.get("dexpaprika-address")).toEqual([]);
    expect(targets.get("moralis-address")).toEqual([]);
  });

  it("prioritizes missing prices before low-depth priced rows, then material source-depth gaps", () => {
    const targets = buildAddressPriceTargetsByProvider({
      providers: ["dexpaprika-address"],
      previousAssetsById: new Map([
        ["low-depth-large", { id: "low-depth-large", symbol: "LDL", consensusSources: ["coingecko", "defillama-list"] }],
        ["low-depth-small", { id: "low-depth-small", symbol: "LDS", consensusSources: ["coingecko"] }],
        ["missing", { id: "missing", symbol: "MISS", consensusSources: ["coingecko", "defillama-list"] }],
      ]),
      assets: [
        {
          id: "low-depth-small",
          symbol: "LDS",
          address: "base:0x0000000000000000000000000000000000000001",
          price: 1,
          ...PUBLISHABLE_PRICE_META,
          circulating: { base: 100_000 },
        },
        {
          id: "missing",
          symbol: "MISS",
          address: "base:0x0000000000000000000000000000000000000002",
          price: 0,
          circulating: { base: 10_000 },
        },
        {
          id: "low-depth-large",
          symbol: "LDL",
          address: "base:0x0000000000000000000000000000000000000003",
          price: 1,
          ...PUBLISHABLE_PRICE_META,
          circulating: { base: 10_000_000 },
        },
      ],
    });

    expect(targets.get("dexpaprika-address")?.map((target) => target.stablecoinId)).toEqual([
      "missing",
      "low-depth-large",
      "low-depth-small",
    ]);
  });

  it("treats positive prices without publication provenance as missing exact-address targets", () => {
    const targets = buildAddressPriceTargetsByProvider({
      providers: ["dexpaprika-address"],
      previousAssetsById: new Map([
        ["numeric-without-source", {
          id: "numeric-without-source",
          symbol: "NWS",
          consensusSources: ["coingecko", "defillama-list", "coinbase"],
        }],
        ["refresh", { id: "refresh", symbol: "REF", consensusSources: ["coingecko"] }],
      ]),
      assets: [
        {
          id: "refresh",
          symbol: "REF",
          address: "base:0x0000000000000000000000000000000000000001",
          price: 1,
          ...PUBLISHABLE_PRICE_META,
          circulating: { base: 10_000_000 },
        },
        {
          id: "numeric-without-source",
          symbol: "NWS",
          address: "base:0x0000000000000000000000000000000000000002",
          price: 1,
          circulating: { base: 100_000 },
        },
      ],
    });

    expect(targets.get("dexpaprika-address")?.map((target) => ({
      id: target.stablecoinId,
      missing: target.missingPrice,
    }))).toEqual([
      { id: "numeric-without-source", missing: true },
      { id: "refresh", missing: false },
    ]);
  });

  it("orders expiring thin-coverage rows first without re-targeting deep high-confidence assets", () => {
    const nowSec = 1_800_000_000;
    const targets = buildAddressPriceTargetsByProvider({
      providers: ["dexpaprika-address"],
      nowSec,
      previousAssetsById: new Map([
        ["deep-expiring", {
          id: "deep-expiring",
          symbol: "EXP",
          consensusSources: ["coingecko", "defillama-list", "coinbase"],
          priceSource: "coingecko",
          priceObservedAt: nowSec,
        }],
        ["thin-expiring", {
          id: "thin-expiring",
          symbol: "TEX",
          consensusSources: ["coingecko"],
          priceSource: "coingecko",
          priceObservedAt: nowSec,
        }],
        ["low-depth", { id: "low-depth", symbol: "LOW", consensusSources: ["coingecko"] }],
      ]),
      assets: [
        {
          id: "low-depth",
          symbol: "LOW",
          address: "base:0x0000000000000000000000000000000000000001",
          price: 1,
          ...PUBLISHABLE_PRICE_META,
        },
        {
          id: "deep-expiring",
          symbol: "EXP",
          address: "base:0x0000000000000000000000000000000000000002",
          price: 1,
          ...PUBLISHABLE_PRICE_META,
        },
        {
          id: "thin-expiring",
          symbol: "TEX",
          address: "base:0x0000000000000000000000000000000000000003",
          price: 1,
          ...PUBLISHABLE_PRICE_META,
        },
      ],
    });

    // A deep, high-confidence asset is not re-targeted merely because a
    // short-window composite member makes its price look expiring — that rule
    // would re-target every oracle-covered major each run and append a
    // non-replay-safe lane to their consensus provenance. Expiring still
    // orders cohorts among rows included for thin coverage.
    expect(targets.get("dexpaprika-address")?.map((target) => ({
      id: target.stablecoinId,
      expiring: target.expiresBeforeNextGeneration,
    }))).toEqual([
      { id: "thin-expiring", expiring: true },
      { id: "low-depth", expiring: false },
    ]);
  });

  it("pins persistent active price gaps ahead of broader exact-address refresh targets", () => {
    const targets = buildAddressPriceTargetsByProvider({
      providers: ["dexpaprika-address"],
      previousAssetsById: new Map([
        ["persistent-gap", {
          id: "persistent-gap",
          symbol: "GAP",
          consensusSources: ["coingecko", "defillama-list", "coinbase"],
        }],
        ["new-gap", {
          id: "new-gap",
          symbol: "NEW",
          consensusSources: ["coingecko", "defillama-list", "coinbase"],
        }],
        ["refresh", {
          id: "refresh",
          symbol: "REF",
          consensusSources: ["coingecko"],
        }],
      ]),
      previousMissingGenerationsById: new Map([["persistent-gap", 1]]),
      assets: [
        {
          id: "refresh",
          symbol: "REF",
          address: "base:0x0000000000000000000000000000000000000001",
          price: 1,
          ...PUBLISHABLE_PRICE_META,
          circulating: { base: 10_000_000 },
        },
        {
          id: "new-gap",
          symbol: "NEW",
          address: "base:0x0000000000000000000000000000000000000002",
          price: null,
          circulating: { base: 100_000_000 },
        },
        {
          id: "persistent-gap",
          symbol: "GAP",
          address: "base:0x0000000000000000000000000000000000000003",
          price: null,
          circulating: { base: 10_000 },
        },
      ],
    });

    expect(targets.get("dexpaprika-address")?.map((target) => ({
      id: target.stablecoinId,
      previousMissingGenerations: target.previousMissingGenerations,
      alertEligibleMissingPrice: target.alertEligibleMissingPrice,
    }))).toEqual([
      { id: "persistent-gap", previousMissingGenerations: 1, alertEligibleMissingPrice: true },
      { id: "new-gap", previousMissingGenerations: 0, alertEligibleMissingPrice: false },
      { id: "refresh", previousMissingGenerations: 0, alertEligibleMissingPrice: false },
    ]);
  });

  it("rotates targets within priority cohorts without moving priced rows ahead of missing assets", () => {
    const targets = [
      makeDexScreenerTarget(1, { stablecoinId: "missing-large", missingPrice: true }),
      makeDexScreenerTarget(2, { stablecoinId: "missing-small", missingPrice: true }),
      makeDexScreenerTarget(3, { stablecoinId: "expiring", expiresBeforeNextGeneration: true, previousSourceDepth: 3 }),
      makeDexScreenerTarget(4, { stablecoinId: "priced-low-depth", previousSourceDepth: 1 }),
      makeDexScreenerTarget(5, { stablecoinId: "priced-covered", previousSourceDepth: 3 }),
    ];

    expect(rotateAddressPriceTargets(targets, 3).map((target) => target.stablecoinId)).toEqual([
      "missing-small",
      "missing-large",
      "expiring",
      "priced-low-depth",
      "priced-covered",
    ]);
  });

  it("keeps alert-eligible gaps pinned ahead of rotated missing cohorts", () => {
    const targets = [
      makeDexScreenerTarget(1, { stablecoinId: "alert-gap", missingPrice: true, previousMissingGenerations: 1, alertEligibleMissingPrice: true, recentlyMissingPrice: true }),
      makeDexScreenerTarget(2, { stablecoinId: "missing-large", missingPrice: true }),
      makeDexScreenerTarget(3, { stablecoinId: "missing-small", missingPrice: true }),
      makeDexScreenerTarget(4, { stablecoinId: "priced-low-depth", previousSourceDepth: 1 }),
    ];

    expect(rotateAddressPriceTargets(targets, 2).map((target) => target.stablecoinId)).toEqual([
      "alert-gap",
      "missing-large",
      "missing-small",
      "priced-low-depth",
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
          ...PUBLISHABLE_PRICE_META,
        },
        {
          id: "solana-only",
          symbol: "SO",
          address: "solana:So11111111111111111111111111111111111111112",
          chains: ["Solana"],
          price: 1,
          ...PUBLISHABLE_PRICE_META,
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

  it("queries Birdeye Solana targets through the Standard-compatible price endpoint", async () => {
    const target = makeDexScreenerTarget(0, {
      chain: "solana",
      providerChainId: "solana",
      address: "So11111111111111111111111111111111111111112",
    });
    let requestedUrl: string | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        success: true,
        data: {
          value: "1.001",
          liquidity: "75000",
          updateUnixTime: 1_700_000_000,
          priceChange24h: 0.02,
          priceInNative: 0.004,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBirdeyeAddressProvider(
      [target],
      { birdeyeApiKey: "test-key" },
      undefined,
      Date.now() + 60_000,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(requestedUrl ?? "");
    expect(requestUrl.pathname).toBe("/defi/price");
    expect(requestUrl.searchParams.get("address")).toBe(target.address);
    expect(requestUrl.searchParams.get("include_liquidity")).toBe("true");
    expect(result.attemptedRequests).toBe(1);
    expect(result.successfulRequests).toBe(1);
    expect(result.quotes).toMatchObject([
      {
        stablecoinId: target.stablecoinId,
        source: "birdeye-address",
        chain: "solana",
        address: target.address,
        priceUsd: 1.001,
        observedAt: 1_700_000_000,
        observedAtMode: "upstream",
        liquidityUsd: 75_000,
        metadata: {
          providerChainId: "solana",
          priceChange24h: 0.02,
          priceInNative: 0.004,
        },
      },
    ]);
    expect(result.rejectedTargets).toEqual({});
    expect(result.diagnostics).toMatchObject([
      {
        source: "birdeye-address",
        status: 200,
        ok: true,
        success: true,
        candidateCount: 1,
        responseRowCount: 1,
        matchedCount: 1,
      },
    ]);
  });

  it("treats Birdeye null price payloads as coverage misses instead of provider failures", async () => {
    const target = makeDexScreenerTarget(0, {
      chain: "solana",
      providerChainId: "solana",
      address: "So11111111111111111111111111111111111111112",
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBirdeyeAddressProvider(
      [target],
      { birdeyeApiKey: "test-key" },
      undefined,
      Date.now() + 60_000,
    );

    expect(result.attemptedRequests).toBe(1);
    expect(result.successfulRequests).toBe(1);
    expect(result.quotes).toEqual([]);
    expect(result.rejectedTargets).toEqual({ "missing-quote": 1 });
    expect(result.diagnostics).toMatchObject([
      {
        source: "birdeye-address",
        status: 200,
        ok: true,
        success: true,
        candidateCount: 1,
        responseRowCount: 0,
        matchedCount: 0,
        rejectionReasonCounts: { "missing-quote": 1 },
      },
    ]);
  });

  it("treats Birdeye 200-level error payloads as provider failures", async () => {
    const target = makeDexScreenerTarget(0, {
      chain: "solana",
      providerChainId: "solana",
      address: "So11111111111111111111111111111111111111112",
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, message: "Invalid API key", data: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBirdeyeAddressProvider(
      [target],
      { birdeyeApiKey: "test-key" },
      undefined,
      Date.now() + 60_000,
    );

    expect(result.attemptedRequests).toBe(1);
    expect(result.successfulRequests).toBe(0);
    expect(result.quotes).toEqual([]);
    expect(result.rejectedTargets).toEqual({});
    expect(result.diagnostics).toMatchObject([
      {
        source: "birdeye-address",
        status: 200,
        ok: true,
        success: false,
        errorClass: "invalid-shape",
        errorMessage: "Expected Birdeye price data object",
        rejectionReasonCounts: { "invalid-shape": 1 },
      },
    ]);
  });

  it("stops Birdeye requests after provider-wide compute-unit exhaustion", async () => {
    const targets = [0, 1, 2].map((index) => makeDexScreenerTarget(index, {
      chain: "solana",
      providerChainId: "solana",
      address: `So1111111111111111111111111111111111111111${index}`,
    }));
    const fetchMock = vi.fn(async () =>
      new Response("Compute units usage limit exceeded", { status: 400 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBirdeyeAddressProvider(
      targets,
      { birdeyeApiKey: "test-key" },
      undefined,
      Date.now() + 60_000,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.attemptedRequests).toBe(1);
    expect(result.successfulRequests).toBe(0);
    expect(result.quotes).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      source: "birdeye-address",
      status: 400,
      success: false,
      errorClass: "quota-exhausted",
      snippet: "Compute units usage limit exceeded",
    });
    expect(result.diagnostics[1]).toMatchObject({
      endpoint: "birdeye-address:request-cap",
      errorClass: "cap",
      candidateCount: 2,
    });
  });

  it("stops Birdeye requests after the first HTTP 429", async () => {
    const targets = [0, 1].map((index) => makeDexScreenerTarget(index, {
      chain: "solana",
      providerChainId: "solana",
      address: `So1111111111111111111111111111111111111111${index}`,
    }));
    const fetchMock = vi.fn(async () =>
      new Response("Too many requests", {
        status: 429,
        headers: { "Retry-After": "60" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBirdeyeAddressProvider(
      targets,
      { birdeyeApiKey: "test-key" },
      undefined,
      Date.now() + 60_000,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.attemptedRequests).toBe(1);
    expect(result.successfulRequests).toBe(0);
    expect(result.diagnostics[0]).toMatchObject({
      status: 429,
      success: false,
      errorClass: "quota-exhausted",
      retryAfterSec: 60,
    });
    expect(result.diagnostics[1]).toMatchObject({
      endpoint: "birdeye-address:request-cap",
      candidateCount: 1,
    });
  });

  it("reports Birdeye targets skipped by the request cap", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({
          success: true,
          data: {
            value: "1.001",
            liquidity: "75000",
            updateUnixTime: 1_700_000_000,
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const resultPromise = runBirdeyeAddressProvider(
        Array.from({ length: 11 }, (_, index) => makeDexScreenerTarget(index, {
          chain: "solana",
          providerChainId: "solana",
          address: `So1111111111111111111111111111111111111111${index}`,
        })),
        { birdeyeApiKey: "test-key" },
        undefined,
        Number.MAX_SAFE_INTEGER,
      );
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(fetchMock).toHaveBeenCalledTimes(10);
      expect(result.diagnostics[result.diagnostics.length - 1]).toMatchObject({
        source: "birdeye-address",
        endpoint: "birdeye-address:request-cap",
        errorClass: "cap",
        candidateCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("redacts the Alchemy API key from retry logs while fetching with the real endpoint", async () => {
    const target = makeDexScreenerTarget(0);
    const secret = "ALCH_SECRET_123/plus+space value";
    const encodedSecret = encodeURIComponent(secret);
    const fetchMock = vi.fn(async () => new Response("upstream error", { status: 520 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const result = await runAlchemyAddressProvider(
      [target],
      { alchemyApiKey: secret },
      undefined,
      Date.now() + 60_000,
    );

    expect(result.attemptedRequests).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.g.alchemy.com/prices/v1/${encodedSecret}/tokens/by-address`,
      expect.any(Object),
    );
    const warnOutput = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(warnOutput).toContain("https://api.g.alchemy.com/prices/v1/<api-key>/tokens/by-address");
    expect(warnOutput).not.toContain(secret);
    expect(warnOutput).not.toContain(encodedSecret);
    warnSpy.mockRestore();
  });

  it("reports Alchemy targets skipped by the request cap", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runAlchemyAddressProvider(
      Array.from({ length: 501 }, (_, index) => makeDexScreenerTarget(index)),
      { alchemyApiKey: "alchemy-key" },
      undefined,
      Date.now() + 60_000,
    );

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(result.diagnostics[result.diagnostics.length - 1]).toMatchObject({
      source: "alchemy-address",
      endpoint: "alchemy-address:request-cap",
      errorClass: "cap",
      candidateCount: 1,
    });
  });

  it("reports CoinGecko onchain targets skipped by the request cap", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      vi.stubGlobal("fetch", fetchMock);

      const resultPromise = runCoingeckoOnchainAddressProvider(
        Array.from({ length: 151 }, (_, index) => makeDexScreenerTarget(index)),
        null,
        undefined,
        1_700_000_000,
        Number.MAX_SAFE_INTEGER,
      );
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(result.diagnostics[result.diagnostics.length - 1]).toMatchObject({
        source: "coingecko-onchain-address",
        endpoint: "coingecko-onchain-address:request-cap",
        errorClass: "cap",
        candidateCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
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
    expect(result.successfulRequests).toBe(1);
  });

  it("averages the two middle DexScreener address prices for even pool counts", async () => {
    const target = makeDexScreenerTarget(0, {
      stablecoinId: "even-median",
      symbol: "USDV",
      address: "0x0000000000000000000000000000000000000001",
    });
    const pair = (priceUsd: string, pairAddress: string) => ({
      chainId: "base",
      dexId: "uniswap",
      pairAddress,
      baseToken: { address: target.address, name: "Verified USD", symbol: "USDV" },
      quoteToken: { address: "0x0000000000000000000000000000000000000002", name: "USD Coin", symbol: "USDC" },
      priceUsd,
      priceNative: null,
      volume: { h24: 10_000, h6: 0, h1: 0, m5: 0 },
      liquidity: { usd: 100_000, base: 50_000, quote: 50_000 },
      pairCreatedAt: null,
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      pair("0.99", "0xpair1"),
      pair("1.01", "0xpair2"),
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runDexScreenerAddressProvider(
      [target],
      undefined,
      1_700_000_000,
      Date.now() + 60_000,
    );

    expect(result.quotes).toHaveLength(1);
    // Canonical median averages the two middle quotes: (0.99 + 1.01) / 2.
    expect(result.quotes[0]?.priceUsd).toBe(1.0);
  });

  it("snapshots DexScreener address rejection counts on diagnostics", async () => {
    const matchedTarget = makeDexScreenerTarget(0, {
      stablecoinId: "matched",
      symbol: "USDV",
      address: "0x0000000000000000000000000000000000000001",
    });
    const missingTarget = makeDexScreenerTarget(1, {
      stablecoinId: "missing",
      symbol: "USDV",
      address: "0x0000000000000000000000000000000000000003",
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        chainId: "base",
        dexId: "uniswap",
        pairAddress: "0xpair1",
        baseToken: { address: matchedTarget.address, name: "Verified USD", symbol: "USDV" },
        quoteToken: { address: "0x0000000000000000000000000000000000000002", name: "USD Coin", symbol: "USDC" },
        priceUsd: "1.00",
        priceNative: null,
        volume: { h24: 10_000, h6: 0, h1: 0, m5: 0 },
        liquidity: { usd: 100_000, base: 50_000, quote: 50_000 },
        pairCreatedAt: null,
      },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runDexScreenerAddressProvider(
      [matchedTarget, missingTarget],
      undefined,
      1_700_000_000,
      Date.now() + 60_000,
    );

    const diagnosticRejections = result.diagnostics[0]?.rejectionReasonCounts;
    expect(result.rejectedTargets).toEqual({ "missing-quote": 1 });
    expect(diagnosticRejections).toEqual({ "missing-quote": 1 });
    expect(diagnosticRejections).not.toBe(result.rejectedTargets);

    result.rejectedTargets["missing-quote"] = 99;
    expect(diagnosticRejections).toEqual({ "missing-quote": 1 });
  });

  it("does not continue DexScreener address batches after an upstream refusal", async () => {
    const fetchMock = vi.fn(async () => new Response("forbidden", { status: 403 }));
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
        status: 403,
        success: false,
        rejectionReasonCounts: { "non-ok": 1 },
      },
      {
        source: "dexscreener-address",
        errorClass: "cap",
        candidateCount: 30,
      },
    ]);
  });

  it("reports DexPaprika request-cap skips without raising the cap", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      address: "0x0000000000000000000000000000000000000000",
      summary: { price_usd: 1, liquidity_usd: 100_000 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runDexPaprikaAddressProvider(
      Array.from({ length: 61 }, (_, index) => makeDexScreenerTarget(index, {
        address: `0x${"0".repeat(39)}${(index % 10).toString(16)}`,
      })),
      undefined,
      Date.now() + 60_000,
    );

    expect(fetchMock).toHaveBeenCalledTimes(60);
    expect(result.diagnostics[result.diagnostics.length - 1]).toMatchObject({
      source: "dexpaprika-address",
      endpoint: "dexpaprika-address:request-cap",
      errorClass: "cap",
      candidateCount: 1,
    });
  });

  it("marks malformed DexPaprika token details as invalid shape diagnostics", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(["not", "a", "token"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runDexPaprikaAddressProvider(
      [makeDexScreenerTarget(1)],
      undefined,
      Date.now() + 60_000,
    );

    expect(result.attemptedRequests).toBe(1);
    expect(result.successfulRequests).toBe(0);
    expect(result.quotes).toEqual([]);
    expect(result.diagnostics).toMatchObject([
      {
        source: "dexpaprika-address",
        ok: true,
        success: false,
        rejectionReasonCounts: { "invalid-shape": 1 },
      },
    ]);
  });

  it("skips durable DexPaprika 404 negatives without opening a request", async () => {
    const target = makeDexScreenerTarget(1);
    const targetKey = `${target.providerChainId}:${target.address.toLowerCase()}`;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => sql.includes("pricing_provider_runtime_state") ? null : null),
          all: vi.fn(async () => sql.includes("pricing_provider_negative_cache")
            ? { results: [{ target_key: targetKey }] }
            : { results: [] }),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        })),
      })),
    } as unknown as D1Database;

    const result = await runDexPaprikaAddressProvider(
      [target],
      undefined,
      Date.now() + 60_000,
      { db, nowSec: 1_700_000_000 },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.attemptedRequests).toBe(0);
    expect(result.diagnostics[0]).toMatchObject({
      endpoint: "dexpaprika-address:negative-cache",
      status: 404,
      candidateCount: 1,
    });
  });

  it("honors Retry-After by stopping a DexPaprika run after the first 429", async () => {
    const fetchMock = vi.fn(async () => new Response("slow down", {
      status: 429,
      headers: { "Retry-After": "120" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const writes: unknown[][] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...binds: unknown[]) => ({
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => {
            writes.push([sql, ...binds]);
            return { meta: { changes: 1 } };
          }),
        })),
      })),
    } as unknown as D1Database;

    const result = await runDexPaprikaAddressProvider(
      [makeDexScreenerTarget(1), makeDexScreenerTarget(2)],
      undefined,
      Date.now() + 60_000,
      { db, nowSec: 1_700_000_000 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.attemptedRequests).toBe(1);
    expect(result.diagnostics[0]).toMatchObject({ status: 429, retryAfterSec: 120 });
    expect(writes.some(([sql]) => String(sql).includes("pricing_provider_runtime_state"))).toBe(true);
  });

  it("keeps blocked address providers neutral for circuit-breaker accounting", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectAddressPriceProviderQuotes({
      targetsByProvider: new Map([[
        "dexscreener-address",
        [makeDexScreenerTarget(1)],
      ]]),
      providers: ["dexscreener-address"],
      sourceAllowed: {
        "alchemy-address": true,
        "moralis-address": true,
        "dexscreener-address": false,
        "dexpaprika-address": true,
        "coingecko-onchain-address": true,
        "birdeye-address": true,
      },
      config: {},
      nowSec: 1_700_000_000,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.providerOutcomes.get("dexscreener-address")).toBe("neutral");
    expect(result.diagnostics).toMatchObject([
      {
        source: "dexscreener-address",
        errorClass: "blocked",
        success: false,
      },
    ]);
  });

  it("marks empty provider results as unsuccessful diagnostics without request attempts", () => {
    const result = emptyProviderResult("moralis-address", 2, "missing-provider");

    expect(result).toMatchObject({
      quotes: [],
      attemptedRequests: 0,
      successfulRequests: 0,
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        source: "moralis-address",
        ok: false,
        success: false,
        candidateCount: 2,
        rejectionReasonCounts: { "missing-provider": 2 },
      }),
    ]);
  });
});
