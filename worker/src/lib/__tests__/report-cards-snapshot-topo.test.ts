import { describe, it, expect } from "vitest";
import { topologicalOrder } from "../report-cards-snapshot";
import { isBlacklistable } from "@shared/lib/report-cards";
import type { StablecoinMeta, GovernanceType } from "@shared/types/core";

function makeMeta(
  id: string,
  reserves?: Array<{ coinId?: string; pct: number; name: string; risk: "low"; blacklistable?: boolean }>,
  overrides?: { governance?: GovernanceType; canBeBlacklisted?: boolean | "possible" },
): StablecoinMeta {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    flags: { governance: overrides?.governance ?? "centralized", backing: "rwa-backed" },
    reserves: reserves ?? [],
    ...(overrides?.canBeBlacklisted !== undefined && { canBeBlacklisted: overrides.canBeBlacklisted }),
  } as unknown as StablecoinMeta;
}

describe("topologicalOrder", () => {
  it("returns isolated nodes in original order", () => {
    const metas = [makeMeta("a"), makeMeta("b"), makeMeta("c")];
    const sorted = topologicalOrder(metas);
    expect(sorted.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("places upstream before downstream", () => {
    const metas = [
      makeMeta("downstream", [{ coinId: "upstream", pct: 50, name: "X", risk: "low" }]),
      makeMeta("upstream"),
    ];
    const sorted = topologicalOrder(metas);
    const ids = sorted.map((m) => m.id);
    expect(ids.indexOf("upstream")).toBeLessThan(ids.indexOf("downstream"));
  });

  it("handles diamond dependencies", () => {
    const metas = [
      makeMeta("d", [
        { coinId: "b", pct: 30, name: "B", risk: "low" },
        { coinId: "c", pct: 30, name: "C", risk: "low" },
      ]),
      makeMeta("b", [{ coinId: "a", pct: 50, name: "A", risk: "low" }]),
      makeMeta("c", [{ coinId: "a", pct: 50, name: "A", risk: "low" }]),
      makeMeta("a"),
    ];
    const sorted = topologicalOrder(metas);
    const ids = sorted.map((m) => m.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
    expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"));
  });

  it("does not hang on circular dependencies", () => {
    const metas = [
      makeMeta("x", [{ coinId: "y", pct: 50, name: "Y", risk: "low" }]),
      makeMeta("y", [{ coinId: "x", pct: 50, name: "X", risk: "low" }]),
    ];
    // Should not hang — visited set prevents infinite recursion
    const sorted = topologicalOrder(metas);
    expect(sorted).toHaveLength(2);
  });
});

describe("transitive blacklist inheritance", () => {
  /** Simulate the transitive set-growing loop from buildReportCardsSnapshot. */
  function buildTransitiveSet(metas: StablecoinMeta[]): Set<string> {
    const sorted = topologicalOrder([...metas]);
    const blacklistableIds = new Set(
      metas.filter((m) => isBlacklistable(m) === true).map((m) => m.id),
    );
    for (const m of sorted) {
      const bl = isBlacklistable(m, blacklistableIds);
      if (bl === true || bl === "inherited") blacklistableIds.add(m.id);
    }
    return blacklistableIds;
  }

  it("second-order coin inherits through an intermediate", () => {
    const metas = [
      makeMeta("centralized-coin", []),
      makeMeta("middle", [{ coinId: "centralized-coin", pct: 60, name: "X", risk: "low" }], {
        governance: "centralized-dependent",
      }),
      makeMeta("downstream", [{ coinId: "middle", pct: 80, name: "Y", risk: "low" }], {
        governance: "decentralized",
      }),
    ];
    const ids = buildTransitiveSet(metas);
    expect(ids.has("centralized-coin")).toBe(true);
    expect(ids.has("middle")).toBe(true);
    expect(ids.has("downstream")).toBe(true);
  });

  it("does not add coins below the 50% threshold", () => {
    const metas = [
      makeMeta("upstream", []),
      makeMeta("downstream", [{ coinId: "upstream", pct: 40, name: "X", risk: "low" }], {
        governance: "decentralized",
      }),
    ];
    const ids = buildTransitiveSet(metas);
    expect(ids.has("upstream")).toBe(true);
    expect(ids.has("downstream")).toBe(false);
  });

  it("explicit canBeBlacklisted: false blocks transitivity", () => {
    const metas = [
      makeMeta("root", []),
      makeMeta("middle", [{ coinId: "root", pct: 100, name: "X", risk: "low" }], {
        governance: "centralized-dependent",
        canBeBlacklisted: false,
      }),
      makeMeta("leaf", [{ coinId: "middle", pct: 80, name: "Y", risk: "low" }], {
        governance: "decentralized",
      }),
    ];
    const ids = buildTransitiveSet(metas);
    expect(ids.has("root")).toBe(true);
    expect(ids.has("middle")).toBe(false);
    expect(ids.has("leaf")).toBe(false);
  });
});
