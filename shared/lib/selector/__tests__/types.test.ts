// Compile-time expectations are included by tsconfig.test-typecheck.json.
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CONTEXT_KEYS,
  DEPEG_TOLERANCE_VALUES,
  EXCLUSION_REASONS,
  EXIT_SPEED_VALUES,
  SELECTOR_PROFILES,
  WEIGHT_KEYS,
} from "../types";
import type {
  ExclusionReason,
  LowestSubDimensionKey,
  SelectorProfile,
  SelectorRecommendation,
  WeightKey,
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

  it("DEPEG_TOLERANCE_VALUES = zero / tight / moderate", () => {
    expect([...DEPEG_TOLERANCE_VALUES]).toEqual(["zero", "tight", "moderate"]);
  });

  it("EXIT_SPEED_VALUES = 1h / 24h / any", () => {
    expect([...EXIT_SPEED_VALUES]).toEqual(["1h", "24h", "any"]);
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

  it("CONTEXT_KEYS includes documented hedges", () => {
    expect([...CONTEXT_KEYS]).toContain("recent-listing");
    expect([...CONTEXT_KEYS]).toContain("coverage-thin");
  });
});

describe("discriminated SelectorRecommendation", () => {
  it("preserves profile-specific types (checked by typecheck:tests)", () => {
    expectTypeOf<Extract<SelectorRecommendation, { profile: "treasury" }>["recommendedSource"]>()
      .toEqualTypeOf<null>();
    expectTypeOf<Extract<SelectorRecommendation, { profile: "yield" }>["recommendedSource"]>()
      .not.toBeNullable();
    expectTypeOf<Extract<SelectorRecommendation, { profile: "trading" }>["perInputStaleness"]>()
      .not.toBeNullable();
    expectTypeOf<LowestSubDimensionKey>().toEqualTypeOf<
      "pegStability" | "liquidity" | "resilience" | "decentralization" |
      "dependencyRisk" | "collateralQuality" | "custodyModel" |
      "governanceOverride" | "activeDepegHistory" | "yieldVariance" | "sourceRisk"
    >();
  });

  it("WeightKey narrows", () => {
    const sample: WeightKey = "safetyOverall";
    expect(WEIGHT_KEYS).toContain(sample);
  });
});
