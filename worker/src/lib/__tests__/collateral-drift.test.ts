import { describe, it, expect } from "vitest";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-card-policy";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { summarizeCollateralDriftFromLiveReserveMap } from "../collateral-drift";

describe("collateral score delta detection", () => {
  function computeDelta(live: ReserveSlice[], curated: ReserveSlice[]): number {
    return Math.abs(
      computeCollateralQualityFromReserves(live) -
      computeCollateralQualityFromReserves(curated),
    );
  }

  it("detects no drift when compositions match", () => {
    const slices: ReserveSlice[] = [
      { name: "USDC", pct: 100, risk: "low" },
    ];
    expect(computeDelta(slices, slices)).toBe(0);
  });

  it("detects drift above threshold when composition diverges", () => {
    const live: ReserveSlice[] = [{ name: "ETH", pct: 100, risk: "very-low" }];
    const curated: ReserveSlice[] = [{ name: "SOL", pct: 100, risk: "high" }];
    // live = 100, curated = 25, delta = 75
    expect(computeDelta(live, curated)).toBe(75);
    expect(computeDelta(live, curated)).toBeGreaterThan(15);
  });

  it("stays below threshold for minor composition changes", () => {
    const live: ReserveSlice[] = [
      { name: "Treasuries", pct: 55, risk: "very-low" },
      { name: "USDC", pct: 45, risk: "low" },
    ];
    const curated: ReserveSlice[] = [
      { name: "Treasuries", pct: 60, risk: "very-low" },
      { name: "USDC", pct: 40, risk: "low" },
    ];
    expect(computeDelta(live, curated)).toBeLessThanOrEqual(15);
  });

  it("boundary: exactly 15 does not trigger (threshold is >15)", () => {
    // live: 40% very-low + 60% low = 40+45=85. curated: 100% very-low = 100. delta=15.
    const live: ReserveSlice[] = [
      { name: "A", pct: 40, risk: "very-low" },
      { name: "B", pct: 60, risk: "low" },
    ];
    const curated: ReserveSlice[] = [{ name: "A", pct: 100, risk: "very-low" }];
    expect(computeDelta(live, curated)).toBe(15);
  });

  it("skips one-slice live snapshots in the drift watch", () => {
    const stablecoins = [{
      id: "tusd-trueusd",
      reserves: [{ name: "Opaque fund investments", pct: 99, risk: "very-high" }],
      liveReservesConfig: { adapter: "chainlink-por" },
    }] as unknown as StablecoinMeta[];

    const result = summarizeCollateralDriftFromLiveReserveMap(
      new Map<string, ReserveSlice[]>([
        ["tusd-trueusd", [{ name: "USD reserves", pct: 100, risk: "very-low" }]],
      ]),
      stablecoins,
    );

    expect(result.driftCoins).toEqual([]);
    expect(result.fallbackCoins).toEqual([]);
  });

  it("still reports drift for comparable multi-slice live mixes", () => {
    const stablecoins = [{
      id: "nusd-neutrl",
      reserves: [
        { name: "Basis trades", pct: 60, risk: "high" },
        { name: "Stablecoins", pct: 20, risk: "low" },
        { name: "OTC", pct: 20, risk: "high" },
      ],
      liveReservesConfig: { adapter: "accountable" },
    }] as unknown as StablecoinMeta[];

    const result = summarizeCollateralDriftFromLiveReserveMap(
      new Map<string, ReserveSlice[]>([
        ["nusd-neutrl", [
          { name: "Stablecoins", pct: 93.7, risk: "low" },
          { name: "OTC", pct: 3.4, risk: "high" },
          { name: "Other", pct: 2.9, risk: "high" },
        ]],
      ]),
      stablecoins,
    );

    expect(result.driftCoins).toMatchObject([
      {
        id: "nusd-neutrl",
        liveScore: 72,
        curatedScore: 35,
        delta: 37,
      },
    ]);
  });
});
