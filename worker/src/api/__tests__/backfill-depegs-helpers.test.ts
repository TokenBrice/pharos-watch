import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PEG_TO_FX,
  SECONDARY_PEG_TO_FX,
  buildFxLookup,
  fetchHistoricalSecondaryFxRates,
} from "../../lib/backfill-fx";
import {
  extractDepegEvents,
  findNearestSupply,
  parseSupplyData,
} from "../backfill-depegs-extraction";
import { summarizeBackfillReplayDiff } from "../backfill-depegs-preview";
import { executeBackfillForCoin } from "../backfill-depegs/execution";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  PRIMARY_CURRENCY_TO_PEG,
  PRIMARY_PEG_TYPE_TO_CURRENCY_PAIRS,
  SECONDARY_FX_CURRENCY_TO_PEG,
  SECONDARY_PEG_TYPE_TO_CURRENCY_PAIRS,
} from "../../lib/fx-config";
import { makeBrzBackfillRow } from "./depeg-replay.test-support";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("historical FX configuration", () => {
  it("keeps backfill FX coverage in parity with the live currency maps", () => {
    const invert = (
      currencyToPeg: Readonly<Record<string, string>>,
      pegTypeToCurrencyPairs: ReadonlyArray<readonly [string, string]>,
    ) => {
      const pegCurrencyByType: Record<string, string> = Object.fromEntries(pegTypeToCurrencyPairs);
      return Object.fromEntries(
        Object.entries(currencyToPeg).map(([currency, pegType]) => [
          pegCurrencyByType[pegType],
          currency.toUpperCase(),
        ]),
      );
    };

    expect(PEG_TO_FX).toEqual(invert(PRIMARY_CURRENCY_TO_PEG, PRIMARY_PEG_TYPE_TO_CURRENCY_PAIRS));
    expect(SECONDARY_PEG_TO_FX).toEqual(
      invert(SECONDARY_FX_CURRENCY_TO_PEG, SECONDARY_PEG_TYPE_TO_CURRENCY_PAIRS),
    );
    expect(PEG_TO_FX.BRL).toBe("BRL");
  });

  it("skips a non-USD coin without any FX reference and performs no writes", async () => {
    const meta = ACTIVE_STABLECOINS.find((coin) => coin.id === "brz-transfero");
    expect(meta).toBeDefined();
    if (!meta) throw new Error("missing BRZ fixture");
    const applyBackfillEvents = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await executeBackfillForCoin({
      db: mockD1(),
      prepared: {
        meta,
        geckoId: "unused-because-missing-fx-skips-first",
        supplyByDate: [],
        currentSupplyUsd: null,
      },
      pegRates: { peggedUSD: 1 },
      fxRates: undefined,
      fxSeries: {},
      commoditySeries: {},
      replayWindow: null,
      coingeckoApiKey: null,
      dryRun: false,
      applyBackfillEvents,
    });

    expect(outcome).toEqual({ status: "skipped", eventCount: 0 });
    expect(applyBackfillEvents).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("missing-fx-reference"));
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

  it("sums all circulating buckets without applying a price", () => {
    expect(parseSupplyData([
      { date: "100", circulating: { peggedUSD: 125, peggedEUR: 75 } },
    ])).toEqual([{ ts: 100, supply: 200 }]);
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
});

describe("buildFxLookup", () => {
  it("falls back to static rate when no series is available", () => {
    const lookup = buildFxLookup([], 1.11);
    expect(lookup(1_700_000_000)).toBe(1.11);
  });

  it("linearly interpolates between surrounding daily FX snapshots", () => {
    const lookup = buildFxLookup(
      [
        { timestamp: 1_000, rate: 1.0 },
        { timestamp: 2_000, rate: 1.2 },
      ],
      1.5,
    );
    // 75% of the way from 1_000 to 2_000 → 1.0 + 0.75 * 0.2 = 1.15
    expect(lookup(1_750)).toBeCloseTo(1.15, 10);
    // midpoint → 1.0 + 0.5 * 0.2 = 1.1
    expect(lookup(1_500)).toBeCloseTo(1.1, 10);
    // exact match → returns rate directly
    expect(lookup(1_000)).toBe(1.0);
    expect(lookup(2_000)).toBe(1.2);
  });

  it("clamps to boundary rates outside the series range", () => {
    const lookup = buildFxLookup(
      [
        { timestamp: 1_000, rate: 1.0 },
        { timestamp: 2_000, rate: 1.2 },
      ],
      1.5,
    );
    expect(lookup(500)).toBe(1.0);
    expect(lookup(3_000)).toBe(1.2);
  });
});

describe("fetchHistoricalSecondaryFxRates", () => {
  it("builds non-flat ARS and KES historical series for EM backfills", async () => {
    mockFetch([
      {
        match: "@2025-06-14/v1/currencies/usd.min.json",
        body: { date: "2025-06-14", usd: { ars: 1_180, kes: 129 } },
      },
      {
        match: "@2025-06-15/v1/currencies/usd.min.json",
        body: { date: "2025-06-15", usd: { ars: 1_190, kes: 130 } },
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-history-secondary:2025"],
        rows: [],
        first: null,
      },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);

    const series = await fetchHistoricalSecondaryFxRates(db, ["ARS", "KES"], "2025-06-14", "2025-06-15");

    expect(series.ARS).toEqual([
      { timestamp: Math.floor(new Date("2025-06-14T00:00:00Z").getTime() / 1000), rate: 1 / 1_180 },
      { timestamp: Math.floor(new Date("2025-06-15T00:00:00Z").getTime() / 1000), rate: 1 / 1_190 },
    ]);
    expect(series.KES).toEqual([
      { timestamp: Math.floor(new Date("2025-06-14T00:00:00Z").getTime() / 1000), rate: 1 / 129 },
      { timestamp: Math.floor(new Date("2025-06-15T00:00:00Z").getTime() / 1000), rate: 1 / 130 },
    ]);
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
        matchBinds: ["fx-history-secondary:2025"],
        rows: [],
        first: {
          value: JSON.stringify({
            "2025-06-14": { cnh: 7.2 },
          }),
          updated_at: Math.floor(Date.now() / 1000),
        },
      },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);

    const series = await fetchHistoricalSecondaryFxRates(db, ["CNH"], "2025-06-14", "2025-06-15");

    expect(series.CNH).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("@2025-06-15/v1/currencies/usd.min.json");
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
        matchBinds: ["fx-history-secondary:2025"],
        rows: [],
        first: null,
      },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
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
        matchBinds: ["fx-history-secondary:2025"],
        rows: [],
        first: null,
      },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);

    const series = await fetchHistoricalSecondaryFxRates(db, ["CNH"], "2025-06-14", "2025-06-14");

    expect(series.CNH).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("secondary FX validation failed"));
  });

  it("refetches a transiently failed day on the next run", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch([
      { match: "cdn.jsdelivr.net", body: { error: "unavailable" }, status: 503 },
      { match: ".currency-api.pages.dev", body: { error: "unavailable" }, status: 503 },
    ], { requireMatch: true });
    const firstDb = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-history-secondary:2025"],
        rows: [],
        first: null,
      },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);

    expect(
      await fetchHistoricalSecondaryFxRates(firstDb, ["ARS"], "2025-06-14", "2025-06-14"),
    ).toEqual({ ARS: [] });
    expect(
      firstDb.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache")),
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
        matchBinds: ["fx-history-secondary:2025"],
        rows: [],
        first: null,
      },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
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
      (entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"),
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
        matchBinds: ["fx-history-secondary:2025"],
        rows: [],
        first: null,
      },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);

    await fetchHistoricalSecondaryFxRates(firstDb, ["ARS"], "2025-06-14", "2025-06-14");
    const cacheWrite = firstDb.getHistory().find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
    const cachedValue = cacheWrite?.binds[1];
    expect(typeof cachedValue).toBe("string");
    expect(JSON.parse(cachedValue as string)).toEqual({ "2025-06-14": {} });

    const secondDb = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-history-secondary:2025"],
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

  it("skips a non-JSON 200 secondary FX day instead of aborting the run", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = new Response("<html>upstream error</html>", { status: 200 });
    mockFetch([
      { match: "cdn.jsdelivr.net", outcomes: [{ response }] },
    ], { requireMatch: true });
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-history-secondary:2025"],
        rows: [],
        first: null,
      },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
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
        matchBinds: ["fx-history-secondary:2025"],
        rows: [],
        first: null,
      },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
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

  it("starts immediately for small-cap assets", () => {
    const events = extractDepegEvents(
      [
        { timestamp: 1_000, price: 0.98 },
        { timestamp: 1_500, price: 1.0 },
      ],
      () => 1,
      "peggedUSD",
      [{ ts: 1_000, supply: 200_000_000 }],
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "below",
      startedAt: 1_000,
      endedAt: 1_500,
      startPrice: 0.98,
      recoveryPrice: 1.0,
    });
  });

  it("uses the current supply fallback when historical supply is absent", () => {
    const belowFloor = extractDepegEvents(
      [
        { timestamp: 1_000, price: 0.5 },
        { timestamp: 2_000, price: 1.0 },
      ],
      () => 1,
      "peggedUSD",
      [],
      undefined,
      undefined,
      { missingSupplyUsd: 999_999 },
    );
    expect(belowFloor).toEqual([]);

    const largeCapSinglePoint = extractDepegEvents(
      [
        { timestamp: 1_000, price: 0.98 },
        { timestamp: 2_000, price: 1.0 },
      ],
      () => 1,
      "peggedUSD",
      [],
      undefined,
      undefined,
      { missingSupplyUsd: 2_000_000_000 },
    );
    expect(largeCapSinglePoint).toEqual([]);

    const largeCapConfirmed = extractDepegEvents(
      [
        { timestamp: 1_000, price: 0.98 },
        { timestamp: 2_000, price: 0.97 },
        { timestamp: 3_000, price: 1.0 },
      ],
      () => 1,
      "peggedUSD",
      [],
      undefined,
      undefined,
      { missingSupplyUsd: 2_000_000_000 },
    );
    expect(largeCapConfirmed).toHaveLength(1);
    expect(largeCapConfirmed[0]).toMatchObject({
      direction: "below",
      startedAt: 1_000,
      peakPrice: 0.97,
      recoveryPrice: 1.0,
    });
  });

  it("supports daily native-peg confirmation windows with wider point gaps", () => {
    const day = 24 * 3_600;
    const events = extractDepegEvents(
      [
        { timestamp: 1_000, price: 1.02 },
        { timestamp: 1_000 + day, price: 1.03 },
        { timestamp: 1_000 + 2 * day, price: 1.0 },
      ],
      () => 1,
      "peggedEUR",
      [{ ts: 1_000, supply: 50_000_000 }],
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
      startedAt: 1_000,
      endedAt: 1_000 + 2 * day,
      peakPrice: 1.03,
    });
  });

  it("keeps extreme single-point native-peg crashes even when confirmation is otherwise required", () => {
    const events = extractDepegEvents(
      [
        { timestamp: 1_000, price: 0.3 },
        { timestamp: 2_000, price: 1.0 },
      ],
      () => 1,
      "peggedBRL",
      [{ ts: 1_000, supply: 50_000_000 }],
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
      startedAt: 1_000,
      endedAt: 2_000,
      startPrice: 0.3,
      recoveryPrice: 1.0,
    });
  });

  it("accepts fractional commodity prices when commodityOunces scales the peg", () => {
    const events = extractDepegEvents(
      [
        { timestamp: 1_000, price: 5.15 },
        { timestamp: 2_000, price: 2.9 },
      ],
      () => 2.9,
      "peggedGOLD",
      [{ ts: 1_000, supply: 2_000_000 }],
      { peggedGOLD: 2_915 },
      { commodityOunces: 0.001 },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "above",
      startedAt: 1_000,
      endedAt: 2_000,
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
        { timestamp: 1_000, price: 0.0005 },
        { timestamp: 2_000, price: 0.0067 },
      ],
      () => 0.0067,
      "peggedJPY",
      [{ ts: 1_000, supply: 2_000_000 }],
      { peggedJPY: 0.0067 },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "below",
      startedAt: 1_000,
      endedAt: 2_000,
      startPrice: 0.0005,
      recoveryPrice: 0.0067,
    });
  });
});

describe("summarizeBackfillReplayDiff", () => {
  it("reports an exact match when existing backfill rows match the replayed events", () => {
    const existingRows = [makeBrzBackfillRow()];

    const summary = summarizeBackfillReplayDiff(existingRows, [
      {
        pegType: "peggedREAL",
        direction: "below",
        peakDeviationBps: -220,
        startedAt: 1_000,
        endedAt: 2_000,
        startPrice: 0.19,
        peakPrice: 0.188,
        recoveryPrice: 0.191,
        pegRef: 0.193,
      },
    ]);

    expect(summary).toMatchObject({
      exactMatch: true,
      removedBackfillEventCount: 0,
      addedBackfillEventCount: 0,
      removedBackfillEventIdsSample: [],
      addedBackfillEventsSample: [],
    });
  });

  it("reports removed ids and added event samples when the replay differs", () => {
    const existingRows = [makeBrzBackfillRow()];

    const summary = summarizeBackfillReplayDiff(existingRows, [
      {
        pegType: "peggedREAL",
        direction: "above",
        peakDeviationBps: 180,
        startedAt: 3_000,
        endedAt: 4_000,
        startPrice: 0.194,
        peakPrice: 0.196,
        recoveryPrice: 0.193,
        pegRef: 0.193,
      },
    ]);

    expect(summary.exactMatch).toBe(false);
    expect(summary.removedBackfillEventCount).toBe(1);
    expect(summary.removedBackfillEventIdsSample).toEqual([10]);
    expect(summary.addedBackfillEventCount).toBe(1);
    expect(summary.addedBackfillEventsSample).toEqual([
      {
        direction: "above",
        peakDeviationBps: 180,
        startedAt: 3_000,
        endedAt: 4_000,
      },
    ]);
  });
});
