// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DependencyHero } from "./dependency-hero";
import { useDependencyExposureWorkspace } from "./dependency-exposure-workspace";
import { buildDependencyHubsModel } from "@shared/lib/dependency-hubs-model";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

vi.mock("@/components/contagion-graph-root", () => ({ ContagionGraph: ({ modeControls }: { modeControls?: ReactNode }) => <div>{modeControls}</div> }));
const cards = [{ id: "parent", name: "Parent", symbol: "P", grade: "A" as const }, { id: "child", name: "Child", symbol: "C", grade: "A" as const }, { id: "other", name: "Other", symbol: "O", grade: "A" as const }];
const edges: ReportCardsV9DependencyEdge[] = [{ from: "parent", to: "child", kind: "basket", materiality: "basket-weighted", weight: 0.4, upstreamScore: 80 }];
function Harness({ publishedEdges, supply, otherSupply = null, defunctOther = false }: { publishedEdges: ReportCardsV9DependencyEdge[]; supply: number | null; otherSupply?: number | null; defunctOther?: boolean }) {
  const workspace = useDependencyExposureWorkspace(undefined);
  const mcapMap = new Map([["child", supply], ["other", otherSupply]]);
  const model = buildDependencyHubsModel({ cards: cards.map(card => ({ ...card, isDefunct: defunctOther && card.id === "other" })), edges: publishedEdges, mcapMap });
  return <DependencyHero workspace={workspace} model={model} cards={cards} dependencyEdges={publishedEdges} mcapMap={mcapMap} methodologyVersion="9.94" publishedAt={1790716625} />;
}
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
  it("does not count a known supply with an unknown share as measurable exposure", () => {
    const unknownShare = [{ ...edges[0], weight: null }];
    const { container } = render(<Harness publishedEdges={unknownShare} supply={100} />);
    expect(screen.getByText("Exposure unavailable")).toBeTruthy();
    expect(container.textContent).not.toContain("$0");
  });
  it("requires the known supply and share on the same contribution", () => {
    render(<Harness publishedEdges={[{ ...edges[0], weight: null }, { ...edges[0], to: "other" }]} supply={100} />);
    expect(screen.getByText("Exposure unavailable")).toBeTruthy();
  });
  it("does not use defunct or absent edges to justify a known-only zero", () => {
    const { container } = render(<Harness publishedEdges={[{ ...edges[0], weight: null }, { ...edges[0], to: "other" }, { ...edges[0], to: "absent" }]} supply={100} otherSupply={100} defunctOther />);
    expect(screen.getByText("Exposure unavailable")).toBeTruthy();
    expect(container.textContent).not.toContain("$0");
  });
  it("qualifies the measured subtotal when other shares and supplies are unknown", () => {
    render(<Harness publishedEdges={[{ ...edges[0], weight: 0.5 }, { ...edges[0], to: "other", weight: null }]} supply={100} />);
    expect(screen.getByText("$50.00 (known only)")).toBeTruthy();
  });
  it("preserves an observed zero mapped share", () => {
    render(<Harness publishedEdges={[{ ...edges[0], weight: 0 }]} supply={100} />);
    expect(screen.getByText("$0.00")).toBeTruthy();
  });
  it("does not invent a classified wrapper subtotal when only basket exposure is measurable", () => {
    render(<Harness publishedEdges={[{ ...edges[0], weight: 0.5 }, { ...edges[0], to: "other", kind: "serial", materiality: "serial", wrapperForm: "pure", weight: null }]} supply={100} />);
    expect(screen.getByText("$50.00 (known only)")).toBeTruthy();
    const summary = screen.getByRole("region", { name: "Mapped direct exposure summary" });
    expect(summary.textContent).toContain("Wrapper claims Unavailable");
  });
});

