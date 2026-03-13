import { describe, expect, it } from "vitest";
import {
  compareDepegTrackerRows,
  rowAccentClass,
  type DepegTableSortKey,
} from "@/components/depeg-table-logic";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import type { PegSummaryCoin, StressSignalEntry } from "@shared/types";
import type { TableSortState } from "@/hooks/use-sorted-table-rows";

function makeCoin(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return {
    id: "usdc",
    symbol: "USDC",
    name: "USD Coin",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    pegScore: 100,
    pegPct: 100,
    severityScore: 0,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: null,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 90,
    methodologyVersion: "v1",
    dexPriceCheck: null,
    ...overrides,
  };
}

function makeDews(overrides: Partial<StressSignalEntry> = {}): StressSignalEntry {
  return {
    score: 0,
    band: "CALM",
    signals: {},
    computedAt: 0,
    methodologyVersion: "v1",
    ...overrides,
  };
}

function makeRow(
  coinOverrides: Partial<PegSummaryCoin> = {},
  dews: StressSignalEntry | null = null,
): DepegTrackerRow {
  return {
    coin: makeCoin(coinOverrides),
    dews,
  };
}

const sort = (key: DepegTableSortKey, direction: "asc" | "desc" = "desc"): TableSortState<DepegTableSortKey> => ({
  key,
  direction,
});

describe("rowAccentClass", () => {
  it("returns red border for active depeg", () => {
    const row = makeRow({ activeDepeg: true });
    expect(rowAccentClass(row)).toBe("border-l-[3px] border-l-red-500");
  });

  it("returns orange border for WARNING band", () => {
    const row = makeRow({ activeDepeg: false }, makeDews({ band: "WARNING" }));
    expect(rowAccentClass(row)).toBe("border-l-[3px] border-l-orange-500");
  });

  it("returns orange border for DANGER band", () => {
    const row = makeRow({ activeDepeg: false }, makeDews({ band: "DANGER" }));
    expect(rowAccentClass(row)).toBe("border-l-[3px] border-l-orange-500");
  });

  it("returns empty string for CALM band with no active depeg", () => {
    const row = makeRow({ activeDepeg: false }, makeDews({ band: "CALM" }));
    expect(rowAccentClass(row)).toBe("");
  });

  it("returns empty string when dews is null", () => {
    const row = makeRow({ activeDepeg: false }, null);
    expect(rowAccentClass(row)).toBe("");
  });
});

describe("compareDepegTrackerRows — __attention sort", () => {
  it("places active depeg rows first", () => {
    const activeRow = makeRow({ activeDepeg: true, currentDeviationBps: 50 });
    const normalRow = makeRow({ activeDepeg: false, currentDeviationBps: 50 });
    const result = compareDepegTrackerRows(activeRow, normalRow, sort("__attention"));
    // attentionScore(activeRow) >> attentionScore(normalRow)
    // sort key __attention: returns attentionScore(b) - attentionScore(a)
    // a=activeRow has higher score → b - a < 0 → activeRow ranks first
    expect(result).toBeLessThan(0);
  });

  it("places higher DEWS band before lower", () => {
    const danger = makeRow({}, makeDews({ band: "DANGER" }));
    const calm = makeRow({}, makeDews({ band: "CALM" }));
    const result = compareDepegTrackerRows(danger, calm, sort("__attention"));
    expect(result).toBeLessThan(0);
  });

  it("uses attention score for default/unknown sort keys too", () => {
    const active = makeRow({ activeDepeg: true });
    const inactive = makeRow({ activeDepeg: false });
    const result = compareDepegTrackerRows(active, inactive, sort("unknown" as DepegTableSortKey));
    expect(result).toBeLessThan(0);
  });
});

describe("compareDepegTrackerRows — pegScore", () => {
  it("sorts by pegScore descending", () => {
    const high = makeRow({ pegScore: 95 });
    const low = makeRow({ pegScore: 40 });
    const result = compareDepegTrackerRows(high, low, sort("pegScore", "desc"));
    expect(result).toBeLessThan(0); // high ranks first
  });

  it("sorts by pegScore ascending", () => {
    const high = makeRow({ pegScore: 95 });
    const low = makeRow({ pegScore: 40 });
    const result = compareDepegTrackerRows(high, low, sort("pegScore", "asc"));
    expect(result).toBeGreaterThan(0); // low ranks first
  });

  it("treats null pegScore as -1 (worst)", () => {
    const withScore = makeRow({ pegScore: 50 });
    const nullScore = makeRow({ pegScore: null });
    const result = compareDepegTrackerRows(withScore, nullScore, sort("pegScore", "desc"));
    expect(result).toBeLessThan(0); // withScore ranks first
  });
});

describe("compareDepegTrackerRows — dewsScore", () => {
  it("sorts by dews score descending", () => {
    const high = makeRow({}, makeDews({ score: 80 }));
    const low = makeRow({}, makeDews({ score: 10 }));
    const result = compareDepegTrackerRows(high, low, sort("dewsScore", "desc"));
    expect(result).toBeLessThan(0);
  });

  it("treats null dews as -1", () => {
    const hasScore = makeRow({}, makeDews({ score: 50 }));
    const noDews = makeRow({}, null);
    const result = compareDepegTrackerRows(hasScore, noDews, sort("dewsScore", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareDepegTrackerRows — currentDeviationBps", () => {
  it("sorts by abs deviation descending", () => {
    const big = makeRow({ currentDeviationBps: -200 });
    const small = makeRow({ currentDeviationBps: 50 });
    const result = compareDepegTrackerRows(big, small, sort("currentDeviationBps", "desc"));
    expect(result).toBeLessThan(0); // |big| = 200 > |small| = 50
  });

  it("treats null deviation as 0", () => {
    const hasDeviation = makeRow({ currentDeviationBps: 100 });
    const nullDeviation = makeRow({ currentDeviationBps: null });
    const result = compareDepegTrackerRows(hasDeviation, nullDeviation, sort("currentDeviationBps", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareDepegTrackerRows — pegPct", () => {
  it("sorts by peg percentage", () => {
    const high = makeRow({ pegPct: 98 });
    const low = makeRow({ pegPct: 75 });
    const result = compareDepegTrackerRows(high, low, sort("pegPct", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareDepegTrackerRows — eventCount", () => {
  it("sorts by event count descending", () => {
    const many = makeRow({ eventCount: 15 });
    const few = makeRow({ eventCount: 2 });
    const result = compareDepegTrackerRows(many, few, sort("eventCount", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareDepegTrackerRows — worstDeviationBps", () => {
  it("sorts by abs worst deviation descending", () => {
    const worst = makeRow({ worstDeviationBps: -500 });
    const mild = makeRow({ worstDeviationBps: 100 });
    const result = compareDepegTrackerRows(worst, mild, sort("worstDeviationBps", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareDepegTrackerRows — activeDepeg", () => {
  it("sorts active depeg first in descending", () => {
    const active = makeRow({ activeDepeg: true });
    const inactive = makeRow({ activeDepeg: false });
    const result = compareDepegTrackerRows(active, inactive, sort("activeDepeg", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareDepegTrackerRows — dexAgrees", () => {
  it("sorts dexAgrees true first in descending", () => {
    const agrees = makeRow({ dexPriceCheck: { agrees: true, dexPrice: 1, dexDeviationBps: 0, sourcePools: 1, sourceTvl: 1 } });
    const disagrees = makeRow({ dexPriceCheck: { agrees: false, dexPrice: 0.98, dexDeviationBps: 200, sourcePools: 1, sourceTvl: 1 } });
    const result = compareDepegTrackerRows(agrees, disagrees, sort("dexAgrees", "desc"));
    expect(result).toBeLessThan(0);
  });
});

describe("compareDepegTrackerRows — trackingSpanDays", () => {
  it("sorts by tracking span descending", () => {
    const long = makeRow({ trackingSpanDays: 365 });
    const short = makeRow({ trackingSpanDays: 7 });
    const result = compareDepegTrackerRows(long, short, sort("trackingSpanDays", "desc"));
    expect(result).toBeLessThan(0);
  });
});
