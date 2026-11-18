import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { BackfillCoinReplayResult } from "../backfill-depegs-replay";
import { parseSupplyData, type BackfillEvent } from "../../../src/lib/historical-depeg-extraction";
import { buildBackfillPlan } from "../backfill-depegs/planning";
import type { ApplyBackfillEventsFn } from "../backfill-depegs/execution";
import {
  acquireDefiLlamaDetailMaterialization,
  DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES,
  resetDefiLlamaDetailStateForTests,
} from "../../../src/api/stablecoin-detail/defillama";
import { DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES } from "../../../src/lib/fetch-retry";
import type * as AbortModule from "../../../src/lib/abort";

vi.mock("../backfill-depegs-replay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backfill-depegs-replay")>()),
  backfillCoin: vi.fn(),
}));
vi.mock("../../../src/lib/abort", async (importOriginal) => ({
  ...(await importOriginal<typeof AbortModule>()),
  sleepWithSignal: vi.fn(async () => undefined),
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
    assessed: (events ?? []).flatMap(({ startedAt, direction }) => [
      { timestamp: startedAt - 60, state: "in-band" }, { timestamp: startedAt, state: direction },
    ]),
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

  it.each([0.03215074656862798, 1])("converts an hourly commodity quorum to token units (%s oz)", async (ounces) => {
    const ts = 1_700_000_000;
    const meta = { ...TRACKED_META_BY_ID.get("kau-kinesis")!, commodityOunces: ounces };
    const peers = ["one", "two", "three", meta.id].map((assetId, index) => ({
      assetId, sourceId: assetId, commodityOunces: 1,
      prices: [{ timestamp: ts, price: index === 3 ? 100 : 2_800 }, { timestamp: ts + 3600, price: 4000 }],
    }));
    vi.mocked(backfillCoin).mockImplementationOnce(async ({ getPegRef }) => {
      expect(getPegRef(ts - 1)).toBeNull();
      expect(getPegRef(ts)).toBeCloseTo(2_800 * ounces);
      expect(getPegRef(ts + 4 * 3600)).toBeNull();
      return { events: [], sourceKind: "market", authoritativeSource: null, marketDiagnostics: null };
    });
    const outcome = await executeBackfillForCoin({
      db: mockD1([{ match: "FROM depeg_events WHERE", rows: [] }]), prepared: { meta, geckoId: "kinesis-gold", supplyTokens: [] },
      fxSeries: {}, commodityPeers: { GOLD: peers },
      replayWindow: null, coingeckoApiKey: null, dryRun: true, applyBackfillEvents: vi.fn(),
    });
    expect(outcome.status).toBe("preview");
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
      prepared: { meta: USN_META, geckoId: "noon-usn", supplyTokens: [] },
      fxSeries: {},
      commodityPeers: {},
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

  it.each([false, true])("preserves a row when history is unevaluable (dryRun=%s)", async (dryRun) => {
    stubReplayEvents(null);
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
      },
      fxSeries: {}, commodityPeers: {},
      replayWindow: null, coingeckoApiKey: null, dryRun, applyBackfillEvents,
    });
    expect(outcome.status).toBe("skipped");
    expect(applyBackfillEvents).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM depeg_events"))).toBe(false);
    const calls = vi.mocked(backfillCoin).mock.calls;
    expect(calls[calls.length - 1]?.[0].supplyByDate).toEqual([]);
    if (dryRun) expect(outcome.preview?.recomputedBackfillEventCount).toBeNull();
  });

  it("uses a previously published dated FX fixing for native supply conversion", async () => {
    stubReplayEvents([]);
    const day = Date.parse("2025-06-16T00:00:00Z") / 1000;
    await executeBackfillForCoin({
      db: mockD1(),
      prepared: {
        meta: TRACKED_META_BY_ID.get("eurc-circle")!, geckoId: "euro-coin",
        supplyTokens: [day, day + 86400].map((date) => ({ date: String(date), circulating: { peggedEUR: 900_000 } })),
      },
      fxSeries: { EUR: [{ timestamp: day, rate: 1.1 }, { timestamp: day + 86400, rate: 1.2 }] },
      commodityPeers: {}, replayWindow: null, coingeckoApiKey: null, dryRun: true,
      applyBackfillEvents: vi.fn(),
    });
    const snapshots = vi.mocked(backfillCoin).mock.calls.slice(-1)[0]![0].supplyByDate;
    expect(snapshots[0]).toEqual({ ts: day, supply: null });
    expect(snapshots[1]?.ts).toBe(day + 86400);
    expect(snapshots[1]?.supply).toBeCloseTo(990_000);
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

  it("treats retained open rows as open-ended and blocks any identical start", () => {
    const open = { started_at: 1_000, ended_at: null, direction: "below" };
    expect(backfillEpisodeCoveredByLiveEvent({ startedAt: 900, endedAt: 1_100, direction: "below" }, open)).toBe(true);
    expect(backfillEpisodeCoveredByLiveEvent({ startedAt: 1_001, endedAt: 1_100, direction: "below" }, open)).toBe(true);
    expect(backfillEpisodeCoveredByLiveEvent({ startedAt: 1_000, endedAt: 1_100, direction: "above" }, open)).toBe(true);
    expect(backfillEpisodeCoveredByLiveEvent({ startedAt: 900, endedAt: 1_100, direction: "above" }, open)).toBe(false);
  });
});

const meta = ACTIVE_STABLECOINS.find((coin) => coin.id === "usdt-tether")!;
const tokens = [{ date: "1000", totalCirculatingUSD: { peggedUSD: 2_000_000_000 } }];

function preparePlan() {
  return buildBackfillPlan({
    db: mockD1([{ match: "cache", rows: [] }]), coins: [meta], replayWindow: null, coingeckoApiKey: null,
  });
}

afterEach(() => {
  vi.useRealTimers();
  resetDefiLlamaDetailStateForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("backfill-depegs planning detail intake", () => {
  it("keeps historical supply and defillama-history provenance for healthy bodies above the shared cap", async () => {
    const body = JSON.stringify({
      gecko_id: "tether", tokens,
      chainBalances: { unused: "x".repeat(DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES) },
    });
    expect(body.length).toBeGreaterThan(DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES);
    expect(body.length).toBeLessThan(DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES);
    mockFetch([{ match: "/stablecoin/", respond: () => new Response(body) }]);
    const plan = await preparePlan();
    const prepared = plan.preparedCoins[0]!;
    expect(prepared.supplyTokens).toEqual(tokens);
    expect(parseSupplyData(prepared.supplyTokens)).toEqual([{ ts: 1000, supply: 2_000_000_000 }]);
    expect(prepared).not.toHaveProperty("chainBalances");
    vi.mocked(backfillCoin).mockResolvedValue({
      sourceKind: "market", authoritativeSource: null, marketDiagnostics: null,
      assessed: [{ timestamp: 900, state: "in-band" }, { timestamp: 1000, state: "below" }],
      events: [{
        pegType: "peggedUSD", direction: "below", peakDeviationBps: -200,
        startedAt: 1000, endedAt: 2000, startPrice: 0.98, peakPrice: 0.98, recoveryPrice: 1, pegRef: 1,
      }],
    });
    const applyBackfillEvents = vi.fn<ApplyBackfillEventsFn>(async () => undefined);
    const outcome = await executeBackfillForCoin({
      db: mockD1([{ match: "FROM depeg_events", rows: [] }]), prepared,
      fxSeries: plan.fxSeries,
      commodityPeers: plan.commodityPeers, replayWindow: null, coingeckoApiKey: null,
      dryRun: false, applyBackfillEvents,
    });
    expect(outcome.status).toBe("applied");
    expect(vi.mocked(backfillCoin).mock.calls[0]![0].supplyByDate).toEqual([{ ts: 1000, supply: 2_000_000_000 }]);
    expect(applyBackfillEvents.mock.calls[0]![1]).toEqual([
      expect.objectContaining({ provenance: expect.objectContaining({ supplySource: "defillama-history" }) }),
    ]);
  });

  it("rejects detail above the provider cap without consuming or truncating its body", async () => {
    const cancelled = vi.fn();
    const fetch = mockFetch([{
      match: "/stablecoin/",
      respond: () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
        headers: { "content-length": String(DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES + 1) },
      }),
    }]);
    const plan = await preparePlan();
    expect(plan.preparedCoins[0]!.supplyTokens).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it("shares detail materialization admission before starting a planning fetch", async () => {
    vi.useFakeTimers();
    const release = await acquireDefiLlamaDetailMaterialization();
    const fetch = mockFetch([{ match: "/stablecoin/", body: { tokens } }]);
    const pending = preparePlan();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await pending).preparedCoins[0]!.supplyTokens).toEqual(tokens);
  });
});
