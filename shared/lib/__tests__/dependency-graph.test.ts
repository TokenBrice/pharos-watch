import { describe, expect, it } from "vitest";
import {
  buildDependencyGraphEdges,
  diagnoseDependencyGraph,
  filterDependencyGraphEdgesToLive,
} from "../dependency-graph";
import { deriveEffectiveDependencies, deriveEffectiveDependencySet } from "../dependency-derivation";
import type { StablecoinMeta } from "../../types/core";

function makeMeta(input: {
  id: string;
  variantOf?: string;
  variantKind?: "savings-passthrough" | "strategy-vault" | "risk-absorption";
  reserves?: Array<{
    name: string;
    pct: number;
    risk: "very-low" | "low" | "medium" | "high" | "very-high";
    coinId?: string;
    depType?: "wrapper" | "mechanism" | "collateral";
  }>;
  dependencies?: Array<{
    id: string;
    weight: number;
    type?: "wrapper" | "mechanism" | "collateral";
  }>;
}): StablecoinMeta {
  return input as unknown as StablecoinMeta;
}

describe("dependency-graph", () => {
  const metas = [
    makeMeta({ id: "upstream" }),
    makeMeta({
      id: "dependent-a",
      reserves: [
        { name: "Upstream reserve", pct: 60, risk: "low", coinId: "upstream" },
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
      reserves: [{ name: "Curated upstream", pct: 100, risk: "low", coinId: "curated-upstream" }],
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
        reserves: [{ name: "Curated upstream", pct: 100, risk: "low", coinId: "curated-upstream" }],
      }),
      {
        liveReserveSlices: [
          { name: "Live upstream", pct: 40, risk: "low", coinId: "live-upstream" },
          { name: "Cash and bills", pct: 60, risk: "very-low" },
        ],
      },
    );

    expect(dependencies).toEqual([{ id: "live-upstream", weight: 0.4, type: "collateral" }]);
  });

  it("falls back to curated dependencies when live reserve slices have no tracked upstreams", () => {
    const dependencies = deriveEffectiveDependencies(
      makeMeta({
        id: "dependent",
        reserves: [{ name: "Curated upstream", pct: 100, risk: "low", coinId: "curated-upstream", depType: "wrapper" }],
      }),
      {
        liveReserveSlices: [
          { name: "Cash and bills", pct: 80, risk: "very-low" },
          { name: "Tokenized treasuries", pct: 20, risk: "low" },
        ],
      },
    );

    expect(dependencies).toEqual([{ id: "curated-upstream", weight: 1, type: "wrapper" }]);
  });

  it("exposes fallback provenance when unmapped live reserve slices use manual dependencies", () => {
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
      dependencies: [{ id: "manual-upstream", weight: 1, type: "collateral" }],
      source: "manual",
      baseSource: "manual",
      dependencyFromLive: false,
      mappedLiveReserveWeight: 0,
      fallbackReason: "live-unmapped-to-manual",
    });
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
          reserves: [{ name: "Curated upstream", pct: 100, risk: "low", coinId: "curated-upstream" }],
        }),
      ],
      {
        liveReserveSlicesById: new Map([
          [
            "dependent",
            [
              { name: "Live upstream", pct: 25, risk: "low", coinId: "live-upstream" },
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
        reserves: [{ name: "Parent reserve sleeve", pct: 82.35, risk: "low", coinId: "upstream" }],
      }),
    );

    expect(result.dependencies).toEqual([{ id: "parent", weight: 1, type: "wrapper" }]);
  });

  it("suppresses self-links in derivation and graph emission", () => {
    const meta = makeMeta({
      id: "subject",
      reserves: [
        { name: "Treasury-held subject", pct: 25, risk: "low", coinId: "subject" },
        { name: "External upstream", pct: 75, risk: "low", coinId: "upstream" },
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
});
