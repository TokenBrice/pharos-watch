import { describe, expect, it } from "vitest";
import fixture from "../dependency-watershed/__fixtures__/dependency-graph-2026-10-12.json";
import { buildWatershedModel, publicationSupplyOf, type WatershedInput, type WatershedNodeInput } from "../dependency-watershed/model";
import { createWidthScale, ribbonPath } from "../dependency-watershed/geometry";
import { readDependencyMapView, writeDependencyMapView } from "../dependency-watershed/view-url";
import { formatHubDirect, hubDirectKnown } from "../dependency-watershed/known";
import { findDependencyCycle, longestPathLayers, partitionBasins } from "../dependency-watershed/ranks";
import { buildDirectHubExposures } from "@shared/lib/dependency-exposure";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

const liveEdges = fixture.edges as ReportCardsV9DependencyEdge[];
const liveNodes: WatershedNodeInput[] = fixture.nodes;

function node(id: string, usd: number | null, sharedBookId: string | null = null): WatershedNodeInput {
  return { id, circulatingUsdAtEvaluation: usd, supplyAsOfSec: 1_791_782_221, sharedBookId };
}
function serial(from: string, to: string): ReportCardsV9DependencyEdge {
  return { from, to, kind: "serial", materiality: "serial", weight: null, upstreamScore: 80 };
}
function basket(from: string, to: string, weight: number | null): ReportCardsV9DependencyEdge {
  return { from, to, kind: "basket", materiality: "basket-weighted", weight, upstreamScore: 80 };
}
function build(input: Partial<WatershedInput> = {}) {
  const model = buildWatershedModel({ nodes: liveNodes, edges: liveEdges, ...input });
  if (!model.ok) throw new Error("expected an acyclic model");
  return model;
}
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("watershed ranks", () => {
  it("assigns longest-path layers", () => {
    const layers = longestPathLayers(["a", "b", "c", "d"], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }, { from: "d", to: "c" }]);
    expect(Object.fromEntries(layers)).toEqual({ a: 0, b: 1, c: 2, d: 0 });
  });

  it("finds cycles and self-loops, and accepts DAGs", () => {
    expect(findDependencyCycle(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "b" }])).toEqual(["b", "c"]);
    expect(findDependencyCycle(["a"], [{ from: "a", to: "a" }])).toEqual(["a"]);
    expect(findDependencyCycle(["a", "b"], [{ from: "a", to: "b" }])).toBeNull();
  });

  it("partitions basins largest first", () => {
    expect(partitionBasins(["a", "b", "c", "x", "y"], [{ from: "a", to: "b" }, { from: "c", to: "b" }, { from: "x", to: "y" }])).toEqual([["a", "b", "c"], ["x", "y"]]);
  });
});

describe("watershed geometry", () => {
  it("is linear, monotonic and floored", () => {
    const scale = createWidthScale(1_000, 40, 1);
    expect(scale.width(1_000)).toBe(40);
    expect(scale.width(500)).toBe(20);
    expect(scale.width(10)).toBe(1);
    expect(scale.width(null)).toBe(1);
    expect(scale.floorUsd).toBe(25);
    for (let usd = 0; usd < 1_000; usd += 50) expect(scale.width(usd + 50)).toBeGreaterThanOrEqual(scale.width(usd));
  });

  it("draws closed ribbons", () => {
    expect(ribbonPath([{ xIn: 0, xOut: 10, top: 0 }, { xIn: 100, xOut: 100, top: 20 }], 4)).toMatch(/^M10,0 C.*Z$/);
  });
});

describe("buildWatershedModel on the live publication", () => {
  it("is deterministic and independent of edge order", () => {
    const first = build();
    expect(build()).toEqual(first);
    const shuffled = [...liveEdges].map((edge, index) => ({ edge, key: (index * 7919) % liveEdges.length })).sort((a, b) => a.key - b.key).map(entry => entry.edge);
    expect(build({ edges: shuffled })).toEqual(first);
  });

  it("draws the hub skeleton and folds leaves", () => {
    const model = build();
    expect(model.columns).toHaveLength(4);
    expect(model.nodes.every(entry => entry.kind === "hub")).toBe(true);
    expect(model.nodes).toHaveLength(52);
    expect(model.otherBasins).toHaveLength(17);
  });

  it("places every participant on the canvas, in a delta, or in another basin", () => {
    const model = build();
    const drawn = new Set(model.nodes.map(entry => entry.id));
    const folded = new Set(model.deltas.flatMap(delta => delta.leafIds));
    const other = new Set(model.otherBasins.flatMap(basin => basin.nodeIds));
    const participants = new Set(liveEdges.flatMap(edge => [edge.from, edge.to]));
    for (const id of participants) {
      const places = [drawn.has(id), folded.has(id), other.has(id)].filter(Boolean).length;
      expect(places, id).toBe(1);
    }
    expect(drawn.size + folded.size + other.size).toBe(participants.size);
  });

  it("keeps the width scale fixed when hubs expand", () => {
    expect(build({ expandedHubs: ["usdc-circle"] }).widthScale).toEqual(build().widthScale);
  });

  it("stacks ports to exact ribbon sums", () => {
    const model = build({ expandedHubs: ["usdc-circle", "usdt-tether"] });
    for (const entry of model.nodes) {
      const out = sum(model.ribbons.filter(ribbon => ribbon.from === entry.id).map(ribbon => ribbon.width)) + (model.deltas.find(delta => delta.hubId === entry.id)?.width ?? 0);
      const inbound = sum(model.ribbons.filter(ribbon => ribbon.to === entry.id).map(ribbon => ribbon.width));
      expect(entry.height + 1e-9).toBeGreaterThanOrEqual(Math.max(out, inbound));
    }
    for (const ribbon of model.ribbons) if (!ribbon.floored) expect(Math.abs(ribbon.width - ribbon.usd! * model.widthScale.pxPerUsd)).toBeLessThan(1e-9);
  });

  it("prints hub totals from buildDirectHubExposures", () => {
    const model = build();
    const reference = buildDirectHubExposures(liveEdges, publicationSupplyOf(liveNodes), {
      sharedBooks: { bookIdOf: id => liveNodes.find(entry => entry.id === id)?.sharedBookId ?? null, measuredHoldingUsd: () => null },
      familyOf: () => null, wrapperFormOf: () => "unknown",
    });
    for (const hub of reference) expect(model.hubExposures.get(hub.hubId)?.direct.knownUsd).toBe(hub.direct.knownUsd);
  });

  it("expands a hub's top dependents and keeps the remainder folded", () => {
    const model = build({ expandedHubs: ["usdc-circle"] });
    const delta = model.deltas.find(entry => entry.hubId === "usdc-circle")!;
    expect(delta.remainder).toBe(true);
    expect(model.nodes.filter(entry => entry.kind === "leaf").length).toBe(model.layout.expandLimit);
    expect(delta.shownCount).toBe(model.layout.expandLimit);
  });

  it("discloses double serial dependents and unknown links", () => {
    const model = build();
    expect(model.disclosures.doubleSerialDependentIds).toEqual(["susdc-spark", "susdt-spark"]);
    expect(model.disclosures.unknownEdgeCount).toBe(model.edges.filter(edge => edge.usd === null).length);
  });

  it("builds within the performance budget", () => {
    build();
    const start = performance.now();
    build();
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("buildWatershedModel on synthetic graphs", () => {
  it("fails closed on a cycle", () => {
    expect(buildWatershedModel({ nodes: [node("a", 1), node("b", 1)], edges: [serial("a", "b"), serial("b", "a")] }))
      .toEqual({ ok: false, reason: "cycle", members: ["a", "b"] });
  });

  it("draws null supply as an unknown floored ribbon without USD", () => {
    const model = buildWatershedModel({ nodes: [node("u", 100), node("h", 50), node("x", null), node("l", 10)], edges: [serial("u", "h"), serial("u", "x"), serial("x", "l"), basket("h", "l", 0.5)] });
    if (!model.ok) throw new Error("cycle");
    const unknown = model.ribbons.find(ribbon => ribbon.to === "x")!;
    expect(unknown).toMatchObject({ usd: null, unknown: true, width: 1 });
    expect(model.hubExposures.get("u")!.direct.knownUsd).toBe(50);
    expect(model.hubExposures.get("u")!.direct.excludedSupplyUnknownIds).toEqual(["x"]);
  });

  it("stacks two full serial claims on a double-serial dependent", () => {
    const model = buildWatershedModel({ nodes: [node("a", 1_000), node("b", 1_000), node("w", 400), node("w2", 5)], edges: [serial("a", "w"), serial("b", "w"), serial("w", "w2")] });
    if (!model.ok) throw new Error("cycle");
    const w = model.nodes.find(entry => entry.id === "w")!;
    const inbound = model.ribbons.filter(ribbon => ribbon.to === "w");
    expect(inbound.map(ribbon => ribbon.usd)).toEqual([400, 400]);
    expect(w.height).toBeGreaterThanOrEqual(sum(inbound.map(ribbon => ribbon.width)));
    expect(model.disclosures.doubleSerialDependentIds).toEqual(["w"]);
  });

  it("uses shared-book reconciliation rather than summed geometry", () => {
    const nodes = [node("usdc", 1_000), node("dai", 400, "sky"), node("usds", 600, "sky"), node("sdai", 100)];
    const edges = [basket("usdc", "dai", 0.5), basket("usdc", "usds", 0.5), serial("dai", "sdai")];
    const model = buildWatershedModel({ nodes, edges, measuredHoldingUsd: (book, upstream) => book === "sky" && upstream === "usdc" ? 450 : null });
    if (!model.ok) throw new Error("cycle");
    const naive = sum(model.edges.filter(edge => edge.from === "usdc").map(edge => edge.usd ?? 0));
    expect(naive).toBe(500);
    expect(model.hubExposures.get("usdc")!.direct.knownUsd).toBe(450);
  });
});

describe("watershed view URL", () => {
  it("defaults to watershed, but opens Network-only explore state in Network", () => {
    expect(readDependencyMapView("")).toBe("watershed");
    expect(readDependencyMapView("?mode=exposure&root=usdc-circle")).toBe("watershed");
    // The Network's own hydration-time defaults are not a request for Network.
    expect(readDependencyMapView("?focus=all&type=all&limit=200")).toBe("watershed");
    expect(readDependencyMapView("?focus=all&type=collateral&limit=200")).toBe("network");
    expect(readDependencyMapView("?focus=usdc-circle")).toBe("network");
    expect(readDependencyMapView("?focus=usdc-circle&view=watershed")).toBe("watershed");
    expect(readDependencyMapView("?view=network")).toBe("network");
  });

  it("writes view only when the default would differ, preserving other parameters", () => {
    expect(writeDependencyMapView("?root=a", "watershed")).toBe("?root=a");
    expect(writeDependencyMapView("?root=a", "network")).toBe("?root=a&view=network");
    expect(writeDependencyMapView("?focus=a&view=network", "watershed")).toBe("?focus=a&view=watershed");
    for (const search of ["?root=a", "?focus=a", "?trace=b&limit=all"]) {
      for (const view of ["watershed", "network"] as const) expect(readDependencyMapView(writeDependencyMapView(search, view))).toBe(view);
    }
  });
});

describe("hub direct availability", () => {
  it("never prints $0 for a hub whose links all lack a share or supply", () => {
    const nodes = [node("hub", 100), node("a", 50), node("b", null)];
    const edges = [basket("hub", "a", null), serial("hub", "b")];
    const model = buildWatershedModel({ nodes, edges });
    if (!model.ok) throw new Error("cycle");
    const exposure = model.hubExposures.get("hub")!;
    expect(exposure.direct.knownUsd).toBe(0);
    expect(hubDirectKnown(exposure, edges)).toBe(false);
    expect(model.directKnown.has("hub")).toBe(false);
    expect(formatHubDirect(exposure, edges)).toBe("Unavailable");
  });

  it("qualifies a partially known hub as known only", () => {
    const nodes = [node("hub", 100), node("a", 50), node("b", null)];
    const edges = [serial("hub", "a"), serial("hub", "b")];
    const model = buildWatershedModel({ nodes, edges });
    if (!model.ok) throw new Error("cycle");
    expect(formatHubDirect(model.hubExposures.get("hub")!, edges)).toBe("$50.00 (known only)");
  });
});
