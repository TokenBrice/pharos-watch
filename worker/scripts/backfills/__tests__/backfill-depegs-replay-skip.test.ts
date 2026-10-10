import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { BackfillCoinReplayResult } from "../backfill-depegs-replay";
import type { BackfillEvent } from "../../../src/lib/historical-depeg-extraction";

vi.mock("../backfill-depegs-replay", () => ({
  backfillCoin: vi.fn(),
}));

import { backfillCoin } from "../backfill-depegs-replay";
import { executeBackfillForCoin } from "../backfill-depegs/execution";
import { backfillEpisodeCoveredByLiveEvent } from "../backfill-depegs-window";

const USN_META = TRACKED_META_BY_ID.get("usn-noon");
if (!USN_META) throw new Error("missing usn-noon fixture");

function episode(overrides: Partial<BackfillEvent>): BackfillEvent {
  return {
    pegType: "peggedUSD",
    direction: "above",
    peakDeviationBps: 500,
    startedAt: 1_700_000_000,
    endedAt: 1_700_003_600,
    startPrice: 1.05,
    peakPrice: 1.05,
    recoveryPrice: 0.999,
    pegRef: 1,
    ...overrides,
  };
}

// Inside the reviewed usn-noon 2026-02-14 suppression window.
const SUPPRESSED_FEB14_EPISODE = episode({
  startedAt: 1_771_074_028,
  endedAt: 1_771_095_624,
});

// Same market episode as the stored live row: intervals overlap on both sides.
const LIVE_COVERED_EPISODE = episode({
  startedAt: 1_700_100_000,
  endedAt: 1_700_104_000,
});

const UNCOVERED_EPISODE = episode({
  startedAt: 1_700_200_000,
  endedAt: 1_700_204_000,
});

const LIVE_ROW = {
  id: 24424,
  stablecoin_id: "usn-noon",
  symbol: "USN",
  peg_type: "peggedUSD",
  direction: "above",
  peak_deviation_bps: 569,
  started_at: 1_700_099_500,
  ended_at: 1_700_104_500,
  start_price: 1.05,
  peak_price: 1.05,
  recovery_price: 0.999,
  peg_reference: 1,
  source: "live",
};

function stubReplayEvents(events: BackfillEvent[] | null): void {
  vi.mocked(backfillCoin).mockResolvedValue({
    events,
    sourceKind: "market",
    authoritativeSource: null,
    marketDiagnostics: null,
  } satisfies BackfillCoinReplayResult);
}

describe("backfill replay episode skips", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["fractional current fallback", 0.03215074656862798, 3000, [], 3000],
    ["fractional historical spot", 0.03215074656862798, 3000, [{ timestamp: 1_700_000_000, rate: 2800 }], 2800],
    ["one ounce current fallback", 1, 3000, [], 3000],
    ["historical spot without current rate", 0.03215074656862798, null, [{ timestamp: 1_700_000_000, rate: 2800 }], 2800],
  ] as const)("converts commodity units once through replay and apply: %s", async (_label, ounces, currentRate, series, spot) => {
    const meta = { ...TRACKED_META_BY_ID.get("kau-kinesis")!, commodityOunces: ounces };
    const expected = spot * ounces;
    vi.mocked(backfillCoin).mockImplementationOnce(async ({ getPegRef }) => ({
      events: [episode({ pegType: "peggedGOLD", pegRef: getPegRef(1_700_000_000) })],
      sourceKind: "market", authoritativeSource: null, marketDiagnostics: null,
    }));
    const applyBackfillEvents = vi.fn();
    const result = await executeBackfillForCoin({
      db: mockD1([{ match: "FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at", rows: [] }]),
      prepared: { meta, geckoId: "kinesis-gold", supplyTokens: [], currentSupplyUsd: 1_000_000_000 },
      pegRates: currentRate == null ? {} : { peggedGOLD: currentRate },
      fxRates: undefined, fxSeries: {}, commoditySeries: { GOLD: [...series] },
      replayWindow: null, coingeckoApiKey: null, dryRun: false, applyBackfillEvents,
    });
    const calls = vi.mocked(backfillCoin).mock.calls;
    expect(calls[calls.length - 1]![0].getPegRef(1_700_000_000)).toBeCloseTo(expected);
    expect(result.status).toBe("applied");
    expect(applyBackfillEvents).toHaveBeenCalledTimes(1);
    expect(applyBackfillEvents.mock.calls[0]![1][0].pegRef).toBeCloseTo(expected);
  });

  it("skips commodity replay without a current rate or historical spot anchor", async () => {
    const before = vi.mocked(backfillCoin).mock.calls.length;
    const applyBackfillEvents = vi.fn();
    const result = await executeBackfillForCoin({
      db: mockD1(),
      prepared: { meta: TRACKED_META_BY_ID.get("kau-kinesis")!, geckoId: "kinesis-gold", supplyTokens: [], currentSupplyUsd: 1_000_000_000 },
      pegRates: {}, fxRates: undefined, fxSeries: {}, commoditySeries: {},
      replayWindow: null, coingeckoApiKey: null, dryRun: false, applyBackfillEvents,
    });
    expect(result).toEqual({ status: "skipped", eventCount: 0, reason: "missing-fx-reference" });
    expect(vi.mocked(backfillCoin).mock.calls).toHaveLength(before);
    expect(applyBackfillEvents).not.toHaveBeenCalled();
  });

  it("drops suppressed and live-covered recomputed episodes before applying", async () => {
    stubReplayEvents([SUPPRESSED_FEB14_EPISODE, LIVE_COVERED_EPISODE, UNCOVERED_EPISODE]);
    const applyBackfillEvents = vi.fn();
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at",
        matchBinds: ["usn-noon"],
        rows: [LIVE_ROW],
      },
    ]);

    const outcome = await executeBackfillForCoin({
      db,
      prepared: { meta: USN_META, geckoId: "noon-usn", supplyTokens: [], currentSupplyUsd: 1_000_000_000 },
      pegRates: { peggedUSD: 1 },
      fxRates: undefined,
      fxSeries: {},
      commoditySeries: {},
      replayWindow: null,
      coingeckoApiKey: null,
      dryRun: false,
      applyBackfillEvents,
    });

    expect(outcome.status).toBe("applied");
    expect(outcome.eventCount).toBe(1);
    expect(applyBackfillEvents).toHaveBeenCalledTimes(1);
    const appliedEvents = applyBackfillEvents.mock.calls[0]![1] as BackfillEvent[];
    expect(appliedEvents.map((event) => event.startedAt)).toEqual([UNCOVERED_EPISODE.startedAt]);
  });

  it("reports the skips in the dry-run preview diff", async () => {
    stubReplayEvents([SUPPRESSED_FEB14_EPISODE, LIVE_COVERED_EPISODE]);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at",
        matchBinds: ["usn-noon"],
        rows: [
          LIVE_ROW,
          {
            ...LIVE_ROW,
            id: 49237,
            source: "backfill",
            started_at: SUPPRESSED_FEB14_EPISODE.startedAt,
            ended_at: SUPPRESSED_FEB14_EPISODE.endedAt,
          },
        ],
      },
    ]);

    const outcome = await executeBackfillForCoin({
      db,
      prepared: { meta: USN_META, geckoId: "noon-usn", supplyTokens: [], currentSupplyUsd: 1_000_000_000 },
      pegRates: { peggedUSD: 1 },
      fxRates: undefined,
      fxSeries: {},
      commoditySeries: {},
      replayWindow: null,
      coingeckoApiKey: null,
      dryRun: true,
      applyBackfillEvents: vi.fn(),
    });

    expect(outcome.status).toBe("preview");
    expect(outcome.eventCount).toBe(0);
    // The stale backfill twin inside the suppression window is slated for removal,
    // and no recomputed episode replaces it.
    expect(outcome.preview).toMatchObject({
      recomputedBackfillEventCount: 0,
      existingLiveEventCount: 1,
      removedBackfillEventCount: 1,
      addedBackfillEventCount: 0,
    });
  });

  it("keeps recomputed episodes when no live row covers them", async () => {
    stubReplayEvents([UNCOVERED_EPISODE]);
    const applyBackfillEvents = vi.fn();
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at",
        matchBinds: ["usn-noon"],
        rows: [LIVE_ROW],
      },
    ]);

    const outcome = await executeBackfillForCoin({
      db,
      prepared: { meta: USN_META, geckoId: "noon-usn", supplyTokens: [], currentSupplyUsd: 1_000_000_000 },
      pegRates: { peggedUSD: 1 },
      fxRates: undefined,
      fxSeries: {},
      commoditySeries: {},
      replayWindow: null,
      coingeckoApiKey: null,
      dryRun: false,
      applyBackfillEvents,
    });

    expect(outcome.status).toBe("applied");
    expect(outcome.eventCount).toBe(1);
  });

  it.each([false, true])("preserves all-absent supply history even with a current fallback (dryRun=%s)", async (dryRun) => {
    stubReplayEvents([]);
    const applyBackfillEvents = vi.fn();
    const db = mockD1([{
      match: "FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at",
      matchBinds: ["usn-noon"],
      rows: [{ ...LIVE_ROW, source: "backfill" }],
    }]);
    const outcome = await executeBackfillForCoin({
      db,
      prepared: {
        meta: USN_META, geckoId: "noon-usn",
        supplyTokens: [{ date: "1700000000", circulating: {} }],
        currentSupplyUsd: 1_000_000_000,
      },
      pegRates: { peggedUSD: 1 }, fxRates: undefined, fxSeries: {}, commoditySeries: {},
      replayWindow: null, coingeckoApiKey: null, dryRun, applyBackfillEvents,
    });
    expect(outcome.status).toBe("skipped");
    expect(applyBackfillEvents).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM depeg_events"))).toBe(false);
    const calls = vi.mocked(backfillCoin).mock.calls;
    expect(calls[calls.length - 1]?.[0].missingSupplyUsd).toBeNull();
    if (dryRun) expect(outcome.preview?.recomputedBackfillEventCount).toBeNull();
  });

  it("converts native history with the historical FX reference before replay", async () => {
    stubReplayEvents([]);
    const meta = TRACKED_META_BY_ID.get("eurc-circle")!;
    await executeBackfillForCoin({
      db: mockD1(),
      prepared: {
        meta, geckoId: "euro-coin",
        supplyTokens: [
          { date: "1000", circulating: { peggedEUR: 900_000 } },
          { date: "2000", circulating: { peggedEUR: 900_000 } },
        ],
        currentSupplyUsd: null,
      },
      pegRates: { peggedEUR: 2 }, fxRates: { peggedEUR: 2 },
      fxSeries: { EUR: [{ timestamp: 1_000, rate: 1.1 }, { timestamp: 2_000, rate: 1.2 }] },
      commoditySeries: {}, replayWindow: null, coingeckoApiKey: null, dryRun: true,
      applyBackfillEvents: vi.fn(),
    });
    const calls = vi.mocked(backfillCoin).mock.calls;
    const snapshots = calls[calls.length - 1]![0].supplyByDate;
    expect(snapshots.map((snapshot) => snapshot.ts)).toEqual([1_000, 2_000]);
    expect(snapshots[0].supply).toBeCloseTo(990_000);
    expect(snapshots[1].supply).toBeCloseTo(1_080_000);
  });

  it("converts fractional commodity native token counts with the per-token peg reference", async () => {
    stubReplayEvents([]);
    const meta = TRACKED_META_BY_ID.get("ggbr-goldfish-gold")!;
    await executeBackfillForCoin({
      db: mockD1(),
      prepared: {
        meta, geckoId: "goldfish-gold",
        supplyTokens: [{ date: "1000", circulating: { peggedGOLD: 500_000 } }],
        currentSupplyUsd: null,
      },
      pegRates: {}, fxRates: undefined, fxSeries: {},
      commoditySeries: { GOLD: [{ timestamp: 1_000, rate: 3_000 }] },
      replayWindow: null, coingeckoApiKey: null, dryRun: true,
      applyBackfillEvents: vi.fn(),
    });
    const calls = vi.mocked(backfillCoin).mock.calls;
    expect(calls[calls.length - 1]![0].supplyByDate).toEqual([{ ts: 1_000, supply: 1_500_000 }]);
  });
});

describe("backfillEpisodeCoveredByLiveEvent", () => {
  it("covers overlapping inclusive intervals of the same direction", () => {
    const live = { started_at: 1_000, ended_at: 2_000, direction: "above" };
    expect(backfillEpisodeCoveredByLiveEvent({ startedAt: 1_500, endedAt: 2_500, direction: "above" }, live)).toBe(true);
    // Sharing exactly one boundary second counts as overlap.
    expect(backfillEpisodeCoveredByLiveEvent({ startedAt: 2_000, endedAt: 3_000, direction: "above" }, live)).toBe(true);
    expect(backfillEpisodeCoveredByLiveEvent({ startedAt: 500, endedAt: 1_000, direction: "above" }, live)).toBe(true);
    // One second apart is disjoint.
    expect(backfillEpisodeCoveredByLiveEvent({ startedAt: 2_001, endedAt: 3_000, direction: "above" }, live)).toBe(false);
    expect(backfillEpisodeCoveredByLiveEvent({ startedAt: 0, endedAt: 999, direction: "above" }, live)).toBe(false);
  });

  it("requires the same direction and treats open live rows as point intervals", () => {
    const open = { started_at: 1_000, ended_at: null, direction: "below" };
    expect(backfillEpisodeCoveredByLiveEvent({ startedAt: 900, endedAt: 1_100, direction: "below" }, open)).toBe(true);
    expect(backfillEpisodeCoveredByLiveEvent({ startedAt: 1_001, endedAt: 1_100, direction: "below" }, open)).toBe(false);
    expect(backfillEpisodeCoveredByLiveEvent({ startedAt: 900, endedAt: 1_100, direction: "above" }, open)).toBe(false);
  });
});
