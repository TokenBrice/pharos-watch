import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../../test-helpers/cron";
import type * as FetchRetry from "../../../../lib/fetch-retry";
import usdy from "@shared/data/stablecoins/coins/usdy-ondo-finance.json";
import usyc from "@shared/data/stablecoins/coins/usyc-hashnote.json";
import reusd from "@shared/data/stablecoins/coins/reusd-re-protocol.json";
import usp from "@shared/data/stablecoins/coins/usp-pikudao.json";
import usd3 from "@shared/data/stablecoins/coins/usd3-reserve-protocol.json";

const fetchWithRetryMock = vi.fn();
const probeTrackedTokenSupplyMock = vi.fn();
const fetchErc20TotalSupplyMock = vi.fn();
const resolveVaultNavSupplyPriceMock = vi.fn();

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [
    {
      id: "ftusd-flying-tulip",
      name: "Flying Tulip USD",
      symbol: "ftUSD",
      geckoId: "flying-tulip-usd",
      detailProvider: "coingecko",
      contracts: [
        { chain: "ethereum", address: "0xf7d85ec4e7710f71992752eac2111312e73e9c9c", decimals: 6 },
        { chain: "sonic", address: "0xf7d85ec4e7710f71992752eac2111312e73e9c9c", decimals: 6 },
      ],
      flags: {
        pegCurrency: "USD",
        backing: "crypto-backed",
        governance: "centralized-dependent",
        yieldBearing: false,
        navToken: false,
      },
    },
    {
      id: "susds-sky",
      name: "Savings USDS",
      symbol: "sUSDS",
      geckoId: "susds",
      detailProvider: "coingecko",
      contracts: [
        { chain: "ethereum", address: "0x1111111111111111111111111111111111111111", decimals: 18 },
      ],
      flags: {
        pegCurrency: "USD",
        backing: "rwa-backed",
        governance: "centralized",
        yieldBearing: true,
        navToken: true,
      },
    },
    {
      id: "fiusd-sygnum",
      name: "Sygnum FIUSD Liquidity Fund Token",
      symbol: "FIUSD",
      geckoId: "sygnum-fiusd-liquidity-fund",
      detailProvider: "coingecko",
      contracts: [
        { chain: "zksync", address: "0x2ab105a3ead22731082b790ca9a00d9a3a7627f9", decimals: 2 },
        { chain: "arbitrum", address: "0xcded6b899edba762d793f44ed295248049440e1e", decimals: 2 },
      ],
      flags: {
        pegCurrency: "USD", backing: "rwa-backed", governance: "centralized",
        yieldBearing: true, navToken: true,
      },
    },
    {
      id: "aa-falconx-mev-capital", name: "Pareto FalconX Credit Vault", symbol: "AA_FalconXUSDC",
      detailProvider: "coingecko",
      contracts: [{ chain: "ethereum", address: "0xc26a6fa2c37b38e549a4a1807543801db684f99c", decimals: 18 }],
      flags: { pegCurrency: "USD", backing: "rwa-backed", governance: "centralized-dependent", yieldBearing: true, navToken: true },
    },
    {
      id: "zsd-zephyr-protocol", name: "Zephyr Stable Dollar", symbol: "ZSD",
      geckoId: "zephyr-protocol-stable-dollar", detailProvider: "coingecko",
      flags: { pegCurrency: "USD", backing: "crypto-backed", governance: "decentralized", yieldBearing: false, navToken: false },
    },
    {
      id: "zys-zephyr-protocol", name: "Zephyr Yield Share", symbol: "ZYS", detailProvider: "coingecko",
      flags: { pegCurrency: "USD", backing: "crypto-backed", governance: "decentralized", yieldBearing: true, navToken: true },
    },
    { ...usdy, flags: { ...usdy.flags, pegCurrency: "USD" } },
    ...[usyc, reusd, usp, usd3].map((meta) => ({ ...meta, flags: { ...meta.flags, pegCurrency: "USD" } })),
  ],
}));

vi.mock("../../../../lib/fetch-retry", async (importOriginal) => ({
  ...(await importOriginal<typeof FetchRetry>()),
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  fetchTextWithRetry: async (...args: unknown[]) => {
    const response = await fetchWithRetryMock(...args);
    if (!response) return null;
    return { response, body: await response.text() };
  },
}));

vi.mock("../../../reserve-adapters/helpers", () => ({
  fetchOnchainUint256: vi.fn(),
  fetchErc20TotalSupply: (...args: unknown[]) => fetchErc20TotalSupplyMock(...args),
  probeTrackedTokenSupply: (...args: unknown[]) => probeTrackedTokenSupplyMock(...args),
}));

vi.mock("../../../../lib/authoritative-price-sources", () => ({
  resolveVaultNavSupplyPrice: (...args: unknown[]) => resolveVaultNavSupplyPriceMock(...args),
}));

import { fetchFiatCoinGeckoTokens, FIAT_CG_METAS } from "../fiat-cg";
import { applyConsensusResults, createValidationContextResolver } from "../../pricing";
import { normalizeStablecoinsPayload } from "../../shared";
import { validatePublishedAssetPrice } from "../../../../lib/price-publish-policy";

describe("fetchFiatCoinGeckoTokens", () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    probeTrackedTokenSupplyMock.mockReset();
    fetchErc20TotalSupplyMock.mockReset();
    resolveVaultNavSupplyPriceMock.mockReset().mockResolvedValue(null);
  });

  it("publishes USDY from its configured supplemental source when the DefiLlama list omits it", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const marketCap = 2_356_848_686.3214035;
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchFiatCoinGeckoTokens({
      "ondo-us-dollar-yield": {
        usd: 1.15,
        usd_market_cap: marketCap,
        last_updated_at: nowSec,
      },
    });

    expect(result.find((asset) => asset.id === "usdy-ondo-finance")).toMatchObject({
      id: "usdy-ondo-finance",
      price: 1.15,
      priceSource: "coingecko",
      priceObservedAt: nowSec,
      priceObservedAtMode: "upstream",
      supplySource: "coingecko-fallback",
      supplyObservedAt: nowSec,
      circulating: { peggedUSD: marketCap },
      chainCirculating: {},
    });
    // The shared fixture still probes unpriced plain-par ftUSD, never USDY.
    expect(probeTrackedTokenSupplyMock.mock.calls.map(([meta]) => meta.id)).toEqual(["ftusd-flying-tulip"]);
  });

  it.each([
    [usyc.id, usyc.geckoId, 1.14, 2_388_281_169.538671],
    [reusd.id, reusd.geckoId, 1.11, 351_324_232.3378745],
    [usp.id, usp.geckoId, 1.15, 4_855_649.434067997],
  ])("publishes DefiLlama-delisted %s from its CoinGecko supplemental source", async (id, geckoId, price, marketCap) => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchFiatCoinGeckoTokens({
      [geckoId!]: { usd: price, usd_market_cap: marketCap, last_updated_at: nowSec },
    });

    expect(result.find((asset) => asset.id === id)).toMatchObject({
      id,
      price,
      priceSource: "coingecko",
      priceObservedAt: nowSec,
      circulating: { peggedUSD: expect.any(Number) },
    });
  });

  it("does not invent USDY supply or par when its current market observations are unavailable", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchFiatCoinGeckoTokens({});

    expect(result.find((asset) => asset.id === "usdy-ondo-finance")).toBeUndefined();
    expect(probeTrackedTokenSupplyMock.mock.calls.map(([meta]) => meta.id)).toEqual(["ftusd-flying-tulip"]);
  });

  it("publishes unavailable sFRAX despite a fresh positive CG cap and preserves independent price", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    FIAT_CG_METAS.push({
      ...FIAT_CG_METAS[0]!, id: "sfrax-frax", name: "Staked FRAX", symbol: "sFRAX", geckoId: "fixture-unreconciled-sfrax",
      flags: { ...FIAT_CG_METAS[0]!.flags, yieldBearing: true, navToken: true },
    });
    try {
      fetchWithRetryMock.mockResolvedValueOnce(new Response(JSON.stringify({ coins: {} }), { status: 200 }));
      const result = await fetchFiatCoinGeckoTokens({
        "fixture-unreconciled-sfrax": { usd: 1.14, usd_market_cap: 99_999_999, last_updated_at: nowSec },
      });
      const held = result.find(({ id }) => id === "sfrax-frax")!;
      expect(held).toMatchObject({
        circulating: {}, supplySource: "onchain-supply-withheld", supplyUnavailableReason: "economic-float-unreconciled",
        price: 1.14, priceObservedAt: nowSec,
      });
      expect(held.supplyObservedAt).toBeUndefined();
      expect(held.supplyRestored).toBeUndefined();
      expect(probeTrackedTokenSupplyMock.mock.calls.filter(([meta]) => meta?.id === "sfrax-frax")).toHaveLength(0);
      expect(resolveVaultNavSupplyPriceMock.mock.calls.filter(([id]) => id === "sfrax-frax")).toHaveLength(0);
    } finally {
      FIAT_CG_METAS.pop();
    }
  });

  it("prefers fresh CoinGecko market cap over curated aggregate on-chain supply", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchFiatCoinGeckoTokens({
      "flying-tulip-usd": {
        usd: 1,
        usd_market_cap: 868_459.9588768134,
        last_updated_at: nowSec,
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "ftusd-flying-tulip",
      supplySource: "coingecko-fallback",
      supplyObservedAt: nowSec,
      circulating: { peggedUSD: 868_459.9588768134 },
      chainCirculating: {},
    });
    expect(probeTrackedTokenSupplyMock).not.toHaveBeenCalled();
  });

  it("uses curated aggregate on-chain supply when CoinGecko market cap is stale", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => {
      if (input.chain === "ethereum") return 1_884_739_402_999n;
      if (input.chain === "sonic") return 37_578_423_196n;
      return null;
    });

    const result = await fetchFiatCoinGeckoTokens({
      "flying-tulip-usd": {
        usd: 1,
        usd_market_cap: 868_459.9588768134,
        last_updated_at: nowSec - 7 * 24 * 60 * 60,
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.chainCirculating?.Ethereum).not.toHaveProperty("circulatingPrevDay");
    expect(result[0]).toMatchObject({
      id: "ftusd-flying-tulip",
      supplySource: "onchain-total-supply",
      supplyObservedAt: expect.any(Number),
      circulating: { peggedUSD: 1_922_317.826195 },
      chainCirculating: {
        Ethereum: {
          current: 1_884_739.402999,
        },
        Sonic: {
          current: 37_578.423196,
        },
      },
    });
    expect(probeTrackedTokenSupplyMock).toHaveBeenCalledTimes(2);
  });

  it("publishes DefiLlama-delisted USD3 from its Ethereum-canonical roster when the CoinGecko cap is stale", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => {
      if (input.chain === "ethereum") return 1_557_829_462_801_000_000_000_000n;
      if (input.chain === "base") return 14_928_115_493_000_000_000_000n;
      return null;
    });

    const result = await fetchFiatCoinGeckoTokens({
      "web-3-dollar": { usd: 1.12, usd_market_cap: 1_761_714.26, last_updated_at: nowSec - 25 * 60 * 60 },
    });
    const row = result.find((asset) => asset.id === "usd3-reserve-protocol");

    expect(row).toMatchObject({
      price: 1.12,
      priceSource: "coingecko-low-volume",
      supplySource: "onchain-total-supply",
    });
    // USD values: Base is reallocated out of the Ethereum total, not summed.
    expect(row?.circulating?.peggedUSD).toBeCloseTo(1_557_829.462801 * 1.12, 4);
    expect(row?.chainCirculating?.Ethereum?.current).toBeCloseTo((1_557_829.462801 - 14_928.115493) * 1.12, 4);
    expect(row?.chainCirculating?.Base?.current).toBeCloseTo(14_928.115493 * 1.12, 4);
  });

  it.each([0n, null])("requires FIUSD's complete native stock despite a fresh positive CG cap (Arbitrum=%s)", async (arbitrumSupply) => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchWithRetryMock.mockResolvedValueOnce(new Response(JSON.stringify({ coins: {} }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) =>
      input.chain === "zksync" ? 151_766n : null,
    );
    fetchErc20TotalSupplyMock.mockImplementation(async (input) =>
      input.chain === "arbitrum" ? arbitrumSupply : null,
    );
    const result = await fetchFiatCoinGeckoTokens({
      "sygnum-fiusd-liquidity-fund": {
        usd: 12_048.93,
        usd_market_cap: 48_167_525.5038,
        last_updated_at: nowSec,
      },
    });
    if (arbitrumSupply === null) {
      expect(result).toEqual([]);
    } else {
      expect(result).toEqual([expect.objectContaining({
        id: "fiusd-sygnum",
        supplySource: "onchain-total-supply",
        circulating: { peggedUSD: 1517.66 * 12_048.93 },
        chainCirculating: {
          zkSync: { current: 1517.66 * 12_048.93, chainId: "zksync" },
          Arbitrum: { current: 0, chainId: "arbitrum" },
        },
      })]);
    }
  });

  it("skips NAV supply fallback when the price lane is missing instead of par-valuing", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchFiatCoinGeckoTokens({
      susds: { usd_market_cap: 0 },
    });

    expect(result).toEqual([]);
    const susdsProbeCalls = probeTrackedTokenSupplyMock.mock.calls.filter(
      ([probeMeta]) => probeMeta != null && typeof probeMeta === "object" && "id" in probeMeta && probeMeta.id === "susds-sky",
    );
    expect(susdsProbeCalls).toHaveLength(0);
  });

  it("reports AA's missing admitted NAV separately from an unreadable totalSupply", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(new Response(JSON.stringify({ coins: {} }), { status: 200 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await fetchFiatCoinGeckoTokens({});
      expect(result.find((asset) => asset.id === "aa-falconx-mev-capital")).toBeUndefined();
      expect(probeTrackedTokenSupplyMock.mock.calls.filter(([meta]) => meta?.id === "aa-falconx-mev-capital")).toHaveLength(0);
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({
        event: "supplemental-supply-withheld",
        metadata: expect.objectContaining({ stablecoinId: "aa-falconx-mev-capital", reason: "nav-price-unavailable" }),
      }));
    } finally {
      warn.mockRestore();
    }
  });

  it("admits a NAV token from the protocol-redeem supply fallback without publishing a price", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) =>
      input.chain === "ethereum" ? 3_000_000_000_000_000_000_000_000n : null,
    );
    resolveVaultNavSupplyPriceMock.mockResolvedValue({
      price: 1.04,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: Math.floor(Date.now() / 1000) - 60,
      observedAtMode: "local_fetch",
      metadata: { inheritedFrom: "usdc-circle" },
    });
    const previousAssetsById = new Map([["usdc-circle", { id: "usdc-circle", name: "USDC", symbol: "USDC" }]]);

    const result = await fetchFiatCoinGeckoTokens(
      { susds: { usd_market_cap: 0 } },
      undefined,
      undefined,
      undefined,
      undefined,
      previousAssetsById,
    );

    const susds = result.find((asset) => asset.id === "susds-sky");
    expect(susds).toMatchObject({
      id: "susds-sky",
      price: null,
      circulating: { peggedUSD: 3_120_000 },
      chainCirculating: { Ethereum: { current: 3_120_000, chainId: "ethereum" } },
    });
    expect(susds?.priceSource).toBeUndefined();
    expect(susds?.supplyObservedAt).toBeGreaterThan(Math.floor(Date.now() / 1000) - 10);
  });

  it("keeps the NAV token out when the supply fallback resolves nothing", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const previousAssetsById = new Map([["usdc-circle", { id: "usdc-circle", name: "USDC", symbol: "USDC" }]]);

    const result = await fetchFiatCoinGeckoTokens(
      {
        susds: { usd_market_cap: 0 },
        // FIUSD is a second NAV fixture now; keep its market-price lane observed
        // so this case isolates the missing-price protocol fallback for sUSDS.
        "sygnum-fiusd-liquidity-fund": {
          usd: 12_048.93,
          last_updated_at: Math.floor(Date.now() / 1000),
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      previousAssetsById,
    );

    expect(result).toEqual([]);
    expect(resolveVaultNavSupplyPriceMock.mock.calls.filter(([id]) => id === "susds-sky")).toHaveLength(1);
    expect(resolveVaultNavSupplyPriceMock.mock.calls.filter(([id]) => id === "aa-falconx-mev-capital")).toHaveLength(1);
  });

  it.each([
    ["stale", -14_401], ["future", 601], ["invalid", "not-a-clock"], ["null", null],
  ])("cannot publish a %s scanner quote through supplemental intake and consensus carry", async (_label, clock) => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchWithRetryMock.mockImplementation(async (url) => Response.json(
      String(url).includes("/livestats")
        ? {
          zsd_circ: 1_000, zsd_price: 1.003, zys_circ: 200, zys_price: 1.9,
          block_timestamp: typeof clock === "number" ? nowSec + clock : clock,
        }
        : { coins: {} },
    ));
    const supplementalAssets = await fetchFiatCoinGeckoTokens({});
    expect(supplementalAssets.find((asset) => asset.id === "zsd-zephyr-protocol")?.supplyObservedAt).toBeNull();
    const assets = normalizeStablecoinsPayload({ peggedAssets: supplementalAssets }).peggedAssets;
    const validationContexts = createValidationContextResolver();
    applyConsensusResults({
      assets, primaryPriceResults: new Map(), validationContexts, syncStartSec: nowSec, reason: "primary",
    });
    const zsd = assets.find((asset) => asset.id === "zsd-zephyr-protocol")!;
    expect(zsd).toMatchObject({
      price: null, priceConfidence: null, priceObservedAt: null, priceUpdatedAt: null,
      priceSyncedAt: null, circulating: { peggedUSD: 1_000 },
    });
    expect(zsd).not.toHaveProperty("supplyObservedAt");
    expect(validatePublishedAssetPrice({ asset: zsd, validationContext: validationContexts.get(zsd) }).accepted).toBe(false);
    expect(assets.some((asset) => asset.id === "zys-zephyr-protocol")).toBe(false);
  });

  it.each(["fresh", "undated", "preferred"] as const)("retains the %s price lane through supplemental publication", async (lane) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const observedAt = nowSec - 60;
    fetchWithRetryMock.mockImplementation(async (url) => Response.json(
      String(url).includes("/livestats")
        ? {
          zsd_circ: 1_000, zsd_price: 1.003, zys_circ: 200, zys_price: 1.9,
          ...(lane === "undated" ? {} : { block_timestamp: lane === "preferred" ? nowSec - 14_401 : observedAt }),
        }
        : { coins: {} },
    ));
    const assets = normalizeStablecoinsPayload({
      peggedAssets: await fetchFiatCoinGeckoTokens(lane === "preferred" ? {
        "zephyr-protocol-stable-dollar": { usd: 0.998, last_updated_at: observedAt },
      } : {}),
    }).peggedAssets;
    const validationContexts = createValidationContextResolver();
    applyConsensusResults({
      assets, primaryPriceResults: new Map(), validationContexts, syncStartSec: nowSec, reason: "primary",
    });
    const zsd = assets.find((asset) => asset.id === "zsd-zephyr-protocol")!;
    expect(zsd).toMatchObject({
      price: lane === "preferred" ? 0.998 : 1.003,
      priceSource: lane === "preferred" ? "coingecko" : "zephyr-scanner",
      priceObservedAt: lane === "undated" ? null : observedAt,
      priceObservedAtMode: lane === "undated" ? null : "upstream",
      circulating: { peggedUSD: lane === "preferred" ? 998 : 1_000 },
    });
    expect(validatePublishedAssetPrice({ asset: zsd, validationContext: validationContexts.get(zsd) }).accepted).toBe(true);
    if (lane !== "preferred") {
      expect(assets.find((asset) => asset.id === "zys-zephyr-protocol")).toMatchObject({
        price: 1.9, priceObservedAt: lane === "undated" ? null : observedAt, circulating: { peggedUSD: 380 },
      });
    }
  });
});
