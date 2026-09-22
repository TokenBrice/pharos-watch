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
afterEach(() => vi.resetAllMocks());

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
  it("enriches only allowlisted missing assets, preserving priced and unrelated peers", async () => {
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
