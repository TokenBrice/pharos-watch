import { describe, expect, it } from "vitest";
import {
  buildDependencyGraphEdges,
  diagnoseDependencyGraph,
  filterDependencyGraphEdgesToLive,
  orderDependencyGraphNodes,
} from "../dependency-graph";
import { deriveDependencies, deriveEffectiveDependencies, deriveEffectiveDependencySet } from "../dependency-derivation";
import type { StablecoinMeta } from "../../types/core";
import { ReserveSliceSchema } from "../../types/reserves";
import { StablecoinReservesResponseSchema } from "../../types/live-reserves";

function makeMeta(input: {
  id: string;
  variantOf?: string;
  variantKind?: "savings-passthrough" | "strategy-vault" | "risk-absorption";
  reserves?: StablecoinMeta["reserves"];
  dependencies?: Array<{
    id: string;
    weight: number;
    type?: "wrapper" | "mechanism" | "collateral";
  }>;
}): StablecoinMeta {
  return input as unknown as StablecoinMeta;
}

describe("dependency-graph", () => {
  it("withholds only untyped live identities and names and counts them", () => {
    const snapshot = StablecoinReservesResponseSchema.parse({
      stablecoinId: "dependent", mode: "live", estimated: false,
      reserves: [
        { name: "Untyped", pct: 70, risk: "low", coinId: "missing" },
        { name: "Typed", pct: 30, risk: "low", coinId: "mapped", depType: "collateral" },
      ],
    });
    const result = deriveEffectiveDependencySet(makeMeta({
      id: "dependent",
      reserves: [{ name: "Curated", pct: 100, risk: "low", coinId: "other", depType: "collateral" }],
    }), {
      liveReserveSlices: snapshot.reserves,
      rejectionReasons: [],
    });
    expect(result.dependencies).toEqual([{ id: "mapped", weight: 0.3, type: "collateral" }]);
    expect(result.mappedLiveReserveWeight).toBe(0.3);
    expect(result.coinIdWithoutDepTypeCount).toBe(1);
    expect(result.rejectionReasons).toEqual([{ sliceIndex: 0, reason: "coinId-without-depType", upstreamAssetId: "missing" }]);
    const allMissing = deriveEffectiveDependencySet(makeMeta({ id: "dependent" }), {
      liveReserveSlices: [{ name: "Untyped", pct: 100, risk: "low", coinId: "missing" }],
    });
    expect(allMissing.baseSource).toBe("live-unmapped");
    expect(allMissing.dependencies).toEqual([]);
    expect(allMissing.coinIdWithoutDepTypeCount).toBe(1);
  });

  it("inherits a unique reviewed type by native identity without changing live weight", () => {
    const result = deriveEffectiveDependencySet(makeMeta({
      id: "dependent", reserves: [
        { sourceKey: "reviewed:old", name: "Reviewed USDC", pct: 100, risk: "low", coinId: "upstream", depType: "collateral" },
      ],
    }), {
      liveReserveSlices: [{ sourceKey: "live:new", name: "Native USDC", pct: 30, risk: "low", coinId: "upstream" }],
    });
    expect(result.dependencies).toEqual([{ id: "upstream", weight: 0.3, type: "collateral" }]);
    expect(result.rejectionReasons).toEqual([]);
    expect(result.coinIdWithoutDepTypeCount).toBe(0);
  });

  it("inherits adapter-declared kinds but never chooses between conflicting reviewed kinds", () => {
    const config: NonNullable<StablecoinMeta["liveReservesConfig"]> = {
      adapter: "single-asset",
      version: 2,
      semantics: "single-asset",
      inputs: { primary: { kind: "http-json", url: "https://example.com/reserves" } },
      params: { slices: [{ sourceKey: "fixture:upstream", coinId: "upstream", depType: "mechanism" }] },
    };
    const liveReserveSlices = [{ sourceKey: "fixture:upstream", name: "Native", pct: 100, risk: "low" as const, coinId: "upstream" }];
    const result = deriveEffectiveDependencySet({ ...makeMeta({ id: "dependent" }), liveReservesConfig: config }, { liveReserveSlices });
    expect(result.dependencies).toEqual([{ id: "upstream", weight: 1, type: "mechanism" }]);
    expect(result.coinIdWithoutDepTypeCount).toBe(0);
    const conflict = deriveEffectiveDependencySet({
      ...makeMeta({ id: "dependent", reserves: [{ name: "Reviewed", pct: 100, risk: "low", coinId: "upstream", depType: "collateral" }] }),
      liveReservesConfig: config,
    }, { liveReserveSlices });
    expect(conflict.dependencies).toEqual([]);
    expect(conflict.rejectionReasons).toEqual([{ sliceIndex: 0, reason: "coinId-without-depType", upstreamAssetId: "upstream" }]);
    expect(conflict.coinIdWithoutDepTypeCount).toBe(1);
  });

  const metas = [
    makeMeta({ id: "upstream" }),
    makeMeta({
      id: "dependent-a",
      reserves: [
        { name: "Upstream reserve", pct: 60, risk: "low", coinId: "upstream", depType: "collateral" },
        { name: "Other reserve", pct: 40, risk: "low" },
      ],
    }),
    makeMeta({
      id: "dependent-b",
      dependencies: [{ id: "upstream", weight: 0.5, type: "wrapper" }],
    }),
  ];

  it("builds canonical dependency edges from reserves and fallback dependencies", () => {
    const edges = buildDependencyGraphEdges(metas);
    expect(edges).toEqual([
      { from: "upstream", to: "dependent-a", weight: 0.6, type: "collateral" },
      { from: "upstream", to: "dependent-b", weight: 0.5, type: "wrapper" },
    ]);
  });

  it("filters dependency edges to the live set", () => {
    const edges = filterDependencyGraphEdgesToLive(
      buildDependencyGraphEdges(metas),
      new Set(["upstream", "dependent-a"]),
    );
    expect(edges).toEqual([{ from: "upstream", to: "dependent-a", weight: 0.6, type: "collateral" }]);
  });

  it("emits a single synthetic wrapper edge for tracked variants", () => {
    const edges = buildDependencyGraphEdges([
      makeMeta({
        id: "parent",
      }),
      makeMeta({
        id: "child",
        variantOf: "parent",
        variantKind: "savings-passthrough",
        reserves: [{ name: "Parent reserve", pct: 100, risk: "low", coinId: "parent", depType: "collateral" }],
      }),
    ]);

    expect(edges).toEqual([{ from: "parent", to: "child", weight: 1, type: "wrapper" }]);
  });

  it("emits the synthetic wrapper edge even when a strategy-vault child has no parent reserve slice", () => {
    const edges = buildDependencyGraphEdges([
      makeMeta({ id: "parent" }),
      makeMeta({
        id: "child",
        variantOf: "parent",
        variantKind: "strategy-vault",
        reserves: [{ name: "Strategy book", pct: 100, risk: "high" }],
      }),
    ]);

    expect(edges).toEqual([{ from: "parent", to: "child", weight: 1, type: "wrapper" }]);
  });

  it("prefers linked live reserve slices over curated linked slices", () => {
    const meta = makeMeta({
      id: "dependent",
      reserves: [{ name: "Curated upstream", pct: 100, risk: "low", coinId: "curated-upstream", depType: "collateral" }],
    });

    const dependencies = deriveEffectiveDependencies(meta, {
      liveReserveSlices: [
        { name: "Live upstream", pct: 65, risk: "low", coinId: "live-upstream", depType: "mechanism" },
        { name: "T-bills", pct: 35, risk: "very-low" },
      ],
    });

    expect(dependencies).toEqual([{ id: "live-upstream", weight: 0.65, type: "mechanism" }]);
  });

  it("keeps unmapped live reserve share as implicit self-backed remainder", () => {
    const dependencies = deriveEffectiveDependencies(
      makeMeta({
        id: "dependent",
        reserves: [{ name: "Curated upstream", pct: 100, risk: "low", coinId: "curated-upstream", depType: "collateral" }],
      }),
      {
        liveReserveSlices: [
          { name: "Live upstream", pct: 40, risk: "low", coinId: "live-upstream", depType: "collateral" },
          { name: "Cash and bills", pct: 60, risk: "very-low" },
        ],
      },
    );

    expect(dependencies).toEqual([{ id: "live-upstream", weight: 0.4, type: "collateral" }]);
  });

  it("canonicalizes machine-precision drift for an exact full-weight live reserve basket", () => {
    const result = deriveEffectiveDependencySet(makeMeta({ id: "dependent" }), {
      liveReserveSlices: [
        { name: "sfrxUSD", pct: 37.976681, risk: "medium", coinId: "sfrxusd-frax", depType: "collateral" },
        { name: "sUSDe", pct: 37.173171, risk: "medium", coinId: "susde-ethena", depType: "collateral" },
        { name: "ygamiUSDC", pct: 12.235688, risk: "high", coinId: "usdc-circle", depType: "collateral" },
        { name: "sUSDS", pct: 11.924473, risk: "low", coinId: "susds-sky", depType: "collateral" },
        { name: "USDe", pct: 0.657631, risk: "medium", coinId: "usde-ethena", depType: "collateral" },
        { name: "USDC", pct: 0.024855, risk: "low", coinId: "usdc-circle", depType: "collateral" },
        { name: "frxUSD", pct: 0.006503, risk: "low", coinId: "frxusd-frax", depType: "collateral" },
        { name: "USDS", pct: 0.000998, risk: "low", coinId: "usds-sky", depType: "collateral" },
      ],
    });

    expect(result.dependencies.reduce((sum, dependency) => sum + dependency.weight, 0)).toBeGreaterThan(1);
    expect(result.mappedLiveReserveWeight).toBe(1);
  });

  it("preserves material live reserve overweights for fail-closed validation", () => {
    const result = deriveEffectiveDependencySet(makeMeta({ id: "dependent" }), {
      liveReserveSlices: [
        { name: "Upstream A", pct: 60, risk: "low", coinId: "upstream-a", depType: "collateral" },
        { name: "Upstream B", pct: 40.001, risk: "low", coinId: "upstream-b", depType: "collateral" },
      ],
    });

    expect(result.mappedLiveReserveWeight).toBeCloseTo(1.00001, 12);
  });

  it("preserves tiny positive linked shares through aggregation and mapped totals", () => {
    const reserves = [
      { name: "Small holding A", pct: 0.000148, risk: "low" as const, coinId: "upstream", depType: "collateral" as const },
      { name: "Small holding B", pct: 0.000148, risk: "low" as const, coinId: "upstream", depType: "collateral" as const },
    ];
    const meta = makeMeta({ id: "dependent", reserves });
    expect(deriveDependencies(meta)[0].weight).toBeCloseTo(0.00000296, 14);
    const live = deriveEffectiveDependencySet(meta, { liveReserveSlices: reserves });
    expect(live.dependencies[0].weight).toBeCloseTo(0.00000296, 14);
    expect(live.mappedLiveReserveWeight).toBeCloseTo(0.00000296, 14);
    const smaller = deriveEffectiveDependencySet(meta, {
      liveReserveSlices: [{ ...reserves[0], pct: 0.0000000000148 }],
    });
    expect(smaller.mappedLiveReserveWeight).toBeGreaterThan(0);
  });

  it("rejects manual collateral absent from linked reserve identities", () => {
    const meta = makeMeta({
      id: "dependent",
      reserves: [{ name: "Backing", pct: 40, risk: "low", coinId: "backing", depType: "collateral" }],
      dependencies: [
        { id: "backing", weight: 0.8, type: "collateral" },
        { id: "missing", weight: 0.2, type: "collateral" },
        { id: "operator", weight: 1, type: "mechanism" },
      ],
    });
    const rejection = {
      sliceIndex: -1, reason: "manual-collateral-not-in-reserves",
      manualDependencyIndex: 1, upstreamAssetId: "missing", share: 0.2,
    };
    expect(deriveEffectiveDependencySet(meta)).toMatchObject({
      dependencies: [
        { id: "backing", weight: 0.4, type: "collateral" },
        { id: "operator", weight: 1, type: "mechanism" },
      ],
      rejectionReasons: [rejection],
    });
    expect(deriveEffectiveDependencySet(meta, { liveReserveSlices: meta.reserves })).toMatchObject({
      rejectionReasons: [rejection],
    });
    expect(() => deriveDependencies(meta)).toThrow(expect.objectContaining({
      code: "manual-collateral-not-in-reserves", rejectionReasons: [rejection],
    }));
  });

  it("retains intermediary provenance on reserve-derived basket and wrapper claims", () => {
    const intermediary = { kind: "bridge" as const, label: "USDC.e", chain: "Polygon", verified: true };
    for (const depType of ["collateral", "wrapper"] as const) {
      const reserve = ReserveSliceSchema.parse({
        name: "USDC.e", pct: 80, risk: "low", coinId: "usdc-circle", depType, intermediary,
      });
      const meta = makeMeta({ id: "dependent", reserves: [reserve] });
      expect(deriveEffectiveDependencySet(meta).dependencies[0]).toMatchObject({
        id: "usdc-circle", weight: depType === "wrapper" ? 1 : 0.8, intermediary,
      });
      expect(deriveEffectiveDependencySet(makeMeta({
        id: "variant", variantOf: "usdc-circle", reserves: [reserve],
      })).dependencies[0].intermediary).toEqual(depType === "wrapper" ? intermediary : undefined);
    }
    expect(ReserveSliceSchema.safeParse({
      name: "Unlinked representation", pct: 100, risk: "low", intermediary,
    }).success).toBe(false);
  });

  it("does not attribute a partial intermediary to an aggregate or synthetic parent claim", () => {
    const intermediary = { kind: "bridge" as const, label: "USDC.e", verified: true };
    const reserves = [
      { name: "Legacy", pct: 27.46, risk: "low" as const, coinId: "usdc-circle", depType: "wrapper" as const, intermediary },
      { name: "Native", pct: 72.54, risk: "low" as const, coinId: "usdc-circle", depType: "wrapper" as const },
    ];
    for (const slices of [reserves, [...reserves].reverse()]) {
      expect(deriveEffectiveDependencySet(makeMeta({ id: "dependent", reserves: slices })).dependencies)
        .toEqual([{ id: "usdc-circle", weight: 1, type: "wrapper" }]);
    }
    expect(deriveEffectiveDependencySet(makeMeta({
      id: "dependent", variantOf: "usdc-circle", reserves,
    })).dependencies).toEqual([{ id: "usdc-circle", weight: 1, type: "wrapper" }]);
  });

  it("accepts keyed zero-percent reviewed rows without admitting dependency edges", () => {
    for (const depType of ["collateral", "wrapper", "mechanism"] as const) {
      const reserve = ReserveSliceSchema.parse({
        sourceKey: "fixture:zero", name: "Reviewed absent holding", pct: 0,
        risk: "low", coinId: "upstream", depType,
      });
      const meta = makeMeta({ id: "dependent", reserves: [reserve] });
      expect(deriveDependencies(meta)).toEqual([]);
      expect(deriveEffectiveDependencySet(meta).dependencies).toEqual([]);
      expect(deriveEffectiveDependencySet(meta, { liveReserveSlices: [reserve] }).dependencies).toEqual([]);
    }
    expect(ReserveSliceSchema.safeParse({
      name: "Unkeyed zero holding", pct: 0, risk: "low",
    }).success).toBe(false);
  });

  it("never restores curated weights for wholly unmapped live reserves", () => {
    const dependencies = deriveEffectiveDependencies(
      makeMeta({
        id: "dependent",
        reserves: [{ name: "Curated upstream", pct: 100, risk: "low", coinId: "curated-upstream", depType: "collateral" }],
      }),
      {
        liveReserveSlices: [
          { name: "Cash and bills", pct: 80, risk: "very-low" },
          { name: "Tokenized treasuries", pct: 20, risk: "low" },
        ],
      },
    );

    expect(dependencies).toEqual([]);
  });

  it("never restores manual weights for wholly unmapped live reserves", () => {
    const result = deriveEffectiveDependencySet(
      makeMeta({
        id: "dependent",
        dependencies: [{ id: "manual-upstream", weight: 1, type: "collateral" }],
      }),
      {
        liveReserveSlices: [
          { name: "Cash and bills", pct: 80, risk: "very-low" },
          { name: "Tokenized treasuries", pct: 20, risk: "low" },
        ],
      },
    );

    expect(result).toMatchObject({
      dependencies: [],
      source: "live-unmapped",
      baseSource: "live-unmapped",
      dependencyFromLive: true,
      mappedLiveReserveWeight: 0,
      fallbackReason: null,
      rejectionReasons: [
        { sliceIndex: 0, reason: "no-match" },
        { sliceIndex: 1, reason: "no-match" },
      ],
    });
  });

  it("retains a strategy variant's parent when its live reserve link is a reviewed non-link", () => {
    const result = deriveEffectiveDependencySet(
      makeMeta({
        id: "yousd-yield-optimizer",
        variantOf: "usdc-circle",
        variantKind: "strategy-vault",
        reserves: [{ name: "USDC strategies", pct: 100, risk: "medium", coinId: "usdc-circle", depType: "collateral" }],
      }),
      {
        liveReserveSlices: [{ name: "USDC strategies", pct: 100, risk: "medium" }],
        rejectionReasons: [{ sliceIndex: 0, reason: "non-link" }],
      },
    );

    expect(result).toMatchObject({
      dependencies: [{ id: "usdc-circle", weight: 1, type: "wrapper" }],
      source: "variant",
      baseSource: "live-unmapped",
      mappedLiveReserveWeight: 0,
      fallbackReason: null,
      rejectionReasons: [{ sliceIndex: 0, reason: "non-link" }],
    });
  });

  it("retains manual structural dependencies without reviving their collateral weights", () => {
    const meta = makeMeta({
      id: "dependent",
      dependencies: [
        { id: "parent", weight: 1, type: "wrapper" },
        { id: "operator", weight: 1, type: "mechanism" },
        { id: "old-backing", weight: 0.8, type: "collateral" },
      ],
    });

    expect(deriveEffectiveDependencies(meta, {
      liveReserveSlices: [{ name: "Unmapped book", pct: 100, risk: "low" }],
    })).toEqual([
      { id: "parent", weight: 1, type: "wrapper" },
      { id: "operator", weight: 1, type: "mechanism" },
    ]);
    expect(deriveEffectiveDependencies(meta, {
      liveReserveSlices: [{ name: "Live backing", pct: 40, risk: "low", coinId: "new-backing", depType: "collateral" }],
    })).toEqual([
      { id: "new-backing", weight: 0.4, type: "collateral" },
      { id: "parent", weight: 1, type: "wrapper" },
      { id: "operator", weight: 1, type: "mechanism" },
    ]);
  });

  it("derives an explicit wrapped-asset claim independently of curated reserve percentages", () => {
    expect(deriveEffectiveDependencies(makeMeta({
      id: "usdk-kast",
      reserves: [{ name: "M0 extension vault", pct: 80, risk: "low", coinId: "m-m0", depType: "wrapper" }],
    }), {
      liveReserveSlices: [{ name: "Eligible collateral", pct: 100, risk: "low" }],
    })).toEqual([{ id: "m-m0", weight: 1, type: "wrapper" }]);
  });

  it("keeps live-unmapped provenance when unmapped live reserve slices have no fallback dependencies", () => {
    const result = deriveEffectiveDependencySet(
      makeMeta({
        id: "dependent",
      }),
      {
        liveReserveSlices: [
          { name: "Cash and bills", pct: 80, risk: "very-low" },
          { name: "Tokenized treasuries", pct: 20, risk: "low" },
        ],
      },
    );

    expect(result).toMatchObject({
      dependencies: [],
      source: "live-unmapped",
      baseSource: "live-unmapped",
      dependencyFromLive: true,
      mappedLiveReserveWeight: 0,
    });
  });

  it("uses live reserve slices when building graph edges", () => {
    const edges = buildDependencyGraphEdges(
      [
        makeMeta({ id: "curated-upstream" }),
        makeMeta({ id: "live-upstream" }),
        makeMeta({
          id: "dependent",
          reserves: [{ name: "Curated upstream", pct: 100, risk: "low", coinId: "curated-upstream", depType: "collateral" }],
        }),
      ],
      {
        liveReserveSlicesById: new Map([
          [
            "dependent",
            [
              { name: "Live upstream", pct: 25, risk: "low", coinId: "live-upstream", depType: "collateral" },
              { name: "Other live reserve", pct: 75, risk: "very-low" },
            ],
          ],
        ]),
      },
    );

    expect(edges).toEqual([{ from: "live-upstream", to: "dependent", weight: 0.25, type: "collateral" }]);
  });

  it("keeps the variant parent wrapper edge dominant over duplicate live parent reserve links", () => {
    const edges = buildDependencyGraphEdges(
      [
        makeMeta({ id: "parent" }),
        makeMeta({
          id: "child",
          variantOf: "parent",
          variantKind: "strategy-vault",
          reserves: [{ name: "Strategy book", pct: 100, risk: "high" }],
        }),
      ],
      {
        liveReserveSlicesById: new Map([
          ["child", [{ name: "Parent live reserve", pct: 100, risk: "low", coinId: "parent", depType: "collateral" }]],
        ]),
      },
    );

    expect(edges).toEqual([{ from: "parent", to: "child", weight: 1, type: "wrapper" }]);
  });

  it("does not double-count a variant parent's reserve book as parallel exposure", () => {
    const result = deriveEffectiveDependencySet(
      makeMeta({
        id: "child",
        variantOf: "parent",
        variantKind: "strategy-vault",
        reserves: [{ name: "Parent reserve sleeve", pct: 82.35, risk: "low", coinId: "upstream", depType: "collateral" }],
      }),
    );

    expect(result.dependencies).toEqual([{ id: "parent", weight: 1, type: "wrapper" }]);
  });

  it("suppresses self-links in derivation and graph emission", () => {
    const meta = makeMeta({
      id: "subject",
      reserves: [
        { name: "Treasury-held subject", pct: 25, risk: "low", coinId: "subject", depType: "collateral" },
        { name: "External upstream", pct: 75, risk: "low", coinId: "upstream", depType: "collateral" },
      ],
    });

    expect(deriveEffectiveDependencies(meta)).toEqual([{ id: "upstream", weight: 0.75, type: "collateral" }]);
    expect(buildDependencyGraphEdges([meta])).toEqual([
      { from: "upstream", to: "subject", weight: 0.75, type: "collateral" },
    ]);
  });

  it("diagnoses self-links, duplicate keys, and multi-node SCCs deterministically", () => {
    const edges = [
      { from: "b", to: "a", weight: 0.4, type: "collateral" as const },
      { from: "a", to: "b", weight: 0.3, type: "mechanism" as const },
      { from: "a", to: "b", weight: 0.2, type: "mechanism" as const },
      { from: "self", to: "self", weight: 1, type: "wrapper" as const },
    ];

    const diagnostics = diagnoseDependencyGraph(edges);
    expect(diagnostics.selfEdges).toEqual([{ from: "self", to: "self", weight: 1, type: "wrapper" }]);
    expect(diagnostics.duplicateEdges).toEqual([
      {
        key: "a->b:mechanism",
        count: 2,
        edges: [
          { from: "a", to: "b", weight: 0.2, type: "mechanism" },
          { from: "a", to: "b", weight: 0.3, type: "mechanism" },
        ],
      },
    ]);
    expect(diagnostics.stronglyConnectedComponents).toEqual([["a", "b"]]);
    expect(diagnoseDependencyGraph([...edges].reverse())).toEqual(diagnostics);
  });

  it("orders the SCC-collapsed graph without hiding cyclic components", () => {
    const edges = [
      { from: "a", to: "b", weight: 1, type: "wrapper" as const },
      { from: "b", to: "a", weight: 1, type: "wrapper" as const },
      { from: "b", to: "child", weight: 1, type: "wrapper" as const },
    ];
    const result = orderDependencyGraphNodes(["child", "free", "b", "a"], edges);
    expect(result.cyclicComponents).toEqual([["a", "b"]]);
    expect(result.order.indexOf("a")).toBeLessThan(result.order.indexOf("child"));
    expect(result.order.indexOf("b")).toBeLessThan(result.order.indexOf("child"));
    expect([...result.order].sort()).toEqual(["a", "b", "child", "free"]);
    expect(orderDependencyGraphNodes(["a", "b", "free", "child"], [...edges].reverse())).toEqual(result);
  });

  it("collapses overlapping self-loops once while preserving every node", () => {
    const edges = [
      { from: "a", to: "b", weight: 1, type: "wrapper" as const },
      { from: "b", to: "a", weight: 1, type: "wrapper" as const },
      { from: "b", to: "b", weight: 1, type: "wrapper" as const },
      { from: "b", to: "child", weight: 1, type: "wrapper" as const },
      { from: "self", to: "self", weight: 1, type: "wrapper" as const },
      { from: "self", to: "self", weight: 0.5, type: "collateral" as const },
    ];
    const result = orderDependencyGraphNodes(["child", "free", "b", "a", "self"], edges);
    expect(result).toEqual({
      order: ["a", "b", "child", "free", "self"],
      cyclicComponents: [["a", "b"], ["self"]],
    });
    expect(orderDependencyGraphNodes(["self", "a", "b", "free", "child"], [...edges].reverse())).toEqual(result);
  });
});
