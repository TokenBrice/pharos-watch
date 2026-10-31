import { describe, expect, it } from "vitest";
import { extractDepegEvents, type SupplySnapshot } from "../historical-depeg-extraction";
import type { PricePoint } from "../historical-market-prices";

const SUPPLY: SupplySnapshot[] = [{ ts: 1_000, supply: 6_000_000 }];

function points(prices: readonly number[]): PricePoint[] {
  return prices.map((price, index) => ({ timestamp: 1_000 + index * 3_600, price }));
}

describe("extractDepegEvents peak corroboration", () => {
  it("does not absorb an isolated single-sample trough into an open event's peak", () => {
    // USDC 2018-10-04 shape: one 0.786 print between 0.937 and 0.981.
    const events = extractDepegEvents(
      points([0.958, 0.937, 0.786, 0.981, 0.992]),
      () => 1,
      "peggedUSD",
      SUPPLY,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "below",
      startedAt: 1_000,
      endedAt: 1_000 + 4 * 3_600,
      peakPrice: 0.937,
      peakDeviationBps: -630,
      recoveryPrice: 0.992,
    });
  });

  it("absorbs a deeper sample when a neighbouring sample corroborates it", () => {
    const events = extractDepegEvents(
      points([0.96, 0.94, 0.9, 0.89, 0.995]),
      () => 1,
      "peggedUSD",
      SUPPLY,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "below",
      startedAt: 1_000,
      peakPrice: 0.89,
      peakDeviationBps: -1_100,
    });
  });

  it("still admits an opening single-sample event (the pinned one-point onset policy)", () => {
    const events = extractDepegEvents(
      points([0.98, 1]),
      () => 1,
      "peggedUSD",
      SUPPLY,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ startedAt: 1_000, peakPrice: 0.98 });
  });

  it("does not absorb a wick that arrives while a large-cap event is pending confirmation", () => {
    const events = extractDepegEvents(
      points([1.02, 1.15, 1.021, 1.0]),
      () => 1,
      "peggedUSD",
      [{ ts: 1_000, supply: 2_000_000_000 }],
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ direction: "above", peakDeviationBps: 210 });
  });
});
