import { describe, expect, it } from "vitest";
import {
  compareScored,
  rankScoredEntries,
  sortScoredEntries,
} from "../ranking";
import type { ScoredEntry } from "../scoring";
import type { MergedRow } from "../types";
import { buildFixtureData, makeInput } from "./fixture";

const baseRow = buildFixtureData().rows.get("usdc-circle");
if (baseRow == null) {
  throw new Error("selector ranking test fixture is missing usdc-circle");
}

function makeEntry(id: string, score: number, supplyUsd: number): ScoredEntry {
  return {
    row: {
      ...baseRow,
      id,
      symbol: id.toUpperCase(),
      name: id,
      protocolSlug: id,
      variantOf: null,
      supplyUsd,
    } as MergedRow,
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
});
