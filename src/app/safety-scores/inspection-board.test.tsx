// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafetyInspectionBoard } from "./inspection-board";
import type { SafetyInspectionBoardModel } from "./view-model";

const MODEL: SafetyInspectionBoardModel = {
  inspectedCount: 2,
  totalMarketCapUsd: 100,
  findingExposureUsd: 40,
  leadFinding: {
    key: "liquidity",
    label: "Liquidity",
    shortLabel: "Liq.",
    averageScore: 31,
    weightedScore: 40,
    findingCount: 2,
    findingExposureUsd: 40,
    unknownCount: 0,
    worstFindings: [
      { id: "weak", symbol: "WEAK", name: "Weak Coin", grade: "F", score: 20, marketCapUsd: 10 },
    ],
  },
  rows: [
    {
      key: "liquidity",
      label: "Liquidity",
      shortLabel: "Liq.",
      averageScore: 31,
      weightedScore: 40,
      findingCount: 2,
      findingExposureUsd: 40,
      unknownCount: 0,
      worstFindings: [
        { id: "weak", symbol: "WEAK", name: "Weak Coin", grade: "F", score: 20, marketCapUsd: 10 },
      ],
    },
    {
      key: "resilience",
      label: "Resilience",
      shortLabel: "Res.",
      averageScore: 80,
      weightedScore: 82,
      findingCount: 0,
      findingExposureUsd: 0,
      unknownCount: 0,
      worstFindings: [],
    },
  ],
};

describe("SafetyInspectionBoard", () => {
  afterEach(() => cleanup());

  it("marks weakest-first inspection sort as active only for ascending dimension sort", () => {
    const onSortChange = vi.fn();
    const { rerender } = render(
      <SafetyInspectionBoard
        model={MODEL}
        sortKey="liquidity"
        sortDirection="asc"
        onSortChange={onSortChange}
      />,
    );

    const liquidityButton = screen.getByRole("button", { name: "Sort report cards by weakest Liquidity first" });
    expect(liquidityButton.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Sort report cards by weakest Resilience first" }));
    expect(onSortChange).toHaveBeenCalledWith("resilience");

    rerender(
      <SafetyInspectionBoard
        model={MODEL}
        sortKey="liquidity"
        sortDirection="desc"
        onSortChange={onSortChange}
      />,
    );
    expect(liquidityButton.getAttribute("aria-pressed")).toBe("false");
  });
});
