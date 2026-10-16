import { describe, it, expect } from "vitest";
import {
  ALL_NODE_LIMIT,
  buildGraphData,
  buildSupernodeState,
  contagionEdgeWeight,
  runSimulation,
  WIDTH,
  HEIGHT,
  DEFAULT_NODE_LIMIT,
  MAX_COLLISION_PASS_NODES,
  PAD,
  MIN_RADIUS,
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

function basketEdge(
  from: string,
  to: string,
  weight: number | null,
  materiality: ReportCardsV9DependencyEdge["materiality"] = weight === null
    ? "basket-bounded-unknown"
    : "basket-weighted",
): ReportCardsV9DependencyEdge {
  return {
    from,
    to,
    kind: "basket",
    materiality,
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

it("preserves unavailable market cap without inflating node size", () => {
  const { nodes } = buildGraphData(
    [mockCard("known", "KNOWN"), mockCard("unknown", "UNKNOWN")],
    new Map<string, number | null>([["known", 100], ["unknown", null]]),
    [basketEdge("unknown", "known", 0.1)],
  );
  expect(nodes.find((node) => node.id === "unknown")).toMatchObject({ mcap: null, r: MIN_RADIUS });
  expect(nodes.find((node) => node.id === "known")!.r).toBeGreaterThan(MIN_RADIUS);
});

// ---------------------------------------------------------------------------
// contagionEdgeWeight
// ---------------------------------------------------------------------------

describe("contagionEdgeWeight", () => {
  it("treats every serial dependency as full pass-through", () => {
    expect(contagionEdgeWeight(serialEdge("a", "b"))).toBe(1);
    expect(contagionEdgeWeight(serialEdge("a", "b", true))).toBe(1);
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

  it("keeps an unrateable upstream's known exposure in the simulation and marks the link score-unknown", () => {
    const cards = [mockCard("a", "A"), mockCard("b", "B"), mockCard("c", "C")];
    const mcapMap = new Map<string, number>([["a", 3], ["b", 2], ["c", 1]]);

    const result = buildGraphData(cards, mcapMap, [
      basketEdge("a", "b", 0.4, "basket-bounded-unknown"),
      basketEdge("a", "c", null),
      serialEdge("b", "c"),
    ]);

    // An unrateable upstream keeps its known 0.4 magnitude (link force is
    // weight * 0.4); an absent weight keeps magnitude 0, exerting no force.
    expect(result.links).toEqual([
      expect.objectContaining({
        source: "b",
        target: "a",
        weight: 0.4,
        scoreKnown: false,
        type: "collateral",
      }),
      expect.objectContaining({
        source: "c",
        target: "a",
        weight: 0,
        scoreKnown: false,
        type: "collateral",
      }),
      expect.objectContaining({
        source: "c",
        target: "b",
        weight: 1,
        scoreKnown: true,
        type: "wrapper",
      }),
    ]);
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

  it("defaults to the largest bounded node limit", () => {
    const ids = Array.from({ length: 230 }, (_, index) => `coin-${index}`);
    const { cards, mcapMap } = makeCardsAndMcap(ids);
    const result = buildGraphData(cards, mcapMap, chainEdges(ids));
    if (typeof DEFAULT_NODE_LIMIT !== "number") {
      throw new TypeError("The default graph limit must remain a bounded numeric option");
    }
    expect(result.nodes).toHaveLength(DEFAULT_NODE_LIMIT);
  });

  it("fills disconnected ranking windows with connected pairs instead of returning empty", () => {
    const ids = ["a", "b", "c", "d"];
    const cards = ids.map(id => mockCard(id, id));
    const mcapMap = new Map(ids.map((id, index) => [id, 4 - index]));
    const result = buildGraphData(cards, mcapMap, [basketEdge("a", "d", 1), basketEdge("b", "c", 1)], 2);
    expect(result.nodes.map(node => node.id)).toEqual(["a", "d"]);
    expect(result.links).toEqual([expect.objectContaining({ source: "d", target: "a" })]);
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
});
