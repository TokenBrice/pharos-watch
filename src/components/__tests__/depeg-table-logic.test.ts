import { describe, expect, it } from "vitest";
import {
  compareDepegTrackerRows,
  type DepegTableSortKey,
} from "@/components/depeg-table-logic";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import type { PegSummaryCoin, StressSignalEntry } from "@shared/types";
import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { makeDews, makePendingIncident } from "./depeg.test-support";
import { NUMERIC_INPUT_STATES } from "@shared/test-utils/boundary-contract-vectors.test-support";


function makeRow(
  coinOverrides: Partial<PegSummaryCoin> = {},
  dews: StressSignalEntry | null = null,
): DepegTrackerRow {
  return {
    coin: makePegSummaryCoin({ id: "usdc", pegScore: 100, trackingSpanDays: 90, ...coinOverrides }),
    dews,
  };
}

const sort = (key: DepegTableSortKey, direction: "asc" | "desc" = "desc"): TableSortState<DepegTableSortKey> => ({
  key,
  direction,
});
const observedValues = NUMERIC_INPUT_STATES.flatMap(({ state, value }) =>
  state === "zero" || state === "positive" ? [value] : [],
);

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

  it("places pending rows ahead of ordinary DEWS warning rows", () => {
    const pending = makeRow({ activeDepeg: false }, makeDews({ band: "CALM" }));
    pending.pendingIncident = makePendingIncident({ stablecoinId: "usdc", symbol: "USDC" });
    const warning = makeRow({ activeDepeg: false }, makeDews({ band: "WARNING", score: 70 }));
    const result = compareDepegTrackerRows(pending, warning, sort("__attention"));
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

  it("reverses attention ordering when sorted ascending", () => {
    const active = makeRow({ activeDepeg: true });
    const inactive = makeRow({ activeDepeg: false });
    const result = compareDepegTrackerRows(active, inactive, sort("__attention", "asc"));
    expect(result).toBeGreaterThan(0);
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

  it.each(["asc", "desc"] as const)("sorts unknown peg health last in %s order, after observed zero and nonzero scores", (direction) => {
    const unknown = makeRow({ pegScore: null });
    for (const value of observedValues) {
      const observed = makeRow({ pegScore: value });
      expect(compareDepegTrackerRows(unknown, observed, sort("pegScore", direction))).toBeGreaterThan(0);
      expect(compareDepegTrackerRows(observed, unknown, sort("pegScore", direction))).toBeLessThan(0);
    }
  });
});

describe("compareDepegTrackerRows — dewsScore", () => {
  it("sorts by dews score descending", () => {
    const high = makeRow({}, makeDews({ score: 80 }));
    const low = makeRow({}, makeDews({ score: 10 }));
    const result = compareDepegTrackerRows(high, low, sort("dewsScore", "desc"));
    expect(result).toBeLessThan(0);
  });

  it.each(["asc", "desc"] as const)("sorts unknown DEWS last in %s order, after observed zero and nonzero scores", (direction) => {
    const unknown = makeRow({}, null);
    for (const value of observedValues) {
      const observed = makeRow({}, makeDews({ score: value }));
      expect(compareDepegTrackerRows(unknown, observed, sort("dewsScore", direction))).toBeGreaterThan(0);
      expect(compareDepegTrackerRows(observed, unknown, sort("dewsScore", direction))).toBeLessThan(0);
    }
  });
});

describe("compareDepegTrackerRows — currentDeviationBps", () => {
  it("sorts by abs deviation descending", () => {
    const big = makeRow({ currentDeviationBps: -200 });
    const small = makeRow({ currentDeviationBps: 50 });
    const result = compareDepegTrackerRows(big, small, sort("currentDeviationBps", "desc"));
    expect(result).toBeLessThan(0); // |big| = 200 > |small| = 50
  });

  it.each(["asc", "desc"] as const)("sorts unknown deviation last in %s order, after observed zero and nonzero deviations", (direction) => {
    const unknown = makeRow({ currentDeviationBps: null });
    for (const value of [...observedValues, -20]) {
      const observed = makeRow({ currentDeviationBps: value });
      expect(compareDepegTrackerRows(unknown, observed, sort("currentDeviationBps", direction))).toBeGreaterThan(0);
      expect(compareDepegTrackerRows(observed, unknown, sort("currentDeviationBps", direction))).toBeLessThan(0);
    }
  });
});

describe("compareDepegTrackerRows — pegPct", () => {
  it.each(["asc", "desc"] as const)("sorts unknown occupancy last in %s order without equating it to zero", (direction) => {
    const unknown = makeRow({ pegPct: null });
    const zero = makeRow({ pegPct: 0 });
    const perfect = makeRow({ pegPct: 100 });
    expect(compareDepegTrackerRows(unknown, zero, sort("pegPct", direction))).toBeGreaterThan(0);
    expect(compareDepegTrackerRows(unknown, perfect, sort("pegPct", direction))).toBeGreaterThan(0);
  });
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

  it.each(["asc", "desc"] as const)("sorts unknown worst deviation last in %s order", (direction) => {
    const unknown = makeRow({ worstDeviationBps: null });
    for (const value of [...observedValues, -100]) {
      const observed = makeRow({ worstDeviationBps: value });
      expect(compareDepegTrackerRows(unknown, observed, sort("worstDeviationBps", direction))).toBeGreaterThan(0);
    }
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
