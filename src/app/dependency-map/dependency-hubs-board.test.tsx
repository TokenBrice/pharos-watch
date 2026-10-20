// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DependencyHubsBoard } from "./dependency-hubs-board";
import { buildDependencyHubsModel } from "@shared/lib/dependency-hubs-model";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

const cards = Array.from({ length: 8 }, (_, i) => ({ id: `coin-${i}`, name: `Coin ${i}`, symbol: `C${i}` }));
const edges: ReportCardsV9DependencyEdge[] = cards.slice(0, 7).map(card => ({ from: card.id, to: "coin-7", kind: "basket", materiality: "basket-weighted", weight: 0.1, upstreamScore: 80 }));
const model = buildDependencyHubsModel({ cards, edges, mcapMap: new Map([["coin-7", 1000]]), marketCapAsOf: 1790716625 });

describe("DependencyHubsBoard", () => {
  it("renders six rows without changing the full-graph scope or amounts", () => {
    render(<DependencyHubsBoard model={model} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(7);
    expect(within(table).getByText("Top 6 of 7")).toBeTruthy();
    expect(within(table).getAllByText("$100.00")).toHaveLength(6);
    expect(within(table).getAllByText("100% from C7")).toHaveLength(6);
    expect(screen.queryByText("Coin 6")).toBeNull();
  });
  it.each([
    { supply: null, weight: 0.5, expected: "Unavailable" },
    { supply: 100, weight: null, expected: "Unavailable" },
    { supply: 0, weight: 0.5, expected: "$0.00" },
    { supply: 100, weight: 0, expected: "$0.00" },
    { supply: 100, weight: 0.5, expected: "$50.00" },
  ])("preserves direct exposure availability for $supply supply and $weight share", ({ supply, weight, expected }) => {
    const publishedEdges = [{ ...edges[0], weight }];
    const model = buildDependencyHubsModel({ cards, edges: publishedEdges, mcapMap: new Map([["coin-7", supply]]) });
    render(<DependencyHubsBoard model={model} />);
    const cells = within(screen.getByRole("table")).getAllByRole("row")[1].querySelectorAll("td");
    expect(cells[1].querySelector("p")!.textContent).toBe(expected);
  });
  it("labels a mixed known subtotal and keeps missing classified supplies unavailable", () => {
    const publishedEdges: ReportCardsV9DependencyEdge[] = [
      { ...edges[0], weight: 0.5 },
      { ...edges[0], to: "coin-6", weight: null },
      { ...edges[0], to: "coin-5", kind: "serial", materiality: "serial", weight: null, wrapperForm: "pure" },
      { ...edges[0], to: "coin-4", kind: "serial", materiality: "serial", weight: null, wrapperForm: "strategy-vault" },
    ];
    const model = buildDependencyHubsModel({ cards, edges: publishedEdges, mcapMap: new Map([["coin-7", 100], ["coin-6", 100]]) });
    render(<DependencyHubsBoard model={model} />);
    const cells = within(screen.getByRole("table")).getAllByRole("row")[1].querySelectorAll("td");
    expect(cells[1].querySelector("p")!.textContent).toBe("$50.00 (known only)");
    expect(cells[2].textContent).toBe("Unavailable");
    expect(cells[3].textContent).toBe("Unavailable");
  });
  it("does not let a defunct or absent target make unknown live exposure measurable", () => {
    const publishedEdges = [{ ...edges[0], weight: null }, { ...edges[0], to: "retired" }, { ...edges[0], to: "absent" }];
    const model = buildDependencyHubsModel({ cards: [...cards, { id: "retired", name: "Retired", symbol: "R", isDefunct: true }], edges: publishedEdges, mcapMap: new Map([["coin-7", 100]]) });
    render(<DependencyHubsBoard model={model} />);
    const cells = within(screen.getByRole("table")).getAllByRole("row")[1].querySelectorAll("td");
    expect(cells[1].querySelector("p")!.textContent).toBe("Unavailable");
  });
  it("does not publish a board for a graph with no dependents", () => {
    const model = buildDependencyHubsModel({ cards, edges: [], mcapMap: new Map() });
    const { container } = render(<DependencyHubsBoard model={model} />);
    expect(container.textContent).toBe("");
  });

});
