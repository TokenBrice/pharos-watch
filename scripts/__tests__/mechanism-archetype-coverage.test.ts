import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "../../shared/types";
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

    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "missing-unresolved-review",
      "invalid-override-review",
    ]);
  });
});
