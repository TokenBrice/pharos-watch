import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { LOW_VOLUME_CG_FALLBACK_IDS, runCoingeckoLowVolumePass } from "../enrich-prices-coingecko-low-volume-pass";
import { fetchCoingeckoSimplePrices } from "../../../lib/coingecko-simple-price";
import { shouldAttemptFetch, recordOutcomeSafe } from "../../../lib/circuit-breaker";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makePeggedAsset } from "./_fixtures";

vi.mock("../../../lib/coingecko-simple-price", () => ({ fetchCoingeckoSimplePrices: vi.fn() }));
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

type LowVolumeRecoveryCase = {
  id: string;
  geckoId: string;
  price: number;
  observedAt: number;
  nowMs: number;
  assetFields: Parameters<typeof makePeggedAsset>[0];
  expiredFields: Parameters<typeof makePeggedAsset>[0];
  expectedSupply: Parameters<typeof makePeggedAsset>[0];
  fxRates?: Record<string, number>;
  responseJson?: boolean;
};

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
  it.each([
    ["future beyond fallback skew", 121, false],
    ["exact future skew boundary", 120, true],
    ["exact seven-day age boundary", -7 * 86400, true],
    ["expired quote", -7 * 86400 - 1, false],
    ["invalid zero clock", null, false],
    ["absent upstream clock", undefined, true],
  ] as const)("admits only valid low-volume observation clocks: %s", async (_name, offset, accepted) => {
    const actual = await vi.importActual<{ fetchCoingeckoSimplePrices: typeof fetchCoingeckoSimplePrices }>(
      "../../../lib/coingecko-simple-price",
    );
    vi.mocked(fetchCoingeckoSimplePrices).mockImplementation(actual.fetchCoingeckoSimplePrices);
    const nowSec = 1_791_299_423;
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    const observedAt = offset === undefined ? undefined : offset === null ? 0 : nowSec + offset;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      "smardex-usdn": { usd: 1.01, ...(observedAt === undefined ? {} : { last_updated_at: observedAt }) },
    })));
    const asset = makePeggedAsset({ id: "usdn-smardex", price: null });
    expect(await runCoingeckoLowVolumePass([asset], null, undefined)).toEqual({
      resolved: accepted ? 1 : 0, failures: [],
    });
    if (accepted) {
      expect(asset).toMatchObject({
        price: 1.01, priceSource: "coingecko-low-volume",
        priceObservedAt: observedAt ?? nowSec,
        priceObservedAtMode: observedAt == null ? "local_fetch" : "upstream",
      });
    } else {
      expect(asset.price).toBeNull();
      expect(asset.priceObservedAt).toBeUndefined();
      expect(asset.priceSource).not.toBe("coingecko-low-volume");
    }
  });

  it.each<LowVolumeRecoveryCase>([
    ...([
      ["usdkg-gold-dollar", "usdkg", 1.001, 1791222170],
      ["fusd-freedom-dollar", "freedom-dollar", 0.997906, 1790853290],
      ["chfau-allunity", "allunity-chf", 1.2, 1791267900],
    ] as const).map(([id, geckoId, price, observedAt]) => {
      const pegType = id === "chfau-allunity" ? "peggedCHF" : "peggedUSD";
      return {
        id, geckoId, price, observedAt, nowMs: 1791299423 * 1000, responseJson: false,
        assetFields: { pegType, supplySource: "defillama", circulating: { peggedUSD: 123 } },
        expiredFields: { pegType },
        expectedSupply: { supplySource: "defillama", circulating: { peggedUSD: 123 } },
        fxRates: { peggedCHF: 1.2 },
      };
    }),
    ...([
      ["cgusd-cygnus-finance", "cygnus-finance-global-usd", 0.991614, 1791903934, "peggedUSD"],
      ["wm-m0", "wrappedm-by-m0", 0.999229, 1792012792, "peggedUSD"],
      ["mxne-real-mxn", "real-mxn", 0.054597, 1792021431, "peggedMXN"],
      ["usdfc-secured-finance", "usdfc", 0.950358, 1792002424, "peggedUSD"],
    ] as const).map(([id, geckoId, price, observedAt, pegType]) => ({
      id, geckoId, price, observedAt, nowMs: 1792043600 * 1000,
      assetFields: {
        pegType, supplyRestored: true, supplySource: "coingecko-fallback", supplyObservedAt: observedAt,
        circulating: { [pegType]: 123 },
      },
      expiredFields: { pegType },
      expectedSupply: {
        supplyRestored: true, supplySource: "coingecko-fallback", supplyObservedAt: observedAt,
        circulating: { [pegType]: 123 },
      },
      fxRates: { peggedMXN: 0.055 },
    })),
    {
      id: "hbd-hive", geckoId: "hive_dollar", price: 0.990063,
      observedAt: Date.UTC(2026, 8, 28, 18, 49, 20) / 1000, nowMs: Date.UTC(2026, 8, 30, 15),
      responseJson: false,
      assetFields: {
        symbol: "HBD", supplyRestored: true, supplySource: "coingecko-fallback",
        supplyObservedAt: Date.UTC(2026, 8, 28, 18, 49, 20) / 1000, circulating: { peggedUSD: 32_677_939 },
      },
      expiredFields: { symbol: "HBD" },
      expectedSupply: {
        supplyRestored: true, supplyObservedAt: Date.UTC(2026, 8, 28, 18, 49, 20) / 1000,
        circulating: { peggedUSD: 32_677_939 },
      },
    },
    {
      id: "brlv-crown", geckoId: "crown-brlv", price: 0.200255,
      observedAt: 1_791_806_930, nowMs: 1_791_885_552 * 1000,
      assetFields: {
        symbol: "BRLV", pegType: "peggedREAL", supplyRestored: true, supplySource: "coingecko-fallback",
        supplyObservedAt: 1_791_806_930, circulating: { peggedREAL: 73_888_563 },
      },
      expiredFields: { symbol: "BRLV", pegType: "peggedREAL" },
      expectedSupply: {
        supplyRestored: true, supplyObservedAt: 1_791_806_930, circulating: { peggedREAL: 73_888_563 },
      },
      fxRates: { peggedREAL: 0.2006 },
    },
    ...([
      ["nxusd-nereus", "nxusd", 1.0218116165811697, 1_791_761_973],
      ["usdh-hermetica", "hermetica-usdh", 0.9997925123055649, 1_791_780_809],
    ] as const).map(([id, geckoId, price, observedAt]) => ({
      id, geckoId, price, observedAt, nowMs: 1_791_787_489 * 1000,
      assetFields: { supplySource: "defillama", circulating: { peggedUSD: 123 } },
      expiredFields: {},
      expectedSupply: { supplySource: "defillama", circulating: { peggedUSD: 123 } },
    })),
  ])("recovers reviewed $id price without upgrading supply, confidence, or observation time, then expires it", async ({
    id, geckoId, price, observedAt, nowMs, assetFields, expiredFields, expectedSupply, fxRates, responseJson = true,
  }) => {
    const actual = await vi.importActual<{ fetchCoingeckoSimplePrices: typeof fetchCoingeckoSimplePrices }>(
      "../../../lib/coingecko-simple-price",
    );
    vi.mocked(fetchCoingeckoSimplePrices).mockImplementation(actual.fetchCoingeckoSimplePrices);
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const quotes = { [geckoId]: { usd: price, last_updated_at: observedAt } };
    vi.stubGlobal("fetch", vi.fn(async () => responseJson
      ? Response.json(quotes)
      : new Response(JSON.stringify(quotes), { status: 200 })));
    const asset = makePeggedAsset({ id, price: null, ...assetFields });
    expect(await runCoingeckoLowVolumePass([asset], null, fxRates)).toEqual({ resolved: 1, failures: [] });
    expect(asset).toMatchObject({
      price, priceSource: "coingecko-low-volume", priceConfidence: "fallback",
      priceObservedAt: observedAt, priceObservedAtMode: "upstream",
      ...expectedSupply,
    });
    vi.setSystemTime((observedAt + 7 * 86400 + 1) * 1000);
    const expired = makePeggedAsset({ id, price: null, ...expiredFields });
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

  it("includes audited dEURO and DLLR production gaps in the relaxed fallback allowlist", async () => {
    const observedAt = Math.floor(Date.now() / 1000) - 6 * 3600;
    mockCoingeckoPrices({
      "decentralized-euro": 1.14,
      "sovryn-dollar": 0.998,
    }, observedAt);
    const dllr = makePeggedAsset({
      id: "dllr-sovryn",
      symbol: "DLLR",
      price: null,
      priceSource: "defillama",
      supplySource: "defillama-history-gap-fill",
      circulating: { peggedUSD: 100_000_000 },
    });
    const deuro = makePeggedAsset({
      id: "deuro-deuro",
      symbol: "DEURO",
      pegType: "peggedEUR",
      price: null,
      priceSource: "coingecko",
      supplySource: "coingecko-fallback",
      circulating: { peggedEUR: 1_600_000 },
    });

    const result = await runCoingeckoLowVolumePass([dllr, deuro], null, { peggedEUR: 1.16 });

    expect(result).toEqual({ resolved: 2, failures: [] });
    expect(dllr).toMatchObject({
      price: 0.998,
      priceSource: "coingecko-low-volume",
      priceConfidence: "fallback",
      supplySource: "defillama-history-gap-fill",
    });
    expect(deuro).toMatchObject({
      price: 1.14,
      priceSource: "coingecko-low-volume",
      priceConfidence: "fallback",
      supplySource: "coingecko-fallback",
    });
  });

  it("includes audited near-peg SMARDEX USDN and CADm gaps in the relaxed fallback allowlist", async () => {
    const observedAt = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    mockCoingeckoPrices({
      "smardex-usdn": 1.006,
      "celo-canadian-dollar": 0.697285,
    }, observedAt);
    const usdn = makePeggedAsset({
      id: "usdn-smardex",
      symbol: "USDN",
      price: null,
      priceSource: "defillama",
      supplySource: "defillama",
      circulating: { peggedUSD: 676_000 },
    });
    const cadm = makePeggedAsset({
      id: "cadm-mento",
      symbol: "CADm",
      pegType: "peggedCAD",
      price: null,
      priceSource: "defillama",
      supplySource: "defillama",
      circulating: { peggedCAD: 0 },
    });

    const result = await runCoingeckoLowVolumePass([usdn, cadm], null, { peggedCAD: 0.70511 });

    expect(result).toEqual({ resolved: 2, failures: [] });
    expect(usdn).toMatchObject({
      price: 1.006,
      priceSource: "coingecko-low-volume",
      priceConfidence: "fallback",
      supplySource: "defillama",
    });
    expect(cadm).toMatchObject({
      price: 0.697285,
      priceSource: "coingecko-low-volume",
      priceConfidence: "fallback",
      supplySource: "defillama",
    });
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
      makePeggedAsset({ id: "btcusd-btcfi", symbol: "BtcUSD", price: null, pegType: "peggedUSD" }),
      makePeggedAsset({ id: "dllr-sovryn", symbol: "DLLR", price: null, pegType: "peggedUSD" }),
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
});
