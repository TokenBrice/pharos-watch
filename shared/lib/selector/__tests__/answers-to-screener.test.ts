import { describe, expect, it } from "vitest";
import {
  buildScreenerUrl,
  selectorAnswersToScreenerFilters,
} from "../answers-to-screener";
import { makeInput } from "./fixture";

describe("selectorAnswersToScreenerFilters", () => {
  it("Treasury base filter restricts safetyGrades to C+ and above", () => {
    const { filters } = selectorAnswersToScreenerFilters(makeInput({ profile: "treasury" }));
    expect(filters.safetyGrades).toEqual(["A+", "A", "A-", "B+", "B", "B-", "C+"]);
    expect(filters.lifecycle).toEqual(["active"]);
  });

  it("base filter carries the selected peg into the Screener handoff", () => {
    const { filters } = selectorAnswersToScreenerFilters(makeInput({ pegCurrency: "USD" }));
    expect(filters.pegs).toEqual(["USD"]);
  });

  it("Yield base filter allows down to C-", () => {
    const { filters } = selectorAnswersToScreenerFilters(makeInput({ profile: "yield" }));
    expect(filters.safetyGrades).toContain("C-");
  });

  it("Trading base filter allows down to C-", () => {
    const { filters } = selectorAnswersToScreenerFilters(makeInput({ profile: "trading" }));
    expect(filters.safetyGrades).toContain("C-");
  });

  it("Treasury × depegTolerance=zero raises safetyPegStabilityMin to 80", () => {
    const { filters } = selectorAnswersToScreenerFilters(
      makeInput({ profile: "treasury", depegTolerance: "zero" }),
    );
    expect(filters.safetyPegStabilityMin).toBe(80);
  });

  it("Treasury × horizon=6mplus raises dependency-risk floor to 65", () => {
    const { filters } = selectorAnswersToScreenerFilters(
      makeInput({ profile: "treasury", horizon: "6mplus" }),
    );
    expect(filters.safetyDependencyRiskMin).toBe(65);
  });

  it("Trading × exitSpeed=1h tightens dewsMax to 35", () => {
    const { filters } = selectorAnswersToScreenerFilters(
      makeInput({ profile: "trading", exitSpeed: "1h" }),
    );
    expect(filters.dewsMax).toBe(35);
    expect(filters.safetyLiquidityMin).toBe(65);
  });

  it("Yield divergenceWarnings includes yield-warning-signals", () => {
    const { divergenceWarnings } = selectorAnswersToScreenerFilters(
      makeInput({ profile: "yield" }),
    );
    expect(divergenceWarnings.map((w) => w.reason)).toContain("yield-warning-signals");
  });

  it("Yield × minApy != null adds the minApy divergence", () => {
    const { divergenceWarnings } = selectorAnswersToScreenerFilters(
      makeInput({ profile: "yield", minApy: 6 }),
    );
    const reasons = divergenceWarnings.map((w) => w.reason);
    expect(reasons).toContain("minApy");
  });

  it("decentralization=required + treasury → types includes 'decentralized'", () => {
    const { filters } = selectorAnswersToScreenerFilters(
      makeInput({ profile: "treasury", decentralization: "required" }),
    );
    expect(filters.types).toEqual(["decentralized"]);
    expect(filters.blacklistable).toEqual(["no"]);
  });
});

describe("buildScreenerUrl", () => {
  it("returns a path with encoded query string", () => {
    const { url } = buildScreenerUrl(makeInput({ profile: "treasury" }), "/screener");
    expect(url.startsWith("/screener?")).toBe(true);
    expect(url).toContain("safetyGrades=");
  });
});

// -----------------------------------------------------------------------------
// 27-combo smoke (plan §11 — Test P1 — replaces 405-combo for the default
// `npm test` lane). Asserts the function does not throw for any profile ×
// horizon × depegTolerance subset.
// -----------------------------------------------------------------------------
describe("survivor-parity smoke", () => {
  const profiles = ["treasury", "yield", "trading"] as const;
  const horizons = ["lt24h", "1to6m", "6mplus"] as const;
  const tolerances = ["zero", "tight", "moderate"] as const;
  it.each(
    profiles.flatMap((p) =>
      horizons.flatMap((h) =>
        tolerances.map((d) => [p, h, d] as const),
      ),
    ),
  )("%s × %s × %s does not throw and returns filters", (p, h, d) => {
    const result = selectorAnswersToScreenerFilters(
      makeInput({ profile: p, horizon: h, depegTolerance: d }),
    );
    expect(result.filters).toBeDefined();
    expect(result.filters.lifecycle).toEqual(["active"]);
    expect(Array.isArray(result.divergenceWarnings)).toBe(true);
  });
});
