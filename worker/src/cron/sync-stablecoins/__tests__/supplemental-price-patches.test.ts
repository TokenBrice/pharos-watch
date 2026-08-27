import { afterEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../enrich-prices-shared";
import { runCoingeckoLowVolumePass } from "../enrich-prices-coingecko-low-volume-pass";
import { mockFetch } from "../../../test-helpers/__shared/mock-fetch";

function asset(input: Partial<PeggedAsset> & Pick<PeggedAsset, "id" | "symbol">): PeggedAsset {
  return {
    name: input.symbol,
    circulating: { peggedUSD: 1_000_000 },
    ...input,
  } as PeggedAsset;
}

function stubCoingeckoResponse(body: unknown): void {
  mockFetch([{
    match: "coingecko.com",
    body,
  }], { requireMatch: true });
}

describe("runCoingeckoLowVolumePass", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("patches selected missing prices from relaxed CoinGecko rows", async () => {
    const observedAt = Math.floor(Date.now() / 1000) - 3600;
    stubCoingeckoResponse({
      "sovryn-dollar": { usd: 0.998, last_updated_at: observedAt },
    });

    const primary = asset({
      id: "dllr-sovryn",
      symbol: "DLLR",
      price: null,
      priceSource: "defillama",
      priceConfidence: null,
      supplySource: "defillama",
      circulating: { peggedUSD: 2_000_000 },
    });

    const result = await runCoingeckoLowVolumePass([primary], null, undefined);

    expect(result).toEqual({ resolved: 1, failures: [] });
    expect(primary).toMatchObject({
      price: 0.998,
      priceSource: "coingecko-low-volume",
      priceSelectedSource: "coingecko-low-volume",
      priceConfidence: "fallback",
      priceUpdatedAt: observedAt,
      priceObservedAt: observedAt,
      priceObservedAtMode: "upstream",
      priceSyncedAt: observedAt,
      supplySource: "defillama",
      circulating: { peggedUSD: 2_000_000 },
      consensusSources: ["coingecko-low-volume"],
    });
  });

  it("includes audited dEURO and DLLR production gaps in the relaxed fallback allowlist", async () => {
    const observedAt = Math.floor(Date.now() / 1000) - 6 * 3600;
    stubCoingeckoResponse({
      "decentralized-euro": { usd: 1.14, last_updated_at: observedAt },
      "sovryn-dollar": { usd: 0.998, last_updated_at: observedAt },
    });

    const dllr = asset({
      id: "dllr-sovryn",
      symbol: "DLLR",
      price: null,
      priceSource: "defillama",
      supplySource: "defillama-history-gap-fill",
      circulating: { peggedUSD: 100_000_000 },
    });
    const deuro = asset({
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
    stubCoingeckoResponse({
      "smardex-usdn": { usd: 1.006, last_updated_at: observedAt },
      "celo-canadian-dollar": { usd: 0.697285, last_updated_at: observedAt },
    });

    const usdn = asset({
      id: "usdn-smardex",
      symbol: "USDN",
      price: null,
      priceSource: "defillama",
      supplySource: "defillama",
      circulating: { peggedUSD: 676_000 },
    });
    const cadm = asset({
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
    stubCoingeckoResponse(Object.fromEntries(
      Object.entries(quotes).map(([id, usd]) => [id, { usd, last_updated_at: observedAt }]),
    ));

    const assets = [
      asset({ id: "btcusd-btcfi", symbol: "BtcUSD", price: null, pegType: "peggedUSD" }),
      asset({ id: "dllr-sovryn", symbol: "DLLR", price: null, pegType: "peggedUSD" }),
      asset({ id: "gbpm-mento", symbol: "GBPm", price: null, pegType: "peggedGBP" }),
      asset({ id: "audm-mento", symbol: "AUDm", price: null, pegType: "peggedAUD" }),
      asset({ id: "copm-mento", symbol: "COPm", price: null, pegType: "peggedCOP" }),
      asset({ id: "chfm-mento", symbol: "CHFm", price: null, pegType: "peggedCHF" }),
      asset({ id: "hchf-hedera-swiss-franc", symbol: "HCHF", price: null, pegType: "peggedCHF" }),
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

  it("does not overwrite prices that are already present", async () => {
    stubCoingeckoResponse({
      bilira: { usd: 0.023, last_updated_at: Math.floor(Date.now() / 1000) - 3600 },
    });

    const primary = asset({
      id: "tryb-bilira",
      symbol: "TRYB",
      price: 0.022,
      priceSource: "defillama-list",
      priceConfidence: "single-source",
      supplySource: "defillama",
    });

    const result = await runCoingeckoLowVolumePass([primary], null, undefined);

    expect(result).toEqual({ resolved: 0, failures: [] });
    expect(primary).toMatchObject({
      price: 0.022,
      priceSource: "defillama-list",
      priceConfidence: "single-source",
      supplySource: "defillama",
    });
  });

  it("ignores unallowlisted stale CoinGecko rows", async () => {
    stubCoingeckoResponse({
      "token-dforce-usd": { usd: 0.414, last_updated_at: Math.floor(Date.now() / 1000) - 3600 },
    });

    const primary = asset({
      id: "usx-dforce",
      symbol: "USX",
      price: null,
      priceSource: "defillama",
      supplySource: "defillama",
    });

    const result = await runCoingeckoLowVolumePass([primary], null, undefined);

    expect(result).toEqual({ resolved: 0, failures: [] });
    expect(primary).toMatchObject({
      price: null,
      priceSource: "defillama",
      supplySource: "defillama",
    });
  });

  it("ignores malformed CoinGecko simple-price payloads", async () => {
    stubCoingeckoResponse({
      "sovryn-dollar": { usd: "0.998" },
    });

    const primary = asset({
      id: "dllr-sovryn",
      symbol: "DLLR",
      price: null,
      priceSource: "defillama",
      supplySource: "defillama",
    });

    const result = await runCoingeckoLowVolumePass([primary], null, undefined);

    expect(result).toEqual({ resolved: 0, failures: ["coingecko-low-volume"] });
    expect(primary).toMatchObject({
      price: null,
      priceSource: "defillama",
      supplySource: "defillama",
    });
  });
});
