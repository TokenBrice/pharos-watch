import { describe, it, expect } from "vitest";
import { topologicalOrder } from "../report-cards-snapshot";
import { DependencyGraphPolicyError, resolveDependencySetsForScoring } from "../report-cards-snapshot-card";
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

  it("rejects an unreviewed static dependency cycle", () => {
    const metas = [
      makeMeta("x", [{ coinId: "y", pct: 50, name: "Y", risk: "low" }]),
      makeMeta("y", [{ coinId: "x", pct: 50, name: "X", risk: "low" }]),
    ];
    expect(() => topologicalOrder(metas)).toThrow(DependencyGraphPolicyError);
    expect(() => topologicalOrder(metas)).toThrow("static-scc-unreviewed");
  });

  it("falls live cycle members back to their acyclic curated dependency sets", () => {
    const metas = [
      makeMeta("a", [{ coinId: "c", pct: 50, name: "C", risk: "low" }]),
      makeMeta("b", [{ coinId: "c", pct: 25, name: "C", risk: "low" }]),
      makeMeta("c"),
    ];
    const sets = resolveDependencySetsForScoring(
      metas,
      new Map([
        ["a", [{ coinId: "b", pct: 100, name: "B", risk: "low" }]],
        ["b", [{ coinId: "a", pct: 100, name: "A", risk: "low" }]],
      ]),
    );

    expect(sets.get("a")).toMatchObject({
      dependencies: [{ id: "c", weight: 0.5, type: "collateral" }],
      dependencyFromLive: false,
      fallbackReason: "live-cycle-to-curated",
    });
    expect(sets.get("b")).toMatchObject({
      dependencies: [{ id: "c", weight: 0.25, type: "collateral" }],
      dependencyFromLive: false,
      fallbackReason: "live-cycle-to-curated",
    });
  });

  it("rejects a live cycle when cycle members have no evidenced fallback", () => {
    const metas = [makeMeta("a"), makeMeta("b")];

    expect(() =>
      resolveDependencySetsForScoring(
        metas,
        new Map([
          ["a", [{ coinId: "b", pct: 100, name: "B", risk: "low" }]],
          ["b", [{ coinId: "a", pct: 100, name: "A", risk: "low" }]],
        ]),
      ),
    ).toThrow("live-scc-unresolved");
  });

  it("marks only the live-derived member when a live edge cycles with a static edge", () => {
    const metas = [
      makeMeta("a", [{ coinId: "c", pct: 50, name: "C", risk: "low" }]),
      makeMeta("b", [{ coinId: "a", pct: 100, name: "A", risk: "low" }]),
      makeMeta("c"),
    ];
    const sets = resolveDependencySetsForScoring(
      metas,
      new Map([["a", [{ coinId: "b", pct: 100, name: "B", risk: "low" }]]]),
    );

    expect(sets.get("a")).toMatchObject({
      dependencies: [{ id: "c", weight: 0.5, type: "collateral" }],
      dependencyFromLive: false,
      fallbackReason: "live-cycle-to-curated",
    });
    expect(sets.get("b")).toMatchObject({
      dependencies: [{ id: "a", weight: 1, type: "collateral" }],
      dependencyFromLive: false,
      fallbackReason: null,
    });
  });

  it("rejects duplicate dependency keys before traversal", () => {
    const metas = [makeMeta("upstream"), makeMeta("dependent")];
    expect(() =>
      topologicalOrder(metas, {
        dependenciesById: new Map([
          [
            "dependent",
            [
              { id: "upstream", weight: 0.4, type: "collateral" },
              { id: "upstream", weight: 0.3, type: "collateral" },
            ],
          ],
        ]),
      }),
    ).toThrow("live-graph-invalid");
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

  it("places upstream before downstream when the edge comes from live reserves", () => {
    const metas = [
      makeMeta("downstream", [{ coinId: "curated", pct: 100, name: "Curated", risk: "low" }]),
      makeMeta("live-upstream"),
      makeMeta("curated"),
    ];

    const sorted = topologicalOrder(metas, {
      liveReserveMap: new Map([
        [
          "downstream",
          [
            { coinId: "live-upstream", pct: 60, name: "Live upstream", risk: "low" },
            { pct: 40, name: "Cash", risk: "low" },
          ],
        ],
      ]),
    });
    const ids = sorted.map((meta) => meta.id);

    expect(ids.indexOf("live-upstream")).toBeLessThan(ids.indexOf("downstream"));
    expect(ids.indexOf("curated")).toBeGreaterThan(ids.indexOf("downstream"));
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

  it("adds coins below the old 50% threshold when upstream freeze exposure is present", () => {
    const metas = [
      makeMeta("upstream", []),
      makeMeta("downstream", [{ coinId: "upstream", pct: 40, name: "X", risk: "low" }], {
        governance: "decentralized",
      }),
    ];
    const ids = buildTransitiveSet(metas);
    expect(ids.has("upstream")).toBe(true);
    expect(ids.has("downstream")).toBe(true);
  });

  it("explicit canBeBlacklisted: false does not block upstream transitivity without reviewed rationale", () => {
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
    expect(ids.has("middle")).toBe(true);
    expect(ids.has("leaf")).toBe(true);
  });

  it("resolves cyclic dependencies to a fixed point instead of order-dependent false negatives", () => {
    const metas = [
      makeMeta(
        "a",
        [
          { name: "USDC", pct: 60, risk: "low" },
          { coinId: "b", pct: 40, name: "B", risk: "low" },
        ],
        {
          governance: "decentralized",
        },
      ),
      makeMeta(
        "b",
        [
          { coinId: "a", pct: 80, name: "A", risk: "low" },
          { name: "ETH", pct: 20, risk: "low" },
        ],
        {
          governance: "decentralized",
        },
      ),
    ];

    const resolved = resolveBlacklistStatuses(metas);

    expect(resolved.get("a")).toBe("inherited");
    expect(resolved.get("b")).toBe("inherited");
  });
});
