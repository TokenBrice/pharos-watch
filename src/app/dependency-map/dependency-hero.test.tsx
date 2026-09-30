// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DependencyHero } from "./dependency-hero";
import { buildDependencyHubsModel } from "@/lib/dependency-hubs-model";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

vi.mock("@/components/contagion-graph-root", () => ({ ContagionGraph: () => <div /> }));
const cards = [{ id: "parent", name: "Parent", symbol: "P", grade: "A" as const }, { id: "child", name: "Child", symbol: "C", grade: "A" as const }];
const edges: ReportCardsV9DependencyEdge[] = [{ from: "parent", to: "child", kind: "basket", materiality: "basket-weighted", weight: 0.4, upstreamScore: 80 }];

describe("DependencyHero", () => {
  it("shows an empty publication rather than a fabricated zero-dollar exposure", () => {
    const model = buildDependencyHubsModel({ cards, edges: [], mcapMap: new Map() });
    render(<DependencyHero model={model} cards={cards} dependencyEdges={[]} mcapMap={new Map()} methodologyVersion="9.94" publishedAt={1790716625} />);
    expect(screen.getByText("No mapped dependencies")).toBeTruthy();
    expect(screen.queryByText(/\$0/)).toBeNull();
  });
  it("names unknown supply separately from a genuine measured zero", () => {
    const model = buildDependencyHubsModel({ cards, edges, mcapMap: new Map([["child", null]]) });
    render(<DependencyHero model={model} cards={cards} dependencyEdges={edges} mcapMap={new Map()} methodologyVersion="9.94" publishedAt={1790716625} />);
    expect(screen.getByText("Supply data unavailable")).toBeTruthy();
    expect(screen.getByText(/Excludes 1 coins without supply data/)).toBeTruthy();
  });
  it("displays distinct publication and market-cap source clocks", () => {
    const model = buildDependencyHubsModel({ cards, edges, mcapMap: new Map([["child", 1000]]), marketCapAsOf: 1790716625 });
    render(<DependencyHero model={model} cards={cards} dependencyEdges={edges} mcapMap={new Map()} methodologyVersion="9.94" publishedAt={1790803025} />);
    expect(screen.getByText(`V9 9.94 · published ${new Date(1790803025 * 1000).toISOString()}`)).toBeTruthy();
    expect(screen.getByText(`market cap as of ${new Date(1790716625 * 1000).toISOString()}`)).toBeTruthy();
  });
});
