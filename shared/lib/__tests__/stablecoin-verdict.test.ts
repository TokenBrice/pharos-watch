import { describe, expect, it } from "vitest";
import {
  deriveStablecoinVerdict,
  type VerdictInputs,
  type StablecoinVerdictArchetype,
} from "@shared/lib/stablecoin-verdict";

const BASE_INPUTS: VerdictInputs = {
  status: "active",
  reportCardGrade: "B",
  pegScore: 85,
  dewsBand: "CALM",
  mechanismArchetype: "fiat-cash",
  governance: "centralized",
  yieldBearing: false,
  activeDepeg: false,
};

function inputs(overrides: Partial<VerdictInputs>): VerdictInputs {
  return { ...BASE_INPUTS, ...overrides };
}

function archetypeOf(overrides: Partial<VerdictInputs>): StablecoinVerdictArchetype {
  return deriveStablecoinVerdict(inputs(overrides)).archetype;
}

describe("deriveStablecoinVerdict — rule precedence", () => {
  it("returns pre-launch when status is pre-launch", () => {
    const verdict = deriveStablecoinVerdict(inputs({ status: "pre-launch" }));
    expect(verdict.archetype).toBe("pre-launch");
    expect(verdict.label).toBe("Pre-launch");
  });

  it("returns frozen-archive when status is frozen", () => {
    const verdict = deriveStablecoinVerdict(inputs({ status: "frozen" }));
    expect(verdict.archetype).toBe("frozen-archive");
    expect(verdict.label).toBe("Frozen Archive");
  });

  it.each([
    ["quarantined", "quarantined-record", "Quarantined Record"],
    ["delisted", "delisted-record", "Delisted Record"],
  ] as const)("returns an inactive record verdict for %s", (status, archetype, label) => {
    const verdict = deriveStablecoinVerdict(inputs({ status, activeDepeg: true }));
    expect(verdict.archetype).toBe(archetype);
    expect(verdict.label).toBe(label);
  });

  it("pre-launch beats every other rule", () => {
    // Centralized fiat-cash A+ would otherwise be institutional-default; here pre-launch wins.
    const archetype = archetypeOf({
      status: "pre-launch",
      reportCardGrade: "A+",
      mechanismArchetype: "fiat-cash",
      governance: "centralized",
      activeDepeg: true,
    });
    expect(archetype).toBe("pre-launch");
  });

  it("frozen-archive beats distressed even when an active depeg is set", () => {
    const archetype = archetypeOf({ status: "frozen", activeDepeg: true });
    expect(archetype).toBe("frozen-archive");
  });

  it("returns distressed on active depeg even for an A-grade fiat-cash coin", () => {
    const archetype = archetypeOf({
      activeDepeg: true,
      reportCardGrade: "A",
      mechanismArchetype: "fiat-cash",
      governance: "centralized",
    });
    expect(archetype).toBe("distressed");
  });

  it.each([["WARNING"] as const, ["DANGER"] as const])(
    "returns distressed when DEWS band is %s",
    (band) => {
      const archetype = archetypeOf({ dewsBand: band });
      expect(archetype).toBe("distressed");
    },
  );

  // `RISKY_GRADES` is every grade below C-; the ladder in `report-card-core.ts`
  // has no D+/D- members, so D and F are the whole risky bucket.
  it.each([["D"] as const, ["F"] as const])(
    "returns low-safety-score (not distressed) when overall grade is %s",
    (grade) => {
      const verdict = deriveStablecoinVerdict(inputs({ reportCardGrade: grade }));
      expect(verdict.archetype).toBe("low-safety-score");
      expect(verdict.label).toBe("Low Safety Score");
    },
  );

  it("does not return distressed for a low grade with no measured distress signal", () => {
    // Regression: a D/F grade alone used to render the red "Distressed" pill on
    // 147 of 337 rated coins with a healthy peg and a CALM DEWS band.
    const archetype = archetypeOf({
      reportCardGrade: "F",
      dewsBand: "CALM",
      activeDepeg: false,
      yieldBearing: true,
      navToken: false,
      mechanismArchetype: "tbill",
    });
    expect(archetype).toBe("low-safety-score");
  });

  it("prefers distressed over low-safety-score when a low grade coincides with an active depeg", () => {
    const archetype = archetypeOf({ reportCardGrade: "F", activeDepeg: true });
    expect(archetype).toBe("distressed");
  });

  it.each([["WARNING"] as const, ["DANGER"] as const])(
    "prefers distressed over low-safety-score when a low grade coincides with DEWS %s",
    (band) => {
      const archetype = archetypeOf({ reportCardGrade: "F", dewsBand: band });
      expect(archetype).toBe("distressed");
    },
  );

  it("keeps the low-grade rule ahead of the yield-hybrid and benchmark rules", () => {
    // The branch was re-labelled, not reordered: a badly rated yield-bearing
    // tbill must still surface the grade rather than fall through to "ok".
    expect(
      archetypeOf({ reportCardGrade: "D", yieldBearing: true, mechanismArchetype: "tbill" }),
    ).toBe("low-safety-score");
    expect(
      archetypeOf({ reportCardGrade: "F", mechanismArchetype: "cdp", governance: "decentralized" }),
    ).toBe("low-safety-score");
  });

  it("returns yield-bearing-hybrid for NAV tokens before the low-grade rule", () => {
    const archetype = archetypeOf({
      navToken: true,
      yieldBearing: true,
      mechanismArchetype: undefined,
      reportCardGrade: "F",
      pegScore: null,
      activeDepeg: false,
    });
    expect(archetype).toBe("yield-bearing-hybrid");
  });

  it("still returns distressed for NAV tokens with an explicit active depeg signal", () => {
    const archetype = archetypeOf({
      navToken: true,
      yieldBearing: true,
      reportCardGrade: "F",
      pegScore: null,
      activeDepeg: true,
    });
    expect(archetype).toBe("distressed");
  });

  it("returns yield-bearing-hybrid when yieldBearing && synthetic-delta-neutral", () => {
    const archetype = archetypeOf({
      yieldBearing: true,
      mechanismArchetype: "synthetic-delta-neutral",
      governance: "decentralized",
    });
    expect(archetype).toBe("yield-bearing-hybrid");
  });

  it("returns yield-bearing-hybrid when yieldBearing && tbill", () => {
    const archetype = archetypeOf({
      yieldBearing: true,
      mechanismArchetype: "tbill",
      governance: "centralized",
    });
    expect(archetype).toBe("yield-bearing-hybrid");
  });

  it("yield-bearing CDPs fall through to decentralized-benchmark, not yield-bearing-hybrid", () => {
    const archetype = archetypeOf({
      yieldBearing: true,
      mechanismArchetype: "cdp",
      governance: "decentralized",
    });
    expect(archetype).toBe("decentralized-benchmark");
  });

  it("returns decentralized-benchmark for decentralized CDP", () => {
    const archetype = archetypeOf({
      mechanismArchetype: "cdp",
      governance: "decentralized",
    });
    expect(archetype).toBe("decentralized-benchmark");
  });

  it("does not return decentralized-benchmark when governance is centralized", () => {
    const archetype = archetypeOf({
      mechanismArchetype: "cdp",
      governance: "centralized",
    });
    expect(archetype).toBe("uncategorized");
  });

  it("returns institutional-default for centralized fiat-cash with passing grade", () => {
    const archetype = archetypeOf({
      mechanismArchetype: "fiat-cash",
      governance: "centralized",
      reportCardGrade: "A",
    });
    expect(archetype).toBe("institutional-default");
  });

  it.each([
    ["A+"] as const,
    ["A"] as const,
    ["A-"] as const,
    ["B+"] as const,
    ["B"] as const,
    ["B-"] as const,
  ])("treats grade %s as institutional-default-eligible", (grade) => {
    const archetype = archetypeOf({
      mechanismArchetype: "fiat-cash",
      governance: "centralized",
      reportCardGrade: grade,
    });
    expect(archetype).toBe("institutional-default");
  });

  it.each([
    ["C+"] as const,
    ["C"] as const,
    ["C-"] as const,
    ["NR"] as const,
  ])("treats grade %s as uncategorized for fiat-cash centralized (not institutional)", (grade) => {
    const archetype = archetypeOf({
      mechanismArchetype: "fiat-cash",
      governance: "centralized",
      reportCardGrade: grade,
    });
    expect(archetype).toBe("uncategorized");
  });

  it("centralized-dependent governance does not qualify for institutional-default", () => {
    const archetype = archetypeOf({
      mechanismArchetype: "fiat-cash",
      governance: "centralized-dependent",
      reportCardGrade: "A",
    });
    expect(archetype).toBe("uncategorized");
  });

  it("returns uncategorized when mechanismArchetype is undefined", () => {
    const archetype = archetypeOf({
      mechanismArchetype: undefined,
      governance: "centralized",
      reportCardGrade: "A",
    });
    expect(archetype).toBe("uncategorized");
  });

  it("returns uncategorized when grade is null but no other rule matches", () => {
    const archetype = archetypeOf({
      mechanismArchetype: "fiat-cash",
      governance: "centralized",
      reportCardGrade: null,
    });
    expect(archetype).toBe("uncategorized");
  });

  it("treats null DEWS band as non-distressed", () => {
    const archetype = archetypeOf({
      dewsBand: null,
      reportCardGrade: "A",
      mechanismArchetype: "fiat-cash",
      governance: "centralized",
    });
    expect(archetype).toBe("institutional-default");
  });

  it("algorithmic-only coin without other matches lands at uncategorized", () => {
    const archetype = archetypeOf({
      mechanismArchetype: "algorithmic",
      governance: "decentralized",
      reportCardGrade: "C",
    });
    expect(archetype).toBe("uncategorized");
  });
});
