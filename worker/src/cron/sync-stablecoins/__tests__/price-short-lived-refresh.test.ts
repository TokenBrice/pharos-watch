import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as contracts from "../enrich-prices-defillama-pass";
import * as jupiter from "../enrich-prices-jupiter-pass";
import { runShortLivedPriceRefresh } from "../price-short-lived-refresh";
import { resolveStablecoinPriceGapReviews } from "../../../lib/stablecoin-publication-coverage";
import { makePeggedAsset } from "./_fixtures";

beforeEach(() => {
  vi.spyOn(contracts, "runDlContractPasses").mockResolvedValue({ resolved: 0, failures: [], pass1: 0, pass1b: 0 });
  vi.spyOn(jupiter, "runJupiterPass").mockResolvedValue({ resolved: 0, failures: [] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const priced = (id: string, source: string) => makePeggedAsset({
  id, price: 1, priceSource: source, priceConfidence: "fallback", priceObservedAt: 1_800_000_000,
});

describe("short-lived fallback refresh", () => {
  it("refreshes missing and source-owned rows, independently and serially, without changing published rows", async () => {
    const assets = [
      priced("m-m0", "defillama-contract"), priced("xo-exodus", "jupiter"),
      priced("usdc-circle", "coingecko"), makePeggedAsset({ id: "usdk-kast", price: null }),
      makePeggedAsset({ id: "not-tracked", price: null }),
    ];
    const order: string[] = [];
    vi.mocked(contracts.runDlContractPasses).mockImplementation(async (cohort) => {
      order.push("contract");
      expect(cohort.map((asset) => asset.id)).toEqual(["m-m0", "usdk-kast"]);
      expect(cohort.every((asset) => asset.price == null)).toBe(true);
      Object.assign(cohort[0], { price: 0.997, priceSource: "defillama-contract", priceConfidence: "single-source",
        priceObservedAt: 1_800_000_010, priceObservedAtMode: "upstream" });
      return { resolved: 1, failures: [], pass1: 1, pass1b: 0 };
    });
    vi.mocked(jupiter.runJupiterPass).mockImplementation(async (cohort) => {
      order.push("jupiter");
      expect(cohort.map((asset) => asset.id)).toEqual(["xo-exodus", "usdk-kast"]);
      Object.assign(cohort[0], { price: 0.999, priceSource: "jupiter", priceConfidence: "fallback",
        priceObservedAt: 1_800_000_020, priceObservedAtMode: "local_fetch" });
      return { resolved: 1, failures: [] };
    });
    const chainRpcs = new Map();
    const result = await runShortLivedPriceRefresh({ assets, jupiterApiKey: "test-key", chainRpcs });
    expect(order).toEqual(["contract", "jupiter"]);
    expect(jupiter.runJupiterPass).toHaveBeenCalledWith(expect.any(Array), undefined, undefined,
      expect.any(AbortSignal), "test-key", chainRpcs);
    expect(result.observations).toEqual([
      { id: "m-m0", source: "defillama-contract", price: 0.997, observedAt: 1_800_000_010, observedAtMode: "upstream" },
      { id: "xo-exodus", source: "jupiter", price: 0.999, observedAt: 1_800_000_020, observedAtMode: "local_fetch" },
    ]);
    expect(assets[0].price).toBe(1);
    expect(assets[1].price).toBe(1);
    expect(assets[3].price).toBeNull();
  });

  it("skips reviewed gaps with stale source labels but keeps current source-owned composites", async () => {
    const reviewedGapIds = new Set([
      "m-m0", "xo-exodus", "usdk-kast", "usda-avalon", "usdkg-gold-dollar", "usdn-smardex",
    ]);
    await runShortLivedPriceRefresh({
      assets: [
        priced("m-m0", "coingecko+defillama-contract"), priced("xo-exodus", "coingecko+jupiter"),
        makePeggedAsset({ id: "usdk-kast", price: null }),
        { ...priced("usda-avalon", "defillama-contract"), price: null },
        { ...priced("usdkg-gold-dollar", "jupiter"), price: null },
        { ...priced("usdn-smardex", "defillama-contract+jupiter"), priceObservedAt: null,
          priceUpdatedAt: null, priceSyncedAt: null },
      ],
      reviewedGapIds,
    });
    expect(contracts.runDlContractPasses).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m-m0", price: null })], undefined, expect.any(AbortSignal), undefined,
    );
    expect(jupiter.runJupiterPass).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "xo-exodus", price: null })], undefined, undefined,
      expect.any(AbortSignal), undefined, undefined,
    );
  });

  it("keeps missing M and XO in both recovery passes under the production review registry", async () => {
    const ids = ["m-m0", "xo-exodus"];
    const reviewedGapIds = new Set(
      resolveStablecoinPriceGapReviews(ids, Date.UTC(2026, 9, 16) / 1000).activeById.keys(),
    );
    expect([...reviewedGapIds]).toEqual([]);
    await runShortLivedPriceRefresh({
      assets: ids.map((id) => makePeggedAsset({ id, price: null, priceSource: "missing" })),
      reviewedGapIds,
    });
    const expectedCohort = ids.map((id) => expect.objectContaining({ id, price: null }));
    expect(contracts.runDlContractPasses).toHaveBeenCalledWith(
      expectedCohort, undefined, expect.any(AbortSignal), undefined,
    );
    expect(jupiter.runJupiterPass).toHaveBeenCalledWith(
      expectedCohort, undefined, undefined, expect.any(AbortSignal), undefined, undefined,
    );
  });

  it("preserves transport failures and continues the independent serial pass", async () => {
    vi.mocked(contracts.runDlContractPasses).mockResolvedValueOnce({ resolved: 0, failures: ["dl-contracts"], pass1: 0, pass1b: 0 });
    const result = await runShortLivedPriceRefresh({ assets: [makePeggedAsset({ id: "m-m0", price: null })] });
    expect(result.contractRefresh.failedPasses).toEqual(["dl-contracts"]);
    expect(jupiter.runJupiterPass).toHaveBeenCalledOnce();
    expect(result.observations).toEqual([]);
  });

  it("propagates caller cancellation instead of reporting an upstream failure", async () => {
    const controller = new AbortController();
    const reason = new Error("slot lost");
    vi.mocked(contracts.runDlContractPasses).mockImplementationOnce(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(runShortLivedPriceRefresh({
      assets: [makePeggedAsset({ id: "m-m0", price: null })], signal: controller.signal,
    })).rejects.toBe(reason);
    expect(jupiter.runJupiterPass).not.toHaveBeenCalled();
  });
});
