import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import { analyzeMechanismArchetypeCoverage } from "../lib/mechanism-archetype-coverage";

function coin(id: string, overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id,
    name: id,
    symbol: id,
    flags: {
      backing: "crypto-backed",
      pegCurrency: "USD",
      governance: "decentralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    ...overrides,
  };
}

describe("mechanism archetype coverage", () => {
  it("counts direct, inherited, and reviewed unresolved coverage", () => {
    const result = analyzeMechanismArchetypeCoverage([
      coin("parent", { mechanismArchetype: "cdp" }),
      coin("child", { variantOf: "parent", variantKind: "strategy-vault" }),
      coin("unresolved", {
        mechanismArchetypeReview: {
          disposition: "unresolved",
          reviewedAt: "2026-07-13",
          reviewer: "test",
          rationale: "The mechanism does not fit the current taxonomy.",
          sources: [{ label: "Docs", url: "https://example.com/docs" }],
        },
      }),
    ]);

    expect(result).toMatchObject({ active: 3, direct: 1, inherited: 1, reviewedUnresolved: 1, resolved: 2 });
    expect(result.findings).toEqual([]);
  });

  it("blocks silent gaps and unreviewed overrides", () => {
    const result = analyzeMechanismArchetypeCoverage([
      coin("gap"),
      coin("override", {
        mechanismArchetype: "tbill",
        archetypeOverride: true,
      }),
    ]);

    expect(result.findings.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "gap", kind: "missing-unresolved-review" },
      { id: "override", kind: "invalid-override-review" },
    ]);
  });

  it("excludes inactive parents from both totals and inheritance", () => {
    const result = analyzeMechanismArchetypeCoverage([
      coin("parent", { status: "pre-launch", mechanismArchetype: "cdp" }),
      coin("child", { variantOf: "parent", variantKind: "strategy-vault" }),
    ]);
    expect(result).toMatchObject({ active: 1, direct: 0, inherited: 0, reviewedUnresolved: 0, resolved: 0 });
    expect(result.findings.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "child", kind: "missing-unresolved-review" },
    ]);
  });

  it("does not count a variant's unresolved review when its parent cannot resolve", () => {
    const result = analyzeMechanismArchetypeCoverage([
      coin("parent"),
      coin("child", {
        variantOf: "parent",
        variantKind: "strategy-vault",
        mechanismArchetypeReview: {
          disposition: "unresolved", reviewedAt: "2026-07-13", reviewer: "test",
          rationale: "No classified parent.", sources: [{ label: "Docs", url: "https://example.com" }],
        },
      }),
    ]);
    expect(result).toMatchObject({ active: 2, reviewedUnresolved: 0, resolved: 0 });
    expect(result.findings.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "child", kind: "missing-classification" },
      { id: "parent", kind: "missing-unresolved-review" },
    ]);
  });

  it("requires a classification with resolved review metadata and accepts a reviewed override", () => {
    const review = {
      disposition: "resolved" as const, reviewedAt: "2026-07-13", reviewer: "test",
      rationale: "Reviewed mechanism.", sources: [{ label: "Docs", url: "https://example.com" }],
    };
    const result = analyzeMechanismArchetypeCoverage([
      coin("gap", { mechanismArchetypeReview: review }),
      coin("override", { mechanismArchetype: "tbill", archetypeOverride: true, mechanismArchetypeReview: review }),
    ]);
    expect(result).toMatchObject({ active: 2, direct: 1, inherited: 0, reviewedUnresolved: 0, resolved: 1 });
    expect(result.findings.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "gap", kind: "missing-classification" },
    ]);
  });
});
