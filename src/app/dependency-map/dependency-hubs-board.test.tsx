// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DependencyHubsBoard } from "./dependency-hubs-board";
import type { DependencyHubsModel } from "@/lib/dependency-hubs-model";

const MODEL: DependencyHubsModel = {
  upstreamHubCount: 1,
  directEdgeCount: 3,
  uniqueDirectDependentCount: 2,
  summedDirectDependencyWeight: 0.9,
  uniqueDependentMcapUsd: 7_000_000_000,
  hubs: [
    {
      id: "usdc-circle",
      label: "USD Coin",
      symbol: "USDC",
      dependentCount: 2,
      summedDirectDependencyWeight: 0.9,
      uniqueDependentMcapUsd: 7_000_000_000,
      hubMcapUsd: 100_000_000_000,
      examples: [
        { id: "dai-maker", label: "Dai", symbol: "DAI", mcapUsd: 5_000_000_000 },
        { id: "frax-france", label: "Frax", symbol: "FRAX", mcapUsd: 2_000_000_000 },
      ],
      edgeTypeBreakdown: [
        { type: "collateral", edgeCount: 1, summedDirectDependencyWeight: 0.6 },
        { type: "mechanism", edgeCount: 1, summedDirectDependencyWeight: 0.2 },
        { type: "wrapper", edgeCount: 1, summedDirectDependencyWeight: 0.1 },
      ],
    },
  ],
};

describe("DependencyHubsBoard", () => {
  it("renders the dependency hub contract with exact modeled values", () => {
    render(<DependencyHubsBoard model={MODEL} />);

    const tableSurface = screen.getByTestId("dependency-hubs-board-table");
    expect(tableSurface.getAttribute("data-table-id")).toBe("dependency-hubs-board");
    expect(tableSurface.className).toContain("pharos-density-compact");
    expect(screen.getByRole("table", { name: "Direct dependency hubs" })).toBeTruthy();
    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
    expect(screen.getAllByText("Upstream hubs").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Direct dependency hubs").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Direct dependents").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Summed direct dependency weight").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Modeled dependent market-cap context").length).toBeGreaterThan(0);
    expect(screen.getByText("USD Coin")).toBeTruthy();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0.90").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$7.0B").length).toBeGreaterThan(0);
    expect(screen.getByText(/Hub own market cap \$100\.0B/)).toBeTruthy();
    expect(screen.getByText(/Example direct dependents:/)).toBeTruthy();
    expect(screen.getByText("DAI, FRAX")).toBeTruthy();
    expect(screen.getByText("Collateral")).toBeTruthy();
    expect(screen.getByText("Mechanism")).toBeTruthy();
    expect(screen.getByText("Wrapper")).toBeTruthy();
  });

  it("does not use overclaiming dependency language", () => {
    const { container } = render(<DependencyHubsBoard model={MODEL} />);
    const text = container.textContent?.toLowerCase() ?? "";
    const forbiddenTerms = [
      ["fire", "break"].join(""),
      ["contain", "ment"].join(""),
      ["lo", "ss"].join(""),
      ["liquid", "ity"].join(""),
      ["guaranteed ", "exposure"].join(""),
    ];

    for (const term of forbiddenTerms) {
      expect(text).not.toContain(term);
    }
  });
});
