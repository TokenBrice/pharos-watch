import { describe, expect, it } from "vitest";
import {
  compareScored,
  rankScoredEntries,
  sortScoredEntries,
} from "../ranking";
import type { ScoredEntry } from "../scoring";
import type { MergedRow } from "../types";
import { makeInput, makeMergedRowWithIdentity } from "./fixture";

function makeEntry(id: string, score: number, supplyUsd: number, overrides: Partial<MergedRow> = {}): ScoredEntry {
  return {
    row: makeMergedRowWithIdentity({ id, symbol: id.toUpperCase(), name: id }, {
      protocolSlug: id, supplyUsd, ...overrides,
    }),
    score,
    components: [],
    confidence: 100,
    confidenceReasons: [],
    redistributedSlots: 0,
    recommendedSource: null,
    perInputStaleness: null,
    relaxedReason: null,
  };
}

describe("selector ranking", () => {
  it("uses a transitive score comparator for raw Array.sort calls", () => {
    const topSmall = makeEntry("top-small", 100, 1);
    const nearLarger = makeEntry("near-larger", 98.6, 100);
    const chainLarger = makeEntry("chain-larger", 97.2, 200);

    expect(
      [chainLarger, nearLarger, topSmall]
        .sort(compareScored)
        .map((entry) => entry.row.id),
    ).toEqual(["top-small", "near-larger", "chain-larger"]);
    expect(compareScored(topSmall, nearLarger)).toBeLessThan(0);
    expect(compareScored(nearLarger, chainLarger)).toBeLessThan(0);
    expect(compareScored(topSmall, chainLarger)).toBeLessThan(0);
  });

  it("tie-breaks within one explicit score cluster without chaining clusters", () => {
    const topSmall = makeEntry("top-small", 100, 1);
    const nearLarger = makeEntry("near-larger", 98.6, 100);
    const chainLarger = makeEntry("chain-larger", 97.2, 200);

    expect(
      sortScoredEntries([chainLarger, nearLarger, topSmall]).map(
        (entry) => entry.row.id,
      ),
    ).toEqual(["near-larger", "top-small", "chain-larger"]);
    expect(
      rankScoredEntries(
        [chainLarger, nearLarger, topSmall],
        makeInput({ profile: "trading" }),
      ).map((entry) => entry.row.id),
    ).toEqual(["near-larger", "top-small", "chain-larger"]);
  });

  it("breaks equal supply by grade, liquidity, then identity with missing values last", () => {
    const entries = [
      makeEntry("missing-grade", 80, 100, { safetyGrade: null, liquidityScore: 100 }),
      makeEntry("lower-grade", 80, 100, { safetyGrade: "B", liquidityScore: 100 }),
      makeEntry("missing-liquidity", 80, 100, { liquidityScore: null }),
      makeEntry("low-liquidity", 80, 100, { liquidityScore: 0 }),
      makeEntry("z", 80, 100),
      makeEntry("a", 80, 100),
    ];
    expect(sortScoredEntries(entries).map((entry) => entry.row.id))
      .toEqual(["a", "z", "low-liquidity", "missing-liquidity", "lower-grade", "missing-grade"]);
  });

  it("includes exactly 1.5 points in a cluster but not the next larger gap", () => {
    expect(sortScoredEntries([
      makeEntry("outside", 98.499999, 1000),
      makeEntry("top", 100, 1),
      makeEntry("boundary", 98.5, 100),
    ]).map((entry) => entry.row.id)).toEqual(["boundary", "top", "outside"]);
  });

  it.each(["treasury", "yield", "trading"] as const)(
    "%s demotes confidence 39 only outside trading and retains confidence 40",
    (profile) => {
      for (const confidence of [39, 40]) {
        const first = { ...makeEntry("first", 90, 100), confidence };
        const second = makeEntry("second", 80, 100);
        expect(rankScoredEntries([second, first], makeInput({ profile })).map((entry) => entry.row.id))
          .toEqual(confidence === 39 && profile !== "trading" ? ["second", "first"] : ["first", "second"]);
      }
    },
  );
});
