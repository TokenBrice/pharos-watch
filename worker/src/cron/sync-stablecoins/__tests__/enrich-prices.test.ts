import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichMissingPrices, hasMissingPrice } from "../enrich-prices";
import type { EnrichmentProgressReporter } from "../enrich-prices-progress";
import { makePeggedAsset } from "./_fixtures";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("enrichMissingPrices", () => {
  it("returns all-zero stats and completes progress without any provider pass when no price is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const assets = [
      makePeggedAsset({ id: "priced-a", symbol: "PRCA", price: 1.0002 }),
      makePeggedAsset({ id: "priced-b", symbol: "PRCB", price: 0.998 }),
    ];
    expect(assets.some((asset) => hasMissingPrice(asset))).toBe(false);
    const progressEvents: unknown[] = [];
    const onProgress: EnrichmentProgressReporter = (event) => {
      progressEvents.push(event);
    };

    const stats = await enrichMissingPrices(assets, undefined, undefined, undefined, null, null, onProgress);

    expect(stats).toEqual({
      totalMissing: 0,
      pass1: 0,
      pass1b: 0,
      passCmc: 0,
      passJupiter: 0,
      passDex: 0,
      passCgLowVolume: 0,
      finalMissing: 0,
      failedPasses: [],
    });
    expect(progressEvents).toEqual([
      { phase: "start", totalMissing: 0 },
      { phase: "complete", totalMissing: 0, finalMissing: 0, failedPasses: [] },
    ]);
    // The fast path exits before any provider, FX, or database work runs.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Already-priced assets pass through untouched.
    expect(assets.map((asset) => asset.price)).toEqual([1.0002, 0.998]);
  });

  it("stamps explicit fallback confidence and the provider clock before returning a recovered price", async () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const geckoId = ACTIVE_META_BY_ID.get("dllr-sovryn")!.geckoId!;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => Response.json(
      String(url).includes("/simple/price") ? { [geckoId]: { usd: 1, last_updated_at: now - 30 } } : { coins: {}, pairs: [] },
    )));
    const assets = [makePeggedAsset({ id: "dllr-sovryn", geckoId, price: null })];
    const stats = await enrichMissingPrices(assets);
    expect(stats).toMatchObject({ passCgLowVolume: 1, finalMissing: 0 });
    expect(assets[0]).toMatchObject({
      price: 1, priceSource: "coingecko-low-volume", priceConfidence: "fallback",
      priceObservedAt: now - 30, priceObservedAtMode: "upstream",
    });
  });
});
