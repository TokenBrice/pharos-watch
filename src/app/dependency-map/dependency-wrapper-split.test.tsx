// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import { buildDependencyHubsModel, type DependencyHubsModel } from "@/lib/dependency-hubs-model";
import { DependencyMapMobileSummary } from "@/components/dependency-map-mobile-summary";
import { DependencyHero } from "./dependency-hero";
import { DependencyHubsBoard } from "./dependency-hubs-board";
import { useDependencyExposureWorkspace } from "./dependency-exposure-workspace";

vi.mock("@/components/contagion-graph-root", () => ({ ContagionGraph: () => <div /> }));
afterEach(cleanup);
const cards = [
  { id: "usds-sky", name: "USDS", symbol: "USDS", grade: "A" as const },
  { id: "susds-sky", name: "Savings USDS", symbol: "sUSDS", grade: "A" as const },
  { id: "unknown", name: "Unknown", symbol: "U", grade: "A" as const },
  { id: "vault", name: "Vault", symbol: "V", grade: "A" as const },
];
const supplies = new Map([["susds-sky", 200], ["unknown", 500], ["vault", 100]]);
function serial(to: string, wrapperForm?: ReportCardsV9DependencyEdge["wrapperForm"]): ReportCardsV9DependencyEdge {
  return { from: "usds-sky", to, kind: "serial", materiality: "serial", weight: null, upstreamScore: 80, wrapperForm };
}
function Hero({ model, edges }: { model: DependencyHubsModel; edges: ReportCardsV9DependencyEdge[] }) {
  const workspace = useDependencyExposureWorkspace(undefined);
  return <DependencyHero model={model} cards={cards} dependencyEdges={edges} mcapMap={supplies} methodologyVersion="9.98" publishedAt={1790716625} workspace={workspace} />;
}

for (const surface of ["hero", "desktop", "mobile"] as const) {
  function show(edges: ReportCardsV9DependencyEdge[]) {
    const model = buildDependencyHubsModel({ cards, edges, mcapMap: supplies });
    if (surface === "hero") render(<Hero model={model} edges={edges} />);
    else if (surface === "desktop") render(<DependencyHubsBoard model={model} />);
    else render(<DependencyMapMobileSummary model={model} />);
    return surface === "hero" ? screen.getByRole("region", { name: "Mapped direct exposure summary" }) : surface === "desktop" ? screen.getByRole("table") : screen.getByText("Largest mapped direct exposures").closest("section") ?? document.body;
  }
  describe(`${surface} wrapper classification availability`, () => {
    it("keeps a v5 serial exposure visible without presenting missing classification as zero", () => {
      const content = show([serial("unknown")]);
      expect(content.textContent).toMatch(/split unavailable/i);
      expect(content.textContent).toContain("$500.00 of known serial exposure");
      if (surface === "hero") {
        expect(content.textContent).not.toMatch(/(?:Wrapper claims|vault claims) \$0\.00/);
      } else if (surface === "desktop") {
        const cells = within(content).getAllByRole("row")[1]!.querySelectorAll("td");
        expect(cells[2]!.textContent).not.toContain("$0.00");
        expect(cells[3]!.textContent).not.toContain("$0.00");
      } else {
        for (const value of content.querySelectorAll("dd")) expect(value.textContent).not.toContain("$0.00");
      }
    });
    it("shows only classified split amounts and identifies the remaining unknown exposure", () => {
      const content = show([serial("susds-sky", "pure"), serial("vault", "strategy-vault"), serial("unknown")]);
      expect(content.textContent).toContain("$200.00");
      expect(content.textContent).toContain("$100.00");
      expect(content.textContent).toContain("$500.00 of known serial exposure");
      expect(content.textContent).toMatch(/classified claims only/i);
      if (surface === "desktop") {
        const cells = within(content).getAllByRole("row")[1]!.querySelectorAll("td");
        expect(cells[2]!.textContent).toContain("$200.00");
        expect(cells[3]!.textContent).toContain("$100.00");
      }
    });
    it("does not assign a zero-dollar value to an unclassified vault category in a partial split", () => {
      const content = show([serial("susds-sky", "pure"), serial("unknown")]);
      if (surface === "hero") expect(content.textContent).toContain("vault claims unavailable");
      else if (surface === "desktop") expect(within(content).getAllByRole("row")[1]!.querySelectorAll("td")[3]!.textContent).not.toContain("$0.00");
      else expect(content.querySelectorAll("dd")[1]!.textContent).not.toContain("$0.00");
      expect(content.textContent).toContain("$500.00 of known serial exposure");
    });
  });
}
