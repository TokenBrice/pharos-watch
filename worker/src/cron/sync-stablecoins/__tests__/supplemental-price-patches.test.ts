import { afterEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../enrich-prices-shared";
import { runCoingeckoLowVolumePass } from "../enrich-prices-coingecko-low-volume-pass";

function asset(input: Partial<PeggedAsset> & Pick<PeggedAsset, "id" | "symbol">): PeggedAsset {
  return {
    name: input.symbol,
    circulating: { peggedUSD: 1_000_000 },
    ...input,
  } as PeggedAsset;
}

describe("runCoingeckoLowVolumePass", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("patches selected missing prices from relaxed CoinGecko rows", async () => {
    const observedAt = Math.floor(Date.now() / 1000) - 3600;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          "pareto-usp": { usd: 0.911, last_updated_at: observedAt },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const primary = asset({
      id: "usp-pareto-credit",
      symbol: "USP",
      price: null,
      priceSource: "defillama",
      priceConfidence: null,
      supplySource: "defillama",
      circulating: { peggedUSD: 2_000_000 },
    });

    const result = await runCoingeckoLowVolumePass([primary], null, undefined);

    expect(result).toEqual({ resolved: 1, failures: [] });
    expect(primary).toMatchObject({
      price: 0.911,
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

  it("includes audited MNEE and VEUR production gaps in the relaxed fallback allowlist", async () => {
    const observedAt = Math.floor(Date.now() / 1000) - 6 * 3600;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          "mnee-usd-stablecoin": { usd: 0.9996, last_updated_at: observedAt },
          "vnx-euro": { usd: 1.16, last_updated_at: observedAt },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const mnee = asset({
      id: "mnee-mnee",
      symbol: "MNEE",
      price: null,
      priceSource: "defillama",
      supplySource: "defillama",
      circulating: { peggedUSD: 100_000_000 },
    });
    const veur = asset({
      id: "veur-vnx",
      symbol: "VEUR",
      pegType: "peggedEUR",
      price: null,
      priceSource: "coingecko",
      supplySource: "defillama-history-gap-fill",
      circulating: { peggedEUR: 3_200_000 },
    });

    const result = await runCoingeckoLowVolumePass([mnee, veur], null, { peggedEUR: 1.16 });

    expect(result).toEqual({ resolved: 2, failures: [] });
    expect(mnee).toMatchObject({
      price: 0.9996,
      priceSource: "coingecko-low-volume",
      priceConfidence: "fallback",
      supplySource: "defillama",
    });
    expect(veur).toMatchObject({
      price: 1.16,
      priceSource: "coingecko-low-volume",
      priceConfidence: "fallback",
      supplySource: "defillama-history-gap-fill",
    });
  });

  it("includes audited near-peg SMARDEX USDN and CADm gaps in the relaxed fallback allowlist", async () => {
    const observedAt = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          "smardex-usdn": { usd: 1.006, last_updated_at: observedAt },
          "celo-canadian-dollar": { usd: 0.697285, last_updated_at: observedAt },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

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

  it("recovers the audited July production cohort with fresh peg-valid rows", async () => {
    const observedAt = Math.floor(Date.now() / 1000) - 3600;
    const quotes = {
      "bitcoin-usd-btcfi": 0.9727,
      "sovryn-dollar": 1.0002,
      "ebusd-stablecoin": 0.9863,
      "celo-british-pound": 1.34,
      "celo-australian-dollar": 0.695,
      ccop: 0.00029996,
      cchf: 1.24,
    } as const;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!url.includes("coingecko.com")) return new Response("Not found", { status: 404 });
      return new Response(JSON.stringify(Object.fromEntries(
        Object.entries(quotes).map(([id, usd]) => [id, { usd, last_updated_at: observedAt }]),
      )), { status: 200 });
    }));

    const assets = [
      asset({ id: "btcusd-btcfi", symbol: "BtcUSD", price: null, pegType: "peggedUSD" }),
      asset({ id: "dllr-sovryn", symbol: "DLLR", price: null, pegType: "peggedUSD" }),
      asset({ id: "ebusd-ebisu", symbol: "ebUSD", price: null, pegType: "peggedUSD" }),
      asset({ id: "gbpm-mento", symbol: "GBPm", price: null, pegType: "peggedGBP" }),
      asset({ id: "audm-mento", symbol: "AUDm", price: null, pegType: "peggedAUD" }),
      asset({ id: "copm-mento", symbol: "COPm", price: null, pegType: "peggedCOP" }),
      asset({ id: "chfm-mento", symbol: "CHFm", price: null, pegType: "peggedCHF" }),
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
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        bilira: { usd: 0.023, last_updated_at: Math.floor(Date.now() / 1000) - 3600 },
      }), { status: 200 })
    ));

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
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        "token-dforce-usd": { usd: 0.414, last_updated_at: Math.floor(Date.now() / 1000) - 3600 },
      }), { status: 200 })
    ));

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
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        "pareto-usp": { usd: "0.911" },
      }), { status: 200 })
    ));

    const primary = asset({
      id: "usp-pareto-credit",
      symbol: "USP",
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
