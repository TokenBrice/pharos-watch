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
    expect(result.dependencyDiagnostics).toMatchObject({
      availableWeight: 0.5,
      unavailableWeight: 0.3,
      availableIds: ["available"],
      unavailableIds: ["missing"],
      weakPenalty: -10,
    });
    expect(result.dependencyDiagnostics?.selfBackedFraction).toBeCloseTo(0.2);
  });

  it("uses the same blend and weak penalty when every upstream is unavailable", () => {
    const full = scoreDependencyRisk(
      {
        governance: "centralized",
        dependencies: [{ id: "pre-launch", weight: 1, type: "collateral" }],
      },
      new Map(),
    );
    const peripheral = scoreDependencyRisk(
      {
        governance: "centralized",
        dependencies: [{ id: "active-nr", weight: 0.01, type: "collateral" }],
      },
      new Map(),
    );

    expect(full.score).toBe(60);
    expect(full.dependencyDiagnostics).toMatchObject({
      rawTotalWeight: 1,
      normalizedTotalWeight: 1,
      selfBackedFraction: 0,
      availableWeight: 0,
      unavailableWeight: 1,
      unavailableIds: ["pre-launch"],
      weakPenalty: -10,
    });
    expect(peripheral.score).toBe(85);
    expect(peripheral.dependencyDiagnostics).toMatchObject({
      selfBackedFraction: 0.99,
      unavailableWeight: 0.01,
      unavailableIds: ["active-nr"],
      weakPenalty: -10,
    });
  });

  it.each([
    ["wrapper", "frozen"],
    ["mechanism", "pre-launch"],
  ] as const)("evaluates %s ceilings after the weak penalty for unavailable %s upstreams", (type, id) => {
    const result = scoreDependencyRisk(
      {
        governance: "centralized-dependent",
        dependencies: [{ id, weight: 1, type }],
      },
      new Map(),
    );

    expect(result.score).toBe(60);
    expect(result.dependencyDiagnostics?.bindingCeiling).toBeNull();
  });

  it.each([
    ["wrapper", 67],
    ["mechanism", 70],
  ] as const)("reports a partially unavailable %s ceiling only when it binds", (type, expectedScore) => {
    const result = scoreDependencyRisk(
      {
        governance: "centralized",
        dependencies: [{ id: "unavailable", weight: 0.01, type }],
      },
      new Map(),
    );

    expect(result.score).toBe(expectedScore);
    expect(result.dependencyDiagnostics?.bindingCeiling).toEqual({
      id: "unavailable",
      type,
      score: type === "wrapper" ? 67 : 70,
    });
  });

  it("normalizes overweight contributions without hiding their raw weights", () => {
    const result = scoreDependencyRisk(
      {
        governance: "centralized",
        dependencies: [
          { id: "a", weight: 0.8, type: "collateral" },
          { id: "b", weight: 0.7, type: "collateral" },
        ],
      },
      new Map([
        ["a", 90],
        ["b", 80],
      ]),
    );

    expect(result.dependencyDiagnostics).toMatchObject({
      rawTotalWeight: 1.5,
      normalizedTotalWeight: 1,
      selfBackedFraction: 0,
    });
    expect(result.dependencyDiagnostics?.contributions.map((entry) => entry.rawWeight)).toEqual([0.8, 0.7]);
    expect(
      result.dependencyDiagnostics?.contributions.reduce((sum, entry) => sum + entry.normalizedWeight, 0),
    ).toBeCloseTo(1);
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

  it("labels the ceiling by the dependency that set it, not by mere wrapper presence", () => {
    // Wrapper dep (90 - 3 = 87) and a lower mechanism dep (50). The mechanism
    // sets the binding ceiling, so the detail must read 'mechanism-critical',
    // not 'wrapper' (audit Q-265).
    const result = scoreDependencyRisk(
      {
        governance: "centralized",
        dependencies: [
          { id: "wrap", weight: 0.5, type: "wrapper" },
          { id: "mech", weight: 0.5, type: "mechanism" },
        ],
      },
      new Map([
        ["wrap", 90],
        ["mech", 50],
      ]),
    );

    expect(result.detail).toContain("mechanism-critical dependency ceiling (50)");
    expect(result.detail).not.toContain("wrapper dependency ceiling");
    expect(result.dependencyDiagnostics?.bindingCeiling).toEqual({
      id: "mech",
      type: "mechanism",
      score: 50,
    });
  });

  it("selects an equal ceiling deterministically across dependency order", () => {
    const dependencies = [
      { id: "z-parent", weight: 0.5, type: "wrapper" as const },
      { id: "a-parent", weight: 0.5, type: "wrapper" as const },
    ];
    const scores = new Map([
      ["z-parent", 80],
      ["a-parent", 80],
    ]);

    const forward = scoreDependencyRisk({ governance: "centralized", dependencies }, scores);
    const reverse = scoreDependencyRisk({ governance: "centralized", dependencies: [...dependencies].reverse() }, scores);

    expect(forward).toEqual(reverse);
    expect(forward.dependencyDiagnostics?.bindingCeiling?.id).toBe("a-parent");
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
