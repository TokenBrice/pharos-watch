import { describe, expect, it } from "vitest";
import {
  buildFxLookup,
  extractDepegEvents,
  findNearestSupply,
  parseSupplyData,
} from "../backfill-depegs";

describe("parseSupplyData", () => {
  it("ignores invalid dates and returns sorted snapshots", () => {
    const parsed = parseSupplyData([
      { date: "200", circulating: { peggedUSD: 20 } },
      { date: "invalid", circulating: { peggedUSD: 10 } },
      { date: "100", circulating: { peggedUSD: 30 } },
      { date: "100", circulating: { peggedUSD: 40 } },
    ]);

    expect(parsed).toEqual([
      { ts: 100, supply: 40 },
      { ts: 200, supply: 20 },
    ]);
  });
});

describe("findNearestSupply", () => {
  it("returns nearest supply snapshot by timestamp", () => {
    const supply = [
      { ts: 1_000, supply: 10 },
      { ts: 2_000, supply: 20 },
      { ts: 3_000, supply: 30 },
    ];

    expect(findNearestSupply(supply, 2_400)).toBe(20);
    expect(findNearestSupply(supply, 2_700)).toBe(30);
  });

  it("returns null when supply history is empty", () => {
    expect(findNearestSupply([], 1_000)).toBeNull();
  });
});

describe("buildFxLookup", () => {
  it("falls back to static rate when no series is available", () => {
    const lookup = buildFxLookup([], 1.11);
    expect(lookup(1_700_000_000)).toBe(1.11);
  });

  it("returns nearest historical rate when a series is available", () => {
    const lookup = buildFxLookup(
      [
        { timestamp: 1_000, rate: 1.0 },
        { timestamp: 2_000, rate: 1.2 },
      ],
      1.5,
    );
    expect(lookup(1_750)).toBe(1.2);
  });
});

describe("extractDepegEvents", () => {
  it("requires confirmation for large-cap assets", () => {
    const events = extractDepegEvents(
      [
        { timestamp: 1_000, price: 1.02 },
        { timestamp: 2_000, price: 1.03 },
        { timestamp: 3_000, price: 1.0 },
      ],
      () => 1,
      "peggedUSD",
      [{ ts: 1_000, supply: 2_000_000_000 }],
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "above",
      startedAt: 1_000,
      endedAt: 3_000,
      startPrice: 1.02,
      peakPrice: 1.03,
      recoveryPrice: 1.0,
    });
  });

  it("does not promote pending large-cap event when points are too far apart", () => {
    const events = extractDepegEvents(
      [
        { timestamp: 1_000, price: 1.02 },
        { timestamp: 1_000 + 7 * 3_600, price: 1.03 },
        { timestamp: 1_000 + 7 * 3_600 + 100, price: 1.0 },
      ],
      () => 1,
      "peggedUSD",
      [{ ts: 1_000, supply: 2_000_000_000 }],
    );

    expect(events).toEqual([]);
  });

  it("starts immediately for small-cap assets", () => {
    const events = extractDepegEvents(
      [
        { timestamp: 1_000, price: 0.98 },
        { timestamp: 1_500, price: 1.0 },
      ],
      () => 1,
      "peggedUSD",
      [{ ts: 1_000, supply: 200_000_000 }],
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "below",
      startedAt: 1_000,
      endedAt: 1_500,
      startPrice: 0.98,
      recoveryPrice: 1.0,
    });
  });
});
