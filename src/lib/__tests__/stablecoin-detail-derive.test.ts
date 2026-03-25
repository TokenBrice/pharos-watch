import { describe, expect, it } from "vitest";
import {
  deriveDeviationBps,
  deriveGaugeDeviationBps,
  derivePegReferenceContext,
  derivePrev90dReferenceMcap,
  deriveSupplyFromMarketCap,
} from "../stablecoin-detail-derive";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("stablecoin detail derivations", () => {
  describe("deriveDeviationBps", () => {
    it("computes basis points from price and peg reference", () => {
      expect(deriveDeviationBps(1.0125, 1)).toBe(125);
      expect(deriveDeviationBps(0.9975, 1)).toBe(-25);
    });

    it("returns 0 when price is missing or peg reference is invalid", () => {
      expect(deriveDeviationBps(null, 1)).toBe(0);
      expect(deriveDeviationBps(undefined, 1)).toBe(0);
      expect(deriveDeviationBps(1.01, 0)).toBe(0);
      expect(deriveDeviationBps(1.01, -1)).toBe(0);
    });

    it("forces gauge deviation to zero for NAV tokens", () => {
      expect(deriveGaugeDeviationBps(240, true)).toBe(0);
      expect(deriveGaugeDeviationBps(240, false)).toBe(240);
    });
  });

  describe("derivePrev90dReferenceMcap", () => {
    it("selects the closest datapoint to the 90d target", () => {
      const nowMs = Date.UTC(2026, 2, 1, 0, 0, 0);
      const targetMs = nowMs - 90 * DAY_MS;
      const history = [
        { date: targetMs - DAY_MS, circulatingUsd: 95 },
        { date: targetMs + 2 * DAY_MS, circulatingUsd: 110 },
        { date: targetMs + 6 * DAY_MS, circulatingUsd: 120 },
      ];

      expect(derivePrev90dReferenceMcap(history, nowMs)).toBe(95);
    });

    it("returns zero when no point is within the 7d tolerance window", () => {
      const nowMs = Date.UTC(2026, 2, 1, 0, 0, 0);
      const targetMs = nowMs - 90 * DAY_MS;
      const history = [
        { date: targetMs - 10 * DAY_MS, circulatingUsd: 90 },
        { date: targetMs + 12 * DAY_MS, circulatingUsd: 110 },
      ];

      expect(derivePrev90dReferenceMcap(history, nowMs)).toBe(0);
    });
  });

  describe("deriveSupplyFromMarketCap", () => {
    it("uses marketCap / price when price is positive", () => {
      expect(deriveSupplyFromMarketCap(250_000_000, 2.5)).toBe(100_000_000);
    });

    it("returns null when price is missing or non-positive", () => {
      expect(deriveSupplyFromMarketCap(250_000_000, null)).toBeNull();
      expect(deriveSupplyFromMarketCap(250_000_000, 0)).toBeNull();
    });

    it("returns null when market cap is missing or non-positive", () => {
      expect(deriveSupplyFromMarketCap(null, 1)).toBeNull();
      expect(deriveSupplyFromMarketCap(undefined, 1)).toBeNull();
      expect(deriveSupplyFromMarketCap(0, 1)).toBeNull();
    });
  });

  describe("derivePegReferenceContext", () => {
    it("uses fallback FX rates for thin peg groups and reports fallback source", () => {
      const assets = [
        { id: "usdt-tether", symbol: "AAA", pegType: "peggedEUR", price: 1.25, circulating: { peggedEUR: 2_000_000 } },
        { id: "usdc-circle", symbol: "BBB", pegType: "peggedEUR", price: 1.24, circulating: { peggedEUR: 3_000_000 } },
      ];

      const result = derivePegReferenceContext({
        assets,
        pegType: "peggedEUR",
        fallbackRates: { peggedEUR: 1.1 },
      });

      expect(result.pegReference).toBe(1.1);
      expect(result.pegRateSource).toBe("fallback");
    });

    it("falls back to 1 when peg type is missing", () => {
      const result = derivePegReferenceContext({
        assets: [],
        pegType: undefined,
      });

      expect(result.pegReference).toBe(1);
      expect(result.pegRateSource).toBeUndefined();
    });
  });
});

describe("deriveSupplyFromMarketCap", () => {
  it("divides market cap by price", () => {
    expect(deriveSupplyFromMarketCap(1_000_000, 1.0)).toBe(1_000_000);
    expect(deriveSupplyFromMarketCap(2_000_000, 0.5)).toBe(4_000_000);
  });

  it("returns null for zero or negative price", () => {
    expect(deriveSupplyFromMarketCap(1_000_000, 0)).toBeNull();
    expect(deriveSupplyFromMarketCap(1_000_000, -1)).toBeNull();
  });

  it("returns null for zero or negative market cap", () => {
    expect(deriveSupplyFromMarketCap(0, 1.0)).toBeNull();
    expect(deriveSupplyFromMarketCap(-100, 1.0)).toBeNull();
  });

  it("returns null for non-number inputs", () => {
    expect(deriveSupplyFromMarketCap(null, 1.0)).toBeNull();
    expect(deriveSupplyFromMarketCap(undefined, 1.0)).toBeNull();
  });
});

describe("deriveDeviationBps", () => {
  it("returns 0 bps for exact peg", () => {
    expect(deriveDeviationBps(1.0, 1.0)).toBe(0);
  });

  it("returns positive bps for price above peg", () => {
    expect(deriveDeviationBps(1.01, 1.0)).toBeCloseTo(100, 0);
  });

  it("returns negative bps for price below peg", () => {
    expect(deriveDeviationBps(0.99, 1.0)).toBeCloseTo(-100, 0);
  });

  it("returns 0 for invalid peg reference", () => {
    expect(deriveDeviationBps(1.0, 0)).toBe(0);
    expect(deriveDeviationBps(1.0, NaN)).toBe(0);
  });

  it("returns 0 for null price", () => {
    expect(deriveDeviationBps(null, 1.0)).toBe(0);
  });
});

describe("deriveGaugeDeviationBps", () => {
  it("returns 0 for NAV tokens", () => {
    expect(deriveGaugeDeviationBps(150, true)).toBe(0);
  });

  it("passes through deviation for non-NAV tokens", () => {
    expect(deriveGaugeDeviationBps(50, false)).toBe(50);
    expect(deriveGaugeDeviationBps(-30, false)).toBe(-30);
  });
});

describe("derivePrev90dReferenceMcap", () => {
  const NOW_MS = Date.now();
  const DAY_MS_LOCAL = 86_400_000;
  const NINETY_DAYS_MS = 90 * DAY_MS_LOCAL;

  it("finds closest entry to 90 days ago", () => {
    const history = [
      { date: NOW_MS - NINETY_DAYS_MS, circulatingUsd: 5_000_000 },
      { date: NOW_MS - 30 * DAY_MS_LOCAL, circulatingUsd: 8_000_000 },
      { date: NOW_MS, circulatingUsd: 10_000_000 },
    ];
    expect(derivePrev90dReferenceMcap(history, NOW_MS)).toBe(5_000_000);
  });

  it("returns 0 for empty history", () => {
    expect(derivePrev90dReferenceMcap([], NOW_MS)).toBe(0);
  });

  it("returns 0 when closest entry exceeds tolerance", () => {
    const history = [
      { date: NOW_MS - 120 * DAY_MS_LOCAL, circulatingUsd: 5_000_000 },
    ];
    expect(derivePrev90dReferenceMcap(history, NOW_MS)).toBe(0);
  });
});
