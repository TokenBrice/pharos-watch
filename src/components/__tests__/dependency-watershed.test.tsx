// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DependencyWatershed } from "@/components/dependency-watershed/dependency-watershed";
import { DependencyMapBasinList } from "@/components/dependency-map-basin-list";
import { buildDependencyHubsModel } from "@shared/lib/dependency-hubs-model";
import type { DependencyGraphResponse } from "@shared/types/dependency-graph";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import { trackEvent } from "@/lib/analytics";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

function node(id: string, usd: number | null): DependencyGraphResponse["nodes"][number] {
  return { id, grade: "A", ratingStatus: "rated", partialEvidence: null, score: 80, circulatingUsdAtEvaluation: usd, supplyAsOfSec: 1_791_782_221, sharedBookId: null, roles: [], dependencyCoverageCount: null } as DependencyGraphResponse["nodes"][number];
}
function publication(edges: ReportCardsV9DependencyEdge[], nodes = [node("aaa", 1_000), node("bbb", 600), node("ccc", 200), node("ddd", null), node("eee", 50)]): DependencyGraphResponse {
  return {
    model: "v9", schemaVersion: 2, methodologyVersion: "10.17", publicationGenerationId: "report-cards:v9:v1:abcdef1234", asOfSec: 1_791_782_221, updatedAt: 1_791_782_221,
    publicationStatus: "current", publicationHealth: { status: "current", acceptedPublicationGenerationId: "report-cards:v9:v1:abcdef1234" }, nodes, edges,
  } as unknown as DependencyGraphResponse;
}
const edges: ReportCardsV9DependencyEdge[] = [
  { from: "aaa", to: "bbb", kind: "basket", materiality: "basket-weighted", weight: 0.5, upstreamScore: 80 },
  { from: "aaa", to: "ddd", kind: "serial", materiality: "serial", weight: null, upstreamScore: 80 },
  { from: "bbb", to: "ccc", kind: "serial", materiality: "serial", weight: null, upstreamScore: 80, wrapperForm: "strategy-vault" },
  { from: "bbb", to: "eee", kind: "serial", materiality: "serial", weight: null, upstreamScore: 80 },
];
const labelOf = (id: string) => id.toUpperCase();

afterEach(cleanup);

describe("DependencyWatershed", () => {
  it("renders an interactive group with named hub buttons and hidden decoration", () => {
    const { container } = render(<DependencyWatershed publication={publication(edges)} overlay={null} result={null} labelOf={labelOf} onAddRoot={vi.fn()} fallback={<p>network</p>} />);
    const group = screen.getByRole("group", { name: "Dependency watershed, 2 hubs in 2 layers" });
    const hubs = within(group).getAllByRole("button");
    expect(hubs.map(hub => hub.getAttribute("aria-label"))).toEqual([
      "AAA: $300.00 (known only) direct mapped dependent supply across 2 direct dependents",
      "BBB: $250.00 direct mapped dependent supply across 2 direct dependents",
    ]);
    expect(hubs.map(hub => hub.getAttribute("tabindex"))).toEqual(["0", "-1"]);
    expect(container.querySelector("svg > g[aria-hidden='true']")).toBeTruthy();
    expect(screen.queryByText("network")).toBeNull();
  });

  it("moves focus with arrows and commits a hub as an exposure root", () => {
    const onAddRoot = vi.fn();
    render(<DependencyWatershed publication={publication(edges)} overlay={null} result={null} labelOf={labelOf} onAddRoot={onAddRoot} fallback={null} />);
    const [aaa, bbb] = within(screen.getByRole("group", { name: /Dependency watershed/ })).getAllByRole("button");
    aaa!.focus();
    fireEvent.keyDown(aaa!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(bbb);
    expect(screen.getByText(/Downstream of BBB: \$250\.00 of mapped dependent supply across 2 coins/)).toBeTruthy();
    fireEvent.keyDown(bbb!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(aaa);
    fireEvent.keyDown(aaa!, { key: "Enter" });
    expect(onAddRoot).toHaveBeenCalledWith("aaa");
  });

  it("keeps folded-dependent chips informational and names mixed supply clocks", () => {
    const pub = publication(edges);
    (pub.nodes[0] as { supplyAsOfSec: number | null }).supplyAsOfSec = 1_791_700_000;
    const onAddRoot = vi.fn();
    const { container } = render(<DependencyWatershed publication={pub} overlay={null} result={null} labelOf={labelOf} onAddRoot={onAddRoot} fallback={null} />);
    const chip = [...container.querySelectorAll("text")].find(text => /dependents? ·/.test(text.textContent ?? ""))!;
    expect(chip.closest("[aria-hidden='true']")).toBeTruthy();
    fireEvent.click(chip);
    expect(onAddRoot).not.toHaveBeenCalled();
    expect(screen.getByText(/mixed supply clocks/)).toBeTruthy();
  });

  it("falls back to the network view with a named cycle notice", () => {
    const cyclic: ReportCardsV9DependencyEdge[] = [...edges, { from: "ccc", to: "aaa", kind: "serial", materiality: "serial", weight: null, upstreamScore: 80 }];
    render(<DependencyWatershed publication={publication(cyclic)} overlay={null} result={null} labelOf={labelOf} onAddRoot={vi.fn()} fallback={<p>network</p>} />);
    expect(screen.getByRole("status").textContent).toMatch(/Layered view unavailable: the published graph contains a dependency cycle \(AAA → BBB → CCC → AAA\)/);
    expect(screen.getByText("network")).toBeTruthy();
  });

  it("exposes the same hub and link facts in the table, with unknown never shown as zero", () => {
    render(<DependencyWatershed publication={publication(edges)} overlay={null} result={null} labelOf={labelOf} onAddRoot={vi.fn()} fallback={null} />);
    const links = screen.getByRole("table", { name: "Published dependency links with mapped USD" });
    const rows = within(links).getAllByRole("row").slice(1).map(row => row.textContent);
    expect(rows).toContain("AAABBBCollateral—50.00%$300.00");
    expect(rows).toContain("AAADDDWrapper—Full claimUnknown");
    expect(screen.getByRole("table", { name: /Upstream hubs/ })).toBeTruthy();
    expect(screen.getByText(/Unknown USD \(1 link\)/)).toBeTruthy();
  });

  it("states the beam as a relationship, not an outcome", () => {
    const pub = publication(edges);
    const result = { rows: [{ id: "bbb", minHop: 1, share: 0.5, band: "material" as const, exposureUsd: 300, supplyUnknown: false, scoreUnknown: false, paths: [] }],
      direct: { knownUsd: 300, excludedSupplyUnknownIds: [], unknownShareEdgeCount: 0, complete: true, overlapUsd: 0, integrityFlag: false },
      indirect: { knownUsd: 0, excludedSupplyUnknownIds: [], unknownShareEdgeCount: 0, complete: true, overlapUsd: 0, integrityFlag: false },
      reached: 1, bandCounts: { material: 1, minor: 0, trace: 0, unknown: 0 } };
    render(<DependencyWatershed publication={pub} overlay={{ roots: ["aaa"], rows: new Map([["bbb", { minHop: 1 }]]) }} result={result} labelOf={labelOf} onAddRoot={vi.fn()} fallback={null} />);
    expect(screen.getByText("Downstream of AAA: $300.00 of mapped dependent supply across 1 coin")).toBeTruthy();
    expect(screen.getByText("Linked coins; not a loss forecast")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: /Dependency watershed/ })).getAllByRole("button")[0]!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("DependencyMapBasinList", () => {
  it("lists hubs below md, drills down by hop, re-roots, and shows n/a for unknown supply", () => {
    const pub = publication(edges);
    const cards = pub.nodes.map(entry => ({ id: entry.id, name: labelOf(entry.id), symbol: labelOf(entry.id) }));
    const model = buildDependencyHubsModel({ cards, edges, mcapMap: new Map(pub.nodes.map(entry => [entry.id, entry.circulatingUsdAtEvaluation])) });
    const onExposure = vi.fn();
    const { container } = render(<DependencyMapBasinList model={model} publication={pub} labelOf={labelOf} onExposure={onExposure} />);
    expect(container.firstElementChild?.className).toContain("md:hidden");
    fireEvent.click(screen.getByRole("button", { name: /^AAA/ }));
    expect(screen.getByText(/^Hop 1/)).toBeTruthy();
    expect(screen.getByText(/^Hop 2/)).toBeTruthy();
    expect(screen.getAllByText("n/a").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Show what depends on BBB" }));
    expect(screen.getByRole("navigation", { name: "Basin trail" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use BBB as exposure root" }));
    expect(onExposure).toHaveBeenCalledWith("bbb");
  });

  it("keeps null hub supply as n/a and opens a coin with its own analytics event", () => {
    const pub = publication([{ from: "aaa", to: "ddd", kind: "serial", materiality: "serial", weight: null, upstreamScore: 80 }]);
    const cards = pub.nodes.map(entry => ({ id: entry.id, name: labelOf(entry.id), symbol: labelOf(entry.id) }));
    const model = buildDependencyHubsModel({ cards, edges: pub.edges, mcapMap: new Map([["ddd", null]]) });
    render(<DependencyMapBasinList model={model} publication={pub} labelOf={labelOf} />);
    const row = screen.getByRole("button", { name: /^AAA/ });
    expect(row.textContent).toContain("n/a");
    fireEvent.click(row);
    expect(screen.getByText(/1 supplies unavailable/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open coin AAA" });
    expect(link.getAttribute("href")).toBe("/stablecoin/aaa");
    fireEvent.click(link);
    expect(trackEvent).toHaveBeenCalledWith("dependency_map_action", { action: "hub_open_coin", value: "aaa" });
  });
});
