import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAddressPriceTargetsByProvider,
  collectAddressPriceProviderQuotes,
  resolveEnabledAddressPriceProviders,
  resolveFallbackChain,
} from "../address-price-providers";
import { runAlchemyAddressProvider } from "../address-price-providers/alchemy";
import { runBirdeyeAddressProvider } from "../address-price-providers/birdeye";
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
    missingPrice: false,
    circulatingUsd: 1_000_000 - index,
    ...overrides,
  };
}

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
