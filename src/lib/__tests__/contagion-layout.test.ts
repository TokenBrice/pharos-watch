import { describe, it, expect } from "vitest";
import {
  percentile,
  minMaxNormalize,
  deterministicJitter,
  buildGraphData,
  buildSupernodeState,
  WIDTH,
  HEIGHT,
  MAX_NODES,
  SUPERNODE_CONFIG,
  type GraphNode,
  type GraphLink,
} from "@/lib/contagion-layout";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { ReportCard, ReportCardGrade } from "@shared/types";

// ---------------------------------------------------------------------------
// Helpers — minimal mock factories
// ---------------------------------------------------------------------------

const DIMENSION_STUB = {
  grade: "B" as ReportCardGrade,
  score: 70,
  detail: "",
};

const RAW_INPUTS_STUB = {
  pegScore: 95,
  activeDepeg: false,
  depegEventCount: 0,
  lastEventAt: null,
  liquidityScore: 60,
  effectiveExitScore: null,
  redemptionBackstopScore: null,
  redemptionRouteFamily: null,
  redemptionImmediateCapacityUsd: null,
  redemptionImmediateCapacityRatio: null,
  concentrationHhi: null,
  bluechipGrade: null,
  canBeBlacklisted: false as const,
  chainTier: "ethereum" as const,
  deploymentModel: "native-multichain" as const,
  collateralQuality: "rwa" as const,
  custodyModel: "institutional-regulated" as const,
  governanceTier: "centralized" as const,
  governanceQuality: "regulated-entity" as const,
  dependencies: [],
  navToken: false,
};

function mockCard(id: string, symbol: string, grade: ReportCardGrade = "B", isDefunct = false): ReportCard {
  return {
    id,
    name: symbol,
    symbol,
    overallGrade: grade,
    overallScore: 70,
    baseScore: 70,
    ratedDimensions: 5,
    dimensions: {
      pegStability: DIMENSION_STUB,
      liquidity: DIMENSION_STUB,
      resilience: DIMENSION_STUB,
      decentralization: DIMENSION_STUB,
      dependencyRisk: DIMENSION_STUB,
    },
    rawInputs: RAW_INPUTS_STUB,
    isDefunct,
  };
}

// ---------------------------------------------------------------------------
// percentile
// ---------------------------------------------------------------------------

describe("percentile", () => {
  it("returns 0 for an empty array", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it("returns the single element for a one-element array", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it("returns the minimum at q=0", () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
  });

  it("returns the maximum at q=1", () => {
    expect(percentile([10, 20, 30], 1)).toBe(30);
  });

  it("interpolates at q=0.5 (median) for even-count array", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
  });

  it("interpolates correctly for an unsorted input", () => {
    const result = percentile([30, 10, 20], 0.5);
    expect(result).toBe(20);
  });
});

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

  it("returns nodes and links arrays", () => {
    const { cards, mcapMap } = makeCardsAndMcap(realIds);
    const result = buildGraphData(cards, mcapMap);
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.links)).toBe(true);
  });

  it("does not include defunct stablecoins", () => {
    const { cards, mcapMap } = makeCardsAndMcap(realIds);
    cards[0] = { ...cards[0], isDefunct: true };
    const result = buildGraphData(cards, mcapMap);
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).not.toContain(realIds[0]);
  });

  it("prunes isolates (nodes with no links in the displayed subset)", () => {
    const { cards, mcapMap } = makeCardsAndMcap(realIds);
    const result = buildGraphData(cards, mcapMap);
    if (result.nodes.length > 0) {
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
    }
  });

  it("respects MAX_NODES limit", () => {
    const allIds = TRACKED_STABLECOINS.map((s) => s.id);
    const { cards, mcapMap } = makeCardsAndMcap(allIds);
    const result = buildGraphData(cards, mcapMap);
    expect(result.nodes.length).toBeLessThanOrEqual(MAX_NODES);
  });

  it("each node has the required shape", () => {
    const { cards, mcapMap } = makeCardsAndMcap(realIds);
    const result = buildGraphData(cards, mcapMap);
    for (const node of result.nodes) {
      expect(typeof node.id).toBe("string");
      expect(typeof node.symbol).toBe("string");
      expect(typeof node.grade).toBe("string");
      expect(typeof node.mcap).toBe("number");
      expect(typeof node.r).toBe("number");
      expect(node.r).toBeGreaterThanOrEqual(0);
    }
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
    return buildGraphData(cards, mcapMap);
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
    if (nodes.length === 0) return;
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
    if (nodes.length === 0) return;
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
