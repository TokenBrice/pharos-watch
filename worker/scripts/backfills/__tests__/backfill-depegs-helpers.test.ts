import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHistoricalReferenceLookup,
  findHistoricalFxValuationRate,
  fetchHistoricalSecondaryFxRates,
} from "../../../src/lib/backfill-fx";
import {
  extractDepegEvents,
  findNearestSupply,
  parseSupplyData,
} from "../../../src/lib/historical-depeg-extraction";

import { fetchCgPriceHistoryHourly } from "../../../src/lib/historical-market-prices";
import { executeBackfillForCoin } from "../backfill-depegs/execution";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createDeferredPromise } from "../../../src/lib/__tests__/deferred.test-support";

// Monday 1970-01-05: 1 January and weekends close FX and metal markets, whose readings are held.
const OPEN = 4 * 24 * 3_600;

const fxFixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fxFixtures.closeAll();
});

/** Run a retry-backed call under fake timers, advancing in 500 ms steps. */
async function drainRetryBackoff<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < 10_000 && !settled; elapsed += 500) {
    await vi.advanceTimersByTimeAsync(500);
  }
  if (!settled) throw new Error("retry backoff did not settle within 10s of fake time");
  return await promise;
}

describe("historical FX configuration", () => {
  it("skips a coin without historical supply and performs no writes", async () => {
    const meta = ACTIVE_STABLECOINS.find((coin) => coin.id === "brz-transfero");
    expect(meta).toBeDefined();
    if (!meta) throw new Error("missing BRZ fixture");
    const applyBackfillEvents = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await executeBackfillForCoin({
      db: mockD1([{ match: "FROM depeg_events WHERE", rows: [] }]),
      prepared: {
        meta,
        geckoId: "unused-because-missing-fx-skips-first",
        supplyTokens: [],
      },
      fxSeries: {},
      commodityPeers: {},
      replayWindow: null,
      coingeckoApiKey: null,
      dryRun: false,
      applyBackfillEvents,
    });

    expect(outcome).toEqual({
      status: "skipped",
      eventCount: 0,
      reason: "missing-historical-supply",
    });
    expect(applyBackfillEvents).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

});

describe("parseSupplyData", () => {
  it("ignores invalid dates and returns sorted snapshots", () => {
    const parsed = parseSupplyData([
      { date: "200", circulating: { peggedUSD: 20 } },
      { date: "invalid", circulating: { peggedUSD: 10 } },
      { date: "100", circulating: { peggedUSD: 30 } },
      { date: "100", circulating: { peggedUSD: 40 } },
    ]);

    expect(parsed).toEqual([
      { ts: 100, supply: 40 },
      { ts: 200, supply: 20 },
    ]);
  });

  it("sums USD buckets without applying a native-unit conversion", () => {
    expect(parseSupplyData([
      { date: "100", totalCirculatingUSD: { peggedUSD: 125, peggedEUR: 75 } },
    ], () => 2)).toEqual([{ ts: 100, supply: 200 }]);
  });

  it("drops absent and invalid buckets but preserves explicit observed zero", () => {
    expect(parseSupplyData([
      { date: "100" },
      { date: "200", circulating: {} },
      { date: "300", circulating: { peggedUSD: Number.NaN } },
      { date: "400", circulating: { peggedUSD: -1 } },
      { date: "500", totalCirculatingUSD: { peggedUSD: Number.POSITIVE_INFINITY } },
      { date: "600", circulating: { peggedUSD: 0 } },
      { date: "700", totalCirculatingUSD: { peggedJPY: 0 }, circulating: { peggedJPY: 200_000_000 } },
    ])).toEqual([{ ts: 600, supply: 0 }, { ts: 700, supply: 0 }]);
  });

  it.each([
    ["peggedJPY", 200_000_000, 1 / 150, true],
    ["peggedJPY", 75_000_000, 1 / 150, false],
    ["peggedEUR", 900_000, 1.2, true],
    ["peggedGOLD", 500, 3_000, true],
  ] as const)("uses USD-converted %s supply for the event floor", (pegType, native, rate, expectedEvent) => {
    const tokens = [{ date: String(OPEN + 1_000), circulating: { [pegType]: native } }];
    const converted = parseSupplyData(tokens, () => rate);
    expect(converted[0].supply).toBeCloseTo(native * rate);
    const events = extractDepegEvents(
      [
        { timestamp: OPEN + 1_000, price: rate * 0.98 },
        { timestamp: OPEN + 2_000, price: rate * 0.97 },
        { timestamp: OPEN + 3_000, price: rate },
      ],
      () => rate,
      pegType,
      converted,
    );
    expect(events).toHaveLength(expectedEvent ? 1 : 0);
  });

  it("prefers historical USD supply over conflicting native units", () => {
    const parsed = parseSupplyData([
      { date: "1000", circulating: { peggedEUR: 500_000 }, totalCirculatingUSD: { peggedEUR: 2_000_000_000 } },
    ], () => 1.2);
    expect(parsed).toEqual([{ ts: 1_000, supply: 2_000_000_000 }]);
    expect(extractDepegEvents(
      [{ timestamp: 1_000, price: 1.17 }, { timestamp: 2_000, price: 1.2 }],
      () => 1.2, "peggedEUR", parsed,
    )).toEqual([]);
  });

  it("does not admit non-USD native supply without a conversion reference", () => {
    expect(parseSupplyData([{ date: "1000", circulating: { peggedJPY: 200_000_000 } }]))
      .toEqual([{ ts: 1000, supply: null }]);
  });
});

describe("findNearestSupply", () => {
  it("returns nearest supply snapshot by timestamp", () => {
    const supply = [
      { ts: 1_000, supply: 10 },
      { ts: 2_000, supply: 20 },
      { ts: 3_000, supply: 30 },
    ];

    expect(findNearestSupply(supply, 2_400)).toBe(20);
    expect(findNearestSupply(supply, 2_700)).toBe(30);
  });

  it("returns null when supply history is empty", () => {
    expect(findNearestSupply([], 1_000)).toBeNull();
  });

  it("returns null once the nearest snapshot is beyond the distance bound", () => {
    const supply = [{ ts: 1_000, supply: 10 }];

    expect(findNearestSupply(supply, 1_000 + 14 * 86_400)).toBe(10);
    expect(findNearestSupply(supply, 1_000 + 14 * 86_400 + 1)).toBeNull();
    expect(findNearestSupply(supply, 1_500, 500)).toBe(10);
    expect(findNearestSupply(supply, 1_501, 500)).toBeNull();
  });
});

it.each([3_600, 86_400])("rejects daily samples from long native ranges (gap %s)", async (gap) => {
  vi.useFakeTimers();
  const startSec = Date.parse("2026-01-01T00:00:00Z") / 1000;
  const fetchSpy = mockFetch([{
    match: "/market_chart/range",
    respond: (input) => {
      const from = Number(new URL(input.url).searchParams.get("from"));
      return { body: { prices: [[from * 1000, 1.02], [(from + gap) * 1000, 1.02]] } };
    },
  }], { requireMatch: true });
  const pending = fetchCgPriceHistoryHourly("euro-coin", { startSec, endSec: startSec + 120 * 86400 },
    "eur", null, undefined, true);
  await vi.runAllTimersAsync();
  expect(await pending).toHaveLength(gap === 3600 ? 4 : 0);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

describe("dated historical references", () => {
  it.each([[2, false], [3, true]])("requires three same-unit peers besides the subject (%s)", (count, usable) => {
    const ts = 1_700_000_000;
    const peers = ["kag-kinesis", "a", "b", "c"].slice(0, count + 1).map((assetId, index) => ({
      assetId, sourceId: assetId, commodityOunces: 0.5,
      prices: [{ timestamp: ts - 60 - index, price: index === 0 ? 4 : 15 }, { timestamp: ts + 60, price: 45 }],
    }));
    const ref = buildHistoricalReferenceLookup({
      subjectId: "kag-kinesis", commodityPeers: { SILVER: peers },
    });
    expect(ref.referenceAt("SILVER", ts)).toEqual(usable ? {
      usdPerUnit: 30, observedAtSec: ts - 63, source: "peer-median", kind: "median", contributors: ["a", "b", "c"],
      contributorEvidence: peers.slice(1).map(({ assetId, prices }) => ({
        assetId, provenanceKey: assetId, observedAtSec: prices[0]!.timestamp, derivation: "spot-derived",
      })),
    } : null);
    expect(ref.referenceAt("SILVER", ts - 120)).toBeNull();
    expect(ref.referenceAt("SILVER", ts + 3 * 3600)).toBeNull();
    expect(ref.referenceAt("GOLD", ts)).toBeNull();
  });
});

describe("fetchHistoricalSecondaryFxRates", () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "merges overlapping month writes (retained=%s, unavailable=%s)", async (retained, unavailable) => {
      const { db, sqlite } = fxFixtures.open();
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2025-07-01T00:00:00Z"));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const seed = retained ? { "2025-06-13": {}, "2025-06-14": { ars: 1_180 } } : {};
      if (retained) sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run("fx-history-secondary:2025", JSON.stringify(seed), Date.now() / 1000);
      const started = createDeferredPromise();
      const release = createDeferredPromise();
      let calls = 0;
      const fetchSpy = mockFetch([
        { match: "@2025-06-14/", respond: async () => {
          if (++calls === 1) {
            started.resolve();
            await release.promise;
            return unavailable ? { body: {}, status: 404 } : { body: { usd: { cnh: 7.2 } } };
          }
          return { body: { usd: { kes: 129 } } };
        } },
        { match: "@2025-06-15/", body: {}, status: 404 },
        { match: ".currency-api.pages.dev", body: {}, status: 404 },
      ], { requireMatch: true });
      const late = fetchHistoricalSecondaryFxRates(db, ["CNH", "KES"], "2025-06-14", "2025-06-15");
      await started.promise;
      await fetchHistoricalSecondaryFxRates(db, ["KES"], "2025-06-14", "2025-06-14");
      release.resolve();
      const series = await late;
      const cache = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get("fx-history-secondary:2025-06") as { value: string };
      expect(JSON.parse(cache.value)).toEqual({
        ...seed, "2025-06-14": { ...(seed["2025-06-14"] ?? {}), ...(!unavailable ? { cnh: 7.2 } : {}), kes: 129 },
        "2025-06-15": null,
      });
      expect(series.KES).toEqual([{ timestamp: Date.parse("2025-06-14T00:00:00Z") / 1000, rate: 1 / 129 }]);
      const fetchCount = fetchSpy.mock.calls.length;
      await fetchHistoricalSecondaryFxRates(db, ["KES"], "2025-06-14", "2025-06-15");
      expect(fetchSpy).toHaveBeenCalledTimes(fetchCount);
    },
  );

  it("refetches and merges missing requested currencies in a partial dated cache, then replays the dated quote", async () => {
    const { db, sqlite } = fxFixtures.open();
    const fetchSpy = mockFetch([{
      match: "@2025-06-14/v1/currencies/usd.min.json",
      outcomes: [
        { body: { date: "2025-06-14", usd: { cnh: 7.2 } } },
        { body: { date: "2025-06-14", usd: { kes: 129 } } },
      ],
    }], { requireMatch: true });
    expect((await fetchHistoricalSecondaryFxRates(db, ["CNH"], "2025-06-14", "2025-06-14")).CNH)
      .toEqual([{ timestamp: Date.parse("2025-06-14T00:00:00Z") / 1000, rate: 1 / 7.2 }]);
    const second = await fetchHistoricalSecondaryFxRates(db, ["KES"], "2025-06-14", "2025-06-14");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const timestamp = Date.parse("2025-06-14T00:00:00Z") / 1000;
    expect(second.KES).toEqual([{ timestamp, rate: 1 / 129 }]);
    const cache = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get("fx-history-secondary:2025-06") as { value: string };
    expect(JSON.parse(cache.value)).toEqual({ "2025-06-14": { cnh: 7.2, kes: 129 } });
    const lookup = buildHistoricalReferenceLookup({ subjectId: "kes" });
    expect(lookup.referenceAt("KES", timestamp + 86400)).toBeNull();
    expect(findHistoricalFxValuationRate(second, "KES", "kes", timestamp)).toBeNull();
    expect(findHistoricalFxValuationRate(second, "KES", "kes", timestamp + 86400)).toBe(1 / 129);
    expect(findHistoricalFxValuationRate(second, "KES", "kes", timestamp + 2 * 86400)).toBeNull();
  });

  it("preserves partial dated evidence after a confirmed unavailable refetch", async () => {
    const { db, sqlite } = fxFixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run("fx-history-secondary:2025", JSON.stringify({ "2025-06-14": { cnh: 7.2 } }), 1);
    mockFetch([
      { match: "cdn.jsdelivr.net", body: {}, status: 404 },
      { match: ".currency-api.pages.dev", body: {}, status: 404 },
    ], { requireMatch: true });
    const series = await fetchHistoricalSecondaryFxRates(db, ["CNH", "KES"], "2025-06-14", "2025-06-14");
    expect(series.CNH).toHaveLength(1);
    expect(series.KES).toEqual([]);
    const cache = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get("fx-history-secondary:2025-06") as { value: string };
    expect(JSON.parse(cache.value)).toEqual({ "2025-06-14": { cnh: 7.2 } });
  });

  it("reuses cached secondary FX days and only fetches missing dates", async () => {
    const fetchSpy = mockFetch([
      {
        match: "@2025-06-15/v1/currencies/usd.min.json",
        body: { date: "2025-06-15", usd: { cnh: 7.25 } },
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-history-secondary:2025-06"],
        rows: [],
        first: {
          value: JSON.stringify({
            "2025-06-14": { cnh: 7.2 },
          }),
          updated_at: Math.floor(Date.now() / 1000),
        },
      },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    const series = await fetchHistoricalSecondaryFxRates(db, ["CNH"], "2025-06-14", "2025-06-15");

    expect(series.CNH).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("@2025-06-15/v1/currencies/usd.min.json");
  });

  it.each([
    ["null-shaped", "null"],
    ["string-shaped", JSON.stringify("not-a-year-cache")],
  ] as const)("refetches a %s secondary FX year cache", async (_shape, cachedValue) => {
    const fetchSpy = mockFetch([
      {
        match: "@2025-06-14/v1/currencies/usd.min.json",
        body: { date: "2025-06-14", usd: { cnh: 7.2 } },
      },
    ]);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-history-secondary:2025-06"],
        rows: [],
        first: {
          value: cachedValue,
          updated_at: Math.floor(Date.now() / 1000),
        },
      },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    const series = await fetchHistoricalSecondaryFxRates(db, ["CNH"], "2025-06-14", "2025-06-14");

    expect(series.CNH).toEqual([
      {
        timestamp: Math.floor(new Date("2025-06-14T00:00:00Z").getTime() / 1000),
        rate: 1 / 7.2,
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const cacheWrite = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO cache"));
    expect(JSON.parse(cacheWrite?.binds[1] as string)).toEqual({
      "2025-06-14": { cnh: 7.2 },
    });
  });

  it("drains non-OK secondary FX fallback responses", async () => {
    const primary = new Response(JSON.stringify({ error: "missing" }), { status: 404 });
    const fallback = new Response(JSON.stringify({ error: "missing" }), { status: 404 });
    mockFetch([
      { match: "cdn.jsdelivr.net", outcomes: [{ response: primary }] },
      { match: ".currency-api.pages.dev", outcomes: [{ response: fallback }] },
    ], { requireMatch: true });

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    const series = await fetchHistoricalSecondaryFxRates(db, ["CNH"], "2025-06-14", "2025-06-14");

    expect(series.CNH).toEqual([]);
    expect(primary.bodyUsed).toBe(true);
    expect(fallback.bodyUsed).toBe(true);
  });

  it("rejects a malformed secondary FX day payload instead of caching bad rates", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch([
      {
        match: "@2025-06-14/v1/currencies/usd.min.json",
        body: { date: "2025-06-14", usd: { cnh: "not-a-number" } },
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    const series = await fetchHistoricalSecondaryFxRates(db, ["CNH"], "2025-06-14", "2025-06-14");

    expect(series.CNH).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("secondary FX validation failed"));
  });

  it.each([503, 404])("refetches a transiently failed day on the next run (fallback status=%s)", async (fallbackStatus) => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch([
      { match: "cdn.jsdelivr.net", body: { error: "unavailable" }, status: 503 },
      { match: ".currency-api.pages.dev", body: { error: "unavailable" }, status: fallbackStatus },
    ], { requireMatch: true });
    const firstDb = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    expect(
      await drainRetryBackoff(fetchHistoricalSecondaryFxRates(firstDb, ["ARS"], "2025-06-14", "2025-06-14")),
    ).toEqual({ ARS: [] });
    expect(
      firstDb.getHistory().some((entry) => entry.sql.includes("INSERT INTO cache")),
    ).toBe(false);

    mockFetch([
      {
        match: "@2025-06-14/v1/currencies/usd.min.json",
        body: { date: "2025-06-14", usd: { ars: 1_180 } },
      },
    ], { requireMatch: true });
    const secondDb = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    expect(
      await fetchHistoricalSecondaryFxRates(secondDb, ["ARS"], "2025-06-14", "2025-06-14"),
    ).toEqual({
      ARS: [{
        timestamp: Math.floor(new Date("2025-06-14T00:00:00Z").getTime() / 1000),
        rate: 1 / 1_180,
      }],
    });
    const cacheWrite = secondDb.getHistory().find(
      (entry) => entry.sql.includes("INSERT INTO cache"),
    );
    expect(JSON.parse(cacheWrite?.binds[1] as string)).toEqual({
      "2025-06-14": { ars: 1_180 },
    });
  });

  it("persists empty-day markers so permanently missing days are not fetched again", async () => {
    const primary = new Response("missing", { status: 404 });
    const fallback = new Response("missing", { status: 404 });
    const fetchSpy = mockFetch([
      { match: "cdn.jsdelivr.net", outcomes: [{ response: primary }] },
      { match: ".currency-api.pages.dev", outcomes: [{ response: fallback }] },
    ], { requireMatch: true });
    const firstDb = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    await fetchHistoricalSecondaryFxRates(firstDb, ["ARS"], "2025-06-14", "2025-06-14");
    const cacheWrite = firstDb.getHistory().find((entry) => entry.sql.includes("INSERT INTO cache"));
    const cachedValue = cacheWrite?.binds[1];
    expect(typeof cachedValue).toBe("string");
    expect(JSON.parse(cachedValue as string)).toEqual({ "2025-06-14": null });

    const secondDb = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-history-secondary:2025-06"],
        rows: [],
        first: {
          value: cachedValue as string,
          updated_at: Math.floor(Date.now() / 1000),
        },
      },
    ]);
    await fetchHistoricalSecondaryFxRates(secondDb, ["ARS"], "2025-06-14", "2025-06-14");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([null, "2025-06", "2025"])("retries provisional double 404s after grace (cache %s)", async (period) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-14T00:01:00Z"));
    const { db, sqlite } = fxFixtures.open();
    if (period) sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(`fx-history-secondary:${period}`, '{"2025-06-14":{}}', 1);
    const fetchSpy = mockFetch([
      { match: "cdn.jsdelivr.net", outcomes: [{ body: {}, status: 404 }, { body: { usd: { ars: 1200 } } }] },
      { match: ".currency-api.pages.dev", body: {}, status: 404 },
    ], { requireMatch: true });
    expect((await fetchHistoricalSecondaryFxRates(db, ["ARS"], "2025-06-14", "2025-06-14")).ARS).toEqual([]);
    vi.setSystemTime(new Date("2025-06-22T00:01:00Z"));
    expect((await fetchHistoricalSecondaryFxRates(db, ["ARS"], "2025-06-14", "2025-06-14")).ARS)
      .toEqual([{ timestamp: Date.parse("2025-06-14T00:00:00Z") / 1000, rate: 1 / 1200 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it.each([
    { date: "2025-06-14" },
    { date: "2025-06-14", usd: { kes: 0 } },
    { date: "2025-06-13", usd: { kes: 130 } },
  ])("retries an invalid 200 secondary FX day before accepting a corrected publication (%j)", async (body) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = mockFetch([
      { match: "cdn.jsdelivr.net", body },
    ], { requireMatch: true });
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    await expect(
      fetchHistoricalSecondaryFxRates(db, ["KES"], "2025-06-14", "2025-06-14"),
    ).resolves.toEqual({ KES: [] });
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO cache"))).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    mockFetch([{ match: "cdn.jsdelivr.net", body: { date: "2025-06-14", usd: { kes: 129 } } }]);
    await expect(fetchHistoricalSecondaryFxRates(db, ["KES"], "2025-06-14", "2025-06-14"))
      .resolves.toEqual({ KES: [{ timestamp: Date.parse("2025-06-14") / 1000, rate: 1 / 129 }] });
  });

  it("skips a non-JSON 200 secondary FX day instead of aborting the run", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = new Response("<html>upstream error</html>", { status: 200 });
    mockFetch([
      { match: "cdn.jsdelivr.net", outcomes: [{ response }] },
    ], { requireMatch: true });
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    await expect(
      fetchHistoricalSecondaryFxRates(db, ["ARS"], "2025-06-14", "2025-06-14"),
    ).resolves.toEqual({ ARS: [] });
    expect(response.bodyUsed).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("secondary FX returned non-JSON"));
  });

  it("caps secondary FX fetches at six concurrent requests", async () => {
    let active = 0;
    let peak = 0;
    let markSixStarted!: () => void;
    const sixStarted = new Promise<void>((resolve) => {
      markSixStarted = resolve;
    });
    let releaseFetches!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFetches = resolve;
    });
    mockFetch([
      {
        match: "cdn.jsdelivr.net",
        respond: async (request) => {
          active++;
          peak = Math.max(peak, active);
          if (active === 6) markSixStarted();
          await release;
          active--;
          const date = request.url.match(/currency-api@(\d{4}-\d{2}-\d{2})/)?.[1];
          return { body: { date, usd: { ars: 1_180 } } };
        },
      },
    ], { requireMatch: true });
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    const fetchPromise = fetchHistoricalSecondaryFxRates(db, ["ARS"], "2025-06-14", "2025-06-20");
    await sixStarted;
    expect(peak).toBe(6);
    releaseFetches();
    await fetchPromise;
  });
});

describe("extractDepegEvents", () => {
  it("requires confirmation for large-cap assets", () => {
    const events = extractDepegEvents(
      [
        { timestamp: 1_000, price: 1.02 },
        { timestamp: 2_000, price: 1.03 },
        { timestamp: 3_000, price: 1.0 },
      ],
      () => 1,
      "peggedUSD",
      [{ ts: 1_000, supply: 2_000_000_000 }],
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "above",
      startedAt: 1_000,
      endedAt: 3_000,
      startPrice: 1.02,
      peakPrice: 1.03,
      recoveryPrice: 1.0,
    });
  });

  it("does not promote pending large-cap event when points are too far apart", () => {
    const events = extractDepegEvents(
      [
        { timestamp: 1_000, price: 1.02 },
        { timestamp: 1_000 + 7 * 3_600, price: 1.03 },
        { timestamp: 1_000 + 7 * 3_600 + 100, price: 1.0 },
      ],
      () => 1,
      "peggedUSD",
      [{ ts: 1_000, supply: 2_000_000_000 }],
    );

    expect(events).toEqual([]);
  });

  it("starts immediately for small-cap assets once the opening print is corroborated", () => {
    const events = extractDepegEvents(
      [
        { timestamp: 1_000, price: 0.98 },
        { timestamp: 1_500, price: 0.97 },
        { timestamp: 2_000, price: 1.0 },
      ],
      () => 1,
      "peggedUSD",
      [{ ts: 1_000, supply: 200_000_000 }],
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "below",
      startedAt: 1_000,
      endedAt: 2_000,
      startPrice: 0.98,
      peakPrice: 0.97,
      recoveryPrice: 1.0,
    });
  });

  it.each([{ supply: [] }, { supply: [{ ts: 999, supply: 0 }] }, { supply: [{ ts: 1001, supply: 2e9 }] }])(
    "requires a prior positive historical floor (%j)", ({ supply }) => {
      const prices = [0.98, 0.97, 1].map((price, index) => ({ timestamp: 1000 + index * 1000, price }));
      expect(extractDepegEvents(prices, () => 1, "peggedUSD", supply)).toEqual([]);
    },
  );

  it.each([false, true])("cannot corroborate a wick through a 48-hour blind gap (%s)", (nearbySupport) => {
    const points = [{ timestamp: 1000, price: 0.75 }, { timestamp: 173800, price: 0.98 },
      { timestamp: 177400, price: 0.84 }, { timestamp: 181000, price: nearbySupport ? 0.845 : 1 },
      { timestamp: 184600, price: 1 }];
    const events = extractDepegEvents(points, () => 1, "peggedUSD", [{ ts: 1000, supply: 6e6 }]);
    expect(events.map(({ peakDeviationBps }) => peakDeviationBps)).toEqual(nearbySupport ? [-1600] : []);
  });

  it("records at-par evidence independently of earlier off-peg duration", () => {
    const prices = [{ timestamp: 1000, price: 0.98 }, { timestamp: 4600, price: 0.98 },
      { timestamp: 87400, price: 1 }];
    const events = extractDepegEvents(prices, () => 1, "peggedUSD", [{ ts: 1000, supply: 6e6 }],
      undefined, undefined, { maxObservationGapSec: 26 * 3600 });
    expect(events).toMatchObject([{ endedAt: 87400, recoveryPrice: 1,
      admittedCoverage: [{ fromSec: 1000, toSec: 4600 }] }]);
  });

  it("keeps a held weekend sample out of peaks and observed duration", () => {
    const friday = Date.parse("2026-11-13T19:00:00Z") / 1000;
    const sunday = Date.parse("2026-11-15T22:00:00Z") / 1000;
    const prices = [
      ...[0.98, 0.98, 0.86].map((price, i) => ({ timestamp: friday + i * 3600, price })),
      { timestamp: friday + 4 * 3600, price: 0.87 },
      { timestamp: sunday, price: 1 },
    ];
    const events = extractDepegEvents(prices, () => 1, "peggedEUR", [{ ts: friday, supply: 6e6 }]);
    expect(events).toMatchObject([{
      startedAt: friday, endedAt: sunday, peakDeviationBps: -200, recoveryPegReference: 1,
      admittedCoverage: [{ fromSec: friday, toSec: friday + 7200 }],
    }]);
  });

  it.each([
    { start: OPEN + 1_000, gapDays: 1, peak: 1.03 },
    { start: Date.parse("2026-11-13T00:00:00Z") / 1000, gapDays: 3, peak: 1.02 },
  ])("supports native confirmation across $gapDays day(s) with an open-time budget", ({ start, gapDays, peak }) => {
    const day = 24 * 3_600;
    const events = extractDepegEvents(
      [
        { timestamp: start, price: 1.02 },
        { timestamp: start + gapDays * day, price: 1.03 },
        { timestamp: start + (gapDays + 1) * day, price: 1.0 },
      ],
      () => 1,
      "peggedEUR",
      [{ ts: start, supply: 50_000_000 }],
      { peggedEUR: 1.08 },
      undefined,
      {
        forceConfirmation: true,
        confirmationMinPoints: 2,
        confirmationMaxGapSec: 36 * 3_600,
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "above",
      startedAt: start,
      endedAt: start + (gapDays + 1) * day,
      peakPrice: peak,
    });
  });

  it("keeps extreme single-point native-peg crashes even when confirmation is otherwise required", () => {
    const events = extractDepegEvents(
      [
        { timestamp: OPEN + 1_000, price: 0.3 },
        { timestamp: OPEN + 2_000, price: 1.0 },
      ],
      () => 1,
      "peggedBRL",
      [{ ts: OPEN + 1_000, supply: 50_000_000 }],
      { peggedBRL: 0.19 },
      undefined,
      {
        forceConfirmation: true,
        confirmationMinPoints: 2,
        confirmationMaxGapSec: 36 * 3_600,
        extremeSinglePointBps: 5_000,
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "below",
      startedAt: OPEN + 1_000,
      endedAt: OPEN + 2_000,
      startPrice: 0.3,
      recoveryPrice: 1.0,
    });
  });

  it("accepts fractional commodity prices when commodityOunces scales the peg", () => {
    const events = extractDepegEvents(
      [
        { timestamp: OPEN + 1_000, price: 5.15 },
        { timestamp: OPEN + 2_000, price: 2.9 },
      ],
      () => 2.9,
      "peggedGOLD",
      [{ ts: OPEN + 1_000, supply: 2_000_000 }],
      { peggedGOLD: 2_915 },
      { commodityOunces: 0.001 },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "above",
      startedAt: OPEN + 1_000,
      endedAt: OPEN + 2_000,
      startPrice: 5.15,
      recoveryPrice: 2.9,
    });
  });

  it("preserves severe downside moves in historical mode when the peg reference is valid", () => {
    const events = extractDepegEvents(
      [
        { timestamp: 1_000, price: 0.0001 },
        { timestamp: 2_000, price: 1.0 },
      ],
      () => 1,
      "peggedUSD",
      [{ ts: 1_000, supply: 2_000_000 }],
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "below",
      startedAt: 1_000,
      endedAt: 2_000,
      startPrice: 0.0001,
      recoveryPrice: 1.0,
    });
  });

  it("preserves low-nominal FX downside moves when validated against the historical peg reference", () => {
    const events = extractDepegEvents(
      [
        { timestamp: OPEN + 1_000, price: 0.0005 },
        { timestamp: OPEN + 2_000, price: 0.0067 },
      ],
      () => 0.0067,
      "peggedJPY",
      [{ ts: OPEN + 1_000, supply: 2_000_000 }],
      { peggedJPY: 0.0067 },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "below",
      startedAt: OPEN + 1_000,
      endedAt: OPEN + 2_000,
      startPrice: 0.0005,
      recoveryPrice: 0.0067,
    });
  });
});


