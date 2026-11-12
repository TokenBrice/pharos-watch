import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import { mockRegistry } from "../../../../test-helpers/cron";
import type { MockRegistryStablecoin } from "../../../../test-helpers/cron/mock-registry";
import type * as FetchRetry from "../../../../lib/fetch-retry";
import ftusd from "@shared/data/stablecoins/coins/ftusd-flying-tulip.json";
import fiusd from "@shared/data/stablecoins/coins/fiusd-sygnum.json";
import aa from "@shared/data/stablecoins/coins/aa-falconx-mev-capital.json";
import zsd from "@shared/data/stablecoins/coins/zsd-zephyr-protocol.json";
import zys from "@shared/data/stablecoins/coins/zys-zephyr-protocol.json";
import usdy from "@shared/data/stablecoins/coins/usdy-ondo-finance.json";
import { CHAIN_META } from "@shared/types/chain-identity";
import buidl from "@shared/data/stablecoins/coins/buidl-blackrock.json";
import usyc from "@shared/data/stablecoins/coins/usyc-hashnote.json";
import reusd from "@shared/data/stablecoins/coins/reusd-re-protocol.json";
import usp from "@shared/data/stablecoins/coins/usp-pikudao.json";
import usd3 from "@shared/data/stablecoins/coins/usd3-reserve-protocol.json";
import hbd from "@shared/data/stablecoins/coins/hbd-hive.json";
import eursafo from "@shared/data/stablecoins/coins/eursafo-spiko.json";

const fetchWithRetryMock = vi.fn();
const probeTrackedTokenSupplyMock = vi.fn();
const fetchErc20TotalSupplyMock = vi.fn();
const resolveVaultNavSupplyPriceMock = vi.fn();
const fetchHiveHbdProtocolSupplyMock = vi.fn();

vi.mock("@shared/lib/stablecoins/registry", () => {
  const coin = (m: MockRegistryStablecoin) => ({ id: m.id, name: m.name, symbol: m.symbol,
    geckoId: m.geckoId, detailProvider: m.detailProvider, contracts: m.contracts,
    flags: { pegCurrency: "USD", backing: m.flags!.backing, governance: m.flags!.governance,
      yieldBearing: m.flags!.yieldBearing === true, navToken: m.flags!.navToken === true } });
  return mockRegistry({
    stablecoins: [
    { ...coin(ftusd), detailProvider: "coingecko" },
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
        pegCurrency: "USD", backing: "rwa-backed", governance: "centralized", yieldBearing: true, navToken: true,
      },
    },
    ...[fiusd, aa, zsd, zys].map(coin),
    { ...usdy, flags: { ...usdy.flags, pegCurrency: "USD" } },
    { ...hbd, flags: { ...hbd.flags, pegCurrency: "USD" } },
    ...[buidl, usyc, reusd, usp, usd3].map((meta) => ({ ...meta, flags: { ...meta.flags, pegCurrency: "USD" } })),
    eursafo,
  ],
  });
});

vi.mock("../../../../lib/chain-observation", () => ({
  fetchSolanaTokenSupply: () => probeTrackedTokenSupplyMock(undefined, { kind: "onchain-solana" }),
}));

vi.mock("../usdy-aptos-supply", () => ({ fetchAptosSupply: async () => 1_000_000n }));

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
  getFreshSingleSourceNavParentId: () => null,
  resolveVaultNavSupplyPrice: (...args: unknown[]) => resolveVaultNavSupplyPriceMock(...args),
}));

vi.mock("../../../reserve-adapters/hive-hbd-protocol", () => ({
  fetchHiveHbdProtocolSupply: (...args: unknown[]) => fetchHiveHbdProtocolSupplyMock(...args),
}));

import { fetchFiatCoinGeckoTokens, FIAT_CG_METAS } from "../fiat-cg";
import { prevalidatePrices, applyConsensusResults, createValidationContextResolver } from "../../pricing";
import { normalizeStablecoinsPayload, restoreMissingTrackedAssets, reviewedOnchainSupplyHoldFields } from "../../shared";
import { overlayFallbackCuratedAggregateSupply } from "../../fallback-intake";
import { validatePublishedAssetPrice } from "../../../../lib/price-publish-policy";

function supplyReads() {
  probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => {
    const chain = input.kind === "onchain-solana" ? "solana" : input.chain;
    if (chain === "ethereum") return 1_900_000_000_000_000n;
    if (chain === "bsc") return 100_000_000_000_000n;
    if (chain === "solana") return 10_000_000_000_000n;
    return 1_000_000n;
  });
  fetchErc20TotalSupplyMock.mockImplementation(async input => input.chain === "arc" ? 0n : probeTrackedTokenSupplyMock(undefined, input));
}
function scanner(clock: unknown) {
  fetchWithRetryMock.mockImplementation(async url => Response.json(String(url).includes("/livestats") ? {
    zsd_circ: 1_000, zsd_price: 1.003, zys_circ: 200, zys_price: 1.9,
    ...(clock === undefined ? {} : { block_timestamp: clock }),
  } : { coins: {} }));
}
const emptyPrices = () => jsonResponse({ coins: {} });
const withheld = [buidl, usyc].map(meta => expect.objectContaining({
  id: meta.id, price: null, circulating: {}, supplySource: "onchain-supply-withheld",
  chainCirculating: Object.fromEntries(meta.contracts.map(c => [CHAIN_META[c.chain].name, { chainId: c.chain, current: null }])),
}));

describe("fetchFiatCoinGeckoTokens", () => {
  const coinGeckoCap = 2_388_281_169.538671;
  let nowSec: number, observedAt: number;
  beforeEach(() => {
    nowSec = Math.floor(Date.now() / 1000);
    observedAt = nowSec - 30;
    fetchWithRetryMock.mockReset();
    probeTrackedTokenSupplyMock.mockReset();
    fetchErc20TotalSupplyMock.mockReset();
    resolveVaultNavSupplyPriceMock.mockReset().mockResolvedValue(null);
    fetchHiveHbdProtocolSupplyMock.mockReset().mockResolvedValue(null);
  });

  it.each([0, 99_000_000])("publishes HBD native supply regardless of CoinGecko cap %s", async (cap) => {
    fetchHiveHbdProtocolSupplyMock.mockResolvedValue({ supply: 8_737_126.658, observedAt });
    fetchWithRetryMock.mockImplementation(emptyPrices);
    const assets = await fetchFiatCoinGeckoTokens({
      [hbd.geckoId]: { usd: 1.53, usd_market_cap: cap, last_updated_at: observedAt },
    });
    expect(assets.find((asset) => asset.id === hbd.id)).toMatchObject({
      circulating: { peggedUSD: 8_737_126.658 },
      price: null,
      supplySource: "onchain-circulating-supply", supplyObservedAt: observedAt,
      circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null,
    });
    expect(fetchHiveHbdProtocolSupplyMock).toHaveBeenCalledWith(hbd.liveReservesConfig, expect.any(AbortSignal));
  });

  it("values HBD units at an admitted market price", async () => {
    fetchHiveHbdProtocolSupplyMock.mockResolvedValue({ supply: 1_000, observedAt });
    fetchWithRetryMock.mockImplementation(emptyPrices);
    const assets = await fetchFiatCoinGeckoTokens({
      [hbd.geckoId]: { usd: 0.98, usd_market_cap: 0, last_updated_at: observedAt },
    });
    expect(assets.find((asset) => asset.id === hbd.id)?.circulating).toEqual({ peggedUSD: 980 });
  });

  it.each([0, 1_000])("admits observed HBD supply %s without inventing a market quote", async (supply) => {
    fetchHiveHbdProtocolSupplyMock.mockResolvedValue({ supply, observedAt });
    fetchWithRetryMock.mockImplementation(emptyPrices);
    const assets = await fetchFiatCoinGeckoTokens({});
    expect(assets.find((asset) => asset.id === hbd.id)).toMatchObject({
      circulating: { peggedUSD: supply }, price: null, supplyObservedAt: observedAt,
      supplySource: "onchain-circulating-supply", chainCirculating: {},
    });
  });

  it("retains the original native supply clock through bounded restoration and then expires it", async () => {
    fetchHiveHbdProtocolSupplyMock.mockResolvedValue({ supply: 1_000, observedAt: nowSec - 30 });
    fetchWithRetryMock.mockImplementation(emptyPrices);
    const assets = await fetchFiatCoinGeckoTokens({});
    const previous = assets.find((asset) => asset.id === hbd.id)!;
    const previousById = new Map([[hbd.id, previous]]);
    const restored = restoreMissingTrackedAssets([], previousById, nowSec);
    expect(restored.assets.find((asset) => asset.id === hbd.id)).toMatchObject({
      circulating: { peggedUSD: 1_000 }, supplyObservedAt: nowSec - 30, supplyRestored: true,
    });
    const expired = restoreMissingTrackedAssets([], previousById, nowSec + 7 * 86_400);
    expect(expired.droppedIds).toContain(hbd.id);
    expect(expired.assets.some((asset) => asset.id === hbd.id)).toBe(false);
  });

  it("withholds HBD on a native read failure even when CoinGecko reports a positive cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchHiveHbdProtocolSupplyMock.mockRejectedValue(new Error("nodes disagree"));
    fetchWithRetryMock.mockImplementation(emptyPrices);
    try {
      const assets = await fetchFiatCoinGeckoTokens({
        [hbd.geckoId]: { usd: 0.98, usd_market_cap: 99_000_000, last_updated_at: observedAt },
      });
      expect(assets.some((asset) => asset.id === hbd.id)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"reason":"hive-native-supply-unavailable"'));
    } finally {
      warn.mockRestore();
    }
  });

  it("publishes USDY from its configured supplemental source when the DefiLlama list omits it", async () => {
    const marketCap = 2_356_848_686.3214035;
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);

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
    [reusd.id, reusd.geckoId, 1.11, 351_324_232.3378745],
    [usp.id, usp.geckoId, 1.15, 4_855_649.434067997],
  ])("publishes DefiLlama-delisted %s from its CoinGecko supplemental source", async (id, geckoId, price, marketCap) => {
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);

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

  it.each([usyc, buidl])("values $id native stock instead of its CoinGecko cap", async (meta) => {
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);
    supplyReads();

    const result = await fetchFiatCoinGeckoTokens({
      [meta.geckoId!]: { usd: 1.14, usd_market_cap: coinGeckoCap, last_updated_at: nowSec },
    });

    const asset = result.find((row) => row.id === meta.id)!;
    expect(asset).toMatchObject({
      id: meta.id,
      price: 1.14,
      priceSource: "coingecko",
      priceObservedAt: nowSec,
      supplySource: "onchain-total-supply",
      supplyObservedAt: expect.any(Number),
      chainCirculating: {
        Ethereum: { chainId: "ethereum" },
        BSC: { chainId: "bsc" },
        Solana: { chainId: "solana" },
        ...(meta === usyc ? { Arc: { chainId: "arc", current: 0 } } : {}),
      },
    });
    expect(asset).not.toHaveProperty("chainPartition");
    expect(asset).not.toHaveProperty("supplyUnavailableReason");
    expect(asset.circulating?.peggedUSD).toBeCloseTo((meta === usyc ? 2_010_000_000 : 3_910_000_006) * 1.14, meta === usyc ? 6 : 4);
    expect(asset.circulating?.peggedUSD).not.toBe(coinGeckoCap);
    expect(asset.chainCirculating?.Ethereum?.current).toBeCloseTo((meta === usyc ? 1_900_000_000 : 3_800_000_000) * 1.14, 6);
    expect(asset.chainCirculating?.BSC?.current).toBeCloseTo(100_000_000 * 1.14, 6);
    expect(asset.chainCirculating?.Solana?.current).toBeCloseTo(10_000_000 * 1.14, 6);
  });

  it.each([[false, 100, 0], [true, 100, 0], [false, 0.005, -3600], [false, 0.998, 601], [null, 1, 0], [undefined, 1, 0]] as const)("rejects BUIDL quote before repricing (%s/%s/%s)", async (outage, usd, offset) => {
    supplyReads();
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);
    vi.spyOn(Date, "now").mockReturnValue((nowSec + 2) * 1000);
    const prior = new Map([[buidl.id, { price: usd, source: "curve-onchain", confidence: "high" as const,
      observedAt, updatedAt: observedAt, agreeSources: [] }]]);
    const asset = (await fetchFiatCoinGeckoTokens({ [buidl.geckoId]: {
      usd, last_updated_at: nowSec + offset,
    } }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, nowSec, outage == null ? null : prior))
      .find(row => row.id === buidl.id)!;
    if (outage === true || outage === null) await overlayFallbackCuratedAggregateSupply([asset], undefined, undefined, undefined, undefined, outage === null ? null : prior);
    const input = { assets: [asset], validationContexts: createValidationContextResolver(), previousTrustedPrices: prior, logLabel: "test" };
    applyConsensusResults({ ...input, primaryPriceResults: new Map(), syncStartSec: nowSec, reason: "primary" });
    prevalidatePrices(input);
    expect([asset.price, asset.circulating]).toEqual([outage == null ? 1 : null, {}]);
    Object.assign(asset, { price: 1, priceSource: "curve-onchain", priceConfidence: "high",
      priceObservedAt: nowSec, priceObservedAtMode: "upstream" });
    prevalidatePrices(input);
    expect([asset.price, asset.circulating]).toEqual([1, {}]);
    vi.restoreAllMocks();
  });

  it.each([usyc, buidl])("withholds $id supply instead of its CoinGecko cap", async (meta) => {
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);

    const result = await fetchFiatCoinGeckoTokens({
      [meta.geckoId!]: { usd: 1.14, usd_market_cap: coinGeckoCap, last_updated_at: nowSec },
    });

    expect(result.find((row) => row.id === meta.id)).toEqual(expect.objectContaining({
      id: meta.id,
      price: 1.14,
      priceSource: "coingecko",
      priceObservedAt: nowSec,
      supplySource: "onchain-supply-withheld",
      supplyUnavailableReason: undefined,
      circulating: {},
      chainCirculating: Object.fromEntries(meta.contracts.map(c => [CHAIN_META[c.chain].name, { chainId: c.chain, current: null }])),
    }));
    expect(probeTrackedTokenSupplyMock.mock.calls.some(([probe]) => probe?.id === meta.id)).toBe(true);
  });

  it("does not invent USDY supply or par when its current market observations are unavailable", async () => {
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);

    const result = await fetchFiatCoinGeckoTokens({});

    expect(result.find((asset) => asset.id === "usdy-ondo-finance")).toBeUndefined();
    expect(probeTrackedTokenSupplyMock.mock.calls.map(([meta]) => meta.id)).toEqual(["ftusd-flying-tulip"]);
  });

  it("publishes unavailable sFRAX despite a fresh positive CG cap and preserves independent price", async () => {
    FIAT_CG_METAS.push({
      ...FIAT_CG_METAS[0]!, id: "sfrax-frax", name: "Staked FRAX", symbol: "sFRAX", geckoId: "fixture-unreconciled-sfrax",
      flags: { ...FIAT_CG_METAS[0]!.flags, yieldBearing: true, navToken: true },
    });
    try {
      fetchWithRetryMock.mockImplementationOnce(emptyPrices);
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

  it("keeps fresh CoinGecko market cap when its on-chain partition cannot be read", async () => {
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);

    const result = await fetchFiatCoinGeckoTokens({
      "flying-tulip-usd": {
        usd: 1,
        usd_market_cap: 868_459.9588768134,
        last_updated_at: nowSec,
      },
    });

    expect(result.map((asset) => asset.id)).toEqual(["ftusd-flying-tulip", "fiusd-sygnum", buidl.id, usyc.id]);
    expect(result.find((asset) => asset.id === "ftusd-flying-tulip")).toMatchObject({
      id: "ftusd-flying-tulip",
      supplySource: "coingecko-fallback",
      supplyObservedAt: nowSec,
      circulating: { peggedUSD: 868_459.9588768134 },
      chainCirculating: {},
    });
    expect(result.find((asset) => asset.id === usyc.id)).toMatchObject({
      price: null, circulating: {}, supplySource: "onchain-supply-withheld",
    });
    expect(probeTrackedTokenSupplyMock).not.toHaveBeenCalled();
    expect(fetchErc20TotalSupplyMock).toHaveBeenCalledTimes(1);
  });

  it("uses curated aggregate on-chain supply when CoinGecko market cap is stale", async () => {
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);
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

    expect(result.map((asset) => asset.id)).toEqual(["ftusd-flying-tulip", "fiusd-sygnum", buidl.id, usyc.id]);
    const ftusd = result.find((asset) => asset.id === "ftusd-flying-tulip")!;
    expect(ftusd.chainCirculating?.Ethereum).not.toHaveProperty("circulatingPrevDay");
    expect(ftusd).toMatchObject({
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
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);
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
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);
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
      expect(result).toEqual([expect.objectContaining({
        id: "fiusd-sygnum", price: 12_048.93, priceObservedAt: nowSec,
        circulating: {}, supplySource: "onchain-supply-withheld",
        supplyUnavailableReason: undefined,
        chainCirculating: {
          zkSync: { current: null, chainId: "zksync" },
          Arbitrum: { current: null, chainId: "arbitrum" },
        },
      }), ...withheld]);
    } else {
      expect(result).toEqual([expect.objectContaining({
        id: "fiusd-sygnum",
        supplySource: "onchain-total-supply",
        circulating: { peggedUSD: 1517.66 * 12_048.93 },
        chainCirculating: {
          zkSync: { current: 1517.66 * 12_048.93, chainId: "zksync" },
          Arbitrum: { current: 0, chainId: "arbitrum" },
        },
      }), ...withheld]);
    }
  });

  it("skips NAV supply fallback when the price lane is missing instead of par-valuing", async () => {
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);

    const result = await fetchFiatCoinGeckoTokens({
      susds: { usd_market_cap: 0 },
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: "fiusd-sygnum", price: null, circulating: {},
        supplyUnavailableReason: undefined,
      }),
      ...withheld,
    ]);
    const susdsProbeCalls = probeTrackedTokenSupplyMock.mock.calls.filter(
      ([probeMeta]) => probeMeta != null && typeof probeMeta === "object" && "id" in probeMeta && probeMeta.id === "susds-sky",
    );
    expect(susdsProbeCalls).toHaveLength(0);
  });

  it("reports AA's missing admitted NAV separately from an unreadable totalSupply", async () => {
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);
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

  it.each([true, false])("protocol-redeem NAV supply available=%s", async (available) => {
    fetchWithRetryMock.mockImplementationOnce(emptyPrices);
    if (available) {
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
    }
    const previousAssetsById = new Map([["usdc-circle", { id: "usdc-circle", name: "USDC", symbol: "USDC" }]]);
    const result = await fetchFiatCoinGeckoTokens({ susds: { usd_market_cap: 0 },
      ...(!available ? { "sygnum-fiusd-liquidity-fund": {
        usd: 12_048.93, last_updated_at: Math.floor(Date.now() / 1000),
      } } : {}),
    }, undefined, undefined, undefined, undefined, previousAssetsById);
    if (available) {
      const susds = result.find((asset) => asset.id === "susds-sky");
      expect(susds).toMatchObject({
        id: "susds-sky",
        price: null,
        circulating: { peggedUSD: 3_120_000 },
        chainCirculating: { Ethereum: { current: 3_120_000, chainId: "ethereum" } },
      });
      expect(susds?.priceSource).toBeUndefined();
      expect(susds?.supplyObservedAt).toBeGreaterThan(Math.floor(Date.now() / 1000) - 10);
    } else {
      expect(result).toEqual([
        expect.objectContaining({
          id: "fiusd-sygnum", price: 12_048.93, circulating: {},
          supplyUnavailableReason: undefined,
        }),
        ...withheld,
      ]);
      expect(resolveVaultNavSupplyPriceMock.mock.calls.filter(([id]) => id === "susds-sky")).toHaveLength(1);
      expect(resolveVaultNavSupplyPriceMock.mock.calls.filter(([id]) => id === "aa-falconx-mev-capital")).toHaveLength(1);
      expect(resolveVaultNavSupplyPriceMock.mock.calls.filter(([id]) => id === buidl.id)).toHaveLength(0);
    }
  });

  it.each([
    ["stale", -14_401], ["future", 601], ["invalid", "not-a-clock"], ["null", null],
  ])("cannot publish a %s scanner quote through supplemental intake and consensus carry", async (_label, clock) => {
    scanner(typeof clock === "number" ? nowSec + clock : clock);
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
    const observedAt = nowSec - 60;
    scanner(lane === "undated" ? undefined : lane === "preferred" ? nowSec - 14_401 : observedAt);
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

describe("fiat CoinGecko NAV continuity", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("retains fresh CoinGecko supply when an issuer perimeter refuses only its on-chain roster", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json({ coins: {} }))));
    const nowSec = Math.floor(Date.now() / 1000), marketCap = 1_798_801_917.8;
    const rows = await fetchFiatCoinGeckoTokens({ [eursafo.geckoId]: {
      usd: 1.14, usd_market_cap: marketCap, last_updated_at: nowSec,
    } });
    const row = rows.find((asset) => asset.id === eursafo.id)!;
    expect(row).toMatchObject({ id: eursafo.id, supplySource: "coingecko-fallback", supplyObservedAt: nowSec,
      circulating: { peggedEUR: marketCap }, chainCirculating: {},
    });
    expect(reviewedOnchainSupplyHoldFields(row, nowSec)).toBeNull();
  });
});
