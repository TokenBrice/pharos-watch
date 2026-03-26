import { describe, expect, it } from "vitest";
import {
  buildDependencyGraphEdges,
  collectDependencyGraphIds,
  filterDependencyGraphEdgesToLive,
} from "../dependency-graph";
import type { StablecoinMeta } from "../../types/core";

function makeMeta(input: {
  id: string;
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
});
