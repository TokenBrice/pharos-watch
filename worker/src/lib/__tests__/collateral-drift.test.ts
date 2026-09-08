import { describe, it, expect } from "vitest";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { summarizeCollateralDriftFromLiveReserveMap } from "../collateral-drift";

describe("collateral score delta detection", () => {
  it.each([
    { pct: 44, expected: [] },
    { pct: 40, expected: [] },
    { pct: 36, expected: [{ id: "drift-coin", liveScore: 84, curatedScore: 100, delta: 16 }] },
  ])("applies the strict drift threshold with $pct percent very-low collateral", ({ pct, expected }) => {
    const live: ReserveSlice[] = [
      { name: "Treasuries", pct, risk: "very-low" },
      { name: "Stablecoins", pct: 100 - pct, risk: "low" },
    ];
    const stablecoins = [{
      id: "drift-coin",
      reserves: [{ name: "Treasuries", pct: 100, risk: "very-low" }],
      liveReservesConfig: { adapter: "accountable" },
    }] as unknown as StablecoinMeta[];
    expect(summarizeCollateralDriftFromLiveReserveMap(new Map([["drift-coin", live]]), stablecoins))
      .toEqual({ driftCoins: expected, fallbackCoins: [] });
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
