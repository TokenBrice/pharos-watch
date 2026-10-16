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

});
