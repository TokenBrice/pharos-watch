import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_TYPE_PRESENTATION,
} from "@/components/contagion-graph-model";
import {
  computeRippleState,
  resolveGraphLinks,
  type ResolvedLink,
} from "@/components/contagion-graph-graph";
import type { GraphLink } from "@/lib/contagion-layout";

describe("contagion graph dependency type presentation", () => {
  it("shows a percentage only for a weighted collateral share", () => {
    expect(DEPENDENCY_TYPE_PRESENTATION.collateral.showWeight).toBe(true);
    expect(DEPENDENCY_TYPE_PRESENTATION.wrapper.showWeight).toBeFalsy();
  });
});

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
});
