import { describe, it, expect, vi, afterEach } from "vitest";
import { isValidFxRate } from "../fx-config";
import { fetchRealtimeFxRates } from "../fx-realtime";
import { FxSyncRunState } from "../../cron/sync-fx-rates-helpers";
import { mockFetch } from "@shared/test-utils/mock-fetch";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchRealtimeFxRates", () => {
  it("returns USD-per-unit rates for all requested currencies", async () => {
    mockFetch([{
      match: () => true,
      body: {
        rates: { JPY: 150.5, EUR: 0.925, BRL: 5.1, ZAR: 18.2, VND: 26000, IDR: 15800, COP: 3200 },
      },
    }]);
    const result = await fetchRealtimeFxRates("test-key");
    expect(result.completed).toBe(true);
    expect(result.rates.get("peggedJPY")).toBeCloseTo(1 / 150.5, 6);
    expect(result.rates.get("peggedEUR")).toBeCloseTo(1 / 0.925, 4);
    expect(result.rates.get("peggedREAL")).toBeCloseTo(1 / 5.1, 4);

    const dailyState = new FxSyncRunState({
      prevState: null,
      syncStartSec: Math.floor(Date.parse("2025-06-15T12:00:00Z") / 1000),
      expectedPegKeys: ["peggedVND", "peggedIDR", "peggedCOP"],
      initialSources: {},
      validateRate: (pegKey, rate, prevRate) => isValidFxRate(pegKey, rate, prevRate, "[fx-realtime:test]"),
    });
    dailyState.applySecondaryRates({
      endpoint: "pages.dev",
      payload: { date: "2025-06-15", usd: { vnd: 26_000, idr: 15_800, cop: 3_200 } },
    }, [
      ["vnd", "peggedVND"],
      ["idr", "peggedIDR"],
      ["cop", "peggedCOP"],
    ]);
    for (const pegKey of ["peggedVND", "peggedIDR", "peggedCOP"] as const) {
      expect(result.rates.get(pegKey)).toBe(dailyState.usableRates[pegKey]);
    }
  });

  it("returns empty map on API failure", async () => {
    vi.useFakeTimers();
    const firstResponse = new Response("down", { status: 500 });
    const secondResponse = new Response("still down", { status: 500 });
    const firstCancel = vi.spyOn(firstResponse.body!, "cancel");
    const secondCancel = vi.spyOn(secondResponse.body!, "cancel");
    const fetchMock = mockFetch([{
      match: () => true,
      outcomes: [{ response: firstResponse }, { response: secondResponse }],
    }]);

    const pending = fetchRealtimeFxRates("test-key");
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.completed).toBe(false);
    expect(result.rates.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstCancel).toHaveBeenCalledOnce();
    expect(secondCancel).toHaveBeenCalledOnce();
  });

  it("retries a rate-limited OXR response before returning rates", async () => {
    vi.useFakeTimers();
    const rateLimited = new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
      headers: { "Retry-After": "1" },
    });
    const cancel = vi.spyOn(rateLimited.body!, "cancel");
    const fetchMock = mockFetch([{
      match: () => true,
      outcomes: [{ response: rateLimited }, { body: { rates: { EUR: 0.925 } } }],
    }]);

    const pending = fetchRealtimeFxRates("test-key");
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.completed).toBe(true);
    expect(result.rates.get("peggedEUR")).toBeCloseTo(1 / 0.925, 4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("validates rates against bounds before returning", async () => {
    mockFetch([{
      match: () => true,
      body: {
        rates: { JPY: 0.001, EUR: 0.925 }, // JPY rate is absurd (1 JPY = $1000)
      },
    }]);
    const result = await fetchRealtimeFxRates("test-key");
    expect(result.completed).toBe(true);
    expect(result.rates.has("peggedJPY")).toBe(false); // rejected by bounds
    expect(result.rates.has("peggedEUR")).toBe(true);   // accepted
  });
});
