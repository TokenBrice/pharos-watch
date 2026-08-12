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
    const { filters } = selectorAnswersToScreenerFilters(makeInput({ pegCurrency: "EUR" }));
    expect(filters.pegs).toEqual(["EUR"]);
  });

  it("Yield base filter allows down to C-", () => {
    const { filters } = selectorAnswersToScreenerFilters(makeInput({ profile: "yield" }));
    expect(filters.safetyGrades).toContain("C-");
  });

  it("Trading base filter allows down to C-", () => {
    const { filters } = selectorAnswersToScreenerFilters(makeInput({ profile: "trading" }));
    expect(filters.safetyGrades).toContain("C-");
  });

  it("Treasury × depegTolerance=zero sets the V9-native and live score floors", () => {
    const { filters } = selectorAnswersToScreenerFilters(
      makeInput({ profile: "treasury", depegTolerance: "zero" }),
    );
    expect(filters.pegScoreMin).toBe(80);
    expect(filters.safetyBackingMin).toBe(50);
    expect(filters.supplyMin).toBe(5_000_000);
  });

  it("peg floors match the engine's exclusion helpers (Q-019)", () => {
    const floor = (profile: "treasury" | "yield" | "trading", tol: "zero" | "tight" | "moderate") =>
      selectorAnswersToScreenerFilters(makeInput({ profile, depegTolerance: tol })).filters
        .pegScoreMin;
    // Treasury → treasuryPegScoreFloor
    expect([floor("treasury", "zero"), floor("treasury", "tight"), floor("treasury", "moderate")]).toEqual([
      80, 70, 60,
    ]);
    // Yield → yieldPegScoreFloor
    expect([floor("yield", "zero"), floor("yield", "tight"), floor("yield", "moderate")]).toEqual([
      65, 55, 45,
    ]);
    // Trading → tradingPegScoreFloor (moderate=70 was the stale 75)
    expect([floor("trading", "zero"), floor("trading", "tight"), floor("trading", "moderate")]).toEqual([
      85, 80, 70,
    ]);
  });

  it("does not emit retired resilience or dependency-risk keys", () => {
    const { filters } = selectorAnswersToScreenerFilters(
      makeInput({ profile: "treasury", horizon: "6mplus" }),
    );
    expect(filters).not.toHaveProperty("safetyResilienceMin");
    expect(filters).not.toHaveProperty("safetyDependencyRiskMin");
    expect(filters).not.toHaveProperty("safetyPegStabilityMin");
  });

  it("Trading × exitSpeed=1h tightens dewsMax to 35", () => {
    const { filters } = selectorAnswersToScreenerFilters(
      makeInput({ profile: "trading", exitSpeed: "1h" }),
    );
    expect(filters.dewsMax).toBe(35);
    expect(filters.liquidityScoreMin).toBe(65);
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
    expect(filters.types).toEqual(["centralized-dependent", "decentralized"]);
    expect(filters.blacklistable).toEqual(["no", "possible"]);
  });

  it("projects the same curated custody model rails used by the engine", () => {
    expect(
      selectorAnswersToScreenerFilters(makeInput({ custodyOk: "onchain-only" })).filters.custodyModels,
    ).toEqual(["onchain"]);
    expect(
      selectorAnswersToScreenerFilters(makeInput({ custodyOk: "regulated-only" })).filters.custodyModels,
    ).toEqual(["institutional-top", "institutional-regulated"]);
  });
});

describe("buildScreenerUrl", () => {
  it("returns a path with encoded query string", () => {
    const { url } = buildScreenerUrl(
      makeInput({ profile: "treasury" }),
      "/screener",
      ["usdc-circle", "dai-makerdao", "usdc-circle"],
    );
    expect(url.startsWith("/screener?")).toBe(true);
    expect(url).toContain("safetyGrades=");
    expect(url).toContain("coins=usdc-circle%2Cdai-makerdao");
  });
});
