import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { LOW_VOLUME_CG_FALLBACK_IDS, runCoingeckoLowVolumePass } from "../enrich-prices-coingecko-low-volume-pass";
import { fetchCoingeckoSimplePrices } from "../../../lib/coingecko-simple-price";
import { shouldAttemptFetch, recordOutcomeSafe } from "../../../lib/circuit-breaker";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makePeggedAsset } from "./_fixtures";

vi.mock("../../../lib/coingecko-simple-price", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/coingecko-simple-price")>()),
  fetchCoingeckoSimplePrices: vi.fn(),
}));
vi.mock("../../../lib/circuit-breaker", () => ({ shouldAttemptFetch: vi.fn(), recordOutcomeSafe: vi.fn() }));

beforeEach(() => {
  vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockCoingeckoPrices(quotes: Readonly<Record<string, number>>, observedAt: number): void {
  vi.mocked(fetchCoingeckoSimplePrices).mockResolvedValue({
    kind: "ok",
    value: new Map(Object.entries(quotes).map(([id, price]) => [
      id,
      { price, observedAt, observedAtMode: "upstream" as const },
    ])),
  });
}

describe("LOW_VOLUME_CG_FALLBACK_IDS registry invariant", () => {
  it("only references IDs present in the active stablecoin registry", () => {
    const orphaned = [...LOW_VOLUME_CG_FALLBACK_IDS].filter((id) => !ACTIVE_META_BY_ID.has(id));
    expect(orphaned).toEqual([]);
  });

  it("only references IDs that have a configured geckoId", () => {
    const missingGeckoId = [...LOW_VOLUME_CG_FALLBACK_IDS].filter((id) => {
      const meta = ACTIVE_META_BY_ID.get(id);
      return !(typeof meta?.geckoId === "string" && meta.geckoId.length > 0);
    });
    expect(missingGeckoId).toEqual([]);
  });
});

describe("runCoingeckoLowVolumePass", () => {
  it("does not overwrite an admitted native primary quote or refresh its original clock", async () => {
    const asset = makePeggedAsset({ id: "hbd-hive", price: 0.98662, priceSource: "hive-native-cg",
      priceObservedAt: 1_792_391_396, priceObservedAtMode: "local_fetch", priceConfidence: "single-source",
      supplySource: "coingecko-fallback", supplyObservedAt: 1_792_000_000 });
    mockCoingeckoPrices({ hive_dollar: 2.25 }, 1_792_391_400);
    expect(await runCoingeckoLowVolumePass([asset], null, undefined)).toMatchObject({ resolved: 0 });
    expect(asset).toMatchObject({ price: 0.98662, priceSource: "hive-native-cg", priceObservedAt: 1_792_391_396, supplyObservedAt: 1_792_000_000 });
    expect(fetchCoingeckoSimplePrices).not.toHaveBeenCalled();
  });

  it("leaves a rejected native attempt missing when the fallback CG HBD mark is out of bounds", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_792_391_400_000);
    const asset = makePeggedAsset({ id: "hbd-hive", price: null });
    mockCoingeckoPrices({ hive_dollar: 2.25 }, 1_792_391_400);
    expect(await runCoingeckoLowVolumePass([asset], null, undefined)).toMatchObject({ resolved: 0 });
    expect(asset.price).toBeNull();
  });
  it.each([
    ["future beyond fallback skew", 121, false],
    ["exact future skew boundary", 120, true],
    ["exact seven-day age boundary", -7 * 86400, true],
    ["expired quote", -7 * 86400 - 1, false],
    ["invalid zero clock", null, false],
    ["absent upstream clock", undefined, true],
  ] as const)("keeps sparse-market quote clocks separate from sync time: %s", async (_name, offset, accepted) => {
    const actual = await vi.importActual<{ fetchCoingeckoSimplePrices: typeof fetchCoingeckoSimplePrices }>(
      "../../../lib/coingecko-simple-price",
    );
    vi.mocked(fetchCoingeckoSimplePrices).mockImplementation(actual.fetchCoingeckoSimplePrices);
    const nowSec = 1_791_299_423;
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    const observedAt = offset === undefined ? undefined : offset === null ? 0 : nowSec + offset;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      "freedom-dollar": { usd: 0.842295, ...(observedAt === undefined ? {} : { last_updated_at: observedAt }) },
    })));
    const asset = makePeggedAsset({ id: "fusd-freedom-dollar", price: null });
    expect(await runCoingeckoLowVolumePass([asset], null, undefined)).toEqual({
      resolved: accepted ? 1 : 0, failures: [],
    });
    if (accepted) {
      expect(asset).toMatchObject({
        price: 0.842295, priceSource: "coingecko-low-volume",
        priceObservedAt: observedAt ?? null,
        priceUpdatedAt: observedAt ?? null,
        priceSyncedAt: nowSec,
        priceObservedAtMode: observedAt == null ? "unknown" : "upstream",
      });
    } else {
      expect(asset.price).toBeNull();
      expect(asset.priceObservedAt).toBeUndefined();
      expect(asset.priceSource).not.toBe("coingecko-low-volume");
    }
  });

  it.each([
    ["fusd-freedom-dollar", "freedom-dollar", 0.997906, 1790853290, 1791299423, "peggedUSD", { supplySource: "defillama", circulating: { peggedUSD: 123 } }, undefined, false],
    ["chfau-allunity", "allunity-chf", 1.2, 1791267900, 1791299423, "peggedCHF", { supplySource: "defillama", circulating: { peggedUSD: 123 } }, { peggedCHF: 1.2 }, false],
    ["cgusd-cygnus-finance", "cygnus-finance-global-usd", 0.991614, 1791903934, 1792043600, "peggedUSD", { supplyRestored: true, supplySource: "coingecko-fallback", supplyObservedAt: 1791903934, circulating: { peggedUSD: 123 } }, undefined, true],
    ["wm-m0", "wrappedm-by-m0", 0.999229, 1792012792, 1792043600, "peggedUSD", { supplyRestored: true, supplySource: "coingecko-fallback", supplyObservedAt: 1792012792, circulating: { peggedUSD: 123 } }, undefined, true],
    ["mxne-real-mxn", "real-mxn", 0.054597, 1792021431, 1792043600, "peggedMXN", { supplyRestored: true, supplySource: "coingecko-fallback", supplyObservedAt: 1792021431, circulating: { peggedMXN: 123 } }, { peggedMXN: 0.055 }, true],
    ["usdfc-secured-finance", "usdfc", 0.950358, 1792002424, 1792043600, "peggedUSD", { supplyRestored: true, supplySource: "coingecko-fallback", supplyObservedAt: 1792002424, circulating: { peggedUSD: 123 } }, undefined, true],
    ["hbd-hive", "hive_dollar", 0.990063, Date.UTC(2026, 8, 28, 18, 49, 20) / 1000, Date.UTC(2026, 8, 30, 15) / 1000, "peggedUSD", { symbol: "HBD", supplyRestored: true, supplySource: "coingecko-fallback", supplyObservedAt: Date.UTC(2026, 8, 28, 18, 49, 20) / 1000, circulating: { peggedUSD: 32_677_939 } }, undefined, false],
    ["brlv-crown", "crown-brlv", 0.200255, 1_791_806_930, 1_791_885_552, "peggedREAL", { symbol: "BRLV", supplyRestored: true, supplySource: "coingecko-fallback", supplyObservedAt: 1_791_806_930, circulating: { peggedREAL: 73_888_563 } }, { peggedREAL: 0.2006 }, true],
    ["nxusd-nereus", "nxusd", 1.0218116165811697, 1_791_761_973, 1_791_787_489, "peggedUSD", { supplySource: "defillama", circulating: { peggedUSD: 123 } }, undefined, true],
    ["usdh-hermetica", "hermetica-usdh", 0.9997925123055649, 1_791_780_809, 1_791_787_489, "peggedUSD", { supplySource: "defillama", circulating: { peggedUSD: 123 } }, undefined, true],
  ] as const)("recovers reviewed %s without upgrading supply/clock, then expires", async (id, geckoId, price, observedAt, nowSec, pegType, fields, fxRates, responseJson) => {
    const actual = await vi.importActual<{ fetchCoingeckoSimplePrices: typeof fetchCoingeckoSimplePrices }>("../../../lib/coingecko-simple-price");
    vi.mocked(fetchCoingeckoSimplePrices).mockImplementation(actual.fetchCoingeckoSimplePrices);
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    const quotes = { [geckoId]: { usd: price, last_updated_at: observedAt } };
    vi.stubGlobal("fetch", vi.fn(async () => responseJson ? Response.json(quotes) : new Response(JSON.stringify(quotes), { status: 200 })));
    const asset = makePeggedAsset({ id, price: null, pegType, ...fields });
    expect(await runCoingeckoLowVolumePass([asset], null, fxRates)).toEqual({ resolved: 1, failures: [] });
    expect(asset).toMatchObject({ price, priceSource: "coingecko-low-volume", priceConfidence: "fallback", priceObservedAt: observedAt, priceObservedAtMode: "upstream", pegType, ...fields });
    vi.setSystemTime((observedAt + 7 * 86400 + 1) * 1000);
    const expired = makePeggedAsset({ id, price: null, pegType });
    expect(await runCoingeckoLowVolumePass([expired], null, fxRates)).toEqual({ resolved: 0, failures: [] });
    expect(expired.price).toBeNull();
  });

  it("enriches only allowlisted missing assets, preserving priced and unrelated peers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_100 * 1000);
    const assets = [
      makePeggedAsset({ id: "usdn-smardex", price: null }),
      makePeggedAsset({ id: "dllr-sovryn", price: 0.98, priceSource: "defillama" }),
      makePeggedAsset({ id: "usdt-tether", price: null }),
    ];
    vi.mocked(fetchCoingeckoSimplePrices).mockResolvedValue({
      kind: "ok", value: new Map(assets.map((asset) => [
        ACTIVE_META_BY_ID.get(asset.id)!.geckoId!, { price: 1.01, observedAt: 1_700_000_000, observedAtMode: "upstream" as const },
      ])),
    });
    expect(await runCoingeckoLowVolumePass(assets, null, undefined)).toEqual({ resolved: 1, failures: [] });
    expect(assets[0]).toMatchObject({ price: 1.01, priceSource: "coingecko-low-volume", priceObservedAt: 1_700_000_000 });
    expect(assets[1]).toMatchObject({ price: 0.98, priceSource: "defillama" });
    expect(assets[2].price).toBeNull();
  });

  it("leaves prices unchanged without requesting an open circuit", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    const asset = makePeggedAsset({ id: "usdn-smardex", price: null });
    expect(await runCoingeckoLowVolumePass([asset], null, undefined, mockD1([], { assertMatchesUsed: true }))).toEqual({ resolved: 0, failures: [] });
    expect(asset.price).toBeNull();
    expect(fetchCoingeckoSimplePrices).not.toHaveBeenCalled();
  });

  it.each(["upstream-error", "ok"] as const)("distinguishes %s from an empty successful provider response", async (kind) => {
    vi.mocked(fetchCoingeckoSimplePrices).mockResolvedValue(kind === "upstream-error"
      ? { kind, value: new Map(), reason: "provider unavailable" }
      : { kind, value: new Map() });
    const asset = makePeggedAsset({ id: "usdn-smardex", price: null });
    expect(await runCoingeckoLowVolumePass([asset], null, undefined, mockD1([], { assertMatchesUsed: true }))).toEqual({
      resolved: 0, failures: kind === "upstream-error" ? ["coingecko-low-volume"] : [],
    });
    expect(asset.price).toBeNull();
    expect(recordOutcomeSafe).toHaveBeenCalledWith(expect.anything(), expect.anything(), kind === "ok");
  });

  it("recovers the audited low-volume production cohort with fresh peg-valid rows", async () => {
    const observedAt = Math.floor(Date.now() / 1000) - 3600;
    const quotes = {
      "bitcoin-usd-btcfi": 0.9727,
      "sovryn-dollar": 1.0002,
      "celo-british-pound": 1.34,
      "celo-australian-dollar": 0.695,
      ccop: 0.00029996,
      cchf: 1.24,
      "hedera-swiss-franc": 1.3888961972270923,
    } as const;
    mockCoingeckoPrices(quotes, observedAt);
    const assets = [
      makePeggedAsset({ id: "btcusd-btcfi", symbol: "BtcUSD", price: null }),
      makePeggedAsset({ id: "dllr-sovryn", symbol: "DLLR", price: null }),
      makePeggedAsset({ id: "gbpm-mento", symbol: "GBPm", price: null, pegType: "peggedGBP" }),
      makePeggedAsset({ id: "audm-mento", symbol: "AUDm", price: null, pegType: "peggedAUD" }),
      makePeggedAsset({ id: "copm-mento", symbol: "COPm", price: null, pegType: "peggedCOP" }),
      makePeggedAsset({ id: "chfm-mento", symbol: "CHFm", price: null, pegType: "peggedCHF" }),
      makePeggedAsset({ id: "hchf-hedera-swiss-franc", symbol: "HCHF", price: null, pegType: "peggedCHF" }),
    ];

    const result = await runCoingeckoLowVolumePass(assets, null, {
      peggedGBP: quotes["celo-british-pound"],
      peggedAUD: quotes["celo-australian-dollar"],
      peggedCOP: quotes.ccop,
      peggedCHF: quotes.cchf,
    });

    expect(result).toEqual({ resolved: 7, failures: [] });
    expect(assets.map(({ price }) => price)).toEqual(Object.values(quotes));
    expect(assets.every(({ priceSource }) => priceSource === "coingecko-low-volume")).toBe(true);
  });

  it("rejects micro-volume outliers while keeping near-peg and unknown-volume low-volume quotes", async () => {
    const observedAt = Math.floor(Date.now() / 1000) - 3600;
    vi.mocked(fetchCoingeckoSimplePrices).mockResolvedValue({
      kind: "ok",
      value: new Map([
        ["freedom-dollar", { price: 0.85, observedAt, observedAtMode: "upstream", volume24hUsd: 7 }],
        ["usdfc", { price: 0.98, observedAt, observedAtMode: "upstream", volume24hUsd: 7 }],
        ["nxusd", { price: 0.85, observedAt, observedAtMode: "upstream", volume24hUsd: null }],
      ]),
    });
    const assets = [
      makePeggedAsset({ id: "fusd-freedom-dollar", price: null }),
      makePeggedAsset({ id: "usdfc-secured-finance", price: null }),
      makePeggedAsset({ id: "nxusd-nereus", price: null }),
    ];
    expect(await runCoingeckoLowVolumePass(assets, null, undefined)).toEqual({ resolved: 2, failures: [] });
    expect(assets[0].price).toBeNull();
    expect(assets[1].price).toBe(0.98);
    expect(assets[2].price).toBe(0.85);
  });
});
