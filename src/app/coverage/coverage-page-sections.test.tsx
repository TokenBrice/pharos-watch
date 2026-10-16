// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CoverageMatrixCard, CoverageSafetyScoreDataCard } from "@/components/coverage/coverage-page-sections";
import { buildCoverageRow } from "@/lib/coverage";
import { logosById } from "@/lib/logos";
import { buildDataCoverageModel } from "@/lib/safety-score-data-coverage";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import type { StablecoinMeta } from "@shared/types";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

function makeCoverageRow(index: number, overrides: Partial<Parameters<typeof buildCoverageRow>[0]> = {}) {
  return buildCoverageRow({
    coin: {
      id: `coin-${index}`,
      name: `Coin ${index}`,
      symbol: `C${index}`,
      flags: {
        pegCurrency: "USD",
        backing: "rwa-backed",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
        navToken: false,
      },
    } satisfies StablecoinMeta,
    marketCapUsd: 1_000_000 + index,
    hasPegCoverage: true,
    consensusSources: ["a", "b", "c"],
    priceConfidence: "high",
    safetyScore: 80,
    dexCoverageClass: "primary",
    hasYieldCoverage: true,
    flowCoverageStatus: "full",
    hasDependencyCoverage: true,
    liveReserveFresh: true,
    ...overrides,
  });
}

type CoverageMatrixModel = Parameters<typeof CoverageMatrixCard>[0];

function makeMatrixModel(overrides: Partial<CoverageMatrixModel> = {}): CoverageMatrixModel {
  const rows = [makeCoverageRow(1)];
  return {
    logos: logosById,
    rows,
    filter: "all",
    setFilter: () => {},
    sort: "market-cap",
    setSort: () => {},
    search: "",
    setSearch: () => {},
    filteredRows: rows,
    hasActiveFilters: false,
    resetFilters: () => {},
    unavailableFeatures: [],
    dataUpdatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("CoverageMatrixCard", () => {
  it("renders unavailable feed warnings without counting them as ordinary gaps", () => {
    const rows = [makeCoverageRow(1, { dataAvailability: { redemption: false } })];
    const { container } = render(
      <CoverageMatrixCard {...makeMatrixModel({ rows, filteredRows: rows, unavailableFeatures: ["redemption"] })} />,
    );
    const view = within(container);

    expect(view.getByRole("status").textContent).toContain("Data n/a");
    expect(view.getByRole("status").textContent).toContain("Backstop");
    expect(
      view.getAllByLabelText(/Data unavailable\. Redemption backstop coverage data is unavailable/).length,
    ).toBeGreaterThan(0);
    expect(
      view.queryByLabelText(/Not covered\. No modeled redemption-backstop route is currently configured/),
    ).toBeNull();
  });

  it("pages long results 20 at a time with an honest count and a URL page", () => {
    window.history.replaceState(null, "", "/coverage/");
    const rows = Array.from({ length: 30 }, (_value, index) => makeCoverageRow(index + 1));
    const { container } = render(<CoverageMatrixCard {...makeMatrixModel({ rows, filteredRows: rows })} />);

    expect(container.textContent).toContain("Showing 1–20 of 30 coins");
    expect(screen.getAllByText("C20").length).toBeGreaterThan(0);
    expect(screen.queryByText("C21")).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Go to next page" })[0]);

    expect(window.location.search).toBe("?page=2");
    expect(container.textContent).toContain("Showing 21–30 of 30 coins");
    expect(screen.getAllByText("C30").length).toBeGreaterThan(0);
    expect(screen.queryByText("C20")).toBeNull();
    window.history.replaceState(null, "", "/coverage/");
  });

});

describe("CoverageSafetyScoreDataCard", () => {
  it("renders the score-input summary and expandable detail on the coverage page", () => {
    const safetyScoreDataCoverage = buildDataCoverageModel(
      makeReportCardsV9Response({ cards: [makeV9Card({ id: "asset-a" })] }),
    );

    const { container } = render(
      <CoverageSafetyScoreDataCard safetyScoreDataCoverage={safetyScoreDataCoverage} />,
    );

    expect(screen.getByRole("heading", { name: "Score input coverage" })).toBeTruthy();
    expect(container.textContent).toContain("1 asset is scored");
    expect(screen.getByText(/Coverage detail|Which inputs are missing/)).toBeTruthy();
    expect(screen.getByText("Inputs evaluated")).toBeTruthy();
  });
});
