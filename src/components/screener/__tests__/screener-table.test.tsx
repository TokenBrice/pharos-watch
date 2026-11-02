// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenerTable } from "@/components/screener/screener-table";
import { PEG_SCORE_HEADER_TITLE } from "@/lib/definitions";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";
import type { ScreenerRow, ScreenerSortKey } from "@/lib/screener-filters";
import type { DataTableSortControls } from "@/components/data-table-shell";

const row: ScreenerRow = {
  id: "usdt-tether",
  name: "Tether",
  symbol: "USDT",
  lifecycle: "active",
  mechanism: null,
  type: "centralized",
  peg: "USD",
  supplyUsd: 100_000_000,
  pegScore: 98,
  dewsScore: 12,
  liquidityScore: 86,
  safetyGrade: "B+",
  safetyScore: 82,
  ratingStatus: "rated",
  partialEvidence: null,
  safetyBackingScore: 78,
  safetyExitScore: 86,
  safetyControlScore: 42,
  safetyEvidence: "adequate",
  safetyWeakestPillar: "control",
  safetyWeakestScore: 42,
  safetyBindingCapReason: null,
  custodyModel: "institutional-regulated",
  blacklistable: "yes",
  mintAuthority: "issuer-or-backend-mint",
  mintAuthorityScore: 42,
  mintAuthorityScoreBand: "concentrated",
  mintAuthorityScoreLabel: "42/100",
  mintAuthorityScoreBandLabel: "Concentrated",
  mintAuthorityScoreBadgeClassName: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  mintAuthorityScoreDetail: "Mint Authority Score: 42/100 (Concentrated).",
};

const rowWithSeries: ScreenerRow = {
  ...row,
  pegDeviationSeries: [0, 3, -2, 1],
  supplySeries: [98_000_000, 99_000_000, 100_000_000],
};

function installViewportMatchMedia(width: number) {
  installMatchMediaMock((query) => {
    const maxWidth = /max-width:\s*(\d+)px/.exec(query)?.[1];
    return maxWidth ? width <= Number(maxWidth) : false;
  });
}

function makeSort(
  overrides: Partial<DataTableSortControls<ScreenerSortKey>> = {},
): DataTableSortControls<ScreenerSortKey> {
  return {
    sortKey: "safetyScore",
    sortDirection: "desc",
    toggleSort: vi.fn(),
    getAriaSortValue: () => "none",
    ...overrides,
  };
}

afterEach(() => {
  cleanupFrontendTest();
});

describe("ScreenerTable mobile cards", () => {
  it("server-renders a cheap pending branch before viewport hydration", () => {
    const html = renderToStaticMarkup(
      <ScreenerTable rows={[rowWithSeries]} dataState="ready" hasActiveFilters={false} sort={makeSort()} />,
    );

    expect(html).toContain("stablecoin-screener-layout-pending");
    expect(html).not.toContain("stablecoin-screener-table");
    expect(html).not.toContain("<svg");
  });

  it("renders the mobile card path with compact score facts and mobile sort controls", async () => {
    const toggleSort = vi.fn();
    installViewportMatchMedia(500);

    render(<ScreenerTable rows={[row]} dataState="ready" hasActiveFilters={false} sort={makeSort({ toggleSort })} />);

    await waitFor(() => {
      expect(screen.getAllByText("USDT").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("Sort results")).toBeTruthy();
    expect(screen.getAllByText(/Peg/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/DEWS/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Liq/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Adequate").length).toBeGreaterThan(0);
    expect(screen.getByText("Mint authority")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open Safety Score waterfall for USDT/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Supply" }));

    expect(toggleSort).toHaveBeenCalledWith("supply");
    expect(screen.queryByTestId("stablecoin-screener-table")).toBeNull();
  });
});

describe("ScreenerTable desktop table", () => {

  it.each([
    { cause: "C" as const, score: 35, reason: "undisclosed by issuer" },
    { cause: "U" as const, score: 50, reason: "unresolved" },
  ])("renders $cause priced unknowns with cause-specific text", async ({ cause, score, reason }) => {
    installViewportMatchMedia(1400);
    const partial: ScreenerRow = {
      ...row,
      partialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["exit"], causes: [] },
      pillars: { backing: { score: 78 }, exit: { score: null, aggregationDisposition: "unavailable", pricedUnknown: { cause, score } }, control: { score: 42 } },
    };
    const { container } = render(<ScreenerTable rows={[partial]} dataState="ready" hasActiveFilters={false} sort={makeSort()} />);
    await waitFor(() => expect(container.textContent).toContain(`Exit ${reason} (assumed ${score})`));
    expect(container.textContent).not.toContain("pipeline gap");
  });
  it("labels the safety summary badge with the projected V9 grade and score", async () => {
    installViewportMatchMedia(1400);

    render(<ScreenerTable rows={[row]} dataState="ready" hasActiveFilters={false} sort={makeSort()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Safety grade B+, score 82")).toBeTruthy();
    });
  });

  it("states the Peg Score's real tracking window in the header tooltip", async () => {
    installViewportMatchMedia(1400);

    render(<ScreenerTable rows={[row]} dataState="ready" hasActiveFilters={false} sort={makeSort()} />);

    await waitFor(() => expect(screen.getByTestId("stablecoin-screener-table")).toBeTruthy());
    const title = screen.getByText("Peg Score").closest("th")?.getAttribute("title");
    expect(title).toBe(PEG_SCORE_HEADER_TITLE);
    expect(title).not.toMatch(/over 30 days/i);
  });

  it("skips xl-only sparkline SVGs below the xl breakpoint", async () => {
    installViewportMatchMedia(900);

    render(<ScreenerTable rows={[rowWithSeries]} dataState="ready" hasActiveFilters={false} sort={makeSort()} />);

    await waitFor(() => {
      expect(screen.getByTestId("stablecoin-screener-table")).toBeTruthy();
    });
    expect(screen.queryByRole("img", { name: /Peg range: worst \/ current for USDT/i })).toBeNull();
    expect(screen.queryByRole("img", { name: /30-day supply trajectory for USDT/i })).toBeNull();
  });

  it("renders xl sparkline SVGs and labels the peg column as a worst/current range", async () => {
    installViewportMatchMedia(1400);

    render(<ScreenerTable rows={[rowWithSeries]} dataState="ready" hasActiveFilters={false} sort={makeSort()} />);

    await waitFor(() => {
      expect(screen.getByRole("img", { name: /Peg range: worst \/ current for USDT/i })).toBeTruthy();
    });
    expect(screen.getByRole("img", { name: /30-day supply trajectory for USDT/i })).toBeTruthy();
    // The cell renders two endpoint samples (all-time worst, current), so the
    // column must not claim a 30-day window.
    expect(screen.queryByText("30d Peg")).toBeNull();
    expect(screen.getByText("Peg range").closest("th")?.getAttribute("title")).toBe(
      "Peg range: worst / current deviation (±bps around the peg)",
    );
  });
});

describe("ScreenerTable pagination", () => {
  const rows = Array.from({ length: 55 }, (_, index) => ({
    ...row,
    id: `coin-${index}`,
    name: `Coin ${index}`,
    symbol: `COIN${index}`,
  }));

  it.each([500, 1400])("bounds the active %ipx layout and discloses the full matched count", async (width) => {
    installViewportMatchMedia(width);
    const { rerender } = render(
      <ScreenerTable rows={rows} dataState="ready" hasActiveFilters={false} sort={makeSort()} />,
    );

    await waitFor(() => expect(screen.getByText("Coin 0")).toBeTruthy());
    expect(screen.getByText("Coin 49")).toBeTruthy();
    expect(screen.queryByText("Coin 50")).toBeNull();
    expect(screen.getByText(/Showing/).textContent).toBe("Showing 1–50 of 55 stablecoins");
    if (width === 1400) expect(screen.getAllByRole("row")).toHaveLength(51);
    else expect(screen.queryByRole("table")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
    expect(screen.getByText("Coin 50")).toBeTruthy();
    expect(screen.getByText("Coin 54")).toBeTruthy();
    expect(screen.queryByText("Coin 0")).toBeNull();
    expect(screen.getByText(/Showing/).textContent).toBe("Showing 51–55 of 55 stablecoins");
    expect(screen.getByRole("button", { name: "Go to next page" }).hasAttribute("disabled")).toBe(true);

    rerender(<ScreenerTable rows={rows.slice(0, 2)} dataState="ready" hasActiveFilters sort={makeSort()} />);
    expect(screen.getByText("Coin 0")).toBeTruthy();
    expect(screen.getByText(/Showing/).textContent).toBe("Showing 1–2 of 2 stablecoins");
  });

  it.each([500, 1400])("separates loading, settled failure and valid empty counts at %ipx", async (width) => {
    installViewportMatchMedia(width);
    const view = render(
      <ScreenerTable rows={[]} dataState="loading" hasActiveFilters={false} sort={makeSort()} />,
    );
    await waitFor(() => expect(screen.getByText("Loading results…")).toBeTruthy());
    expect(screen.queryByText(/Showing/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Go to next page" })).toBeNull();

    view.rerender(<ScreenerTable rows={[]} dataState="unavailable" hasActiveFilters={false} sort={makeSort()} />);
    expect(screen.getByText("Result counts unavailable.")).toBeTruthy();
    expect(screen.getByText(/Screener inputs unavailable/)).toBeTruthy();
    expect(screen.queryByText(/Loading/)).toBeNull();
    expect(screen.queryByText(/Showing/)).toBeNull();

    view.rerender(<ScreenerTable rows={[]} dataState="ready" hasActiveFilters sort={makeSort()} />);
    expect(screen.getByText(/Showing/).textContent).toBe("Showing 0–0 of 0 stablecoins");
    expect(screen.getByText("No stablecoins match these filters.")).toBeTruthy();
  });

  it("leaves Enter activation to pager and sorting buttons instead of opening the cursor coin", async () => {
    installViewportMatchMedia(1400);
    const toggleSort = vi.fn();
    render(<ScreenerTable rows={rows} dataState="ready" hasActiveFilters={false} sort={makeSort({ toggleSort })} />);
    await waitFor(() => expect(screen.getByText("Coin 0")).toBeTruthy());
    const opened = vi.fn((event: Event) => event.preventDefault());
    document.querySelectorAll("[data-screener-open]").forEach((link) => link.addEventListener("click", opened));

    const next = screen.getByRole("button", { name: "Go to next page" });
    next.focus();
    expect(fireEvent.keyDown(next, { key: "Enter" })).toBe(true);
    expect(opened).not.toHaveBeenCalled();
    // jsdom does not synthesize a native button click from a keyboard event.
    fireEvent.click(next);
    expect(screen.getByText("Coin 50")).toBeTruthy();
    const previous = screen.getByRole("button", { name: "Go to previous page" });
    previous.focus();
    expect(fireEvent.keyDown(previous, { key: "Enter" })).toBe(true);
    fireEvent.click(previous);
    expect(screen.getByText("Coin 0")).toBeTruthy();

    const supply = screen.getByRole("button", { name: "Sort by Supply" });
    supply.focus();
    expect(fireEvent.keyDown(supply, { key: "Enter" })).toBe(true);
    fireEvent.click(supply);
    expect(toggleSort).toHaveBeenCalledWith("supply");
    expect(opened).not.toHaveBeenCalled();
  });
});
