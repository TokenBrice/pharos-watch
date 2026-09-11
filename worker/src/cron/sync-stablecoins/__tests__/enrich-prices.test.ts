import { describe, expect, it, vi } from "vitest";
import { enrichMissingPrices, hasMissingPrice } from "../enrich-prices";
import type { EnrichmentProgressReporter } from "../enrich-prices-progress";
import { makePeggedAsset } from "./_fixtures";

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
});
