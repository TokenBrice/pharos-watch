import { describe, expect, it } from "vitest";
import {
  buildHistoricalDewsMap,
  computeHistoricalDewsStressBreadth,
  usesHistoricalStressBreadth,
} from "../psi-replay";
import { buildSupplySnapshotMap } from "../psi-recompute";
import { psiDepegRow, psiSupplyPair, replayPsiDay, DAY } from "./psi.test-support";

describe("psi-replay", () => {
  it("enables historical stress breadth for v3.x only", () => {
    expect(usesHistoricalStressBreadth("2.1")).toBe(false);
    expect(usesHistoricalStressBreadth("3.0")).toBe(true);
    expect(usesHistoricalStressBreadth("3.2")).toBe(true);
  });

  it("computes historical DEWS stress breadth from daily stress history", () => {
    const day = 1_746_384_000;
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100_000_000_000 },
      { stablecoin_id: "usdc-circle", snapshot_date: day, circulating_usd: 64_000_000_000 },
    ]);
    const dewsByDay = buildHistoricalDewsMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, band: "WARNING" },
      { stablecoin_id: "usdc-circle", snapshot_date: day, band: "CALM" },
    ]);

    const stressBreadth = computeHistoricalDewsStressBreadth(day, supplyByCoin, dewsByDay);
    expect(stressBreadth).toBeCloseTo(15, 4);
  });

  it("replays v2.x without stress breadth but v3.x with stress breadth", () => {
    const day = 1_746_384_000;
    const supplyRows = [
      ...psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 100_000_000_000, priorMcap: 100_000_000_000 }),
      ...psiSupplyPair({ stablecoinId: "usdc-circle", day, currentMcap: 64_000_000_000, priorMcap: 64_000_000_000 }),
    ];
    const depegEvents = [psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: -DAY, endedOffsetSec: null, peakDeviationBps: -100 })];
    const dewsByDay = buildHistoricalDewsMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, band: "WARNING" },
      { stablecoin_id: "usdc-circle", snapshot_date: day, band: "ALERT" },
    ]);

    const v21 = replayPsiDay(day, "2.1", supplyRows, depegEvents, dewsByDay);
    const v30 = replayPsiDay(day, "3.0", supplyRows, depegEvents, dewsByDay);

    expect(v21.input.dewsStressBreadth).toBeUndefined();
    expect(v30.input.dewsStressBreadth).toBeGreaterThan(5);
    expect(v21.result?.score).toBeGreaterThan(v30.result?.score ?? -Infinity);
    expect((v21.result?.score ?? 0) - (v30.result?.score ?? 0)).toBe(5);
  });

  it("prefers same-day historical price over peak deviation in replay inputs", () => {
    const day = 1_746_384_000;
    const replay = replayPsiDay(day, "3.2", psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 100_000_000_000, priorMcap: 100_000_000_000, currentPrice: 0.985, priorPrice: 1 }), [psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: -DAY, endedOffsetSec: null, peakDeviationBps: -300 })]);

    expect(replay.input.depegs).toEqual([
      { bps: -150, mcapUsd: 100_000_000_000, depegAgeDays: 1 },
    ]);
    expect(replay.input.historicalPriceCoverageCount).toBe(1);
    expect(replay.input.peakDeviationFallbackCount).toBe(0);
  });

  it("includes multi-day events with sub-threshold daily prices (matching live cron)", () => {
    const day = 1_746_384_000;
    const replay = replayPsiDay(day, "3.2", psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 100_000_000_000, priorMcap: 100_000_000_000, currentPrice: 0.995, priorPrice: 1 }), [psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: -DAY, endedOffsetSec: null, peakDeviationBps: -300 })]);

    // Multi-day active events contribute with their daily price regardless
    // of threshold, matching the live cron behavior.
    expect(replay.input.depegs).toEqual([
      { bps: -50, mcapUsd: 100_000_000_000, depegAgeDays: 1 },
    ]);
    expect(replay.input.historicalPriceCoverageCount).toBe(1);
    expect(replay.input.peakDeviationFallbackCount).toBe(0);
  });

  it("keeps crisis-like replay sensitivity when adding bounded stress breadth", () => {
    const day = 1_746_384_000;
    const replay = replayPsiDay(day, "3.0", [
      ...psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 145_000_000_000, priorMcap: 145_000_000_000 }),
      ...psiSupplyPair({ stablecoinId: "usdc-circle", day, currentMcap: 60_000_000_000, priorMcap: 60_000_000_000 }),
    ], [psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: -DAY, endedOffsetSec: null, peakDeviationBps: -300 })], buildHistoricalDewsMap([
        { stablecoin_id: "usdt-tether", snapshot_date: day, band: "WARNING" },
        { stablecoin_id: "usdc-circle", snapshot_date: day, band: "ALERT" },
      ]));

    expect(replay.result?.band).toBe("MELTDOWN");
    expect(replay.result?.score).toBeLessThan(20);
  });

  it("keeps SVB-like historical price shocks as sharp replay drawdowns", () => {
    const day = 1_678_579_200; // 2023-03-11
    const replay = replayPsiDay(day, "3.2", [
      ...psiSupplyPair({ stablecoinId: "usdc-circle", day, currentMcap: 43_000_000_000, priorMcap: 43_500_000_000, currentPrice: 0.88, priorPrice: 1 }),
      ...psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 73_000_000_000, priorMcap: 72_000_000_000, currentPrice: 1.001, priorPrice: 1 }),
    ], [psiDepegRow({ stablecoinId: "usdc-circle", day, startedOffsetSec: -DAY, endedOffsetSec: null, peakDeviationBps: -1200 })], buildHistoricalDewsMap([
        { stablecoin_id: "usdc-circle", snapshot_date: day, band: "WARNING" },
      ]));

    expect(replay.input.depegs).toEqual([
      { bps: -1200, mcapUsd: 43_000_000_000, depegAgeDays: 1 },
    ]);
    expect(replay.result?.band).toBe("MELTDOWN");
    expect(replay.result?.score).toBeLessThan(20);
  });

  it("uses peak deviation as a start-day floor when the daily snapshot misses an intraday shock", () => {
    const day = 1_678_579_200; // 2023-03-11
    const replay = replayPsiDay(day, "3.2", [
      ...psiSupplyPair({ stablecoinId: "usdc-circle", day, currentMcap: 43_000_000_000, priorMcap: 43_500_000_000, currentPrice: 0.998, priorPrice: 1 }),
      ...psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 73_000_000_000, priorMcap: 72_000_000_000, currentPrice: 1.001, priorPrice: 1 }),
    ], [psiDepegRow({ stablecoinId: "usdc-circle", day, startedOffsetSec: 6 * 3600, endedOffsetSec: null, peakDeviationBps: -1200 })], buildHistoricalDewsMap([
        { stablecoin_id: "usdc-circle", snapshot_date: day, band: "WARNING" },
      ]));

    expect(replay.input.depegs).toEqual([
      { bps: -1200, mcapUsd: 43_000_000_000, depegAgeDays: 0 },
    ]);
    expect(replay.result?.band).toBe("MELTDOWN");
  });

  it("drops near-midnight start-day peaks that do not materially persist into the next UTC day", () => {
    const day = 1_608_508_800; // 2020-12-21
    const replay = replayPsiDay(day, "1.0", psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 64_026_005, priorMcap: 58_685_677, currentPrice: 1.0026849879160749, priorPrice: 1.0285746209170659 }), [psiDepegRow({ stablecoinId: "usdt-tether", day, startedOffsetSec: 22 * 3600 + 113, endedOffsetSec: DAY + 93, peakDeviationBps: 339 })]);

    expect(replay.input.depegs).toEqual([]);
    expect(replay.input.historicalPriceCoverageCount).toBe(0);
    expect(replay.input.peakDeviationFallbackCount).toBe(0);
  });

  it("uses the daily replay price for moderate same-day follow-on depegs", () => {
    const day = 1_678_665_600; // 2023-03-13
    const replay = replayPsiDay(day, "1.0", psiSupplyPair({ stablecoinId: "lusd-liquity", day, currentMcap: 247_756_468, priorMcap: 230_964_010, currentPrice: 1.0134849488335838, priorPrice: 1.0057375677243316 }), [psiDepegRow({ stablecoinId: "lusd-liquity", day, startedOffsetSec: 10 * 3600 + 78, endedOffsetSec: DAY + 9 * 3600 + 130, peakDeviationBps: 209 })]);

    expect(replay.input.depegs).toEqual([
      { bps: 135, mcapUsd: 247_756_468, depegAgeDays: 0 },
    ]);
    expect(replay.input.historicalPriceCoverageCount).toBe(1);
    expect(replay.input.peakDeviationFallbackCount).toBe(0);
  });

  it("replays legacy UST depeg rows against the canonical shadow asset", () => {
    const day = 1_652_140_800; // 2022-05-10
    const replay = replayPsiDay(day, "1.0", [
      ...psiSupplyPair({ stablecoinId: "ust-terra", day, currentMcap: 15_682_326_993, priorMcap: 18_700_360_530 }),
      ...psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 82_000_000_000, priorMcap: 81_500_000_000, currentPrice: 1, priorPrice: 1 }),
    ], [psiDepegRow({ stablecoinId: "ust-terra-classic", day, startedOffsetSec: -28_700, endedOffsetSec: null, peakDeviationBps: -9900 })]);

    expect(replay.input.depegs).toEqual([
      { bps: -9900, mcapUsd: 15_682_326_993, depegAgeDays: expect.any(Number) },
    ]);
    expect(replay.result?.band).toBe("MELTDOWN");
    expect(replay.result?.score).toBeLessThan(20);
  });
});
