import { describe, expect, it } from "vitest";
import {
  compareDepegTrackerRows,
  type DepegTableSortKey,
} from "@/components/depeg/depeg-table-logic";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { StressSignalEntry } from "@shared/types/stress";
import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { makeDews } from "./depeg.test-support";
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

describe("compareDepegTrackerRows — numeric field keys", () => {
  // The comparator is shared and covered centrally; one row per extractor pins this module's field
  // mapping and its absolute transforms. Null handling stays in the per-key cases below.
  it.each([
    ["pegScore", "desc", { pegScore: 95 }, { pegScore: 40 }],
    ["pegScore", "asc", { pegScore: 40 }, { pegScore: 95 }],
    ["pegPct", "desc", { pegPct: 98 }, { pegPct: 75 }],
    ["eventCount", "desc", { eventCount: 15 }, { eventCount: 2 }],
    ["trackingSpanDays", "desc", { trackingSpanDays: 365 }, { trackingSpanDays: 7 }],
    ["currentDeviationBps", "desc", { currentDeviationBps: -200 }, { currentDeviationBps: 50 }],
    ["worstDeviationBps", "desc", { worstDeviationBps: -500 }, { worstDeviationBps: 100 }],
  ] as const)("ranks %s %s by its own extractor, absolute where signed", (key, direction, first, second) => {
    expect(compareDepegTrackerRows(makeRow(first), makeRow(second), sort(key, direction))).toBeLessThan(0);
  });
});

describe.each([
  ["pegScore", makeRow({ pegScore: null }), observedValues.map((pegScore) => makeRow({ pegScore }))],
  ["dewsScore", makeRow(), observedValues.map((score) => makeRow({}, makeDews({ score })))],
  ["currentDeviationBps", makeRow({ currentDeviationBps: null }),
    [...observedValues, -20].map((currentDeviationBps) => makeRow({ currentDeviationBps }))],
] as const)("compareDepegTrackerRows — %s availability", (key, unknown, observedRows) => {
  it.each(["asc", "desc"] as const)("sorts unknown last in %s order, after observed zero and nonzero values", (direction) => {
    for (const observed of observedRows) {
      expect(compareDepegTrackerRows(unknown, observed, sort(key, direction))).toBeGreaterThan(0);
      expect(compareDepegTrackerRows(observed, unknown, sort(key, direction))).toBeLessThan(0);
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
});

describe("compareDepegTrackerRows — pegPct", () => {
  it.each(["asc", "desc"] as const)("sorts unknown occupancy last in %s order without equating it to zero", (direction) => {
    const unknown = makeRow({ pegPct: null });
    const zero = makeRow({ pegPct: 0 });
    const perfect = makeRow({ pegPct: 100 });
    expect(compareDepegTrackerRows(unknown, zero, sort("pegPct", direction))).toBeGreaterThan(0);
    expect(compareDepegTrackerRows(unknown, perfect, sort("pegPct", direction))).toBeGreaterThan(0);
  });
});

describe("compareDepegTrackerRows — worstDeviationBps", () => {
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
