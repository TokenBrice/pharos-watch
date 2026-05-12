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
});
