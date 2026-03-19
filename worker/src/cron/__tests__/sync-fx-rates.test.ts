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
        body: { usd: { cnh: 7.28, rub: 90, uah: 41, ars: 1400 } },
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
    expect(metadata.sources.fawazahmed0).toBe("ok");

    const write = db.getHistory().find(
      (entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "fx-rates",
    );
    const cachedRates = JSON.parse(String(write?.binds[1] ?? "{}")) as Record<string, number>;
    expect(cachedRates.peggedCNH).toBeCloseTo(1 / 7.28, 6);
    expect(cachedRates.peggedCNH).not.toBe(cachedRates.peggedCNY);
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

  it("uses secondary API for CNH/RUB/UAH/ARS rates", async () => {
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
        body: { usd: { cnh: 7.28, rub: 90, uah: 41, ars: 1400 } },
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
    expect(metadata.rateCount).toBeGreaterThanOrEqual(20);
    expect(metadata.secondaryCoverage).toBe(4);
  });

  it("overlays fresh Chainlink reference feeds when they agree with current references", async () => {
    const decimalsHex = "0x0000000000000000000000000000000000000000000000000000000000000008";
    const latestRoundDataHex =
      "0x" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "0000000000000000000000000000000000000000000000000000000006717d60" +
      "0000000000000000000000000000000000000000000000000000000000000000" +
      "00000000000000000000000000000000000000000000000000000000684ea5dc" +
      "0000000000000000000000000000000000000000000000000000000000000001";

    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("frankfurter.app")) {
        return new Response(JSON.stringify({
          base: "USD",
          date: "2025-06-15",
          rates: { EUR: 0.925, GBP: 0.79, CHF: 0.88, JPY: 149.5, BRL: 5.0, IDR: 15800, SGD: 1.35, TRY: 36, AUD: 1.55, ZAR: 18.3, CAD: 1.37, CNY: 7.25, PHP: 56, MXN: 17.2 },
        }), { status: 200 });
      }
      if (url.includes("currency-api")) {
        return new Response(JSON.stringify({ usd: { cnh: 7.28, rub: 90, uah: 41, ars: 1400 } }), { status: 200 });
      }
      if (url.includes("gold-api.com/price/XAU")) {
        return new Response(JSON.stringify({ price: 2900 }), { status: 200 });
      }
      if (url.includes("gold-api.com/price/XAG")) {
        return new Response(JSON.stringify({ price: 32 }), { status: 200 });
      }
      if (url === "https://rpc.base.test") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { params?: Array<{ to?: string; data?: string }> };
        const call = body.params?.[0];
        if (call?.to === "0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F" && call.data === "0x313ce567") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: decimalsHex }), { status: 200 });
        }
        if (call?.to === "0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F" && call.data === "0xfeaf968c") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: latestRoundDataHex }), { status: 200 });
        }
      }
      return new Response("not found", { status: 404 });
    }));

    const db = mockD1([
      { match: "cache", rows: [], first: null },
      { match: "circuit", rows: [] },
    ]);
    const chainRpcs = new Map([
      ["base", {
        chainId: "base",
        chainName: "Base",
        type: "evm" as const,
        rpcUrl: "https://rpc.base.test",
        explorerUrl: "https://basescan.org",
      }],
    ]);

    const result = await syncFxRates(db, undefined, undefined, chainRpcs);
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.sources.chainlink).toBe("ok");

    const write = db.getHistory().find(
      (entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "fx-rates",
    );
    const cachedRates = JSON.parse(String(write?.binds[1] ?? "{}")) as Record<string, number>;
    expect(cachedRates.peggedEUR).toBeCloseTo(1.08101, 4);
  });
});
