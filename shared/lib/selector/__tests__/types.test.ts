/**
 * Type-test patterns. Most assertions are at compile time; we use `expectType`
 * helpers via TypeScript's type system. The runtime tests just round-trip
 * exhaustive enum lists.
 */
import { describe, expect, it } from "vitest";
import {
  CONTEXT_KEYS,
  DEPEG_TOLERANCE_VALUES,
  EXCLUSION_REASONS,
  EXIT_SPEED_VALUES,
  HORIZON_VALUES,
  LOWEST_SUB_DIMENSION_KEYS,
  SELECTOR_PROFILES,
  WEIGHT_KEYS,
  WHY_KEYS,
} from "../types";
import type {
  ExclusionReason,
  LowestSubDimensionKey,
  SelectorProfile,
  SelectorRecommendation,
  WeightKey,
  WhyKey,
} from "../types";

function assertExhaustive(_: never): never {
  throw new Error("non-exhaustive switch");
}

describe("type vocabularies", () => {
  it("SELECTOR_PROFILES is exhaustive", () => {
    const seen: SelectorProfile[] = [];
    for (const profile of SELECTOR_PROFILES) {
      switch (profile) {
        case "treasury":
        case "yield":
        case "trading":
          seen.push(profile);
          break;
        default:
          assertExhaustive(profile);
      }
    }
    expect(seen).toEqual(["treasury", "yield", "trading"]);
  });

  it("LOWEST_SUB_DIMENSION_KEYS covers exactly 11 keys", () => {
    expect(LOWEST_SUB_DIMENSION_KEYS).toHaveLength(11);
  });

  it("HORIZON_VALUES has exactly 5 horizons", () => {
    expect(HORIZON_VALUES).toHaveLength(5);
  });

  it("DEPEG_TOLERANCE_VALUES = zero / tight / moderate", () => {
    expect([...DEPEG_TOLERANCE_VALUES]).toEqual(["zero", "tight", "moderate"]);
  });

  it("EXIT_SPEED_VALUES = 1h / 24h / any", () => {
    expect([...EXIT_SPEED_VALUES]).toEqual(["1h", "24h", "any"]);
  });

  it("WEIGHT_KEYS covers every scoring slot", () => {
    expect(WEIGHT_KEYS.length).toBeGreaterThanOrEqual(17);
  });

  it("EXCLUSION_REASONS has all rule codes", () => {
    const required: ExclusionReason[] = [
      "below-supply-floor",
      "active-depeg",
      "safety-grade-floor",
      "dews-ceiling",
      "howey-uncertain",
      "template-coverage-gap",
      "coverage-too-thin",
    ];
    for (const reason of required) {
      expect(EXCLUSION_REASONS).toContain(reason);
    }
  });

  it("WHY_KEYS is non-empty and types as union", () => {
    expect(WHY_KEYS.length).toBeGreaterThan(0);
    const k: WhyKey = WHY_KEYS[0]!;
    expect(typeof k).toBe("string");
  });

  it("CONTEXT_KEYS includes documented hedges", () => {
    expect([...CONTEXT_KEYS]).toContain("recent-listing");
    expect([...CONTEXT_KEYS]).toContain("coverage-thin");
  });
});

describe("discriminated SelectorRecommendation", () => {
  it("narrows on profile", () => {
    function discriminate(rec: SelectorRecommendation): string {
      switch (rec.profile) {
        case "treasury":
          return rec.recommendedSource === null ? "treasury" : "broken";
        case "yield":
          return rec.recommendedSource.protocol; // type-narrowed to non-null
        case "trading":
          return Object.keys(rec.perInputStaleness).join(","); // non-null
        default:
          return assertExhaustive(rec);
      }
    }
    expect(typeof discriminate).toBe("function");
  });

  it("LowestSubDimensionKey narrows", () => {
    function _(k: LowestSubDimensionKey): number {
      switch (k) {
        case "pegStability":
        case "liquidity":
        case "resilience":
        case "decentralization":
        case "dependencyRisk":
        case "collateralQuality":
        case "custodyModel":
        case "governanceOverride":
        case "activeDepegHistory":
        case "yieldVariance":
        case "sourceRisk":
          return 1;
        default:
          return assertExhaustive(k);
      }
    }
    expect(_).toBeDefined();
  });

  it("WeightKey narrows", () => {
    const sample: WeightKey = "safetyOverall";
    expect(WEIGHT_KEYS).toContain(sample);
  });
});
