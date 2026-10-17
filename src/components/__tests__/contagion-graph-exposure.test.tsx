// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContagionGraph } from "@/components/contagion-graph-root";
import { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";
import { footprintViewBox, upstreamArrowPoint, type ExposureOverlay } from "@/components/contagion-graph/contagion-graph-exposure";
import { buildDependencyHubsModel } from "@shared/lib/dependency-hubs-model";
import type { ContagionGraphCard } from "@/lib/contagion-layout";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type * as ContagionLayout from "@/lib/contagion-layout";
import { ContagionGraphSvg } from "@/components/contagion-graph/contagion-graph-svg";
import { installSvgCoordinateShim } from "./contagion-graph-test-support";
import { ContagionGraphInsights } from "@/components/contagion-graph/contagion-graph-insights";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/contagion-layout", async () => {
  const actual = await vi.importActual<typeof ContagionLayout>("@/lib/contagion-layout");
  return { ...actual, runSimulationInChunks: (_nodes: unknown, _links: unknown, _state: unknown, complete: (positions: Map<string, { x: number; y: number }>) => void) => {
    complete(new Map(Array.from({ length: 8 }, (_, i) => [`coin-${i}`, { x: 100 + i * 75, y: 300 }])));
    return () => {};
  } };
});
const cards: ContagionGraphCard[] = Array.from({ length: 8 }, (_, i) => ({ id: `coin-${i}`, symbol: `C${i}`, grade: "B" }));
const dependencyEdges: ReportCardsV9DependencyEdge[] = cards.slice(1).map((card, i) => ({ from: cards[i].id, to: card.id, kind: "serial", materiality: "serial", weight: null, upstreamScore: 50 }));
const mcapMap = new Map(cards.map(card => [card.id, 1_000_000]));
const exposureOverlay: ExposureOverlay = {
  roots: ["coin-0"],
  rows: new Map(cards.slice(1).map((card, i) => [card.id, { minHop: i + 1, band: "material" as const, share: 1, exposureUsd: i === 6 ? null : 1_000_000 }])),
  highlightedPaths: [["coin-0", "coin-1", "coin-2"]],
};
beforeEach(() => {
  installSvgCoordinateShim();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: !query.includes("reduced-motion"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

describe("controlled exposure graph", () => {
  it.each(["B", null] as const)("retains %s partial-evidence qualifications in edge-free roots and both inspection panels", (grade) => {
    const partialEvidence = { causes: ["A"] as const, excludedPillars: ["exit"] };
    const graph = renderHook(() => useContagionGraphModel({
      cards: [{ ...cards[0], grade, partialEvidence }],
      dependencyEdges: [], mcapMap, trackActions: false,
      exposureOverlay: { roots: ["coin-0"], rows: new Map(), highlightedPaths: [] },
    }));
    const node = graph.result.current.nodes[0];
    expect(node.partialEvidence).toEqual(partialEvidence);
    const { container } = render(
      <>
        {(["overlay", "panel"] as const).map((variant) => (
          <ContagionGraphInsights key={variant} variant={variant} inspectedNode={node}
            visibleLinks={[]} fullLinks={[]} directExposureById={new Map()} nodeMap={new Map([[node.id, node]])}
            onTraceNode={vi.fn()} />
        ))}
      </>,
    );
    const panels = container.querySelectorAll('[aria-label="Selected node details"]');
    expect(panels).toHaveLength(2);
    for (const panel of panels) {
      expect(panel.textContent).toContain(grade === null ? "Pipeline gap" : "Grade B");
      expect(panel.textContent).toContain("Partial evidence: pipeline gap (A)");
      if (grade === null) expect(panel.textContent).not.toContain("Grade");
    }
  });
  it("renders roots, an unknown-supply hatch and long-hop rows without changing hover traversal", () => {
    const { container } = render(<ContagionGraph cards={cards} dependencyEdges={dependencyEdges} mcapMap={mcapMap} exposureOverlay={exposureOverlay} />);
    const finalHalo = container.querySelector('[data-exposure-halo="coin-7"]')!;
    expect(finalHalo.getAttribute("fill")).toMatch(/^url\(#unknown-supply-/);
    expect(finalHalo.getAttribute("data-unknown-supply")).toBe("true");
    expect((finalHalo.parentElement as unknown as SVGGElement).style.animationDelay).toBe("420ms");
    expect(container.querySelectorAll("[data-exposure-halo]")).toHaveLength(8);
    expect(container.querySelectorAll("[data-highlighted-path]")).toHaveLength(2);
    fireEvent.mouseEnter(container.querySelector('[data-node-id="coin-0"]')!);
    expect(container.querySelectorAll("[data-exposure-halo]")).toHaveLength(8);
    expect(finalHalo.getAttribute("data-min-hop")).toBe("7");
  });
  it("points arrowheads toward the upstream endpoint in Explore and Exposure", () => {
    const point = upstreamArrowPoint({ x: 200, y: 100 }, { x: 100, y: 100 }, 20);
    expect(point).toEqual({ x: 125, y: 100 });
    const { container, rerender } = render(<ContagionGraph cards={cards} dependencyEdges={dependencyEdges} mcapMap={mcapMap} />);
    const assertArrow = () => {
      const line = container.querySelector('line[data-upstream-id="coin-0"]')!;
      expect(Number(line.getAttribute("x1"))).toBe(175);
      expect(Number(line.getAttribute("x2"))).toBeLessThan(175);
      expect(Number(line.getAttribute("x2"))).toBeGreaterThan(100);
      expect(line.getAttribute("marker-end")).toMatch(/^url\(#upstream-arrow-/);
    };
    assertArrow();
    rerender(<ContagionGraph cards={cards} dependencyEdges={dependencyEdges} mcapMap={mcapMap} exposureOverlay={exposureOverlay} />);
    assertArrow();
  });
  it("fits the footprint, resets manual zoom, and reports Limit truncation", () => {
    const { container } = render(<ContagionGraph cards={cards} dependencyEdges={dependencyEdges} mcapMap={mcapMap} exposureOverlay={exposureOverlay} maxNodes={3} />);
    expect(screen.getByRole("status").textContent).toContain("Showing 2 of 7 linked coins");
    const svg = container.querySelector("line[data-upstream-id]")!.closest("svg")!;
    const fit = svg.getAttribute("viewBox");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(svg.getAttribute("viewBox")).not.toBe(fit);
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(svg.getAttribute("viewBox")).toBe(fit);
  });
  it("uses supplied full-graph hub exposures identically to the fallback through limit changes", () => {
    const options = { cards, dependencyEdges, mcapMap, trackActions: false };
    const hubs = buildDependencyHubsModel({ cards: cards.map(card => ({ ...card, name: card.symbol })), edges: dependencyEdges, mcapMap }).hubs.map(({ hubId, direct, passThroughUsd, vaultClaimUsd, ownFamilyUsd, dependentCount, topDependent }) => ({ hubId, direct, passThroughUsd, vaultClaimUsd, ownFamilyUsd, dependentCount, topDependent }));
    const supplied = renderHook(() => useContagionGraphModel({ ...options, hubExposures: hubs }));
    const fallback = renderHook(() => useContagionGraphModel(options));
    act(() => { supplied.result.current.setNodeLimit(50); fallback.result.current.setNodeLimit(50); });
    expect([...supplied.result.current.directExposureById].map(([id, hub]) => [id, hub.direct])).toEqual([...fallback.result.current.directExposureById].map(([id, hub]) => [id, hub.direct]));
    expect([...supplied.result.current.supernodeState.tierById]).toEqual([...fallback.result.current.supernodeState.tierById]);
    expect([...supplied.result.current.supernodeState.scoreById]).toEqual([...fallback.result.current.supernodeState.scoreById]);
  });
  it("keeps valid graph rows when another basket share is malformed", () => {
    const edges = [{ ...dependencyEdges[0], kind: "basket" as const, materiality: "basket-weighted" as const, weight: Number.NaN }, ...dependencyEdges.slice(1)];
    const graph = renderHook(() => useContagionGraphModel({ cards, dependencyEdges: edges, mcapMap, trackActions: false }));
    expect(graph.result.current.visibleLinks.find(link => link.tgtId === "coin-0")?.shareUnknown).toBe(true);
    expect(graph.result.current.visibleLinks.find(link => link.tgtId === "coin-1")?.weight).toBe(1);
    expect(graph.result.current.directExposureById.get("coin-0")?.direct.unknownShareEdgeCount).toBe(1);
    expect(graph.result.current.directExposureById.get("coin-1")?.direct.knownUsd).toBe(1_000_000);
  });
  it("closes fullscreen before handing an exposure root to the results workspace", async () => {
    const onUseAsExposureRoot = vi.fn();
    render(<ContagionGraph cards={cards} dependencyEdges={dependencyEdges} mcapMap={mcapMap} onUseAsExposureRoot={onUseAsExposureRoot} />);
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen graph" }));
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: /^Use .* as exposure root$/ }));
    expect(onUseAsExposureRoot).toHaveBeenCalledWith("coin-1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("retains manual zoom through a node drag until Fit or footprint identity changes", () => {
    const { container, rerender } = render(<ContagionGraph cards={cards} dependencyEdges={dependencyEdges} mcapMap={mcapMap} exposureOverlay={exposureOverlay} />);
    const svg = container.querySelector("line[data-upstream-id]")!.closest("svg")!;
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const manual = svg.getAttribute("viewBox");
    const root = container.querySelector('[data-node-id="coin-0"]')!;
    fireEvent.pointerDown(root, { isPrimary: true, pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 300 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 180, clientY: 380 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(root.getAttribute("data-pinned")).toBe("true");
    expect(svg.getAttribute("viewBox")).toBe(manual);
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(svg.getAttribute("viewBox")).not.toBe(manual);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const secondManual = svg.getAttribute("viewBox");
    rerender(<ContagionGraph cards={cards} dependencyEdges={dependencyEdges} mcapMap={mcapMap} exposureOverlay={{ roots: ["coin-6"], rows: new Map([["coin-7", exposureOverlay.rows.get("coin-7")!]]), highlightedPaths: [] }} />);
    expect(svg.getAttribute("viewBox")).not.toBe(secondManual);
  });
  it("retains an early pan when simulation coordinates arrive, then Fit uses those coordinates", () => {
    const model = renderHook(() => useContagionGraphModel({ cards, dependencyEdges, mcapMap, exposureOverlay }));
    const pending = { ...model.result.current, positions: new Map() };
    const { container, rerender } = render(<ContagionGraphSvg graph={pending} nodeTooltipEl={null} edgeTooltipEl={null} />);
    const svg = container.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ width: 800, height: 600, x: 0, y: 0, top: 0, left: 0, bottom: 600, right: 800, toJSON: () => ({}) });
    fireEvent.pointerDown(svg, { isPrimary: true, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 120, clientY: 130 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(svg.getAttribute("viewBox")).toBe("-20 -30 800 600");
    rerender(<ContagionGraphSvg graph={model.result.current} nodeTooltipEl={null} edgeTooltipEl={null} />);
    expect(svg.getAttribute("viewBox")).toBe("-20 -30 800 600");
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(svg.getAttribute("viewBox")).not.toBe("-20 -30 800 600");
  });
  it("fits a large footprint without clipping or altering an already-base-aspect bounding box", () => {
    const nodes = cards.slice(0, 2).map(card => ({ ...card, r: 0, mcap: 1 }));
    const positions = new Map([["coin-0", { x: 35, y: 35 }], ["coin-1", { x: 1565, y: 1165 }]]);
    expect(footprintViewBox(nodes, positions, new Set(["coin-0", "coin-1"]))).toBe("0 0 1600 1200");
  });
  it("centers sparse nodes in the unobstructed area while preserving base scale", () => {
    const nodes = cards.slice(0, 2).map(card => ({ ...card, r: 10, mcap: 1 }));
    const positions = new Map([["coin-0", { x: 400, y: 150 }], ["coin-1", { x: 400, y: 300 }]]);
    const [x, y, width, height] = footprintViewBox(nodes, positions, new Set(["coin-0", "coin-1"]), { bottomInsetFraction: 0.35 }).split(" ").map(Number);
    expect([width, height]).toEqual([800, 600]);
    expect(x).toBe(0);
    expect(y + height * 0.65 / 2).toBe(225);
    expect(y).toBeLessThanOrEqual(105);
    expect(y + height * 0.65).toBeGreaterThanOrEqual(345);
  });
  it("expands large footprints for legend clearance without clipping their top", () => {
    const nodes = cards.slice(0, 2).map(card => ({ ...card, r: 0, mcap: 1 }));
    const positions = new Map([["coin-0", { x: 35, y: 35 }], ["coin-1", { x: 1565, y: 1165 }]]);
    const [x, y, width, height] = footprintViewBox(nodes, positions, new Set(["coin-0", "coin-1"]), { bottomInsetFraction: 0.25 }).split(" ").map(Number);
    expect(width / height).toBeCloseTo(800 / 600);
    expect(y).toBeLessThanOrEqual(0);
    expect(y + height * 0.75).toBeGreaterThanOrEqual(1200);
    expect(x).toBeLessThanOrEqual(0);
    expect(x + width).toBeGreaterThanOrEqual(1600);
  });
});
