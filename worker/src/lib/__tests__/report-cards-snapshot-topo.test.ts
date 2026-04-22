import { describe, it, expect } from "vitest";
import { topologicalOrder } from "../report-cards-snapshot";
import { resolveBlacklistStatuses } from "@shared/lib/report-cards";
import type { StablecoinMeta, GovernanceType } from "@shared/types/core";

function makeMeta(
  id: string,
  reserves?: Array<{ coinId?: string; pct: number; name: string; risk: "low"; blacklistable?: boolean }>,
  overrides?: {
    governance?: GovernanceType;
    canBeBlacklisted?: boolean | "possible";
    variantOf?: string;
    variantKind?: "savings-passthrough" | "strategy-vault" | "risk-absorption";
  },
): StablecoinMeta {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    flags: { governance: overrides?.governance ?? "centralized", backing: "rwa-backed" },
    reserves: reserves ?? [],
    ...(overrides?.variantOf ? { variantOf: overrides.variantOf } : {}),
    ...(overrides?.variantKind ? { variantKind: overrides.variantKind } : {}),
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

  it("places a tracked variant after its parent even when reserves would imply a different edge type", () => {
    const metas = [
      makeMeta("child", [{ coinId: "parent", pct: 100, name: "Parent", risk: "low" }], {
        variantOf: "parent",
        variantKind: "risk-absorption",
      }),
      makeMeta("parent"),
    ];

    const sorted = topologicalOrder(metas);
    const ids = sorted.map((meta) => meta.id);

    expect(ids.indexOf("parent")).toBeLessThan(ids.indexOf("child"));
  });

  it("places a strategy-vault child after its parent even when the reserves do not reference the parent directly", () => {
    const metas = [
      makeMeta("child", [{ name: "Strategy book", pct: 100, risk: "low" }], {
        variantOf: "parent",
        variantKind: "strategy-vault",
      }),
      makeMeta("parent"),
    ];

    const sorted = topologicalOrder(metas);
    const ids = sorted.map((meta) => meta.id);

    expect(ids.indexOf("parent")).toBeLessThan(ids.indexOf("child"));
  });
});

describe("transitive blacklist inheritance", () => {
  function buildTransitiveSet(metas: StablecoinMeta[]): Set<string> {
    const resolved = resolveBlacklistStatuses(metas);
    return new Set(
      Array.from(resolved.entries())
        .filter(([, status]) => status === true || status === "inherited")
        .map(([id]) => id),
    );
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

  it("resolves cyclic dependencies to a fixed point instead of order-dependent false negatives", () => {
    const metas = [
      makeMeta("a", [
        { name: "USDC", pct: 60, risk: "low" },
        { coinId: "b", pct: 40, name: "B", risk: "low" },
      ], {
        governance: "decentralized",
      }),
      makeMeta("b", [
        { coinId: "a", pct: 80, name: "A", risk: "low" },
        { name: "ETH", pct: 20, risk: "low" },
      ], {
        governance: "decentralized",
      }),
    ];

    const resolved = resolveBlacklistStatuses(metas);

    expect(resolved.get("a")).toBe("inherited");
    expect(resolved.get("b")).toBe("inherited");
  });
});
