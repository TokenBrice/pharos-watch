import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRedstonePrices, REDSTONE_TRACKED_SYMBOL_ALLOWLIST } from "../redstone";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import redstoneBatchFixture from "./fixtures/redstone-batch.json";

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

    const outcome = await fetchRedstonePrices(["USDT"]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.size).toBe(1);
    const r = outcome.value.get("USDT")!;
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

    const outcome = await fetchRedstonePrices(["USDT"]);
    const r = outcome.value.get("USDT")!;
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

    const outcome = await fetchRedstonePrices(["USDe", "crvUSD"]);
    expect(outcome.value.get("USDe")?.price).toBeCloseTo(1.0001, 4);
    expect(outcome.value.get("crvUSD")?.price).toBeCloseTo(0.9996, 4);
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

    const outcome = await fetchRedstonePrices(["USDT", "USD1"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.value.get("USDT")?.price).toBe(1);
    expect(outcome.value.get("USD1")?.price).toBeCloseTo(0.9993, 4);
  });

  it("filters out symbols that are outside the tracked RedStone allowlist", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await fetchRedstonePrices(["NOTREAL", REDSTONE_TRACKED_SYMBOL_ALLOWLIST[0]]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("NOTREAL"),
      expect.any(Object),
    );
    expect(outcome.value.size).toBe(0);
  });

  it("rejects stale prices before they can enter consensus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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

    const outcome = await fetchRedstonePrices(["USDT"]);

    expect(outcome.value.size).toBe(0);
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

    const outcome = await fetchRedstonePrices(["USDT"]);

    expect(outcome.value.size).toBe(0);
  });

  it("returns upstream-error outcome when every batch HTTP request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("server error", { status: 503 })));
    const outcome = await fetchRedstonePrices(["USDT"]);
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.size).toBe(0);
  });

  it("returns no-data outcome when requested symbols are all outside the allowlist", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const outcome = await fetchRedstonePrices(["NOTREAL"]);
    expect(outcome.kind).toBe("no-data");
  });

  it("returns ok outcome when at least one price is returned", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        USDT: {
          value: 0.9999,
          source: { binance: 0.9999 },
          timestamp: Date.now(),
        },
      }), { status: 200 }),
    ));
    const outcome = await fetchRedstonePrices(["USDT"]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.get("USDT")?.price).toBeCloseTo(0.9999, 4);
  });

  it("selects the newest entry by timestamp when array responses are returned", async () => {
    const now = Date.now();
    const olderTimestamp = now - 60_000;
    const newerTimestamp = now;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        USDT: [
          { value: 0.5, source: { binance: 0.5 }, timestamp: olderTimestamp },
          { value: 1.0, source: { binance: 1.0 }, timestamp: newerTimestamp },
        ],
      }), { status: 200 }),
    ));

    const outcome = await fetchRedstonePrices(["USDT"]);

    expect(outcome.value.get("USDT")?.price).toBe(1.0);
    expect(outcome.value.get("USDT")?.timestamp).toBe(Math.floor(newerTimestamp / 1000));
  });

  it("bounds solo-retry budget to 5 requests when many batch symbols drop", async () => {
    const tenSymbols = REDSTONE_TRACKED_SYMBOL_ALLOWLIST.slice(0, 10);
    expect(tenSymbols.length).toBe(10);

    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchRedstonePrices([...tenSymbols]);

    // 1 batch fetch + at most 5 solo retries = 6 total fetch calls.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("parses a real RedStone /prices USDT response (fixture)", async () => {
    // Fixture captured from
    // https://api.redstone.finance/prices?provider=redstone-primary-prod&symbols=USDT
    // Verifies the live object-per-symbol payload shape is accepted and the
    // per-venue breakdown is preserved.
    const fixtureTimestampMs = redstoneBatchFixture.USDT.timestamp;
    // Freeze time just after fixture's timestamp so the 300s staleness gate
    // accepts the sample.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixtureTimestampMs + 10_000));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(redstoneBatchFixture), { status: 200 }),
    ));

    const outcome = await fetchRedstonePrices(["USDT"]);

    expect(outcome.kind).toBe("ok");
    const result = outcome.value.get("USDT")!;
    expect(result.price).toBeCloseTo(redstoneBatchFixture.USDT.value, 6);
    expect(result.venues.size).toBe(Object.keys(redstoneBatchFixture.USDT.source).length);
    expect(result.timestamp).toBe(Math.floor(fixtureTimestampMs / 1000));
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
