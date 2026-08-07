import { describe, it, expect } from "vitest";
import {
  ALL_NODE_LIMIT,
  minMaxNormalize,
  deterministicJitter,
  clampGraphPosition,
  buildGraphData,
  buildSupernodeState,
  contagionEdgeWeight,
  runSimulation,
  WIDTH,
  HEIGHT,
  MAX_NODES,
  MAX_COLLISION_PASS_NODES,
  PAD,
  SUPERNODE_CONFIG,
  type ContagionGraphCard,
  type GraphNode,
  type GraphLink,
} from "@/lib/contagion-layout";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type { V9Grade } from "@shared/types/safety-score-v9";

// ---------------------------------------------------------------------------
// Helpers — minimal mock factories
// ---------------------------------------------------------------------------

function mockCard(id: string, symbol: string, grade: V9Grade = "B", isDefunct = false): ContagionGraphCard {
  return { id, symbol, grade, isDefunct };
}

function basketEdge(from: string, to: string, weight: number | null): ReportCardsV9DependencyEdge {
  return {
    from,
    to,
    kind: "basket",
    materiality: weight === null ? "basket-bounded-unknown" : "basket-weighted",
    weight,
    upstreamScore: null,
  };
}

function serialEdge(from: string, to: string, blocked = false): ReportCardsV9DependencyEdge {
  return {
    from,
    to,
    kind: "serial",
    materiality: blocked ? "serial-blocked" : "serial",
    weight: null,
    upstreamScore: null,
  };
}

// ---------------------------------------------------------------------------
// minMaxNormalize
// ---------------------------------------------------------------------------

describe("minMaxNormalize", () => {
  it("returns an empty map for empty ids", () => {
    const result = minMaxNormalize([], new Map());
    expect(result.size).toBe(0);
  });

  it("normalizes values between 0 and 1", () => {
    const ids = ["a", "b", "c"];
    const values = new Map([["a", 10], ["b", 20], ["c", 30]]);
    const result = minMaxNormalize(ids, values);
    expect(result.get("a")).toBe(0);
    expect(result.get("b")).toBe(0.5);
    expect(result.get("c")).toBe(1);
  });

  it("returns all zeros when all values are equal", () => {
    const ids = ["a", "b"];
    const values = new Map([["a", 5], ["b", 5]]);
    const result = minMaxNormalize(ids, values);
    expect(result.get("a")).toBe(0);
    expect(result.get("b")).toBe(0);
  });

  it("treats missing ids as 0", () => {
    const ids = ["a", "b"];
    const values = new Map([["a", 10]]);
    const result = minMaxNormalize(ids, values);
    expect(result.get("a")).toBe(1);
    expect(result.get("b")).toBe(0);
  });
});

describe("clampGraphPosition", () => {
  it("keeps dragged nodes inside the padded graph bounds", () => {
    expect(clampGraphPosition(-20, HEIGHT + 20, 12)).toEqual({
      x: PAD + 12,
      y: HEIGHT - PAD - 12,
    });
  });
});

// ---------------------------------------------------------------------------
// contagionEdgeWeight
// ---------------------------------------------------------------------------

describe("contagionEdgeWeight", () => {
  it("treats every serial dependency as full pass-through", () => {
    expect(contagionEdgeWeight(serialEdge("a", "b"))).toBe(1);
    expect(contagionEdgeWeight(serialEdge("a", "b", true))).toBe(1);
  });

  it("carries the published basket weight and floors bounded-unknown baskets at zero", () => {
    expect(contagionEdgeWeight(basketEdge("a", "b", 0.35))).toBe(0.35);
    expect(contagionEdgeWeight(basketEdge("a", "b", null))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deterministicJitter
// ---------------------------------------------------------------------------

describe("deterministicJitter", () => {
  it("returns the same value for the same inputs", () => {
    const a = deterministicJitter("usdt-tether", 17, 8);
    const b = deterministicJitter("usdt-tether", 17, 8);
    expect(a).toBe(b);
  });

  it("returns different values for different ids", () => {
    const a = deterministicJitter("usdt-tether", 17, 8);
    const b = deterministicJitter("usdc-circle", 17, 8);
    expect(a).not.toBe(b);
  });

  it("returns different values for different salts", () => {
    const a = deterministicJitter("usdt-tether", 17, 8);
    const b = deterministicJitter("usdt-tether", 53, 8);
    expect(a).not.toBe(b);
  });

  it("stays within the specified range", () => {
    const range = 10;
    for (const id of ["a", "bb", "ccc", "dddd", "eeeee"]) {
      const v = deterministicJitter(id, 42, range);
      expect(v).toBeGreaterThanOrEqual(-range);
      expect(v).toBeLessThanOrEqual(range);
    }
  });
});

// ---------------------------------------------------------------------------
// buildGraphData
// ---------------------------------------------------------------------------

describe("buildGraphData", () => {
  const realIds = TRACKED_STABLECOINS.slice(0, 10).map((s) => s.id);

  function makeCardsAndMcap(ids: string[]) {
    const cards = ids.map((id) => {
      const meta = TRACKED_STABLECOINS.find((s) => s.id === id);
      return mockCard(id, meta?.symbol ?? id.toUpperCase());
    });
    const mcapMap = new Map(ids.map((id, i) => [id, (ids.length - i) * 1_000_000_000]));
    return { cards, mcapMap };
  }

  /** Chains the ranked ids so no node is isolated. */
  function chainEdges(ids: string[]): ReportCardsV9DependencyEdge[] {
    return ids.slice(1).map((id, index) => basketEdge(ids[index], id, 0.5));
  }

  it("returns nodes and links arrays", () => {
    const { cards, mcapMap } = makeCardsAndMcap(realIds);
    const result = buildGraphData(cards, mcapMap, chainEdges(realIds));
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.links)).toBe(true);
  });

  it("treats an empty dependencyEdges array as no graph edges", () => {
    const cards = [mockCard("usds-sky", "USDS"), mockCard("susds-sky", "SUSDS")];
    const mcapMap = new Map<string, number>([
      ["usds-sky", 5_000_000_000],
      ["susds-sky", 2_000_000_000],
    ]);

    const result = buildGraphData(cards, mcapMap, []);

    expect(result.nodes).toEqual([]);
    expect(result.links).toEqual([]);
  });

  it("collapses V9 materiality onto the drawn relationship", () => {
    const cards = [mockCard("usds-sky", "USDS"), mockCard("susds-sky", "SUSDS")];
    const mcapMap = new Map<string, number>([
      ["usds-sky", 5_000_000_000],
      ["susds-sky", 2_000_000_000],
    ]);

    const result = buildGraphData(cards, mcapMap, [serialEdge("usds-sky", "susds-sky")]);

    expect(result.links).toEqual([
      expect.objectContaining({
        source: "susds-sky",
        target: "usds-sky",
        weight: 1,
        type: "wrapper",
      }),
    ]);
  });

  it("draws an unresolvable upstream as its plain relationship", () => {
    const cards = [mockCard("a", "A"), mockCard("b", "B"), mockCard("c", "C")];
    const mcapMap = new Map<string, number>([["a", 3], ["b", 2], ["c", 1]]);

    const result = buildGraphData(cards, mcapMap, [
      serialEdge("a", "b", true),
      basketEdge("a", "c", null),
    ]);

    expect(result.links.map((link) => link.type).sort()).toEqual(["collateral", "wrapper"]);
  });

  it("does not include defunct stablecoins", () => {
    const { cards, mcapMap } = makeCardsAndMcap(realIds);
    cards[0] = { ...cards[0], isDefunct: true };
    const result = buildGraphData(cards, mcapMap, chainEdges(realIds));
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).not.toContain(realIds[0]);
  });

  it("prunes isolates (nodes with no links in the displayed subset)", () => {
    const { cards, mcapMap } = makeCardsAndMcap(realIds);
    const result = buildGraphData(cards, mcapMap, chainEdges(realIds));
    expect(result.nodes.length).toBeGreaterThan(0);
    const connectedIds = new Set<string>();
    for (const link of result.links) {
      const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
      const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
      connectedIds.add(srcId);
      connectedIds.add(tgtId);
    }
    for (const node of result.nodes) {
      expect(connectedIds.has(node.id)).toBe(true);
    }
  });

  it("respects MAX_NODES limit", () => {
    const allIds = TRACKED_STABLECOINS.map((s) => s.id);
    const { cards, mcapMap } = makeCardsAndMcap(allIds);
    const result = buildGraphData(cards, mcapMap, chainEdges(allIds));
    expect(result.nodes.length).toBeLessThanOrEqual(MAX_NODES);
  });

  it("includes the full connected ranked graph for the all node limit", () => {
    const ids = ["coin-a", "coin-b", "coin-c", "coin-d"];
    const { cards, mcapMap } = makeCardsAndMcap(ids);
    const dependencyEdges = [
      basketEdge("coin-a", "coin-b", 1),
      basketEdge("coin-a", "coin-c", 1),
      basketEdge("coin-a", "coin-d", 1),
    ];

    expect(buildGraphData(cards, mcapMap, dependencyEdges, 2).nodes).toHaveLength(2);
    expect(buildGraphData(cards, mcapMap, dependencyEdges, ALL_NODE_LIMIT).nodes.map((node) => node.id).sort()).toEqual(
      ids,
    );
  });

  it("each node has the required shape", () => {
    const { cards, mcapMap } = makeCardsAndMcap(realIds);
    const result = buildGraphData(cards, mcapMap, chainEdges(realIds));
    for (const node of result.nodes) {
      expect(typeof node.id).toBe("string");
      expect(typeof node.symbol).toBe("string");
      expect(typeof node.grade).toBe("string");
      expect(typeof node.mcap).toBe("number");
      expect(typeof node.r).toBe("number");
      expect(node.r).toBeGreaterThanOrEqual(0);
    }
  });

  it("drops edges whose endpoints are not both live cards", () => {
    const cards = [mockCard("upstream", "UP"), mockCard("downstream", "DOWN")];
    const mcapMap = new Map<string, number>([
      ["upstream", 5_000_000_000],
      ["downstream", 3_000_000_000],
    ]);

    const result = buildGraphData(cards, mcapMap, [
      basketEdge("upstream", "downstream", 0.6),
      basketEdge("upstream", "untracked-coin", 0.6),
    ]);

    expect(result.nodes.map((node) => node.id).sort()).toEqual(["downstream", "upstream"]);
    expect(result.links).toHaveLength(1);
  });

  it("keeps node and link totals stable when a serial edge is added alongside an existing basket edge", () => {
    const cards = [
      mockCard("upstream", "UP"),
      mockCard("downstream", "DOWN"),
      mockCard("susds-sky", "SUSDS"),
      mockCard("usds-sky", "USDS"),
    ];
    const mcapMap = new Map<string, number>([
      ["upstream", 5_000_000_000],
      ["downstream", 3_000_000_000],
      ["usds-sky", 4_000_000_000],
      ["susds-sky", 1_000_000_000],
    ]);

    const edgesWithoutVariant = [basketEdge("upstream", "downstream", 0.6)];
    const edgesWithVariant = [...edgesWithoutVariant, serialEdge("usds-sky", "susds-sky")];

    const baseline = buildGraphData(cards, mcapMap, edgesWithoutVariant);
    const withVariant = buildGraphData(cards, mcapMap, edgesWithVariant);

    expect(withVariant.nodes.length).toBe(baseline.nodes.length + 2);
    expect(withVariant.links.length).toBe(baseline.links.length + 1);
  });
});

// ---------------------------------------------------------------------------
// buildSupernodeState
// ---------------------------------------------------------------------------

describe("buildSupernodeState", () => {
  function makeSimpleGraph(): { nodes: GraphNode[]; links: GraphLink[] } {
    const ids = TRACKED_STABLECOINS.slice(0, 20).map((s) => s.id);
    const cards = ids.map((id) => {
      const meta = TRACKED_STABLECOINS.find((s) => s.id === id)!;
      return mockCard(id, meta.symbol);
    });
    const mcapMap = new Map(ids.map((id, i) => [id, (ids.length - i) * 1_000_000_000]));
    // Star the ranked head so the hub tiers have something to score.
    const edges = ids.slice(1).map((id) => basketEdge(ids[0], id, 0.5));
    return buildGraphData(cards, mcapMap, edges);
  }

  it("returns the expected SupernodeState shape", () => {
    const { nodes, links } = makeSimpleGraph();
    const state = buildSupernodeState(nodes, links);
    expect(state.tierById).toBeInstanceOf(Map);
    expect(state.scoreById).toBeInstanceOf(Map);
    expect(state.layoutTargetById).toBeInstanceOf(Map);
    expect(state.anchorStrengthById).toBeInstanceOf(Map);
  });

  it("assigns tier 2 to at least minTier1 nodes", () => {
    const { nodes, links } = makeSimpleGraph();
    expect(nodes.length).toBeGreaterThan(0);
    const state = buildSupernodeState(nodes, links);
    const tier2Count = [...state.tierById.values()].filter((t) => t === 2).length;
    expect(tier2Count).toBeGreaterThanOrEqual(SUPERNODE_CONFIG.minTier1);
  });

  it("places layout targets within the canvas bounds", () => {
    const { nodes, links } = makeSimpleGraph();
    const state = buildSupernodeState(nodes, links);
    for (const [, target] of state.layoutTargetById) {
      expect(target.x).toBeGreaterThanOrEqual(0);
      expect(target.x).toBeLessThanOrEqual(WIDTH);
      expect(target.y).toBeGreaterThanOrEqual(0);
      expect(target.y).toBeLessThanOrEqual(HEIGHT);
    }
  });

  it("assigns anchor strengths based on tier", () => {
    const { nodes, links } = makeSimpleGraph();
    const state = buildSupernodeState(nodes, links);
    for (const node of nodes) {
      const tier = state.tierById.get(node.id) ?? 0;
      const strength = state.anchorStrengthById.get(node.id)!;
      expect(typeof strength).toBe("number");
      if (tier === 2) {
        expect(strength).toBe(0.24);
      } else if (tier === 1) {
        expect(strength).toBe(0.105);
      } else {
        expect(strength).toBe(0.04);
      }
    }
  });

  it("applies hysteresis when prevTierById is provided", () => {
    const { nodes, links } = makeSimpleGraph();
    expect(nodes.length).toBeGreaterThan(0);
    const state1 = buildSupernodeState(nodes, links);

    const state2 = buildSupernodeState(nodes, links, state1.tierById);
    expect(state2.tierById).toBeInstanceOf(Map);

    const tier2Ids1 = [...state1.tierById.entries()].filter(([, t]) => t === 2).map(([id]) => id);
    for (const id of tier2Ids1) {
      const stillTiered = (state2.tierById.get(id) ?? 0) > 0;
      expect(stillTiered).toBe(true);
    }
  });

  it("handles empty nodes gracefully", () => {
    const state = buildSupernodeState([], []);
    expect(state.tierById.size).toBe(0);
    expect(state.scoreById.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runSimulation — O(n²) collision-pass bound
// ---------------------------------------------------------------------------

describe("runSimulation", () => {
  function makeRing(count: number): { nodes: GraphNode[]; links: GraphLink[] } {
    const nodes: GraphNode[] = Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      symbol: `N${i}`,
      grade: "B",
      mcap: (count - i) * 1_000_000,
      r: 12,
    }));
    // Connect each node to the next so none are isolated.
    const links: GraphLink[] = Array.from({ length: count - 1 }, (_, i) => ({
      source: `n${i}`,
      target: `n${i + 1}`,
      weight: 1,
      type: "collateral",
    }));
    return { nodes, links };
  }

  it("returns a position for every node even past the collision-pass cap", () => {
    const count = MAX_COLLISION_PASS_NODES + 25;
    const { nodes, links } = makeRing(count);
    const state = buildSupernodeState(nodes, links);
    const positions = runSimulation(nodes, links, state);
    expect(positions.size).toBe(count);
    for (const [, pos] of positions) {
      expect(Number.isFinite(pos.x)).toBe(true);
      expect(Number.isFinite(pos.y)).toBe(true);
    }
  });

  it("keeps every node inside the padded canvas bounds", () => {
    const { nodes, links } = makeRing(MAX_COLLISION_PASS_NODES + 25);
    const state = buildSupernodeState(nodes, links);
    const positions = runSimulation(nodes, links, state);
    for (const node of nodes) {
      const pos = positions.get(node.id)!;
      expect(pos.x).toBeGreaterThanOrEqual(PAD - node.r);
      expect(pos.x).toBeLessThanOrEqual(WIDTH - PAD + node.r);
      expect(pos.y).toBeGreaterThanOrEqual(PAD - node.r);
      expect(pos.y).toBeLessThanOrEqual(HEIGHT - PAD + node.r);
    }
  });

  it("returns an empty map for an empty graph", () => {
    expect(runSimulation([], [], buildSupernodeState([], [])).size).toBe(0);
  });
});
