import { describe, expect, it } from "vitest";
import {
  buildDependencyGraphEdges,
  collectDependencyGraphIds,
  filterDependencyGraphEdgesToLive,
} from "../dependency-graph";
import { deriveEffectiveDependencies } from "../dependency-derivation";
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
      dependencies: [
        { id: "upstream", weight: 0.5, type: "wrapper" },
      ],
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
    expect(edges).toEqual([
      { from: "upstream", to: "dependent-a", weight: 0.6, type: "collateral" },
    ]);
  });

  it("collects both upstream and dependent ids for coverage semantics", () => {
    const ids = collectDependencyGraphIds(buildDependencyGraphEdges(metas));
    expect(ids).toEqual(new Set(["upstream", "dependent-a", "dependent-b"]));
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
        reserves: [
          { name: "Parent reserve", pct: 100, risk: "low", coinId: "parent", depType: "collateral" },
        ],
      }),
    ]);

    expect(edges).toEqual([
      { from: "parent", to: "child", weight: 1, type: "wrapper" },
    ]);
  });

  it("emits the synthetic wrapper edge even when a strategy-vault child has no parent reserve slice", () => {
    const edges = buildDependencyGraphEdges([
      makeMeta({ id: "parent" }),
      makeMeta({
        id: "child",
        variantOf: "parent",
        variantKind: "strategy-vault",
        reserves: [
          { name: "Strategy book", pct: 100, risk: "high" },
        ],
      }),
    ]);

    expect(edges).toEqual([
      { from: "parent", to: "child", weight: 1, type: "wrapper" },
    ]);
  });

  it("prefers linked live reserve slices over curated linked slices", () => {
    const meta = makeMeta({
      id: "dependent",
      reserves: [
        { name: "Curated upstream", pct: 100, risk: "low", coinId: "curated-upstream" },
      ],
    });

    const dependencies = deriveEffectiveDependencies(meta, {
      liveReserveSlices: [
        { name: "Live upstream", pct: 65, risk: "low", coinId: "live-upstream", depType: "mechanism" },
        { name: "T-bills", pct: 35, risk: "very-low" },
      ],
    });

    expect(dependencies).toEqual([
      { id: "live-upstream", weight: 0.65, type: "mechanism" },
    ]);
  });

  it("keeps unmapped live reserve share as implicit self-backed remainder", () => {
    const dependencies = deriveEffectiveDependencies(
      makeMeta({
        id: "dependent",
        reserves: [
          { name: "Curated upstream", pct: 100, risk: "low", coinId: "curated-upstream" },
        ],
      }),
      {
        liveReserveSlices: [
          { name: "Live upstream", pct: 40, risk: "low", coinId: "live-upstream" },
          { name: "Cash and bills", pct: 60, risk: "very-low" },
        ],
      },
    );

    expect(dependencies).toEqual([
      { id: "live-upstream", weight: 0.4, type: "collateral" },
    ]);
  });

  it("uses live reserve slices when building graph edges", () => {
    const edges = buildDependencyGraphEdges(
      [
        makeMeta({ id: "curated-upstream" }),
        makeMeta({ id: "live-upstream" }),
        makeMeta({
          id: "dependent",
          reserves: [
            { name: "Curated upstream", pct: 100, risk: "low", coinId: "curated-upstream" },
          ],
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

    expect(edges).toEqual([
      { from: "live-upstream", to: "dependent", weight: 0.25, type: "collateral" },
    ]);
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
          [
            "child",
            [
              { name: "Parent live reserve", pct: 100, risk: "low", coinId: "parent", depType: "collateral" },
            ],
          ],
        ]),
      },
    );

    expect(edges).toEqual([
      { from: "parent", to: "child", weight: 1, type: "wrapper" },
    ]);
  });
});
