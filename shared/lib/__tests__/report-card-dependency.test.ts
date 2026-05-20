import { describe, it, expect } from "vitest";
import { deriveEffectiveDependencies } from "../dependency-derivation";
import { scoreDependencyRisk } from "../report-cards";

describe("scoreDependencyRisk", () => {
  it("scores self-backed centralized coin at 95", () => {
    const result = scoreDependencyRisk(
      {
        governance: "centralized",
        dependencies: [],
      },
      new Map(),
    );
    expect(result.score).toBe(95);
  });

  it("scores self-backed decentralized coin at 90", () => {
    const result = scoreDependencyRisk(
      {
        governance: "decentralized",
        dependencies: [],
      },
      new Map(),
    );
    expect(result.score).toBe(90);
  });

  it("caps wrapper dependency score", () => {
    const upstream = new Map([["usdc", 80]]);
    const result = scoreDependencyRisk(
      {
        governance: "centralized",
        dependencies: [{ id: "usdc", weight: 1.0, type: "wrapper" }],
      },
      upstream,
    );
    // Wrapper cap: dep_score - 3 = 77
    expect(result.score).toBeLessThanOrEqual(77);
  });

  it("scores partially unavailable dependency weights at the conservative fallback", () => {
    const result = scoreDependencyRisk(
      {
        governance: "centralized",
        dependencies: [
          { id: "available", weight: 0.5, type: "collateral" as const },
          { id: "missing", weight: 0.3, type: "collateral" as const },
        ],
      },
      new Map([["available", 90]]),
    );

    // 50% * 90 + 30% * 70 + 20% self-backed centralized score 95 = 85, then
    // the unavailable dependency is treated as weak (<75), applying -10.
    expect(result.score).toBe(75);
    expect(result.detail).toContain("Unavailable upstream scores: 1 dep");
  });

  it("uses the wider risk-absorption wrapper ceiling for tracked variants", () => {
    const result = scoreDependencyRisk(
      {
        governance: "centralized-dependent",
        dependencies: [{ id: "usds-sky", weight: 1, type: "wrapper" }],
        variantParentId: "usds-sky",
        variantKind: "risk-absorption",
      },
      new Map([["usds-sky", 80]]),
    );

    expect(result.score).toBe(75);
  });

  it("uses the strategy-vault wrapper ceiling for tracked strategy variants", () => {
    const result = scoreDependencyRisk(
      {
        governance: "centralized-dependent",
        dependencies: [{ id: "usdai-usd-ai", weight: 1, type: "wrapper" }],
        variantParentId: "usdai-usd-ai",
        variantKind: "strategy-vault",
      },
      new Map([["usdai-usd-ai", 80]]),
    );

    expect(result.score).toBe(75);
  });

  it("uses the strictest wrapper ceiling for bond-maturity variants", () => {
    const result = scoreDependencyRisk(
      {
        governance: "centralized-dependent",
        dependencies: [{ id: "usd0-usual", weight: 1, type: "wrapper" }],
        variantParentId: "usd0-usual",
        variantKind: "bond-maturity",
      },
      new Map([["usd0-usual", 95]]),
    );

    expect(result.score).toBe(87);
  });

  it("applies live-derived mechanism dependency ceilings", () => {
    const dependencies = deriveEffectiveDependencies(
      {
        reserves: [{ name: "Curated stablecoin", pct: 100, risk: "low", coinId: "curated" }],
        dependencies: [],
      },
      {
        liveReserveSlices: [
          { name: "Live mechanism stablecoin", pct: 40, risk: "low", coinId: "live", depType: "mechanism" },
          { name: "Self-backed reserve", pct: 60, risk: "very-low" },
        ],
      },
    );

    const result = scoreDependencyRisk(
      {
        governance: "centralized",
        dependencies,
      },
      new Map([["live", 50]]),
    );

    expect(result.score).toBe(50);
  });
});
