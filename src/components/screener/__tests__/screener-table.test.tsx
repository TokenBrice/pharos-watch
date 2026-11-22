// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenerTable } from "@/components/screener/screener-table";
import { PEG_SCORE_HEADER_TITLE } from "@/lib/definitions";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import type { ScreenerRow, ScreenerSortKey } from "@/lib/screener-filters";
import type { DataTableSortControls } from "@/components/data-table-shell";

function render(ui: React.ReactNode) {
  const client = new QueryClient();
  return rtlRender(ui, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}

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

const secondRow: ScreenerRow = {
  ...row,
  id: "usdc-circle",
  name: "USD Coin",
  symbol: "USDC",
  safetyGrade: "NR",
  safetyScore: null,
};

const rowWithSeries: ScreenerRow = {
  ...row,
  pegDeviationSeries: [0, 3, -2, 1],
  supplySeries: [98_000_000, 99_000_000, 100_000_000],
};

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

describe("ScreenerTable responsive @container layout", () => {
  it("server-renders both CSS @container responsive views without a JS hydration pending bounce", () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ScreenerTable rows={[rowWithSeries]} dataState="ready" hasActiveFilters={false} sort={makeSort()} />
      </QueryClientProvider>,
    );

    expect(html).toContain("@container");
    expect(html).toContain("stablecoin-screener-mobile");
    expect(html).toContain("stablecoin-screener-table");
    expect(html).toContain('data-sticky-mode="page"');
    expect(html).not.toContain("stablecoin-screener-layout-pending");
  });

  it("renders the mobile card view with compact score facts and mobile sort controls", () => {
    const toggleSort = vi.fn();
    render(<ScreenerTable rows={[row]} dataState="ready" hasActiveFilters={false} sort={makeSort({ toggleSort })} />);

    const mobile = within(screen.getByTestId("stablecoin-screener-mobile"));
    expect(mobile.getByText("Sort results")).toBeTruthy();
    expect(mobile.getByText("USDT")).toBeTruthy();
    expect(mobile.getAllByText(/Peg/).length).toBeGreaterThan(0);
    expect(mobile.getAllByText(/DEWS/).length).toBeGreaterThan(0);
    expect(mobile.getAllByText(/Liq/).length).toBeGreaterThan(0);
    expect(mobile.getAllByText("Adequate").length).toBeGreaterThan(0);
    expect(mobile.getByText("Mint authority")).toBeTruthy();
    expect(mobile.getByRole("link", { name: /Open Safety Score waterfall for USDT/i })).toBeTruthy();

    fireEvent.click(mobile.getByRole("button", { name: "Supply" }));
    expect(toggleSort).toHaveBeenCalledWith("supply");
  });
});

describe("ScreenerTable desktop table and batch selection tray", () => {
  it.each([
    { cause: "C" as const, score: 35, reason: "undisclosed by issuer" },
    { cause: "U" as const, score: 50, reason: "unresolved" },
  ])("renders $cause priced unknowns with cause-specific text", ({ cause, score, reason }) => {
    const partial: ScreenerRow = {
      ...row,
      partialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["exit"], causes: [] },
      pillars: {
        backing: { score: 78 },
        exit: { score: null, aggregationDisposition: "unavailable", pricedUnknown: { cause, score } },
        control: { score: 42 },
      },
    };
    render(<ScreenerTable rows={[partial]} dataState="ready" hasActiveFilters={false} sort={makeSort()} />);
    const table = screen.getByTestId("stablecoin-screener-table");
    expect(table.textContent).toContain(`Exit ${reason} (assumed ${score})`);
    expect(table.textContent).not.toContain("pipeline gap");
  });

  it("leads the row with its state and names the DEWS band", () => {
    const critical = { kind: "critical", notice: { type: "danger", title: "Chain halted" } } as const;
    render(
      <ScreenerTable
        rows={[{ ...row, dewsScore: 44, dewsBand: "ALERT", states: [critical] }]}
        dataState="ready"
        hasActiveFilters={false}
        sort={makeSort()}
      />,
    );
    const table = screen.getByTestId("stablecoin-screener-table");
    expect(table.querySelector('[data-coin-state="critical"]')?.textContent).toContain("Critical notice");
    expect(within(table).getByText("Alert")).toBeTruthy();
  });

  it("strips V10 prefixes, labels Peg Score properly, and keeps NR badge nowrap", () => {
    render(<ScreenerTable rows={[row, secondRow]} dataState="ready" hasActiveFilters={false} sort={makeSort()} />);

    const table = within(screen.getByTestId("stablecoin-screener-table"));
    expect(table.getByText("Safety Profile")).toBeTruthy();
    expect(table.queryByText(/V10/)).toBeNull();
    expect(table.getByLabelText("Safety grade B+, score 82")).toBeTruthy();
    const nrBadge = table.getByLabelText("Safety grade NR");
    expect(nrBadge.className).toContain("whitespace-nowrap");

    const title = table.getByText("Peg Score").closest("th")?.getAttribute("title");
    expect(title).toBe(PEG_SCORE_HEADER_TITLE);
    expect(title).not.toMatch(/over 30 days/i);
  });

  it("renders Insufficient evidence instead of downgrading it to Limited", () => {
    render(
      <ScreenerTable
        rows={[{ ...row, safetyEvidence: "insufficient" }]}
        dataState="ready"
        hasActiveFilters={false}
        sort={makeSort()}
      />,
    );
    const table = within(screen.getByTestId("stablecoin-screener-table"));
    expect(table.getAllByText("Insufficient").length).toBeGreaterThan(0);
    expect(table.queryByText("Limited")).toBeNull();
  });

  it("renders xl sparkline SVGs inside xl:table-cell columns with accurate Peg range labels", () => {
    render(<ScreenerTable rows={[rowWithSeries]} dataState="ready" hasActiveFilters={false} sort={makeSort()} />);

    const table = within(screen.getByTestId("stablecoin-screener-table"));
    expect(table.getByRole("img", { name: /Peg range: worst \/ current for USDT/i })).toBeTruthy();
    expect(table.getByRole("img", { name: /30-day supply trajectory for USDT/i })).toBeTruthy();
    expect(table.queryByText("30d Peg")).toBeNull();
    expect(table.getByText("Peg range").closest("th")?.getAttribute("title")).toBe(
      "Peg range: worst / current deviation (±bps around the peg)",
    );
  });

  it("selects rows via checkboxes and exposes Compare, Model in Portfolio, and Copy link in the batch tray", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<ScreenerTable rows={[row, secondRow]} dataState="ready" hasActiveFilters={false} sort={makeSort()} />);

    expect(screen.queryByTestId("screener-batch-tray")).toBeNull();

    const table = within(screen.getByTestId("stablecoin-screener-table"));
    fireEvent.click(table.getByRole("checkbox", { name: "Select Tether (USDT)" }));
    fireEvent.click(table.getByRole("checkbox", { name: "Select USD Coin (USDC)" }));

    const tray = within(screen.getByTestId("screener-batch-tray"));
    expect(tray.getByText("2 selected")).toBeTruthy();

    const compareLink = tray.getByRole("link", { name: /Compare \(2\)/i });
    expect(compareLink.getAttribute("href")).toMatch(/^\/compare\/?\?coins=usdt-tether,usdc-circle$/);

    const portfolioLink = tray.getByRole("link", { name: /Model in Portfolio/i });
    expect(portfolioLink.getAttribute("href")).toMatch(/^\/portfolio\/?\?coins=usdt-tether,usdc-circle$/);

    fireEvent.click(tray.getByRole("button", { name: /Copy link/i }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/screener/?coins=usdt-tether,usdc-circle"));

    fireEvent.click(tray.getByRole("button", { name: "Clear batch selection" }));
    expect(screen.queryByTestId("screener-batch-tray")).toBeNull();
  });
});

describe("ScreenerTable pagination", () => {
  const rows = Array.from({ length: 55 }, (_, index) => ({
    ...row,
    id: `coin-${index}`,
    name: `Coin ${index}`,
    symbol: `COIN${index}`,
  }));

  it("bounds each view to 50 rows per page and discloses the full matched count", () => {
    const { rerender } = render(
      <ScreenerTable rows={rows} dataState="ready" hasActiveFilters={false} sort={makeSort()} />,
    );

    const desktop = within(screen.getByTestId("stablecoin-screener-table"));
    const mobile = within(screen.getByTestId("stablecoin-screener-mobile"));

    expect(desktop.getByText("Coin 0")).toBeTruthy();
    expect(desktop.getByText("Coin 49")).toBeTruthy();
    expect(desktop.queryByText("Coin 50")).toBeNull();
    expect(desktop.getAllByRole("row")).toHaveLength(51);
    expect(desktop.getByText(/Showing/).textContent).toBe("Showing 1–50 of 55 stablecoins");
    expect(mobile.getByText(/Showing/).textContent).toBe("Showing 1–50 of 55 stablecoins");

    fireEvent.click(desktop.getByRole("button", { name: "Go to next page" }));
    expect(desktop.getByText("Coin 50")).toBeTruthy();
    expect(desktop.getByText("Coin 54")).toBeTruthy();
    expect(desktop.queryByText("Coin 0")).toBeNull();
    expect(desktop.getByText(/Showing/).textContent).toBe("Showing 51–55 of 55 stablecoins");
    expect(desktop.getByRole("button", { name: "Go to next page" }).hasAttribute("disabled")).toBe(true);

    rerender(<ScreenerTable rows={rows.slice(0, 2)} dataState="ready" hasActiveFilters sort={makeSort()} />);
    expect(desktop.getByText("Coin 0")).toBeTruthy();
    expect(desktop.getByText(/Showing/).textContent).toBe("Showing 1–2 of 2 stablecoins");
  });

  it("separates loading, settled failure and valid empty counts across both responsive views", () => {
    const view = render(
      <ScreenerTable rows={[]} dataState="loading" hasActiveFilters={false} sort={makeSort()} />,
    );
    const desktop = within(screen.getByTestId("stablecoin-screener-table"));
    expect(desktop.getByText("Loading results…")).toBeTruthy();
    expect(desktop.queryByText(/Showing/)).toBeNull();

    view.rerender(<ScreenerTable rows={[]} dataState="unavailable" hasActiveFilters={false} sort={makeSort()} />);
    expect(desktop.getByText("Result counts unavailable.")).toBeTruthy();
    expect(desktop.getByText(/Screener inputs unavailable/)).toBeTruthy();
    expect(desktop.queryByText(/Loading/)).toBeNull();

    view.rerender(<ScreenerTable rows={[]} dataState="ready" hasActiveFilters sort={makeSort()} />);
    expect(desktop.getByText(/Showing/).textContent).toBe("Showing 0–0 of 0 stablecoins");
    expect(desktop.getByText("No stablecoins match these filters.")).toBeTruthy();
  });

  it("leaves Enter activation to pager and sorting buttons instead of opening the cursor coin", () => {
    const toggleSort = vi.fn();
    render(<ScreenerTable rows={rows} dataState="ready" hasActiveFilters={false} sort={makeSort({ toggleSort })} />);
    const desktop = within(screen.getByTestId("stablecoin-screener-table"));
    expect(desktop.getByText("Coin 0")).toBeTruthy();
    const opened = vi.fn((event: Event) => event.preventDefault());
    document.querySelectorAll("[data-screener-open]").forEach((link) => link.addEventListener("click", opened));

    const next = desktop.getByRole("button", { name: "Go to next page" });
    next.focus();
    expect(fireEvent.keyDown(next, { key: "Enter" })).toBe(true);
    expect(opened).not.toHaveBeenCalled();
    fireEvent.click(next);
    expect(desktop.getByText("Coin 50")).toBeTruthy();

    const previous = desktop.getByRole("button", { name: "Go to previous page" });
    previous.focus();
    expect(fireEvent.keyDown(previous, { key: "Enter" })).toBe(true);
    fireEvent.click(previous);
    expect(desktop.getByText("Coin 0")).toBeTruthy();

    const supply = desktop.getByRole("button", { name: "Sort by Supply" });
    supply.focus();
    expect(fireEvent.keyDown(supply, { key: "Enter" })).toBe(true);
    fireEvent.click(supply);
    expect(toggleSort).toHaveBeenCalledWith("supply");
    expect(opened).not.toHaveBeenCalled();
  });
});
