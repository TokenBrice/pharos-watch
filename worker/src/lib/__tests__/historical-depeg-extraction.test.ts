import { describe, expect, it } from "vitest";
import { extractDepegEvents, parseSupplyData, type SupplySnapshot } from "../historical-depeg-extraction";
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
  it("blocks an older supply from carrying across a rejected USD checkpoint", () => {
    const day = 86_400;
    const quotes = points([1, 1.02, 1.03, 1]).map((point) => ({ ...point, timestamp: point.timestamp + 5 * day }));
    const boundary = quotes[0]!.timestamp - day;
    const rejected = { date: String(boundary), totalCirculatingUSD: { peggedUSD: -1 }, totalCirculating: { peggedUSD: 910_000 } };
    const valid = { date: rejected.date, totalCirculatingUSD: { peggedUSD: 1_200_000 } };
    const history = [
      { date: String(boundary - 3 * day), totalCirculatingUSD: { peggedUSD: 1_200_000 } },
      { date: String(boundary + 2 * day), totalCirculatingUSD: { peggedUSD: 900_000 } },
    ];
    const run = (...rows: typeof history) => extractDepegEvents(quotes, () => 1, "peggedUSD", parseSupplyData([...history, ...rows]));
    expect(run()).toMatchObject([{ peakDeviationBps: 300 }]);
    expect(run(rejected)).toEqual([]);
    expect(run(rejected, valid)).toHaveLength(1);
    expect(run(valid, rejected)).toHaveLength(1);
  });

  it("blocks supply carry at a rejected native checkpoint while preserving valid same-time readings", () => {
    const quotes = points([1, 1.02, 1.03, 1]);
    const date = "950";
    const history = [{ date: "900", totalCirculatingUSD: { peggedUSD: 1_200_000 } }];
    const run = (...rows: Parameters<typeof parseSupplyData>[0]) => {
      const supply = parseSupplyData([...history, ...rows]);
      return { checkpoint: supply.find(({ ts }) => ts === Number(date)),
        events: extractDepegEvents(quotes, () => 1, "peggedUSD", supply) };
    };
    const valid = { date, totalCirculatingUSD: { peggedUSD: 1_200_000 } };
    for (const rejected of [{ date, totalCirculating: { peggedUSD: -1 } }, { date, circulating: { peggedUSD: -1 } }]) {
      expect(run(rejected)).toEqual({ checkpoint: { ts: 950, supply: null }, events: [] });
      expect(run(rejected, valid).events).toMatchObject([{ peakDeviationBps: 300 }]);
      expect(run(valid, rejected).events).toMatchObject([{ peakDeviationBps: 300 }]);
    }
    expect(run({ date, totalCirculating: { peggedUSD: 0 } })).toEqual({ checkpoint: { ts: 950, supply: 0 }, events: [] });
  });

  it("does not let an older large market cap cross a newer commodity supply boundary", () => {
    const at = Date.parse("2026-11-18T12:00:00Z") / 1000;
    const boundary = at - 86400;
    const tokens = [
      { date: String(at - 4 * 86400), totalCirculatingUSD: { peggedGOLD: 2_000_000 } },
      { date: String(boundary), totalCirculating: { peggedGOLD: 10 } },
    ];
    const quotes = [3880, 3880, 4000].map((price, index) => ({ timestamp: at + index * 3600, price }));
    const run = (snapshots: SupplySnapshot[]) => extractDepegEvents(quotes, () => 4_000, "peggedGOLD", snapshots);
    expect(run(parseSupplyData(tokens.slice(0, 1)))).toHaveLength(1);
    for (const equivalentLookup of [(ts: number) => ts === boundary ? 4_000 : null, () => 4_000]) {
      expect(run(parseSupplyData(tokens, equivalentLookup))).toEqual([]);
    }
    const missing = parseSupplyData(tokens);
    expect(missing[missing.length - 1]).toEqual({ ts: boundary, supply: null });
    expect(run(missing)).toEqual([]);
  });

  it.each([["JPY", 1.5071416], ["BRL", 1.23]] as const)(
    "requires a dated independently traded %s premium before admitting the peak",
    (currency, price) => {
      const series = points([1, price, price, 1]).map((point) => ({ ...point, timestamp: point.timestamp + 1_800_000_000 }));
      const snapshots = [{ ts: series[0]!.timestamp, supply: 6_000_000 }];
      const run = (corroboration?: (timestamp: number) => PricePoint) => extractDepegEvents(
        series, () => 1, `pegged${currency}`, snapshots, {}, undefined,
        { admitReference: () => true, fiatCorroborationAt: corroboration },
      );
      const independent = (timestamp: number): PricePoint => ({
        timestamp, price, nativeQuote: { currency, derivation: { kind: "traded-pair", lineage: { venue: "venue", pair: `TOKEN/${currency}` } } },
      });
      expect(run()).toHaveLength(0);
      expect(run((timestamp) => independent(timestamp + 1))).toHaveLength(0);
      expect(run(independent)).toMatchObject([{ peakPrice: price }]);
    },
  );
  it.each([1.00996, 0.99004])("does not round %s across the USD threshold", (price) => {
    expect(extractDepegEvents(points([1, price, price, 1]), () => 1, "peggedUSD", SUPPLY)).toEqual([]);
  });

  it("keeps a USD episode open between entry and recovery thresholds", () => {
    const series = points([1, 1.02, 1.03, 1.008, 1]);
    const observations: (string | null)[] = [];
    const events = extractDepegEvents(series, () => 1, "peggedUSD", SUPPLY, {}, undefined, {
      onEvaluated: (_, state) => observations.push(state),
    });
    expect(events).toMatchObject([{ startedAt: series[1]!.timestamp, endedAt: series[4]!.timestamp, recoveryPrice: 1,
      admittedCoverage: [{ fromSec: series[1]!.timestamp, toSec: series[3]!.timestamp }] }]);
    expect(observations).toEqual(["in-band", "above", "above", "intermediate", "in-band"]);
  });

  it("closes at both exact USD recovery boundaries and keeps an outside print open", () => {
    for (const [peak, endPrice, recovered] of [
      [0.97, 0.995, true], [1.03, 1.005, true], [0.97, 0.9950001, true], [0.97, 0.9949999, false],
    ] as const) {
      const series = points([1, peak, peak, endPrice]);
      const [event] = extractDepegEvents(series, () => 1, "peggedUSD", SUPPLY);
      expect(event?.endedAt).toBe(recovered ? series[3]!.timestamp : null);
    }
  });

  it.each([false, true])("retimes the opening price and denominator together (pending=%s)", (forceConfirmation) => {
    const series = points([0.8, 1.045, 1.045, 1.1]).map((point) => ({ ...point, timestamp: point.timestamp + 1_800_000_000 }));
    const start = series[0]!.timestamp;
    const replacement = series[1]!.timestamp;
    expect(extractDepegEvents(series, (ts) => ts === start ? 1 : 1.1, "peggedEUR",
      [{ ts: start, supply: 6_000_000 }], {}, undefined, { forceConfirmation, admitReference: () => true }))
      .toMatchObject([{ startedAt: replacement, startPrice: 1.045, pegRef: 1.1, peakDeviationBps: -500 }]);
  });

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
      endedAt: null,
      peakPrice: 0.937,
      peakDeviationBps: -630,
      recoveryPrice: null,
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
