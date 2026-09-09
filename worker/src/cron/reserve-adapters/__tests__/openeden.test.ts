import { fetchWithRetryMock, resetRpcMocks } from "./helpers/rpc-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { StablecoinMeta } from "@shared/types/core";
import { adaptOpenEdenUsdo, fetchOpenEdenUsdoReserves } from "../openeden";

const forbiddenFetch = vi.fn(() => { throw new Error("Unexpected real network request"); });
beforeEach(() => {
  forbiddenFetch.mockClear();
  vi.stubGlobal("fetch", forbiddenFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(forbiddenFetch).not.toHaveBeenCalled();
});

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
      redemption: {
        capacityUsd: 4_767_161.22,
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
    expect(result.metadata).toMatchObject({
      redemption: { capacityUsd: 411_606.20 },
    });
  });

  it("includes the RLUSD component in component-total validation and slices", () => {
    const result = adaptOpenEdenUsdo({ ...payload, usdcAmount: 10, rlusdAmount: 5 });

    expect(result.slices).toContainEqual({
      name: "RLUSD buffer",
      pct: 5,
      risk: "low",
      coinId: "rlusd-ripple",
    });
  });

  it.each([1.005, 100.5])("normalizes decimal and percentage ratio %s", (ratio) => {
    expect(adaptOpenEdenUsdo({ ...payload, ratio }).metadata?.reserveRatio).toBe(1.005);
  });

  it.each([Number.NaN, 0, -1])("rejects non-numeric or non-positive ratio %s", (ratio) => {
    expect(() => adaptOpenEdenUsdo({ ...payload, ratio })).toThrow(/ratio is non-numeric/);
  });
});

describe("fetchOpenEdenUsdoReserves", () => {
  const coin = { id: "usdo-openeden" } as StablecoinMeta;
  const url = "https://prod-gw.openeden.com/usdo/sys/reserve-composition-last";

  function makeConfig(): LiveReservesConfig {
    return {
      adapter: "openeden-usdo",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "http-json", url } },
    };
  }

  beforeEach(resetRpcMocks);

  it.each([0.999, 1.001])("enforces the 1% component boundary: %s", (delta) => {
    const candidate = { ...payload, usdcAmount: 15 + delta };
    if (delta < 1) {
      expect(adaptOpenEdenUsdo(candidate).metadata?.componentTotalUsd).toBeCloseTo(100.999, 6);
    } else {
      expect(() => adaptOpenEdenUsdo(candidate)).toThrow(/components sum/);
    }
  });

  it.each([0.01999, 0.02001])("enforces the 2% ratio boundary: %s", (delta) => {
    const candidate = { ...payload, usdoAmount: 100 / (1 + delta) };
    if (delta < 0.02) {
      expect(adaptOpenEdenUsdo(candidate).metadata?.reserveRatio).toBe(1);
    } else {
      expect(() => adaptOpenEdenUsdo(candidate)).toThrow(/does not match derived ratio/);
    }
  });
  it.each(["browser", "neutral", "default"])("recovers through the %s HTTP identity", async (successfulIdentity) => {
    const observed: string[] = [];
    const unexpected: string[] = [];
    fetchWithRetryMock.mockImplementation(async (requested: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const identity = headers.has("origin") ? "browser" : headers.has("accept-language") ? "neutral" : "default";
      observed.push(identity);
      if (requested !== url || headers.get("accept") !== "application/json"
        || (identity === "browser" && (headers.get("origin") !== "https://openeden.com"
          || headers.get("referer") !== "https://openeden.com/usdo/transparency"))) {
        unexpected.push(requested);
        return null;
      }
      return new Response(JSON.stringify(payload), { status: identity === successfulIdentity ? 200 : 403 });
    });
    const result = await fetchOpenEdenUsdoReserves(coin, makeConfig(), new AbortController().signal, { requestCache: new Map() });
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 15 });
    expect(result.slices).toContainEqual({ name: "OpenEden TBILL", pct: 70, risk: "very-low", coinId: "tbill-openeden" });
    expect(observed).toEqual(["browser", "neutral", "default"].slice(0, ["browser", "neutral", "default"].indexOf(successfulIdentity) + 1));
    expect(unexpected).toEqual([]);
  });

  it("reuses a successful request from an initially empty cache", async () => {
    fetchWithRetryMock.mockResolvedValue(new Response(JSON.stringify(payload)));
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    const first = await fetchOpenEdenUsdoReserves(coin, makeConfig(), new AbortController().signal, ctx);
    const second = await fetchOpenEdenUsdoReserves(coin, makeConfig(), new AbortController().signal, ctx);
    expect(second).toEqual(first);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it("retains each failed HTTP cause and adapter identity", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      return new Response("denied", { status: headers.has("origin") ? 401 : headers.has("accept-language") ? 403 : 404 });
    });
    const error = await fetchOpenEdenUsdoReserves(coin, makeConfig(), new AbortController().signal, { requestCache: new Map() }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    for (const cause of ["openeden-usdo", "HTTP 401", "HTTP 403", "HTTP 404"]) {
      expect((error as Error).message).toContain(cause);
    }
  });

  it("rethrows the original abort without fallback", async () => {
    const abortError = new Error("adapter-timeout");
    const controller = new AbortController();
    controller.abort(abortError);
    await expect(fetchOpenEdenUsdoReserves(coin, makeConfig(), controller.signal, { requestCache: new Map() })).rejects.toBe(abortError);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });
});
