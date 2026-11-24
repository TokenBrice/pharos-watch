import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { COINGECKO_MICRO_VOLUME_OUTLIER_REASON } from "@shared/lib/pricing-source-policy";
import { cgSimplePricePath } from "../coingecko";
import { evaluateCoingeckoMicroVolumeOutlier, fetchCoingeckoSimplePrices } from "../coingecko-simple-price";
import { buildPriceValidationContext } from "../price-validation";

const NOW_SEC = 1_792_391_400;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cgSimplePricePath", () => {
  it("forces full precision without dropping existing parameters", () => {
    const path = cgSimplePricePath("ids=euro-coin&vs_currencies=eur&precision=2");
    const url = new URL(path, "https://api.coingecko.com");

    expect(url.pathname).toBe("/simple/price");
    expect(url.searchParams.get("ids")).toBe("euro-coin");
    expect(url.searchParams.get("vs_currencies")).toBe("eur");
    expect(url.searchParams.get("precision")).toBe("full");
  });
});

describe("fetchCoingeckoSimplePrices", () => {
  it("requests 24h volume, preserves R1 null volume, and quarantines malformed sibling rows", async () => {
    // R8: a provider-shape anomaly in one quote must not reject its 249
    // healthy siblings from the same /simple/price batch.
    const spy = mockFetch([
      {
        match: "api.coingecko.com/api/v3/simple/price",
        body: {
          hive_dollar: { usd: 0.98662, usd_24h_vol: 25_000, last_updated_at: NOW_SEC - 30 },
          "wrappedm-by-m0": { usd: null, last_updated_at: NOW_SEC - 30 },
          usdfc: { usd: 0.950358, usd_24h_vol: null, last_updated_at: NOW_SEC - 90 },
          a7a5: { usd: 0.001774, usd_24h_vol: 0, last_updated_at: NOW_SEC - 10 },
        },
      },
    ], { requireMatch: true });

    const outcome = await fetchCoingeckoSimplePrices(
      ["hive_dollar", "wrappedm-by-m0", "usdfc", "a7a5"],
      null,
      undefined,
      NOW_SEC,
    );

    expect(String(spy.mock.calls[0]?.[0])).toContain("include_24hr_vol=true");
    expect(outcome.kind).toBe("ok");
    expect(Object.fromEntries(outcome.value)).toEqual({
      hive_dollar: { price: 0.98662, observedAt: NOW_SEC - 30, observedAtMode: "upstream", volume24hUsd: 25_000 },
      usdfc: { price: 0.950358, observedAt: NOW_SEC - 90, observedAtMode: "upstream", volume24hUsd: null },
      a7a5: { price: 0.001774, observedAt: NOW_SEC - 10, observedAtMode: "upstream", volume24hUsd: 0 },
    });
  });

  it.each([
    [0.001774, 7.06, { pegType: "peggedRUB" }, { peggedRUB: 0.01218 }, "rejected"],
    [1.0501, 999.99, { pegType: "peggedUSD" }, undefined, "rejected"],
    [0.94, 0, { pegType: "peggedUSD" }, undefined, "rejected"],
    [0.95, 7, { pegType: "peggedUSD" }, undefined, "ok"],
    [1.05, 7, { pegType: "peggedUSD" }, undefined, "ok"],
    [0.8, 1_000, { pegType: "peggedUSD" }, undefined, "ok"],
    [0.8, null, { pegType: "peggedUSD" }, undefined, "volume_unavailable"],
    [1.4, 7, { pegType: "peggedUSD", navToken: true }, undefined, "ok"],
    [1.4, 7, { pegCurrency: "VAR", pegType: "peggedVAR" }, undefined, "ok"],
    [0.001, 7, { pegType: "peggedRUB" }, undefined, "ok"],
  ] as const)("micro-volume outlier gate (%s, vol=%s -> %s)", (price, volume24hUsd, ctx, rates, expected) => {
    const res = evaluateCoingeckoMicroVolumeOutlier({
      price, volume24hUsd, context: buildPriceValidationContext(ctx),
      references: rates ? { rates, type: "fresh", updatedAt: NOW_SEC } : undefined,
    });
    expect(res.status).toBe(expected);
    if (res.status === "rejected") expect(res.reason).toBe(COINGECKO_MICRO_VOLUME_OUTLIER_REASON);
  });
});
