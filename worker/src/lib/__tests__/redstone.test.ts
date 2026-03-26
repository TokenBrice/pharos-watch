import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRedstonePrices, REDSTONE_TRACKED_SYMBOL_ALLOWLIST } from "../redstone";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchRedstonePrices", () => {
  it("returns price and venue breakdown from the live object-per-symbol payload shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        USDT: {
          value: 0.9998,
          source: { binance: 0.9999, coinbase: 0.9997, curve: 0.9998 },
          timestamp: Date.now(),
        },
      }), { status: 200 }),
    ));

    const results = await fetchRedstonePrices(["USDT"]);
    expect(results.size).toBe(1);
    const r = results.get("USDT")!;
    expect(r.price).toBeCloseTo(0.9998, 4);
    expect(r.venues.size).toBeGreaterThanOrEqual(3);
    expect(r.venueAgreementPct).toBeGreaterThan(0);
  });

  it("computes venue agreement percentage correctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        USDT: {
          value: 0.97,
          source: {
            binance: 0.97, coinbase: 0.97, kraken: 0.97,
            curve: 1.00, uniswap: 1.00,
          },
          timestamp: Date.now(),
        },
      }), { status: 200 }),
    ));

    const results = await fetchRedstonePrices(["USDT"]);
    const r = results.get("USDT")!;
    expect(r.venueAgreementPct).toBeCloseTo(60, 0);
  });

  it("preserves exact-case symbols for mixed-case assets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        USDe: {
          value: 1.0002,
          source: { curve: 1.0001 },
          timestamp: Date.now(),
        },
        crvUSD: {
          value: 0.9996,
          source: { curve: 0.9996 },
          timestamp: Date.now(),
        },
      }), { status: 200 }),
    ));

    const results = await fetchRedstonePrices(["USDe", "crvUSD"]);
    expect(results.get("USDe")?.price).toBeCloseTo(1.0001, 4);
    expect(results.get("crvUSD")?.price).toBeCloseTo(0.9996, 4);
  });

  it("retries missing batch symbols individually", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        USDT: {
          value: 1.0,
          source: { kraken: 1.0 },
          timestamp: Date.now(),
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        USD1: {
          value: 0.9993,
          source: { coingecko: 0.9993 },
          timestamp: Date.now(),
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await fetchRedstonePrices(["USDT", "USD1"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.get("USDT")?.price).toBe(1);
    expect(results.get("USD1")?.price).toBeCloseTo(0.9993, 4);
  });

  it("filters out symbols that are outside the tracked RedStone allowlist", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await fetchRedstonePrices(["NOTREAL", REDSTONE_TRACKED_SYMBOL_ALLOWLIST[0]]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("NOTREAL"),
      expect.any(Object),
    );
    expect(results.size).toBe(0);
  });

  it("rejects stale prices before they can enter consensus", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T12:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        USDT: {
          value: 1.0,
          source: { binance: 1.0, coinbase: 1.0 },
          timestamp: Date.now() - 301_000,
        },
      }), { status: 200 }),
    ));

    const results = await fetchRedstonePrices(["USDT"]);

    expect(results.size).toBe(0);
  });

  it("rejects entries that do not include a usable per-venue breakdown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        USDT: {
          value: 1.0,
          source: {},
          timestamp: Date.now(),
        },
      }), { status: 200 }),
    ));

    const results = await fetchRedstonePrices(["USDT"]);

    expect(results.size).toBe(0);
  });
});

describe("REDSTONE_TRACKED_SYMBOL_ALLOWLIST", () => {
  it("contains unique symbols that all exist in the tracked registry", () => {
    const trackedSymbols = new Set(TRACKED_STABLECOINS.map((stablecoin) => stablecoin.symbol));

    expect(new Set(REDSTONE_TRACKED_SYMBOL_ALLOWLIST).size).toBe(REDSTONE_TRACKED_SYMBOL_ALLOWLIST.length);
    for (const symbol of REDSTONE_TRACKED_SYMBOL_ALLOWLIST) {
      expect(trackedSymbols.has(symbol)).toBe(true);
    }
  });
});
