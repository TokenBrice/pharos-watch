import { describe, it, expect, vi, afterEach } from "vitest";
import { isValidFxRate } from "../fx-config";
import { fetchRealtimeFxRates } from "../fx-realtime";
import { FxSyncRunState } from "../../cron/sync-fx-rates-helpers";
import { mockFetch } from "@shared/test-utils/mock-fetch";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NOW_SEC = Math.floor(Date.parse("2025-06-15T12:00:00Z") / 1000);

describe("fetchRealtimeFxRates", () => {
  it("returns USD-per-unit rates with the upstream snapshot time", async () => {
    mockFetch([{
      match: () => true,
      body: {
        timestamp: NOW_SEC - 1_800,
        rates: { JPY: 150.5, EUR: 0.925, BRL: 5.1, ZAR: 18.2, VND: 26000, IDR: 15800, COP: 3200 },
      },
    }]);
    const result = await fetchRealtimeFxRates("test-key", undefined, NOW_SEC);
    expect(result.completed).toBe(true);
    expect(result.rejection).toBeNull();
    expect(result.observation?.observedAt).toBe(NOW_SEC - 1_800);
    const rates = result.observation?.rates ?? new Map<string, number>();
    expect(rates.get("peggedJPY")).toBeCloseTo(1 / 150.5, 6);
    expect(rates.get("peggedEUR")).toBeCloseTo(1 / 0.925, 4);
    expect(rates.get("peggedREAL")).toBeCloseTo(1 / 5.1, 4);

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
      expect(rates.get(pegKey)).toBe(dailyState.usableRates[pegKey]);
    }
  });

  it.each([
    ["missing", undefined, "timestamp-missing"],
    ["stale beyond one missed hourly publish", NOW_SEC - 2 * 3600 - 1, "timestamp-stale"],
    ["future-skewed", NOW_SEC + 5 * 60 + 1, "timestamp-future"],
  ] as const)("rejects a %s upstream timestamp instead of stamping the fetch time", async (_label, timestamp, reason) => {
    mockFetch([{ match: () => true, body: { timestamp, rates: { EUR: 0.925 } } }]);

    const result = await fetchRealtimeFxRates("test-key", undefined, NOW_SEC);

    expect(result.completed).toBe(true);
    expect(result.observation).toBeNull();
    expect(result.rejection).toEqual({ reason, upstreamTimestamp: timestamp ?? null });
  });

  it("admits snapshots at the inclusive age and future-skew boundaries", async () => {
    for (const timestamp of [NOW_SEC - 2 * 3600, NOW_SEC + 5 * 60]) {
      mockFetch([{ match: () => true, body: { timestamp, rates: { EUR: 0.925 } } }]);
      const result = await fetchRealtimeFxRates("test-key", undefined, NOW_SEC);
      expect(result.observation?.observedAt).toBe(timestamp);
    }
  });

  it("returns no observation on API failure", async () => {
    vi.useFakeTimers();
    const firstResponse = new Response("down", { status: 500 });
    const secondResponse = new Response("still down", { status: 500 });
    const firstCancel = vi.spyOn(firstResponse.body!, "cancel");
    const secondCancel = vi.spyOn(secondResponse.body!, "cancel");
    const fetchMock = mockFetch([{
      match: () => true,
      outcomes: [{ response: firstResponse }, { response: secondResponse }],
    }]);

    const pending = fetchRealtimeFxRates("test-key", undefined, NOW_SEC);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.completed).toBe(false);
    expect(result.observation).toBeNull();
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
      outcomes: [{ response: rateLimited }, { body: { timestamp: NOW_SEC - 600, rates: { EUR: 0.925 } } }],
    }]);

    const pending = fetchRealtimeFxRates("test-key", undefined, NOW_SEC);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.completed).toBe(true);
    expect(result.observation?.rates.get("peggedEUR")).toBeCloseTo(1 / 0.925, 4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("validates rates against bounds before returning", async () => {
    mockFetch([{
      match: () => true,
      body: {
        timestamp: NOW_SEC - 600,
        rates: { JPY: 0.001, EUR: 0.925 }, // JPY rate is absurd (1 JPY = $1000)
      },
    }]);
    const result = await fetchRealtimeFxRates("test-key", undefined, NOW_SEC);
    expect(result.completed).toBe(true);
    expect(result.observation?.rates.has("peggedJPY")).toBe(false); // rejected by bounds
    expect(result.observation?.rates.has("peggedEUR")).toBe(true);   // accepted
  });
});
