// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DependencyHero } from "./dependency-hero";
import { useDependencyExposureWorkspace } from "./dependency-exposure-workspace";
import { buildDependencyHubsModel } from "@shared/lib/dependency-hubs-model";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type { DependencyGraphResponse } from "@shared/types/dependency-graph";

vi.mock("@/components/contagion-graph-root", () => ({ ContagionGraph: ({ modeControls }: { modeControls?: ReactNode }) => <div>{modeControls}</div> }));
const cards = [{ id: "parent", name: "Parent", symbol: "P", grade: "A" as const }, { id: "child", name: "Child", symbol: "C", grade: "A" as const }];
const edges: ReportCardsV9DependencyEdge[] = [{ from: "parent", to: "child", kind: "basket", materiality: "basket-weighted", weight: 0.4, upstreamScore: 80 }];
function Harness({ publishedEdges, supply }: { publishedEdges: ReportCardsV9DependencyEdge[]; supply: number | null }) {
  const workspace = useDependencyExposureWorkspace(undefined);
  const mcapMap = new Map([["child", supply]]);
  const model = buildDependencyHubsModel({ cards, edges: publishedEdges, mcapMap });
  return <DependencyHero workspace={workspace} model={model} cards={cards} dependencyEdges={publishedEdges} mcapMap={mcapMap} methodologyVersion="9.94" publishedAt={1790716625} />;
}
afterEach(cleanup);
describe("DependencyHero availability", () => {
  it("does not fabricate USD for an empty graph or unavailable supply", () => {
    const empty = render(<Harness publishedEdges={[]} supply={null} />);
    expect(empty.container.textContent).not.toMatch(/\$0/);
    empty.unmount();
    const unknown = render(<Harness publishedEdges={edges} supply={null} />);
    expect(unknown.container.textContent).not.toMatch(/\$0/);
    expect(screen.getByText("Supply data unavailable")).toBeTruthy();
  });
  it("distinguishes published zero supply from unavailable supply", () => {
    render(<Harness publishedEdges={edges} supply={0} />);
    expect(screen.queryByText("Supply data unavailable")).toBeNull();
    expect(screen.getByText("$0.00")).toBeTruthy();
  });
});

describe("DependencyHero view switch", () => {
  function DesktopHarness() {
    const pub = { methodologyVersion: "10.17", publicationGenerationId: "g:abcdef1", asOfSec: 0, updatedAt: 0, publicationStatus: "current", publicationHealth: { status: "current", acceptedPublicationGenerationId: "g:abcdef1" },
      nodes: cards.map(card => ({ id: card.id, grade: "A", ratingStatus: "rated", partialEvidence: null, score: 80, circulatingUsdAtEvaluation: 100, supplyAsOfSec: 1790716625, sharedBookId: null, roles: [], dependencyCoverageCount: null })), edges } as unknown as DependencyGraphResponse;
    const workspace = useDependencyExposureWorkspace(pub);
    const mcapMap = new Map([["child", 100]]);
    const model = buildDependencyHubsModel({ cards, edges, mcapMap });
    return <DependencyHero workspace={workspace} model={model} cards={cards} dependencyEdges={edges} mcapMap={mcapMap} methodologyVersion="10.17" publishedAt={1790716625} />;
  }
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(min-width: 768px)", addEventListener: () => {}, removeEventListener: () => {} }));
  });
  afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

  it("defaults to the watershed on desktop and keeps other parameters when switching to network", () => {
    window.history.replaceState(null, "", "/dependency-map/?ref=coin");
    render(<DesktopHarness />);
    expect(screen.getByRole("group", { name: /Dependency watershed/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Network" }));
    expect(window.location.search).toBe("?ref=coin&view=network");
    expect(screen.queryByRole("group", { name: /Dependency watershed/ })).toBeNull();
  });

  it("restores the network view from ?view=network and preserves other parameters", () => {
    window.history.replaceState(null, "", "/dependency-map/?limit=all&root=parent&view=network");
    render(<DesktopHarness />);
    expect(screen.queryByRole("group", { name: /Dependency watershed/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Watershed" }));
    expect(window.location.search).toBe("?limit=all&root=parent&view=watershed");
    expect(screen.getByRole("group", { name: /Dependency watershed/ })).toBeTruthy();
  });

  it("opens the coin-page ?focus= deep link in the Network view, which reads focus", () => {
    window.history.replaceState(null, "", "/dependency-map/?focus=parent");
    render(<DesktopHarness />);
    expect(screen.queryByRole("group", { name: /Dependency watershed/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Network" }).getAttribute("aria-pressed")).toBe("true");
  });
});
