import { describe, expect, it } from "vitest";

import {
  computeRippleState,
  computeVisibleGraph,
  findDirectionalNeighbor,
  resolveGraphLinks,
  type ResolvedLink,
} from "@/components/contagion-graph-graph";
import type { GraphLink, GraphNode } from "@/lib/contagion-layout";

const NODES: GraphNode[] = [
  { id: "usdc", symbol: "USDC", grade: "A", mcap: 10, r: 12, x: 0, y: 0, vx: 0, vy: 0 },
  { id: "usdt", symbol: "USDT", grade: "A", mcap: 9, r: 12, x: 0, y: 0, vx: 0, vy: 0 },
  { id: "usde", symbol: "USDe", grade: "B", mcap: 8, r: 12, x: 0, y: 0, vx: 0, vy: 0 },
  { id: "susde", symbol: "sUSDe", grade: "B", mcap: 7, r: 12, x: 0, y: 0, vx: 0, vy: 0 },
];

const LINKS: GraphLink[] = [
  { source: "usdt", target: "usdc", weight: 0.8, type: "collateral" },
  { source: "usde", target: "usdt", weight: 0.6, type: "collateral" },
  { source: "susde", target: "usde", weight: 1, type: "wrapper" },
];

function makeResolvedLinks(): ResolvedLink[] {
  return resolveGraphLinks(
    LINKS,
    new Map([
      ["usdc", 2],
      ["usdt", 1],
      ["usde", 0],
      ["susde", 0],
    ]),
  );
}

describe("contagion graph helpers", () => {
  it("retains score availability independently of a known share", () => {
    const links = resolveGraphLinks([
      { source: "usdt", target: "usdc", type: "collateral", weight: 0.25, scoreKnown: false },
      { source: "susde", target: "usde", type: "wrapper", weight: 1, scoreKnown: true },
    ], new Map());
    expect(links[0]).toMatchObject({ weight: 0.25, scoreKnown: false });
    expect(links[1]).toMatchObject({ weight: 1, scoreKnown: true });
  });

  it("computes visible links and nodes for hub focus", () => {
    const result = computeVisibleGraph({
      resolvedLinks: makeResolvedLinks(),
      focusMode: "hub",
      edgeTypeFilter: "all",
      neighborhoodFocusId: null,
      nodes: NODES,
      hubIdsByScore: ["usdc", "usdt"],
    });

    expect(result.visibleLinks.map((link) => link.index)).toEqual([0, 1]);
    expect(result.visibleNodeIds).toEqual(new Set(["usdc", "usdt", "usde"]));
    expect(result.visibleLinkIndices).toEqual(new Set([0, 1]));
  });

  it("filters visible links by relationship", () => {
    const result = computeVisibleGraph({
      resolvedLinks: makeResolvedLinks(),
      focusMode: "all",
      edgeTypeFilter: "wrapper",
      neighborhoodFocusId: null,
      nodes: NODES,
      hubIdsByScore: ["usdc", "usdt"],
    });

    expect(result.visibleLinks.map((link) => link.index)).toEqual([2]);
    expect(result.visibleLinkIndices).toEqual(new Set([2]));
    expect(result.visibleNodeIds).toEqual(new Set(["usdc", "usdt", "usde", "susde"]));
  });

  it("builds multi-hop upstream provider chain from the hovered node", () => {
    const result = computeRippleState("usdc", makeResolvedLinks());

    expect(result.nodeDistance).toEqual(
      new Map([
        ["usdc", 0],
        ["usdt", 1],
        ["usde", 2],
        ["susde", 3],
      ]),
    );
    expect(result.edgeDistance).toEqual(
      new Map([
        [0, 1],
        [1, 2],
        [2, 3],
      ]),
    );
  });

  it("stops at the hop boundary without including the next edge", () => {
    const result = computeRippleState("usdc", makeResolvedLinks(), 2);
    expect(result.nodeDistance).toEqual(new Map([["usdc", 0], ["usdt", 1], ["usde", 2]]));
    expect(result.connectedEdges).toEqual(new Set([0, 1]));
  });

  it("terminates cycles and preserves shortest distances", () => {
    const links = resolveGraphLinks([
      ...LINKS,
      { source: "usdc", target: "susde", weight: 1, type: "collateral" },
      { source: "susde", target: "usdc", weight: 1, type: "collateral" },
    ], new Map());
    const result = computeRippleState("usdc", links);
    expect(result.nodeDistance).toEqual(new Map([["usdc", 0], ["usdt", 1], ["susde", 1], ["usde", 2]]));
    expect(result.connectedEdges).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it("includes direct outbound neighbors without walking further outbound", () => {
    const result = computeRippleState("usde", makeResolvedLinks());
    expect(result.nodeDistance).toEqual(new Map([["usde", 0], ["usdt", 1], ["susde", 1]]));
    expect(result.connectedEdges).toEqual(new Set([1, 2]));
  });

  it("finds the best connected node in the requested arrow direction", () => {
    const bestId = findDirectionalNeighbor({
      nodeId: "usdt",
      direction: "ArrowLeft",
      links: makeResolvedLinks(),
      positions: new Map([
        ["usdc", { x: 500, y: 300 }],
        ["usdt", { x: 350, y: 300 }],
        ["usde", { x: 200, y: 300 }],
        ["susde", { x: 100, y: 300 }],
      ]),
    });

    expect(bestId).toBe("usde");
  });
});
