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

  it("distinguishes missing DEWS archive from an observed all-CALM day", () => {
    const day = 1_746_384_000;
    const supplyRows = psiSupplyPair({ stablecoinId: "usdt-tether", day, currentMcap: 100e9, priorMcap: 100e9 });
    const missing = replayPsiDay(day, "3.0", supplyRows);
    expect(missing.result).toBeNull();
    expect(missing.unavailableReason).toBe("dews-archive-unavailable");
    expect(missing.input.dewsStressBreadth).toBeUndefined();
    expect(missing.input.dewsArchiveRowCount).toBe(0);
    expect(missing.input.dewsArchiveSnapshotDate).toBeNull();

    const calm = replayPsiDay(day, "3.0", supplyRows, [], buildHistoricalDewsMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, band: "CALM" },
    ]));
    expect(calm.unavailableReason).toBeNull();
    expect(calm.result?.components.stressBreadth).toBe(0);
    expect(calm.input.dewsStressBreadth).toBe(0);
    expect(calm.input.dewsArchiveRowCount).toBe(1);
    expect(calm.input.dewsArchiveSnapshotDate).toBe(day);
  });

  it("holds replay when prior-week trend evidence is absent even for pre-v3 days", () => {
    const day = 1_746_384_000;
    const replay = replayPsiDay(day, "2.1", [
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100e9 },
    ]);
    expect(replay.result).toBeNull();
    expect(replay.unavailableReason).toBe("trend-inputs-unavailable");
    expect(replay.input.mcap7dChangePct).toBeNull();
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
