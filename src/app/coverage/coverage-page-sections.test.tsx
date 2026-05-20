// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CoverageMobileResults } from "./coverage-page-sections";
import { buildCoverageRow } from "@/lib/coverage";
import type { StablecoinMeta } from "@shared/types";

function makeCoverageRow(index: number) {
  return buildCoverageRow({
    coin: {
      id: `coin-${index}`,
      name: `Coin ${index}`,
      symbol: `C${index}`,
      flags: {
        pegCurrency: "peggedUSD",
        backing: "fiat-backed",
        governance: "centralized",
      },
    } as StablecoinMeta,
    marketCapUsd: 1_000_000 + index,
    hasPegCoverage: true,
    consensusSources: ["a", "b", "c"],
    priceConfidence: "high",
    safetyScore: 80,
    dexCoverageClass: "primary",
    hasYieldCoverage: true,
    flowCoverageStatus: "complete",
    hasDependencyCoverage: true,
    liveReserveFresh: true,
  });
}

describe("CoverageMobileResults", () => {
  it("batches mobile coverage cards and can collapse back to the first batch", () => {
    const rows = Array.from({ length: 30 }, (_value, index) => makeCoverageRow(index + 1));

    render(<CoverageMobileResults rows={rows} logos={{}} />);

    expect(screen.getByText("Showing 24 of 30 matching coins")).toBeTruthy();
    expect(screen.getByText("C24")).toBeTruthy();
    expect(screen.queryByText("C25")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show next 6 coins" }));

    expect(screen.getByText("Showing 30 of 30 matching coins")).toBeTruthy();
    expect(screen.getByText("C30")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));

    expect(screen.getByText("Showing 24 of 30 matching coins")).toBeTruthy();
    expect(screen.queryByText("C30")).toBeNull();
  });
});
