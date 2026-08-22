// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CoverageMatrixCard, CoverageMobileResults, CoverageSafetyScoreDataCard } from "@/components/coverage/coverage-page-sections";
import { buildCoverageRow } from "@/lib/coverage";
import { logosById } from "@/lib/logos";
import { buildDataCoverageModel } from "@/lib/safety-score-data-coverage";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import type { StablecoinMeta } from "@shared/types";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
}));

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

describe("CoverageMobileResults", () => {
  it("batches mobile coverage cards and can collapse back to the first batch", () => {
    const rows = Array.from({ length: 30 }, (_value, index) => makeCoverageRow(index + 1));

    render(<CoverageMobileResults rows={rows} logos={logosById} />);

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

  it("renders the empty-result state and reset affordance", () => {
    render(
      <CoverageMatrixCard
        {...makeMatrixModel({
          search: "nomatch",
          filteredRows: [],
          hasActiveFilters: true,
        })}
      />,
    );

    expect(screen.getByText("No stablecoins match your search or filters.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear all filters" })).toBeTruthy();
  });

  it("renders the desktop comparison table with per-feature badges", () => {
    const { container } = render(<CoverageMatrixCard {...makeMatrixModel()} />);
    const view = within(container);

    const matrixSurface = view.getByTestId("coverage-matrix-table");
    const matrixTable = view.getByRole("table", { name: /Per-coin feature availability/ });

    expect(matrixSurface.getAttribute("data-table-id")).toBe("coverage-matrix");
    expect(matrixTable.getAttribute("data-slot")).toBe("table");
    expect(screen.getAllByText("Coin 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("C1").length).toBeGreaterThan(0);
    expect(within(matrixTable).getByRole("rowheader", { name: /Coin 1/ })).toBeTruthy();
    expect(screen.getAllByRole("columnheader", { name: /Backstop/ }).length).toBeGreaterThan(0);
  });

  it("renders the impaired redemption legend entry", () => {
    render(<CoverageMatrixCard {...makeMatrixModel()} />);

    expect(screen.getAllByText("Impaired").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "A redemption route is configured, but current market or route-availability evidence contradicts strong redemption coverage.",
      ).length,
    ).toBeGreaterThan(0);
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
