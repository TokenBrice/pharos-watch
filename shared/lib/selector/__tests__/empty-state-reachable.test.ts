import { describe, expect, it } from "vitest";
import { runSelector } from "../engine";
import type { MergedRow, SelectorData, SelectorInput } from "../types";
import { buildFixtureData, FIXTURE_DATASET, makeInput, FIXTURE_ROWS } from "./fixture";

/**
 * Build a `SelectorData` over a transformed fixture. Used to construct
 * adversarial scenarios where the data deliberately can't pass an exclusion
 * gate (e.g. all coins carry a fresh active depeg).
 */
function harshFixture(transform: (row: MergedRow) => MergedRow): SelectorData {
  const rows = new Map<string, MergedRow>();
  for (const row of FIXTURE_ROWS) {
    rows.set(row.id, transform(row));
  }
  return { rows };
}

const ADVERSARIAL_INPUTS: Array<{
  name: string;
  input: SelectorInput;
  data: SelectorData;
}> = [
  {
    // All universe coins carry a fresh 60 bps deviation → fails zero-tolerance.
    name: "Treasury × zero tolerance × fixture-wide deviation",
    input: makeInput({
      profile: "treasury",
      horizon: "6mplus",
      depegTolerance: "zero",
      composability: "none",
      exitSpeed: "any",
    }),
    data: harshFixture((row) => ({
      ...row,
      activeDepeg: true,
      currentDeviationBps: 60,
    })),
  },
  {
    name: "Yield × minApy=20 × yieldNativeOnly=true × zero tolerance",
    input: makeInput({
      profile: "yield",
      horizon: "1to4w",
      depegTolerance: "zero",
      composability: "high",
      exitSpeed: "any",
      minApy: 20,
      yieldNativeOnly: true,
    }),
    data: buildFixtureData(),
  },
  {
    // All universe coins flagged with an active depeg > 50bps under zero tolerance.
    name: "Trading × 1h × zero tolerance × fixture-wide deviation",
    input: makeInput({
      profile: "trading",
      horizon: "lt24h",
      depegTolerance: "zero",
      composability: "high",
      exitSpeed: "1h",
    }),
    data: harshFixture((row) => ({
      ...row,
      activeDepeg: true,
      currentDeviationBps: 60,
    })),
  },
];

describe("empty-state reachable per profile", () => {
  it.each(ADVERSARIAL_INPUTS)(
    "$name → 0 survivors",
    ({ input, data }) => {
      const out = runSelector(input, data, FIXTURE_DATASET);
      expect(out.recommended.length).toBe(0);
      expect(out.lowConfidence).toBe(true);
    },
  );

  it("Treasury empty state caps lower-ranked at 2", () => {
    const { input, data } = ADVERSARIAL_INPUTS[0]!;
    const out = runSelector(input, data, FIXTURE_DATASET);
    expect(out.recommended.length).toBe(0);
    expect(out.lowerRanked.length).toBeLessThanOrEqual(2);
  });
});

describe("each profile is empty-reachable", () => {
  it("at least one adversarial input per profile yields 0 survivors", () => {
    const profiles = new Set<string>();
    for (const { input, data } of ADVERSARIAL_INPUTS) {
      const out = runSelector(input, data, FIXTURE_DATASET);
      if (out.recommended.length === 0) profiles.add(input.profile);
    }
    expect(profiles).toEqual(new Set(["treasury", "yield", "trading"]));
  });
});
