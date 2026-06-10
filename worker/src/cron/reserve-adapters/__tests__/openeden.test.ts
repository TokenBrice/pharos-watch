import { describe, expect, it } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { StablecoinMeta } from "@shared/types/core";
import { adaptOpenEdenUsdo, fetchOpenEdenUsdoReserves } from "../openeden";
import { buildBrowserHeaders } from "../request";

describe("adaptOpenEdenUsdo", () => {
  it("maps reserve composition fields into reserve slices", () => {
    const result = adaptOpenEdenUsdo({
      date: "2026-03-25T08:00:17.600Z",
      usdoAmount: 62_283_070,
      totalTbillAmountInUsd: 46_831_981.32,
      usdcAmount: 4_767_161.22,
      buidlAmount: 4_568_146.14,
      vbillAmount: 6_372_155.86,
      usycAmountInUsd: 0,
      benjiAmount: 0,
      reserveAssetsInUsd: 62_539_444.54,
      ratio: 100.4116,
    });

    expect(result.slices).toEqual([
      { name: "OpenEden TBILL", pct: 74.9, risk: "very-low", coinId: "tbill-openeden" },
      { name: "OpenEden VBILL", pct: 10.2, risk: "low" },
      { name: "USDC buffer", pct: 7.6, risk: "low", coinId: "usdc-circle" },
      { name: "BlackRock BUIDL", pct: 7.3, risk: "low", coinId: "buidl-blackrock" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 2, 25, 8, 0, 17) / 1000,
      reserveAssetsInUsd: 62_539_444.54,
      supplyUsd: 62_283_070,
      immediateRedeemableUsd: 4_767_161.22,
      redemption: {
        routeStatus: "open",
        routeStatusSource: "protocol-api",
        holderEligibility: "verified-customer",
      },
    });
  });

  it("includes pendingUsdc in component-total validation", () => {
    // Regression: OpenEden added a pendingUsdc field (USDC from user
    // subscriptions awaiting T-Bill conversion) that contributes to
    // reserveAssetsInUsd. Without this field in the component sum the
    // 1% tolerance check throws for live payloads where pending
    // subscriptions are non-zero. Values mirror the 2026-04-19 live
    // production payload shape: pendingUsdc accounts for ~1.76% of
    // reserveAssetsInUsd, which previously tripped the validation.
    const result = adaptOpenEdenUsdo({
      date: "2026-04-19T00:00:00.000Z",
      usdoAmount: 44_085_617.15,
      totalTbillAmountInUsd: 38_824_683.87,
      usdcAmount: 411_606.20,
      rlusdAmount: 4_000_200,
      buidlAmount: 3_219_897.49,
      vbillAmount: 1_763_678.75,
      usycAmountInUsd: 0,
      benjiAmount: 0,
      pendingUsdc: 864_831.69,
      reserveAssetsInUsd: 49_084_898.00,
      ratio: 111.3399,
    });

    expect(result.slices).toContainEqual({
      name: "Pending USDC",
      pct: 1.8,
      risk: "very-low",
      coinId: "usdc-circle",
    });
    expect(result.metadata?.componentTotalUsd).toBeCloseTo(49_084_898.00, 2);
  });

  it("includes the RLUSD component in component-total validation and slices", () => {
    const result = adaptOpenEdenUsdo({
      date: "2026-03-25T08:00:17.600Z",
      usdoAmount: 100,
      totalTbillAmountInUsd: 70,
      usdcAmount: 10,
      rlusdAmount: 5,
      buidlAmount: 5,
      vbillAmount: 10,
      usycAmountInUsd: 0,
      benjiAmount: 0,
      reserveAssetsInUsd: 100,
      ratio: 1,
    });

    expect(result.slices).toContainEqual({
      name: "RLUSD buffer",
      pct: 5,
      risk: "low",
      coinId: "rlusd-ripple",
    });
  });

  it("accepts decimal-scale ratio values as-is", () => {
    const result = adaptOpenEdenUsdo({
      date: "2026-03-25T08:00:17.600Z",
      usdoAmount: 100,
      totalTbillAmountInUsd: 70,
      usdcAmount: 15,
      buidlAmount: 5,
      vbillAmount: 10,
      usycAmountInUsd: 0,
      benjiAmount: 0,
      reserveAssetsInUsd: 100,
      ratio: 1.005,
    });
    expect(result.metadata?.reserveRatio).toBe(1.005);
  });

  it("divides percent-scale ratio values by 100", () => {
    const result = adaptOpenEdenUsdo({
      date: "2026-03-25T08:00:17.600Z",
      usdoAmount: 100,
      totalTbillAmountInUsd: 70,
      usdcAmount: 15,
      buidlAmount: 5,
      vbillAmount: 10,
      usycAmountInUsd: 0,
      benjiAmount: 0,
      reserveAssetsInUsd: 100,
      ratio: 100.5,
    });
    expect(result.metadata?.reserveRatio).toBe(1.005);
  });

  it("throws for non-numeric or non-positive ratio values", () => {
    const base = {
      date: "2026-03-25T08:00:17.600Z",
      usdoAmount: 100,
      totalTbillAmountInUsd: 70,
      usdcAmount: 15,
      buidlAmount: 5,
      vbillAmount: 10,
      usycAmountInUsd: 0,
      benjiAmount: 0,
      reserveAssetsInUsd: 100,
    };
    expect(() => adaptOpenEdenUsdo({ ...base, ratio: Number.NaN })).toThrow(/ratio is non-numeric/);
    expect(() => adaptOpenEdenUsdo({ ...base, ratio: 0 })).toThrow(/ratio is non-numeric/);
    expect(() => adaptOpenEdenUsdo({ ...base, ratio: -1 })).toThrow(/ratio is non-numeric/);
  });
});

describe("fetchOpenEdenUsdoReserves", () => {
  const coin = { id: "usdo-openeden" } as StablecoinMeta;
  const url = "https://prod-gw.openeden.com/usdo/sys/reserve-composition-last";
  // Mirrors the adapter's browser-style headers and 8s per-attempt timeout,
  // both of which are embedded in the shared JSON request cache key.
  const cacheKey = `json-get:${url}:8000:${JSON.stringify(
    buildBrowserHeaders("https://openeden.com", "https://openeden.com/usdo/transparency"),
  )}`;
  const payload = {
    date: "2026-03-25T08:00:17.600Z",
    usdoAmount: 100,
    totalTbillAmountInUsd: 70,
    usdcAmount: 15,
    buidlAmount: 5,
    vbillAmount: 10,
    usycAmountInUsd: 0,
    benjiAmount: 0,
    reserveAssetsInUsd: 100,
    ratio: 1,
  };

  function makeConfig(): LiveReservesConfig {
    return {
      adapter: "openeden-usdo",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "http-json", url } },
    };
  }

  it("fetches the reserve composition with browser-style headers and adapts it", async () => {
    const cache = new Map<string, Promise<unknown>>();
    cache.set(cacheKey, Promise.resolve(payload));

    const result = await fetchOpenEdenUsdoReserves(
      coin,
      makeConfig(),
      new AbortController().signal,
      { requestCache: cache } as never,
    );

    expect(result.metadata?.reserveRatio).toBe(1);
    expect(result.slices.length).toBeGreaterThan(0);
  });

  it("labels fetch failures with the adapter and fetch identity", async () => {
    const cache = new Map<string, Promise<unknown>>();
    cache.set(cacheKey, Promise.reject(new Error(`Fetch failed for ${url}`)));

    await expect(fetchOpenEdenUsdoReserves(
      coin,
      makeConfig(),
      new AbortController().signal,
      { requestCache: cache } as never,
    )).rejects.toThrow(
      `openeden-usdo reserve composition fetch failed: Fetch failed for ${url}`,
    );
  });

  it("rethrows the original error untouched when the adapter attempt signal aborted", async () => {
    const abortError = new Error("adapter-timeout");
    const cache = new Map<string, Promise<unknown>>();
    cache.set(cacheKey, Promise.reject(abortError));
    const controller = new AbortController();
    controller.abort(abortError);

    await expect(fetchOpenEdenUsdoReserves(
      coin,
      makeConfig(),
      controller.signal,
      { requestCache: cache } as never,
    )).rejects.toBe(abortError);
  });
});
