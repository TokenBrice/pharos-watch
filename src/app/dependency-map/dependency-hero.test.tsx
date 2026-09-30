// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DependencyHero } from "./dependency-hero";
import { useDependencyExposureWorkspace } from "./dependency-exposure-workspace";
import { buildDependencyHubsModel } from "@/lib/dependency-hubs-model";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

vi.mock("@/components/contagion-graph-root", () => ({ ContagionGraph: () => <div /> }));
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
