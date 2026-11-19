import { getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { describe, expect, it } from "vitest";
import {
  buildStabilityInputForDay,
  buildSupplySnapshotMap,
  type PsiSupplyRow,
  type PsiDepegEventRow,
} from "../psi-recompute";
import {
  findNearestSupplySnapshot,
  type PsiUniverseCache,
} from "../psi-history-universe";
import { buildPsiDayInput, buildPsiStabilityInput, psiDepegRow, psiSupplyPair, DAY } from "./psi.test-support";
import { getPublishedReferenceEvidence, readAdmittedNativeEventObservation } from "../psi-reference";

it("only passes repricing from the published generation, decision session and provider", () => {
  const reopen = Date.UTC(2026, 7, 9, 21) / 1000;
  const decision = reopen + 3600;
  const observation = { pegKey: "peggedEUR", source: "openExchangeRates", cadence: "intraday",
    observedAtSec: decision, usdPerUnit: 1.1 } as const;
  const repricing = { source: observation.source, sessionOpenedAtSec: reopen,
    preCloseUsdPerUnit: 1.09, firstInSessionObservedAtSec: reopen + 60 };
  const selection = { kind: "fx", generation: "fixture-fx", observation, repricing } as const;
  const denominator = { kind: "fx", generation: "fixture-fx", observation, usdPerUnit: 1.1 };

  expect(getPublishedReferenceEvidence(selection, "other-generation", decision)).toBeUndefined();
  expect(getPublishedReferenceEvidence(selection, selection.generation, decision)).toEqual({
    ...denominator, preCloseUsdPerUnit: 1.09, firstInSessionObservedAtSec: reopen + 60,
  });
  expect(getPublishedReferenceEvidence(selection, selection.generation, decision + 7 * DAY)).toEqual(denominator);
  expect(getPublishedReferenceEvidence({
    ...selection, repricing: { ...repricing, source: "frankfurter" },
  }, selection.generation, decision)).toEqual(denominator);
});

describe("buildSupplySnapshotMap", () => {
  it("returns an empty map for empty input", () => {
    const result = buildSupplySnapshotMap([]);
    expect(result.size).toBe(0);
  });

  it("groups multiple coins independently and keeps per-coin sorting", () => {
    const rows: PsiSupplyRow[] = ([
      ["usdc-circle", 2, 220], ["usdt-tether", 3, 330], ["usdc-circle", 1, 210], ["usdt-tether", 1, 310],
    ] as const).map(([stablecoin_id, day, circulating_usd]) => ({ stablecoin_id, snapshot_date: day * DAY, circulating_usd }));

    const result = buildSupplySnapshotMap(rows);
    expect(result.get("usdc-circle")).toEqual([
      { date: 1 * DAY, mcap: 210 },
      { date: 2 * DAY, mcap: 220 },
    ]);
    expect(result.get("usdt-tether")).toEqual([
      { date: 1 * DAY, mcap: 310 },
      { date: 3 * DAY, mcap: 330 },
    ]);
  });

  it("filters rows outside the PSI universe", () => {
    const rows: PsiSupplyRow[] = [
      { stablecoin_id: "usdt-tether", snapshot_date: DAY, circulating_usd: 100 },
      { stablecoin_id: "ust-terra", snapshot_date: DAY, circulating_usd: 5 },
      { stablecoin_id: "not-a-psi-coin", snapshot_date: DAY, circulating_usd: 999 },
    ];

    const result = buildSupplySnapshotMap(rows);
    expect(result.has("usdt-tether")).toBe(true);
    expect(result.has("ust-terra")).toBe(true);
    expect(result.has("not-a-psi-coin")).toBe(false);
  });
});

describe("findNearestSupplySnapshot", () => {
  const snapshots = [
    { date: 10 * DAY, mcap: 1000 },
    { date: 20 * DAY, mcap: 2000 },
    { date: 40 * DAY, mcap: 4000 },
  ];

  it("returns exact date match", () => {
    expect(findNearestSupplySnapshot(snapshots, 20 * DAY)).toEqual({
      date: 20 * DAY,
      mcap: 2000,
    });
  });

  it("returns null when nearest snapshot is farther than 14 days", () => {
    expect(findNearestSupplySnapshot(snapshots, 55 * DAY)).toBeNull();
  });

  it("selects the earlier snapshot when a later one is closer", () => {
    expect(findNearestSupplySnapshot(snapshots, 32 * DAY)).toEqual({
      date: 20 * DAY,
      mcap: 2000,
    });
  });

  it("returns null when every snapshot is later than the day being replayed", () => {
    expect(findNearestSupplySnapshot(snapshots, 5 * DAY)).toBeNull();
  });

  it("returns null for empty/undefined snapshots", () => {
    expect(findNearestSupplySnapshot([], 10 * DAY)).toBeNull();
    expect(findNearestSupplySnapshot(undefined, 10 * DAY)).toBeNull();
  });
});

describe("buildStabilityInputForDay", () => {
  it.each([
    ["eurc-circle", "peggedEUR", 1.08],
    ["jpyc-jpyc", "peggedJPY", 0.0067],
    ["usdt-tether", "peggedUSD", 0.98],
  ])("replays %s with contemporaneous same-domain evidence", (id, pegType, price) => {
    const day = Date.UTC(2026, 7, 6) / 1000;
    const event: PsiDepegEventRow = {
      stablecoin_id: id, source: "live", peg_type: pegType,
      peg_reference: 1, started_at: day + DAY - 3600, ended_at: null,
      start_price: 0.98, peak_deviation_bps: -200,
    };
    const replay = (usdPrice: number, events = [event]) => buildStabilityInputForDay(
      day, day + 2 * DAY, events,
      buildSupplySnapshotMap([{ stablecoin_id: id, snapshot_date: day, circulating_usd: 1e9, price: usdPrice }]),
    );
    expect(replay(price).depegs).toEqual([{ bps: -200, mcapUsd: 1e9, depegAgeDays: 0 }]);
    if (pegType !== "peggedUSD") {
      expect(replay(price * 1.2).depegs).toEqual(replay(price).depegs);
      const unavailable = replay(price, [{ ...event, started_at: day }]);
      expect(unavailable.depegs).toEqual([]);
      expect(unavailable.openDepegsWithoutPrice).toBe(1);
      expect(unavailable.peakDeviationFallbackCount).toBe(0);
      expect(replay(price, [{ ...event, source: "backfill", quote_mode: "native-peg" }]).depegs)
        .toEqual(replay(price).depegs);
      expect(replay(price, [{ ...event, source: "backfill", quote_mode: null }]).openDepegsWithoutPrice).toBe(1);
    }
  });

  it("retains XAUT cap trend while admitting native momentum only for reconciled counts", () => {
    const day = Date.UTC(2026, 9, 27) / 1000;
    const id = "xaut-tether";
    const row = (date: number, count: number, source: string) => ({
      stablecoin_id: id, snapshot_date: date, circulating_usd: count * 3000, circulating_native: count,
      supply_provenance: JSON.stringify({ supplySource: source, supplyObservedAt: date, supplyChainGuard: null }),
    });
    const replay = (priorSource: string) => buildStabilityInputForDay(day, day + DAY - 1, [], buildSupplySnapshotMap([
      row(day - 7 * DAY, 1e6, priorSource), row(day, 900_000, "onchain-circulating-supply"),
    ]));
    expect(replay("coingecko").mcap7dChangePct).toBe(-10);
    expect(replay("coingecko").nativeQuantityMomentum).toBeUndefined();
    expect(replay("onchain-circulating-supply").nativeQuantityMomentum).toEqual({ [id]: -10 });
  });

  it("handles no active depegs", () => {
    const day = Date.UTC(2026, 7, 6) / 1000;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 1000, priorMcap: 900 }), [], day + 2 * DAY);

    expect(result.depegCount).toBe(0);
    expect(result.depegs).toEqual([]);
    expect(result.totalMcapUsd).toBe(1000);
    expect(result.mcap7dChangePct).toBeCloseTo(11.1111111111);
  });

  it("withholds an archived native AxCNH price with no offshore trade lineage", () => {
    const day = Date.UTC(2026, 7, 6) / 1000;
    const id = "axcnh-anchorx";
    const event = {
      stablecoin_id: id, source: "live", peg_type: "peggedCNH", quote_mode: "native-peg" as const,
      peg_reference: 1, started_at: day + DAY - 3600, ended_at: null,
      start_price: 0.97, peak_deviation_bps: -300,
    };
    expect(readAdmittedNativeEventObservation(event, day + DAY, true)).toBeNull();
    const result = buildStabilityInputForDay(day, day + 2 * DAY, [event],
      buildSupplySnapshotMap([{ stablecoin_id: id, snapshot_date: day, circulating_usd: 1e9 }]));
    expect(result.openDepegsWithoutPrice).toBe(1);
    expect(result.depegs).toEqual([]);
  });

  it("uses the worst absolute bps for active coin depegs", () => {
    const day = Date.UTC(2026, 7, 6) / 1000;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 2_000_000, priorMcap: 1_500_000, currentPrice: 0.975 }), [
      psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: -4 * DAY, endedOffsetSec: null, peakDeviationBps: 120 }),
      psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: -2 * DAY, endedOffsetSec: null, peakDeviationBps: -250 }),
    ]);

    expect(result.depegCount).toBe(1);
    expect(result.depegs).toEqual([
      {
        bps: -250,
        mcapUsd: 2_000_000,
        depegAgeDays: 4,
      },
    ]);
    expect(result.historicalPriceCoverageCount).toBe(1);
    expect(result.peakDeviationFallbackCount).toBe(0);
  });

  it.each(["timed onset", "untimed daily estimate"])("uses the stored USD reference with %s evidence", (basis) => {
    const day = Date.UTC(2026, 2, 31) / 1000;
    const onset = 1_774_982_034;
    const price = 0.985874;
    const timed = basis === "timed onset";
    const id = "pmusd-precious-metals";
    const event: PsiDepegEventRow = {
      stablecoin_id: id, peg_type: "peggedUSD", peg_reference: 0.9991379105131056,
      started_at: timed ? onset : day - DAY, ended_at: timed ? 1_774_989_239 : null,
      start_price: timed ? price : undefined, peak_deviation_bps: -133,
    };
    const supply = buildSupplySnapshotMap([
      { stablecoin_id: id, snapshot_date: day, circulating_usd: 2e6, price: timed ? null : price },
    ]);
    const replay = buildStabilityInputForDay(day, day + DAY, [event], supply, undefined, undefined, timed ? [onset] : []);
    expect(replay.depegs[0]?.bps).toBe(-133);
  });

  it.each([
    ["2026-11-13", 21, -200], ["2026-11-14", 21, -200],
    ["2026-11-15", 22, -200], ["2026-11-15", 23.75, -200],
    ["2026-11-16", 1, -200], ["2026-11-16", 21, -100],
  ])("pairs gold at the quote clock and carries through reopening on %s at %s UTC", (date, hour, bps) => {
    const day = Date.parse(date) / 1000;
    const friday = Date.parse("2026-11-13") / 1000;
    const monday = Date.parse("2026-11-16") / 1000;
    const event: PsiDepegEventRow = {
      stablecoin_id: "xaut-tether", started_at: friday - DAY, ended_at: null,
      peg_type: "peggedGOLD", peg_reference: 4_500, peak_deviation_bps: -500, quote_mode: "usd",
    };
    const supply = buildSupplySnapshotMap([
      [friday, 20, 3_920], [friday + DAY, 20, 3_800], [monday - DAY, 23.5, 3_000], [monday, 20, 4_158],
    ].map(([date, observedHour, price]) => ({
      stablecoin_id: event.stablecoin_id, snapshot_date: date!, price,
      circulating_usd: 1e9, price_observed_at: date! + observedHour! * 3600,
    })));
    const result = buildStabilityInputForDay(day, day + DAY, [event], supply, undefined, {
      referenceAt(currency, at) {
        expect(currency).toBe("GOLD");
        const observedAtSec = at >= monday - DAY && at < monday ? friday + 20 * 3600 : at - 60;
        const usdPerUnit = at >= monday ? 4_200 : 4_000;
        const session = getReferenceSessionState("metal", observedAtSec);
        return { usdPerUnit, observedAtSec, source: "gold-api.com", kind: "fallback",
          observation: { pegKey: "peggedGOLD", usdPerUnit, observedAtSec, source: "gold-api.com", cadence: "intraday",
            ...(session.open ? { repricing: { source: "gold-api.com", sessionOpenedAtSec: session.sessionOpenedAtSec,
              preCloseUsdPerUnit: 3_990 } } : {}) },
        };
      },
    }, [day + hour * 3600]);
    expect(result.depegs[0]?.bps).toBeCloseTo(bps);
    expect(buildStabilityInputForDay(day, day + DAY, [event], supply).openDepegsWithoutPrice).toBe(1);
  });

  it("replays a live bullion USD quote without a quote-mode row when dated benchmark evidence exists", () => {
    const day = Date.UTC(2026, 9, 30) / 1000;
    const startedAt = day + 14 * 3600;
    const event: PsiDepegEventRow = {
      stablecoin_id: "xaut-tether", started_at: startedAt, ended_at: null, source: "live",
      peg_type: "peggedGOLD", peg_reference: 3_905.57, start_price: 3_968.1082, peak_deviation_bps: 160,
    };
    const supply = buildSupplySnapshotMap([
      { stablecoin_id: event.stablecoin_id, snapshot_date: day, circulating_usd: 1e9 },
    ]);
    const session = getReferenceSessionState("metal", startedAt);
    const source = "gold-api.com" as const;
    const observation = { pegKey: "peggedGOLD" as const, usdPerUnit: event.peg_reference,
      observedAtSec: startedAt - 60, source, cadence: "intraday" as const,
      ...(session.open ? { repricing: { source, sessionOpenedAtSec: session.sessionOpenedAtSec,
        preCloseUsdPerUnit: 3_900 } } : {}) };
    const replay = (row: PsiDepegEventRow, withReference = true) => buildStabilityInputForDay(
      day, day + DAY, [row], supply, undefined,
      withReference ? { referenceAt: () => ({ ...observation, kind: "fallback", observation }) } : undefined,
      [startedAt + 60],
    );
    const explicit = replay({ ...event, quote_mode: "usd" });
    expect(explicit.depegs[0]?.bps).toBeCloseTo(160.13);
    expect(replay(event).depegs).toEqual(explicit.depegs);
    expect(replay(event, false).openDepegsWithoutPrice).toBe(1);
    expect(replay({ ...event, quote_mode: "foreign" }).openDepegsWithoutPrice).toBe(1);
  });

  it("includes resolved depegs that are still active on the target day", () => {
    const day = Date.UTC(2026, 7, 6) / 1000;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdc-circle", day, currentMcap: 500_000, priorMcap: 500_000, currentPrice: 1.018 }), [psiDepegRow({ stablecoinId: "usdc-circle", day, startedOffsetSec: -DAY, endedOffsetSec: DAY + 60, peakDeviationBps: 180 })]);

    expect(result.depegCount).toBe(1);
    expect(result.depegs[0]).toEqual({
      bps: 180,
      mcapUsd: 500_000,
      depegAgeDays: 1,
    });
    expect(result.historicalPriceCoverageCount).toBe(1);
    expect(result.peakDeviationFallbackCount).toBe(0);
  });

  it("counts depegs that start later during the target UTC day", () => {
    const day = Date.UTC(2026, 7, 6) / 1000;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdc-circle", day, currentMcap: 500_000, priorMcap: 500_000 }), [{ ...psiDepegRow({ stablecoinId: "usdc-circle", day, startedOffsetSec: 12 * 3600, endedOffsetSec: 18 * 3600, peakDeviationBps: -250 }), start_price: 0.982 }]);

    expect(result.depegCount).toBe(1);
    expect(result.depegs[0]).toEqual({
      bps: -180,
      mcapUsd: 500_000,
      depegAgeDays: 0,
    });
  });

  it("maps legacy PSI depeg ids onto canonical historical supply snapshots", () => {
    const day = Date.UTC(2026, 7, 6) / 1000;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "ust-terra", day, currentMcap: 18_000_000_000, priorMcap: 17_500_000_000 }), [{ ...psiDepegRow({ stablecoinId: "ust-terra-classic", day, startedOffsetSec: 0, endedOffsetSec: null, peakDeviationBps: -9900 }), start_price: 0.01 }]);

    expect(result.depegCount).toBe(1);
    expect(result.depegs).toEqual([
      {
        bps: -9900,
        mcapUsd: 18_000_000_000,
        depegAgeDays: 0,
      },
    ]);
  });

  it.each([[10, -135], [25, -140]])("only uses onset-day observations by the replay cutoff, mark at hour %s", (hour, bps) => {
    const day = Date.UTC(2026, 7, 6) / 1000;
    const rows = [{ stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 2e6, price: 0.9865, price_observed_at: day + hour * 3600 }];
    const event = { ...psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: 6 * 3600, endedOffsetSec: null, peakDeviationBps: -9900 }), start_price: 0.986 };
    const replay = buildPsiStabilityInput(day, rows, [event]);
    expect(replay.depegs[0]?.bps).toBe(bps);
    expect(replay.peakDeviationFallbackCount).toBe(0);
    const unpriced = buildPsiStabilityInput(day, [{ ...rows[0]!, price_observed_at: null }], [{ ...event, start_price: undefined }]);
    expect(unpriced.openDepegsWithoutPrice).toBe(1);
  });

  it.each(["usr-resolv", "gyen-gyen"])("uses %s weights and coverage before freeze", (id) => {
    const march = Date.UTC(2026, 2, 25) / 1000;
    const august = Date.UTC(2026, 7, 6) / 1000;
    const pair = (day: number) => psiSupplyPair({ stablecoinId: id, day, currentMcap: 2e6, priorMcap: 1e6, currentPrice: 0.98 });
    const before = buildPsiStabilityInput(march, pair(march));
    const after = buildPsiStabilityInput(august, pair(august));
    expect(before).toMatchObject({ totalMcapUsd: 2e6, coveredUniverseCount: 1, mcap7dChangePct: 100 });
    expect(after).toMatchObject({ totalMcapUsd: 0, coveredUniverseCount: 0, mcap7dChangePct: null });
  });

  it("includes multi-day events with sub-threshold daily prices (matching live cron behavior)", () => {
    const day = Date.UTC(2026, 7, 6) / 1000;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 2_000_000, priorMcap: 1_500_000, currentPrice: 0.993, priorPrice: 1 }), [psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: -3 * DAY, endedOffsetSec: null, peakDeviationBps: -1200 })]);

    // Multi-day active events contribute with their daily price deviation
    // regardless of threshold, matching the live cron which includes all
    // active depegs without threshold filtering.
    expect(result.depegCount).toBe(1);
    expect(result.depegs).toEqual([
      {
        bps: -70,
        mcapUsd: 2_000_000,
        depegAgeDays: 3,
      },
    ]);
    expect(result.historicalPriceCoverageCount).toBe(1);
    expect(result.peakDeviationFallbackCount).toBe(0);
  });

  it("reports unavailable trend rather than flat growth without a paired prior denominator", () => {
    const day = Date.UTC(2026, 7, 6) / 1000;
    const result = buildPsiStabilityInput(day, [{ stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 1000 }]);
    expect(result.totalMcapUsd).toBe(1000);
    expect(result.mcap7dChangePct).toBeNull();
    expect(result.trendUnavailableIds).toContain("usdt-tether");
  });

  it.each([[14, 0], [14, 1], [14, 2], [13, 0], [20, 0]])("pairs trend identities independently of current supply (%s / %s)", (date, age) => {
    const day = Date.UTC(2026, 10, date) / 1000;
    const input = buildPsiStabilityInput(day, [
      ...psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 2e9, priorMcap: 2e9 }),
      { stablecoin_id: "usdc-circle", snapshot_date: day, circulating_usd: 10e9 },
      // Available at the prior target but outside the current 14-day as-of window.
      { stablecoin_id: "dai-makerdao", snapshot_date: day - 21 * DAY, circulating_usd: 3e9 },
      ...psiSupplyPair({ stablecoinId: "usds-sky", day, currentMcap: 0, priorMcap: 0 }),
      ...psiSupplyPair({ stablecoinId: "gho-aave", day: day - age * DAY, currentMcap: age === 2 ? 699e6 : 268e6, priorMcap: 699e6 }),
    ]);
    expect(input.totalMcapUsd).toBe(12e9 + (age === 2 ? 699e6 : 268e6));
    expect(input.mcap7dChangePct).toBe(0);
    expect(input.trendUnavailableIds).toContain("usdc-circle");
    expect(input.trendUnavailableIds).toContain("dai-makerdao");
    expect(input.trendUnavailableIds).not.toContain("usds-sky");
    expect(input.trendUnavailableIds).toContain("gho-aave");
  });

  it("holds a measured zero paired prior denominator instead of inventing a trend", () => {
    const day = Date.UTC(2026, 7, 6) / 1000;
    const input = buildPsiStabilityInput(day, psiSupplyPair({
      stablecoinId: "usdt-tether", day, currentMcap: 1e9, priorMcap: 0,
    }));
    expect(input.mcap7dChangePct).toBeNull();
    expect(input.trendUnavailableIds).not.toContain("usdt-tether");
  });

  it("reports PSI-universe coverage metadata", () => {
    const day = 1_746_384_000; // 2025-05-09T00:00:00Z
    const input = buildPsiStabilityInput(day, [
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100_000_000 },
      { stablecoin_id: "ust-terra", snapshot_date: day, circulating_usd: 5_000_000 },
      { stablecoin_id: "not-a-psi-coin", snapshot_date: day, circulating_usd: 999_000_000 },
    ], [], day);

    expect(input.totalMcapUsd).toBe(105_000_000);
    expect(input.eligibleUniverseCount).toBeGreaterThan(input.coveredUniverseCount);
    expect(input.coveredUniverseCount).toBe(2);
    expect(input.historicalAssetCoverageCount).toBe(1);
  });

  it("uses PSI-bounded market cap for depeg denominators", () => {
    const day = 1_746_384_000; // 2025-05-09T00:00:00Z
    const input = buildPsiStabilityInput(day, [
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100_000_000, price: 0.988 },
      { stablecoin_id: "not-a-psi-coin", snapshot_date: day, circulating_usd: 900_000_000 },
    ], [psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: -DAY, endedOffsetSec: null, peakDeviationBps: -120 })], day + DAY);

    expect(input.totalMcapUsd).toBe(100_000_000);
    expect(input.depegs).toEqual([
      { bps: -120, mcapUsd: 100_000_000, depegAgeDays: 1 },
    ]);
  });

  it("produces identical output with and without a universe cache and memoizes by day", () => {
    const day = Date.UTC(2026, 7, 6) / 1000;
    const { now, supplyByCoin } = buildPsiDayInput({ day, now: day + 2 * DAY, supplyRows: psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 1000, priorMcap: 900 }) });

    const uncached = buildStabilityInputForDay(day, now, [], supplyByCoin);

    const cache: PsiUniverseCache = new Map();
    const cached = buildStabilityInputForDay(day, now, [], supplyByCoin, cache);

    expect(cached).toEqual(uncached);
    // The current day and the 7-day-ago day are both memoized after one call.
    expect(cache.has(day)).toBe(true);
    expect(cache.has(day - 7 * DAY)).toBe(true);

    // A second day reuses the prior day's universe (day-7d of the next call may
    // hit an already-cached entry); the cache only ever grows by distinct days.
    const sizeAfterFirst = cache.size;
    buildStabilityInputForDay(day + 7 * DAY, now, [], supplyByCoin, cache);
    // day+7d and (day+7d)-7d===day; day already cached, so only +1 new entry.
    expect(cache.size).toBe(sizeAfterFirst + 1);
  });
});
