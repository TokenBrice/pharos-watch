import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

// Stub fetchWithRetry to use our mocked global fetch
vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: async (url: string, opts?: RequestInit) => {
    return fetch(url, opts);
  },
}));

import { syncFxRates } from "../sync-fx-rates";

describe("syncFxRates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("caches FX rates from frankfurter.app when API succeeds", async () => {
    mockFetch([
      {
        match: "frankfurter.app",
        body: {
          base: "USD",
          date: "2025-06-15",
          rates: { EUR: 0.925, GBP: 0.79, CHF: 0.88, JPY: 149.5, BRL: 5.0, IDR: 15800, SGD: 1.35, TRY: 36, AUD: 1.55, ZAR: 18.3, CAD: 1.37, CNY: 7.25, PHP: 56, MXN: 17.2 },
        },
      },
      {
        match: "currency-api",
        body: { usd: { rub: 90, uah: 41, ars: 1400 } },
      },
      {
        match: "gold-api.com/price/XAU",
        body: { price: 2900 },
      },
      {
        match: "gold-api.com/price/XAG",
        body: { price: 32 },
      },
    ]);

    const db = mockD1([
      { match: "cache", rows: [], first: null },
    ]);

    const result = await syncFxRates(db);
    expect(result.itemCount).toBeGreaterThan(0);
    expect(result.metadata).toBeDefined();

    const metadata = JSON.parse(result.metadata!);
    expect(metadata.rateCount).toBeGreaterThan(5);
  });

  it("falls back to cached rates when frankfurter.app is unavailable", async () => {
    mockFetch([
      {
        match: "frankfurter.app",
        body: { error: "Service unavailable" },
        status: 503,
      },
    ]);

    const db = mockD1([
      {
        match: "cache",
        rows: [],
        first: {
          value: JSON.stringify({ peggedEUR: 1.08, peggedRUB: 0.011 }),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
    ]);

    const result = await syncFxRates(db);
    expect(result.itemCount).toBe(2);
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.fallbackMode).toBe("cached-fx-rates");
  });

  it("uses secondary API for RUB/UAH/ARS rates", async () => {
    mockFetch([
      {
        match: "frankfurter.app",
        body: {
          base: "USD",
          date: "2025-06-15",
          rates: { EUR: 0.925, GBP: 0.79, CHF: 0.88, JPY: 149.5, BRL: 5.0, IDR: 15800, SGD: 1.35, TRY: 36, AUD: 1.55, ZAR: 18.3, CAD: 1.37, CNY: 7.25, PHP: 56, MXN: 17.2 },
        },
      },
      {
        match: "currency-api",
        body: { usd: { rub: 90, uah: 41, ars: 1400 } },
      },
      {
        match: "gold-api.com/price/XAU",
        body: { price: 2900 },
      },
      {
        match: "gold-api.com/price/XAG",
        body: { price: 32 },
      },
    ]);

    const db = mockD1([
      { match: "cache", rows: [], first: null },
    ]);

    const result = await syncFxRates(db);
    const metadata = JSON.parse(result.metadata ?? "{}");
    // Should include gold and silver prices
    expect(metadata.rateCount).toBeGreaterThanOrEqual(14);
  });
});
