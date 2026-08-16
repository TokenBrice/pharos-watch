import { describe, expect, it } from "vitest";
import type { DependencyGraphEdge } from "@shared/lib/dependency-graph";
import type { DependencyHubCard } from "@/lib/dependency-hubs-model";
import { buildDependencyHubsModel } from "@/lib/dependency-hubs-model";

const CARDS: readonly DependencyHubCard[] = [
  { id: "usdc-circle", name: "USD Coin", symbol: "USDC", isDefunct: false },
  { id: "dai-maker", name: "Dai", symbol: "DAI", isDefunct: false },
  { id: "frax-france", name: "Frax", symbol: "FRAX", isDefunct: false },
  { id: "ust-terra", name: "TerraClassicUSD", symbol: "USTC", isDefunct: true },
];

describe("buildDependencyHubsModel", () => {
  it("dedupes direct dependents for count and market-cap context while summing direct edge weights", () => {
    const model = buildDependencyHubsModel({
      cards: CARDS,
      edges: [
        { from: "usdc-circle", to: "dai-maker", weight: 0.6, type: "collateral" },
        { from: "usdc-circle", to: "dai-maker", weight: 0.2, type: "mechanism" },
        { from: "usdc-circle", to: "frax-france", weight: 0.1, type: "wrapper" },
        { from: "usdc-circle", to: "ust-terra", weight: 0.9, type: "collateral" },
      ] satisfies readonly DependencyGraphEdge[],
      mcapMap: new Map([
        ["usdc-circle", 100],
        ["dai-maker", 5],
        ["frax-france", 2],
        ["ust-terra", 1],
      ]),
    });

    expect(model.directEdgeCount).toBe(3);
    expect(model.uniqueDirectDependentCount).toBe(2);
    expect(model.uniqueDependentMcapUsd).toBe(7);

    const usdcHub = model.hubs.find((hub) => hub.id === "usdc-circle");
    expect(usdcHub).toBeTruthy();
    expect(usdcHub?.dependentCount).toBe(2);
    expect(usdcHub?.summedDirectDependencyWeight).toBeCloseTo(0.9);
    expect(usdcHub?.uniqueDependentMcapUsd).toBe(7);
    expect(usdcHub?.hubMcapUsd).toBe(100);
    expect(usdcHub?.examples.map((example) => example.symbol)).toEqual(["DAI", "FRAX"]);
    expect(usdcHub?.edgeTypeBreakdown).toEqual([
      { type: "collateral", edgeCount: 1, summedDirectDependencyWeight: 0.6 },
      { type: "mechanism", edgeCount: 1, summedDirectDependencyWeight: 0.2 },
      { type: "wrapper", edgeCount: 1, summedDirectDependencyWeight: 0.1 },
    ]);
  });

  it("keeps hub market cap separate from modeled dependent market-cap context", () => {
    const model = buildDependencyHubsModel({
      cards: CARDS.slice(0, 2),
      edges: [
        { from: "usdc-circle", to: "dai-maker", weight: 0.75, type: "collateral" },
      ] satisfies readonly DependencyGraphEdge[],
      mcapMap: new Map([
        ["usdc-circle", 100_000_000_000],
      ]),
    });

    expect(model.hubs).toHaveLength(1);
    expect(model.hubs[0]?.hubMcapUsd).toBe(100_000_000_000);
    expect(model.hubs[0]?.uniqueDependentMcapUsd).toBe(0);
    expect(model.uniqueDependentMcapUsd).toBe(0);
  });
});
