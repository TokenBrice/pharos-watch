// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MintBurnReconciliationSummary } from "@shared/types";
import { MintBurnReconciliationCard } from "@/components/status/mint-burn-reconciliation";

function makeSummary(rowCount: number): MintBurnReconciliationSummary {
  return {
    checkedAt: 1_773_000_000,
    comparedCoins: 4,
    criticalCount: 1,
    warnCount: 1,
    insufficientCount: Math.max(0, rowCount - 2),
    rows: Array.from({ length: rowCount }, (_, index) => ({
      stablecoinId: `coin-${index}`,
      symbol: `SYM${index}`,
      flowNet24hUsd: 1_000_000 + index * 10_000,
      chainSupplyDelta24hUsd: index % 3 === 0 ? null : 900_000 + index * 10_000,
      absoluteDiffUsd: index % 3 === 0 ? null : 100_000 + index * 1_000,
      diffRatio: index % 3 === 0 ? null : 0.12,
      status: index === 0 ? "critical" : index === 1 ? "warn" : "insufficient-source",
      coverageStatus: "full",
    })),
  };
}

describe("MintBurnReconciliationCard", () => {

  it("collapses the long tail behind a disclosure button", () => {
    render(<MintBurnReconciliationCard summary={makeSummary(8)} />);

    expect(screen.getByText("SYM0")).toBeTruthy();
    expect(screen.getByText("SYM5")).toBeTruthy();
    expect(screen.queryByText("SYM6")).toBeNull();
    expect(screen.queryByText("SYM7")).toBeNull();
    expect(screen.getByRole("button", { name: "See all 8 assets" })).toBeTruthy();
  });

  it("reveals the remaining rows when expanded", () => {
    render(<MintBurnReconciliationCard summary={makeSummary(8)} />);

    fireEvent.click(screen.getByRole("button", { name: "See all 8 assets" }));

    expect(screen.getByText("SYM6")).toBeTruthy();
    expect(screen.getByText("SYM7")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show fewer" })).toBeTruthy();
  });
});
