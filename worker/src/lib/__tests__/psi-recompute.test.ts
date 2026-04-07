import { describe, expect, it } from "vitest";
import {
  buildStabilityInputForDay,
  buildSupplySnapshotMap,
  type PsiDepegEventRow,
  type PsiSupplyRow,
} from "../psi-recompute";
import { findNearestSupplySnapshot } from "../psi-history-universe";

const DAY = 86_400;

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
    const now = day + 2 * DAY;
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 1000 },
      { stablecoin_id: "usdt-tether", snapshot_date: day - 7 * DAY, circulating_usd: 900 },
    ]);

    const result = buildStabilityInputForDay(day, now, [], supplyByCoin);

    expect(result.depegCount).toBe(0);
    expect(result.depegs).toEqual([]);
    expect(result.totalMcapUsd).toBe(1000);
    expect(result.mcap7dChangePct).toBeCloseTo(11.1111111111);
  });

  it("uses the worst absolute bps for active coin depegs", () => {
    const day = 40 * DAY;
    const now = day + DAY;
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 2_000_000 },
      { stablecoin_id: "usdt-tether", snapshot_date: day - 7 * DAY, circulating_usd: 1_500_000 },
    ]);
    const events: PsiDepegEventRow[] = [
      {
        stablecoin_id: "usdt-tether",
        peak_deviation_bps: 120,
        peg_reference: 1,
        started_at: day - 4 * DAY,
        ended_at: null,
      },
      {
        stablecoin_id: "usdt-tether",
        peak_deviation_bps: -250,
        peg_reference: 1,
        started_at: day - 2 * DAY,
        ended_at: null,
      },
    ];

    const result = buildStabilityInputForDay(day, now, events, supplyByCoin);

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
    const now = day + DAY;
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 2_000_000, price: 0.9925 },
      { stablecoin_id: "usdt-tether", snapshot_date: day - 7 * DAY, circulating_usd: 1_500_000, price: 1 },
    ]);
    const events: PsiDepegEventRow[] = [
      {
        stablecoin_id: "usdt-tether",
        peak_deviation_bps: -250,
        peg_reference: 1,
        started_at: day - 2 * DAY,
        ended_at: null,
      },
    ];

    const result = buildStabilityInputForDay(day, now, events, supplyByCoin);

    expect(result.depegs).toEqual([
      {
        bps: -75,
        mcapUsd: 2_000_000,
        depegAgeDays: 2,
      },
    ]);
    expect(result.historicalPriceCoverageCount).toBe(1);
    expect(result.peakDeviationFallbackCount).toBe(0);
  });

  it("includes resolved depegs that are still active on the target day", () => {
    const day = 20 * DAY;
    const now = day + DAY;
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdc-circle", snapshot_date: day, circulating_usd: 500_000 },
      { stablecoin_id: "usdc-circle", snapshot_date: day - 7 * DAY, circulating_usd: 500_000 },
    ]);
    const events: PsiDepegEventRow[] = [
      {
        stablecoin_id: "usdc-circle",
        peak_deviation_bps: 180,
        peg_reference: 1,
        started_at: day - DAY,
        ended_at: day + 60,
      },
    ];

    const result = buildStabilityInputForDay(day, now, events, supplyByCoin);

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
    const now = day + DAY;
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdc-circle", snapshot_date: day, circulating_usd: 500_000 },
      { stablecoin_id: "usdc-circle", snapshot_date: day - 7 * DAY, circulating_usd: 500_000 },
    ]);
    const events: PsiDepegEventRow[] = [
      {
        stablecoin_id: "usdc-circle",
        peak_deviation_bps: -180,
        peg_reference: 1,
        started_at: day + 12 * 3600,
        ended_at: day + 18 * 3600,
      },
    ];

    const result = buildStabilityInputForDay(day, now, events, supplyByCoin);

    expect(result.depegCount).toBe(1);
    expect(result.depegs[0]).toEqual({
      bps: -180,
      mcapUsd: 500_000,
      depegAgeDays: 0,
    });
  });

  it("uses peak deviation as a start-day floor when the daily snapshot misses an intraday shock", () => {
    const day = 40 * DAY;
    const now = day + DAY;
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 2_000_000, price: 0.9995 },
      { stablecoin_id: "usdt-tether", snapshot_date: day - 7 * DAY, circulating_usd: 1_500_000, price: 1 },
    ]);
    const events: PsiDepegEventRow[] = [
      {
        stablecoin_id: "usdt-tether",
        peak_deviation_bps: -1200,
        peg_reference: 1,
        started_at: day + 6 * 3600,
        ended_at: null,
      },
    ];

    const result = buildStabilityInputForDay(day, now, events, supplyByCoin);

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

  it("returns 0 mcap7dChangePct when 7d-ago mcap is zero", () => {
    const day = 12 * DAY;
    const now = day + DAY;
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 1000 },
    ]);

    const result = buildStabilityInputForDay(day, now, [], supplyByCoin);
    expect(result.totalMcapUsd).toBe(1000);
    expect(result.mcap7dChangePct).toBe(0);
  });

  it("reports PSI-universe coverage metadata", () => {
    const day = 1_746_384_000; // 2025-05-09T00:00:00Z
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100_000_000 },
      { stablecoin_id: "ust-terra", snapshot_date: day, circulating_usd: 5_000_000 },
      { stablecoin_id: "not-a-psi-coin", snapshot_date: day, circulating_usd: 999_000_000 },
    ]);

    const input = buildStabilityInputForDay(day, day, [], supplyByCoin);

    expect(input.totalMcapUsd).toBe(105_000_000);
    expect(input.eligibleUniverseCount).toBeGreaterThan(input.coveredUniverseCount);
    expect(input.coveredUniverseCount).toBe(2);
    expect(input.shadowCoverageCount).toBe(1);
  });

  it("uses PSI-bounded market cap for depeg denominators", () => {
    const day = 1_746_384_000; // 2025-05-09T00:00:00Z
    const supplyByCoin = buildSupplySnapshotMap([
      { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100_000_000 },
      { stablecoin_id: "not-a-psi-coin", snapshot_date: day, circulating_usd: 900_000_000 },
    ]);

    const input = buildStabilityInputForDay(
      day,
      day,
      [
        {
          stablecoin_id: "usdt-tether",
          peak_deviation_bps: -120,
          peg_reference: 1,
          started_at: day - DAY,
          ended_at: null,
        },
      ],
      supplyByCoin,
    );

    expect(input.totalMcapUsd).toBe(100_000_000);
    expect(input.depegs).toEqual([
      { bps: -120, mcapUsd: 100_000_000, depegAgeDays: 1 },
    ]);
  });
});
