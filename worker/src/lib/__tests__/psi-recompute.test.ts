import { describe, expect, it } from "vitest";
import {
  buildStabilityInputForDay,
  buildSupplySnapshotMap,
  type PsiSupplyRow,
} from "../psi-recompute";
import {
  findNearestSupplySnapshot,
  type PsiUniverseCache,
} from "../psi-history-universe";
import { buildPsiDayInput, buildPsiStabilityInput, psiDepegRow, psiSupplyPair, DAY } from "./psi.test-support";

describe("buildSupplySnapshotMap", () => {
  it("returns an empty map for empty input", () => {
    const result = buildSupplySnapshotMap([]);
    expect(result.size).toBe(0);
  });

  it("groups a single coin and sorts snapshots by date", () => {
    const rows: PsiSupplyRow[] = [
      { stablecoin_id: "usdt-tether", snapshot_date: 3 * DAY, circulating_usd: 300 },
      { stablecoin_id: "usdt-tether", snapshot_date: 1 * DAY, circulating_usd: 100 },
      { stablecoin_id: "usdt-tether", snapshot_date: 2 * DAY, circulating_usd: 200 },
    ];

    const result = buildSupplySnapshotMap(rows);
    expect(result.get("usdt-tether")).toEqual([
      { date: 1 * DAY, mcap: 100 },
      { date: 2 * DAY, mcap: 200 },
      { date: 3 * DAY, mcap: 300 },
    ]);
  });

  it("groups multiple coins independently and keeps per-coin sorting", () => {
    const rows: PsiSupplyRow[] = [
      { stablecoin_id: "usdc-circle", snapshot_date: 2 * DAY, circulating_usd: 220 },
      { stablecoin_id: "usdt-tether", snapshot_date: 3 * DAY, circulating_usd: 330 },
      { stablecoin_id: "usdc-circle", snapshot_date: 1 * DAY, circulating_usd: 210 },
      { stablecoin_id: "usdt-tether", snapshot_date: 1 * DAY, circulating_usd: 310 },
    ];

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

  it("returns nearest snapshot within 14-day window", () => {
    expect(findNearestSupplySnapshot(snapshots, 27 * DAY)).toEqual({
      date: 20 * DAY,
      mcap: 2000,
    });
  });

  it("returns null when nearest snapshot is farther than 14 days", () => {
    expect(findNearestSupplySnapshot(snapshots, 55 * DAY)).toBeNull();
  });

  it("returns null for empty/undefined snapshots", () => {
    expect(findNearestSupplySnapshot([], 10 * DAY)).toBeNull();
    expect(findNearestSupplySnapshot(undefined, 10 * DAY)).toBeNull();
  });
});

describe("buildStabilityInputForDay", () => {
  it("handles no active depegs", () => {
    const day = 30 * DAY;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 1000, priorMcap: 900 }), [], day + 2 * DAY);

    expect(result.depegCount).toBe(0);
    expect(result.depegs).toEqual([]);
    expect(result.totalMcapUsd).toBe(1000);
    expect(result.mcap7dChangePct).toBeCloseTo(11.1111111111);
  });

  it("uses the worst absolute bps for active coin depegs", () => {
    const day = 40 * DAY;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 2_000_000, priorMcap: 1_500_000 }), [
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
    expect(result.historicalPriceCoverageCount).toBe(0);
    expect(result.peakDeviationFallbackCount).toBe(1);
  });

  it("replays day-level depeg severity from historical supply prices when available", () => {
    const day = 40 * DAY;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 2_000_000, priorMcap: 1_500_000, currentPrice: 0.985, priorPrice: 1 }), [psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: -2 * DAY, endedOffsetSec: null, peakDeviationBps: -250 })]);

    expect(result.depegs).toEqual([
      {
        bps: -150,
        mcapUsd: 2_000_000,
        depegAgeDays: 2,
      },
    ]);
    expect(result.historicalPriceCoverageCount).toBe(1);
    expect(result.peakDeviationFallbackCount).toBe(0);
  });

  it("caps replayed historical deviation at the recorded peak when stored peg reference is stale", () => {
    const day = 40 * DAY;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "eurs-stasis", day, currentMcap: 39_000_000, priorMcap: 38_000_000, currentPrice: 1.2353, priorPrice: 1.22 }), [psiDepegRow({ stablecoinId: "eurs-stasis", day, startedOffsetSec: -2 * DAY, endedOffsetSec: DAY, peakDeviationBps: 189 })]);

    expect(result.depegs).toEqual([
      {
        bps: 189,
        mcapUsd: 39_000_000,
        depegAgeDays: 2,
      },
    ]);
    expect(result.historicalPriceCoverageCount).toBe(0);
    expect(result.peakDeviationFallbackCount).toBe(1);
  });

  it("includes resolved depegs that are still active on the target day", () => {
    const day = 20 * DAY;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdc-circle", day, currentMcap: 500_000, priorMcap: 500_000 }), [psiDepegRow({ stablecoinId: "usdc-circle", day, startedOffsetSec: -DAY, endedOffsetSec: DAY + 60, peakDeviationBps: 180 })]);

    expect(result.depegCount).toBe(1);
    expect(result.depegs[0]).toEqual({
      bps: 180,
      mcapUsd: 500_000,
      depegAgeDays: 1,
    });
    expect(result.historicalPriceCoverageCount).toBe(0);
    expect(result.peakDeviationFallbackCount).toBe(1);
  });

  it("counts depegs that start later during the target UTC day", () => {
    const day = 20 * DAY;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdc-circle", day, currentMcap: 500_000, priorMcap: 500_000 }), [psiDepegRow({ stablecoinId: "usdc-circle", day, startedOffsetSec: 12 * 3600, endedOffsetSec: 18 * 3600, peakDeviationBps: -180 })]);

    expect(result.depegCount).toBe(1);
    expect(result.depegs[0]).toEqual({
      bps: -180,
      mcapUsd: 500_000,
      depegAgeDays: 0,
    });
  });

  it("maps legacy PSI depeg ids onto canonical shadow supply snapshots", () => {
    const day = 20 * DAY;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "ust-terra", day, currentMcap: 18_000_000_000, priorMcap: 17_500_000_000 }), [psiDepegRow({ stablecoinId: "ust-terra-classic", day, startedOffsetSec: 0, endedOffsetSec: null, peakDeviationBps: -9900 })]);

    expect(result.depegCount).toBe(1);
    expect(result.depegs).toEqual([
      {
        bps: -9900,
        mcapUsd: 18_000_000_000,
        depegAgeDays: 0,
      },
    ]);
  });

  it("uses peak deviation as a start-day floor when the daily snapshot misses an intraday shock", () => {
    const day = 40 * DAY;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 2_000_000, priorMcap: 1_500_000, currentPrice: 0.9995, priorPrice: 1 }), [psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: 6 * 3600, endedOffsetSec: null, peakDeviationBps: -1200 })]);

    expect(result.depegs).toEqual([
      {
        bps: -1200,
        mcapUsd: 2_000_000,
        depegAgeDays: 0,
      },
    ]);
    expect(result.historicalPriceCoverageCount).toBe(0);
    expect(result.peakDeviationFallbackCount).toBe(1);
  });

  it("drops start-day peaks that only bleed a few seconds past UTC close", () => {
    const day = 40 * DAY;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 64_000_000, priorMcap: 63_000_000, currentPrice: 1.0027, priorPrice: 1 }), [psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: 22 * 3600, endedOffsetSec: DAY + 90, peakDeviationBps: 339 })]);

    expect(result.depegCount).toBe(0);
    expect(result.depegs).toEqual([]);
    expect(result.historicalPriceCoverageCount).toBe(0);
    expect(result.peakDeviationFallbackCount).toBe(0);
  });

  it("uses the daily price when a same-day follow-on depeg is already materially captured", () => {
    const day = 40 * DAY;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "lusd-liquity", day, currentMcap: 247_756_468, priorMcap: 241_941_590, currentPrice: 1.0135, priorPrice: 0.997 }), [psiDepegRow({ stablecoinId: "lusd-liquity", day, startedOffsetSec: 10 * 3600, endedOffsetSec: DAY + 9 * 3600, peakDeviationBps: 209 })]);

    expect(result.depegs).toEqual([
      {
        bps: 135,
        mcapUsd: 247_756_468,
        depegAgeDays: 0,
      },
    ]);
    expect(result.historicalPriceCoverageCount).toBe(1);
    expect(result.peakDeviationFallbackCount).toBe(0);
  });

  it("drops a same-day wick that fully recovers back inside threshold before UTC close", () => {
    const day = 40 * DAY;
    const result = buildPsiStabilityInput(day, psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 2_000_000, priorMcap: 1_500_000, currentPrice: 0.9995, priorPrice: 1 }), [psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: 6 * 3600, endedOffsetSec: 18 * 3600, peakDeviationBps: -1200 })]);

    expect(result.depegCount).toBe(0);
    expect(result.depegs).toEqual([]);
    expect(result.historicalPriceCoverageCount).toBe(0);
    expect(result.peakDeviationFallbackCount).toBe(0);
  });

  it("includes multi-day events with sub-threshold daily prices (matching live cron behavior)", () => {
    const day = 40 * DAY;
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

  it("returns 0 mcap7dChangePct when 7d-ago mcap is zero", () => {
    const day = 12 * DAY;
    const result = buildPsiStabilityInput(day, [{ stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 1000 }]);
    expect(result.totalMcapUsd).toBe(1000);
    expect(result.mcap7dChangePct).toBe(0);
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
    expect(input.shadowCoverageCount).toBe(1);
  });

  it("uses PSI-bounded market cap for depeg denominators", () => {
    const day = 1_746_384_000; // 2025-05-09T00:00:00Z
    const input = buildPsiStabilityInput(day, [
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100_000_000 },
      { stablecoin_id: "not-a-psi-coin", snapshot_date: day, circulating_usd: 900_000_000 },
    ], [psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: -DAY, endedOffsetSec: null, peakDeviationBps: -120 })], day);

    expect(input.totalMcapUsd).toBe(100_000_000);
    expect(input.depegs).toEqual([
      { bps: -120, mcapUsd: 100_000_000, depegAgeDays: 1 },
    ]);
  });

  it("produces identical output with and without a universe cache and memoizes by day", () => {
    const day = 30 * DAY;
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
