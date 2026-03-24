import { describe, expect, it } from "vitest";
import {
  buildHistoricalDewsMap,
  computeHistoricalDewsStressBreadth,
  replayHistoricalPsiForDay,
  usesHistoricalStressBreadth,
} from "../psi-replay";
import { buildSupplySnapshotMap } from "../psi-recompute";

const DAY = 86_400;

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
    const now = day + DAY;
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100_000_000_000 },
      { stablecoin_id: "usdt-tether", snapshot_date: day - 7 * DAY, circulating_usd: 100_000_000_000 },
      { stablecoin_id: "usdc-circle", snapshot_date: day, circulating_usd: 64_000_000_000 },
      { stablecoin_id: "usdc-circle", snapshot_date: day - 7 * DAY, circulating_usd: 64_000_000_000 },
    ]);
    const depegs = [
      {
        stablecoin_id: "usdt-tether",
        peak_deviation_bps: -100,
        peg_reference: 1,
        started_at: day - DAY,
        ended_at: null,
      },
    ];
    const dewsByDay = buildHistoricalDewsMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, band: "WARNING" },
      { stablecoin_id: "usdc-circle", snapshot_date: day, band: "ALERT" },
    ]);

    const v21 = replayHistoricalPsiForDay({
      day,
      now,
      methodologyVersion: "2.1",
      depegEvents: depegs,
      supplyByCoin,
      dewsByDay,
    });
    const v30 = replayHistoricalPsiForDay({
      day,
      now,
      methodologyVersion: "3.0",
      depegEvents: depegs,
      supplyByCoin,
      dewsByDay,
    });

    expect(v21.input.dewsStressBreadth).toBeUndefined();
    expect(v30.input.dewsStressBreadth).toBeGreaterThan(5);
    expect(v21.result?.score).toBeGreaterThan(v30.result?.score ?? -Infinity);
    expect((v21.result?.score ?? 0) - (v30.result?.score ?? 0)).toBe(5);
  });

  it("prefers same-day historical price over peak deviation in replay inputs", () => {
    const day = 1_746_384_000;
    const now = day + DAY;
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100_000_000_000, price: 0.995 },
      { stablecoin_id: "usdt-tether", snapshot_date: day - 7 * DAY, circulating_usd: 100_000_000_000, price: 1 },
    ]);

    const replay = replayHistoricalPsiForDay({
      day,
      now,
      methodologyVersion: "3.2",
      depegEvents: [
        {
          stablecoin_id: "usdt-tether",
          peak_deviation_bps: -300,
          peg_reference: 1,
          started_at: day - DAY,
          ended_at: null,
        },
      ],
      supplyByCoin,
      dewsByDay: new Map(),
    });

    expect(replay.input.depegs).toEqual([
      { bps: -50, mcapUsd: 100_000_000_000, depegAgeDays: 1 },
    ]);
    expect(replay.input.historicalPriceCoverageCount).toBe(1);
    expect(replay.input.peakDeviationFallbackCount).toBe(0);
  });

  it("keeps crisis-like replay sensitivity when adding bounded stress breadth", () => {
    const day = 1_746_384_000;
    const now = day + DAY;
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 145_000_000_000 },
      { stablecoin_id: "usdt-tether", snapshot_date: day - 7 * DAY, circulating_usd: 145_000_000_000 },
      { stablecoin_id: "usdc-circle", snapshot_date: day, circulating_usd: 60_000_000_000 },
      { stablecoin_id: "usdc-circle", snapshot_date: day - 7 * DAY, circulating_usd: 60_000_000_000 },
    ]);

    const replay = replayHistoricalPsiForDay({
      day,
      now,
      methodologyVersion: "3.0",
      depegEvents: [
        {
          stablecoin_id: "usdt-tether",
          peak_deviation_bps: -300,
          peg_reference: 1,
          started_at: day - DAY,
          ended_at: null,
        },
      ],
      supplyByCoin,
      dewsByDay: buildHistoricalDewsMap([
        { stablecoin_id: "usdt-tether", snapshot_date: day, band: "WARNING" },
        { stablecoin_id: "usdc-circle", snapshot_date: day, band: "ALERT" },
      ]),
    });

    expect(replay.result?.band).toBe("MELTDOWN");
    expect(replay.result?.score).toBeLessThan(20);
  });

  it("keeps SVB-like historical price shocks as sharp replay drawdowns", () => {
    const day = 1_678_579_200; // 2023-03-11
    const now = day + DAY;
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdc-circle", snapshot_date: day, circulating_usd: 43_000_000_000, price: 0.88 },
      { stablecoin_id: "usdc-circle", snapshot_date: day - 7 * DAY, circulating_usd: 43_500_000_000, price: 1 },
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 73_000_000_000, price: 1.001 },
      { stablecoin_id: "usdt-tether", snapshot_date: day - 7 * DAY, circulating_usd: 72_000_000_000, price: 1 },
    ]);

    const replay = replayHistoricalPsiForDay({
      day,
      now,
      methodologyVersion: "3.2",
      depegEvents: [
        {
          stablecoin_id: "usdc-circle",
          peak_deviation_bps: -1200,
          peg_reference: 1,
          started_at: day - DAY,
          ended_at: null,
        },
      ],
      supplyByCoin,
      dewsByDay: buildHistoricalDewsMap([
        { stablecoin_id: "usdc-circle", snapshot_date: day, band: "WARNING" },
      ]),
    });

    expect(replay.input.depegs).toEqual([
      { bps: -1200, mcapUsd: 43_000_000_000, depegAgeDays: 1 },
    ]);
    expect(replay.result?.band).toBe("MELTDOWN");
    expect(replay.result?.score).toBeLessThan(20);
  });
});
