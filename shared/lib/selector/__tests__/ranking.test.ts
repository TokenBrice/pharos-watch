import { describe, expect, it } from "vitest";
import {
  applyConcentrationSafeguard,
  compareScored,
  dedupVariants,
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
  it.each(["treasury", "trading"] as const)(
    "%s buckets a real parent and all children into one family",
    (profile) => {
      const root = makeEntry("usdc-circle", 80, 100);
      const child = makeEntry("gtusdc-gauntlet", 90, 10, { variantOf: root.row.id, isYieldBearing: true });
      const sibling = makeEntry("other-usdc", 85, 20, { variantOf: root.row.id });
      expect(dedupVariants([root, child], profile).map((entry) => entry.row.id))
        .toEqual(["gtusdc-gauntlet"]);
      expect(dedupVariants([root, sibling, child], profile).map((entry) => entry.row.id))
        .toEqual(["gtusdc-gauntlet"]);
    },
  );

  it("splits yield-bearing and non-yield-bearing members only in Yield", () => {
    const root = makeEntry("usdc-circle", 80, 100);
    const child = makeEntry("gtusdc-gauntlet", 90, 10, { variantOf: root.row.id, isYieldBearing: true });
    const sibling = makeEntry("other-usdc", 85, 20, { variantOf: root.row.id, isYieldBearing: true });
    expect(dedupVariants([root, sibling, child], "yield").map((entry) => entry.row.id))
      .toEqual(["gtusdc-gauntlet", "usdc-circle"]);
  });

  it("chooses equal-score family representatives by the existing deterministic tie breakers", () => {
    const root = makeEntry("usdc-circle", 80, 100);
    const child = makeEntry("gtusdc-gauntlet", 80, 200, { variantOf: root.row.id });
    expect(dedupVariants([root, child], "trading")).toEqual([child]);
    expect(dedupVariants([child, root], "trading")).toEqual([child]);
    const tiedChild = makeEntry("gtusdc-gauntlet", 80, 100, { variantOf: root.row.id });
    expect(dedupVariants([root, tiedChild], "trading")).toEqual([tiedChild]);
    expect(dedupVariants([tiedChild, root], "trading")).toEqual([tiedChild]);
  });

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

  it("does not relocate concentration onto an already-selected replacement protocol", () => {
    const ranked = applyConcentrationSafeguard([
      makeEntry("a1", 95, 100, { protocolSlug: "a" }),
      makeEntry("a2", 94, 100, { protocolSlug: "a" }),
      makeEntry("b1", 93, 100, { protocolSlug: "b" }),
      makeEntry("b2", 92, 100, { protocolSlug: "b" }),
      makeEntry("c1", 91, 100, { protocolSlug: "c" }),
    ]);
    expect(ranked.slice(0, 3).map((entry) => entry.row.protocolSlug)).toEqual(["a", "b", "c"]);
    expect(ranked[2]?.concentrationAdjusted).toBe(true);
  });

  it.each([
    { protocolSlug: "c", score: 91, expected: "candidate" },
    { protocolSlug: "c", score: 90.999, expected: "a2" },
    { protocolSlug: "a", score: 93, expected: "a2" },
    { protocolSlug: null, score: 93, expected: "a2" },
  ])("keeps the three-point boundary and fallback for $protocolSlug at $score", ({ protocolSlug, score, expected }) => {
    const ranked = applyConcentrationSafeguard([
      makeEntry("a1", 95, 100, { protocolSlug: "a" }),
      makeEntry("a2", 94, 100, { protocolSlug: "a" }),
      makeEntry("candidate", score, 100, { protocolSlug }),
    ]);
    expect(ranked[1]?.row.id).toBe(expected);
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
