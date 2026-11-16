import { describe, expect, it } from "vitest";
import { extractDepegEvents, type SupplySnapshot } from "../historical-depeg-extraction";
import type { PricePoint } from "../historical-market-prices";

const SUPPLY: SupplySnapshot[] = [{ ts: 1_000, supply: 6_000_000 }];

function points(prices: readonly number[]): PricePoint[] {
  return prices.map((price, index) => ({ timestamp: 1_000 + index * 3_600, price }));
}

// Friday 21:00 UTC with FX closed, then Wednesday 21:00 UTC with FX trading.
it.each([[1_794_603_600, 0], [1_794_430_800, 1]])("holds sub-severe EUR readings while FX is closed (%s)", (start, expected) => {
  const series = [1.12, 1.12, 1.12, 1.16].map((price, index) => ({ timestamp: start + index * 3_600, price }));
  expect(extractDepegEvents(series, () => 1.16, "peggedEUR", [{ ts: start, supply: 6_000_000 }])).toHaveLength(expected);
});

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

  it("does not publish a lone onset wick between par readings as the peak", () => {
    const events = extractDepegEvents(
      points([1, 0.85, 1]),
      () => 1,
      "peggedUSD",
      SUPPLY,
    );

    expect(events).toEqual([]);
  });

  it("does not publish an above-peg lone onset print between par readings", () => {
    const events = extractDepegEvents(
      points([1, 1.05, 1]),
      () => 1,
      "peggedUSD",
      SUPPLY,
    );

    expect(events).toEqual([]);
  });

  it("does not publish a large-cap onset wick confirmed only by a near-par reading", () => {
    const events = extractDepegEvents(
      points([1, 0.85, 0.985, 1]),
      () => 1,
      "peggedUSD",
      [{ ts: 1_000, supply: 2_000_000_000 }],
    );

    expect(events).toEqual([]);
  });

  it("publishes the first corroborated sample when the onset print is not corroborated", () => {
    const events = extractDepegEvents(
      points([0.85, 0.97, 0.96, 1]),
      () => 1,
      "peggedUSD",
      SUPPLY,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "below",
      startedAt: 1_000 + 3_600,
      endedAt: 1_000 + 3 * 3_600,
      startPrice: 0.97,
      peakPrice: 0.96,
      peakDeviationBps: -400,
      recoveryPrice: 1,
    });
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
