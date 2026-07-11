// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StablecoinTable } from "@/components/stablecoin-table";
import { ALL_COLUMNS } from "@/lib/column-visibility";
import { cleanupFrontendTest, installMatchMediaMock, resetBrowserStorage } from "@/test-utils/frontend";
import type { ReportCard, StablecoinData } from "@shared/types";

const push = vi.fn();
const { scrollToIndexMock, virtualItemsMock, virtualTotalSizeMock } = vi.hoisted(() => ({
  scrollToIndexMock: vi.fn(),
  virtualItemsMock: [{ index: 0, start: 0, end: 40 }],
  virtualTotalSizeMock: { current: 40 },
}));

function setMobileMedia(matches: boolean) {
  installMatchMediaMock(matches);
}

afterEach(() => {
  cleanupFrontendTest();
});

vi.mock("@/components/table-toolbar", () => ({
  TableToolbar: () => <div data-testid="table-toolbar" />,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => virtualItemsMock,
    getTotalSize: () => virtualTotalSizeMock.current,
    scrollToIndex: scrollToIndexMock,
  }),
}));

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));

const coin = {
  id: "usdt-tether",
  name: "Tether",
  symbol: "USDT",
  pegType: "peggedUSD",
  price: 1,
  circulating: { peggedUSD: 100_000_000 },
  circulatingPrevDay: { peggedUSD: 99_000_000 },
  circulatingPrevWeek: { peggedUSD: 98_000_000 },
  circulatingPrevMonth: { peggedUSD: 97_000_000 },
  chainCirculating: {},
  chains: ["Ethereum"],
} as unknown as StablecoinData;

const usdc = {
  ...coin,
  id: "usdc-circle",
  name: "USD Coin",
  symbol: "USDC",
  circulating: { peggedUSD: 50_000_000 },
} as unknown as StablecoinData;

const susds = {
  ...coin,
  id: "susds-sky",
  name: "Sky Savings USDS",
  symbol: "sUSDS",
  circulating: { peggedUSD: 75_000_000 },
} as unknown as StablecoinData;

const dai = {
  ...coin,
  id: "dai-makerdao",
  name: "Dai",
  symbol: "DAI",
  circulating: { peggedUSD: 90_000_000 },
} as unknown as StablecoinData;

const reportCard: ReportCard = {
  id: "usdt-tether",
  name: "Tether",
  symbol: "USDT",
  overallGrade: "B+",
  overallScore: 80,
  baseScore: 80,
  dimensions: {
    pegStability: { grade: "A", score: 95, detail: "ok" },
    liquidity: { grade: "B+", score: 82, detail: "ok" },
    resilience: { grade: "B", score: 72, detail: "ok" },
    decentralization: { grade: "C", score: 55, detail: "ok" },
    dependencyRisk: { grade: "B", score: 74, detail: "ok" },
  },
  ratedDimensions: 5,
  rawInputs: {
    pegScore: 95,
    activeDepeg: false,
    activeDepegBps: null,
    depegEventCount: 0,
    lastEventAt: null,
    liquidityScore: 89,
    effectiveExitScore: 89,
    redemptionBackstopScore: null,
    redemptionRouteFamily: null,
    redemptionModelConfidence: null,
    redemptionUsedForLiquidity: false,
    redemptionImmediateCapacityUsd: null,
    redemptionImmediateCapacityRatio: null,
    concentrationHhi: 0.1,
    bluechipGrade: null,
    canBeBlacklisted: true,
    chainTier: "ethereum",
    deploymentModel: "native-multichain",
    collateralQuality: "rwa",
    custodyModel: "institutional-regulated",
    governanceTier: "centralized",
    governanceQuality: "single-entity",
    dependencies: [],
    navToken: false,
    collateralFromLive: false,
    dependencyFromLive: false,
  },
  isDefunct: false,
};

describe("StablecoinTable", () => {
  beforeEach(() => {
    resetBrowserStorage();
    push.mockReset();
    scrollToIndexMock.mockReset();
    setMobileMedia(false);
    virtualItemsMock.splice(0, virtualItemsMock.length, { index: 0, start: 0, end: 40 });
    virtualTotalSizeMock.current = 40;
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  it("normalizes persisted column visibility from localStorage", async () => {
    localStorage.setItem("pharos-table-columns", JSON.stringify(["mcap", "bogus"]));

    render(<StablecoinTable data={[coin]} isLoading={false} activeFilters={[]} pegRates={{}} />);

    await waitFor(() => {
      expect(screen.getByText("Market Cap")).toBeTruthy();
      expect(screen.queryByText("Price")).toBeNull();
    });
  });

  it("keeps desktop column preferences from overriding mobile defaults", async () => {
    setMobileMedia(true);
    localStorage.setItem(
      "pharos-table-columns",
      JSON.stringify([
        "rank",
        "name",
        "price",
        "peg",
        "mcap",
        "change24h",
        "change7d",
        "grade",
        "stability",
        "liquidity",
        "blacklistable",
        "backing",
        "type",
      ]),
    );

    render(
      <StablecoinTable
        data={[coin]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
        reportCards={{ [coin.id]: reportCard }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Market Cap")).toBeTruthy();
      expect(screen.queryByText("Blacklist")).toBeNull();
      expect(screen.queryByText("Peg Score")).toBeNull();
      expect(screen.getByTitle(/Mint Authority Score/i).textContent).toContain("Mint");
    });
  });

  it("honors mobile-specific column preferences on mobile", async () => {
    setMobileMedia(true);
    localStorage.setItem("pharos-table-columns-mobile", JSON.stringify(["rank", "name", "blacklistable"]));

    render(
      <StablecoinTable
        data={[coin]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
        reportCards={{ [coin.id]: reportCard }}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText("Blacklist").length).toBeGreaterThan(0);
      expect(screen.queryByText("Market Cap")).toBeNull();
    });
  });

  it("keeps horizontal scrolling enabled on the table viewport", () => {
    render(<StablecoinTable data={[coin]} isLoading={false} activeFilters={[]} pegRates={{}} />);

    const table = screen.getAllByRole("table")[0];
    const shell = screen.getByTestId("stablecoin-overview-table");
    const scrollContainer = table?.parentElement;

    expect(shell.getAttribute("data-table-id")).toBe("stablecoin-overview");
    expect(shell.className).toContain("pharos-table-shell");
    expect(shell.className).toContain("pharos-density-spacious");
    expect(shell.className).toContain("pharos-table-striped-indexed");
    expect(scrollContainer?.getAttribute("data-slot")).toBe("table-viewport");
    expect(scrollContainer?.className).toContain("scroll-shadow");
    expect(scrollContainer?.className).toContain("overflow-x-auto");
    expect(scrollContainer?.className).toContain("overflow-y-auto");
    expect(scrollContainer?.className).not.toContain("overflow-x-hidden");
    expect(scrollContainer?.className).not.toContain("xl:overflow-x-hidden");
    expect(shell.querySelector("[data-slot='table-container']")).toBeNull();
  });

  it("sizes the table to the visible columns so fixed-layout cells never squeeze below content width", () => {
    render(<StablecoinTable data={[coin]} isLoading={false} activeFilters={[]} pegRates={{}} />);

    const table = screen.getAllByRole("table")[0] as HTMLTableElement;
    const scrollContainer = table?.parentElement;

    expect(scrollContainer?.className).toContain("overflow-x-auto");
    expect(scrollContainer?.className).not.toContain("overflow-x-hidden");
    // Inline min-width is the sum of per-column minimums for the visible set;
    // 420 is the floor, so any real column set resolves above it.
    const minWidth = Number.parseInt(table.style.minWidth, 10);
    expect(minWidth).toBeGreaterThanOrEqual(420);
  });

  it("honors all-column route defaults", () => {
    render(
      <StablecoinTable
        data={[coin]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
        initialVisibleColumns={ALL_COLUMNS.map((column) => column.id)}
      />,
    );

    expect(screen.getByText("Flags")).toBeTruthy();
  });

  it("can hide header methodology helper buttons", () => {
    render(
      <StablecoinTable
        data={[coin]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
        showHeaderMethodologyHints={false}
      />,
    );

    expect(screen.getByText("Grade")).toBeTruthy();
    expect(screen.getByText("Peg Score")).toBeTruthy();
    expect(screen.getAllByText("Liq").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Explain Safety Score" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Explain Peg Score" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Explain Liquidity Score" })).toBeNull();
  });

  it("renders the blacklistable column when enabled", () => {
    localStorage.setItem("pharos-table-columns", JSON.stringify(["mcap", "blacklistable"]));

    render(
      <StablecoinTable
        data={[coin]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
        reportCards={{ [coin.id]: reportCard }}
      />,
    );

    expect(screen.getAllByText("Blacklist").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Yes").length).toBeGreaterThan(0);
  });

  it("renders upstream FreezeWatch status without source-link affordance", () => {
    localStorage.setItem("pharos-table-columns", JSON.stringify(["name", "blacklistable"]));

    render(<StablecoinTable data={[dai]} isLoading={false} activeFilters={[]} pegRates={{}} />);

    expect(screen.getByText("Upstream")).toBeTruthy();
    expect(screen.queryByLabelText(/source/i)).toBeNull();
  });

  it("renders a star control when pinning is enabled", () => {
    const onTogglePinned = vi.fn();

    render(
      <StablecoinTable
        data={[coin]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
        onTogglePinnedStablecoin={onTogglePinned}
      />,
    );

    const starButton = screen.getByRole("button", { name: "Star USDT" });
    fireEvent.click(starButton);

    expect(onTogglePinned).toHaveBeenCalledWith("usdt-tether");
    expect(push).not.toHaveBeenCalled();
  });

  it("marks starred row controls as pressed", () => {
    render(
      <StablecoinTable
        data={[coin]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
        pinnedStablecoinIds={["usdt-tether"]}
        onTogglePinnedStablecoin={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Unstar USDT" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows starred stablecoins before the rest of the sorted table", () => {
    render(
      <StablecoinTable
        data={[coin, usdc]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
        pinnedStablecoinIds={["usdc-circle"]}
        onTogglePinnedStablecoin={vi.fn()}
      />,
    );

    expect(screen.getByText("USDC")).toBeTruthy();
    expect(screen.queryByText("USDT")).toBeNull();
  });

  it("keeps rank values tied to pre-pin sort order", () => {
    localStorage.setItem("pharos-table-columns", JSON.stringify(["rank", "name"]));
    virtualItemsMock.splice(
      0,
      virtualItemsMock.length,
      { index: 0, start: 0, end: 40 },
      { index: 1, start: 40, end: 80 },
    );
    virtualTotalSizeMock.current = 80;

    render(
      <StablecoinTable
        data={[coin, usdc]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
        pinnedStablecoinIds={["usdc-circle"]}
        onTogglePinnedStablecoin={vi.fn()}
      />,
    );

    const usdcRow = screen.getByText("USDC").closest("tr");
    const usdtRow = screen.getByText("USDT").closest("tr");

    expect(usdcRow?.querySelectorAll("td")[1]?.textContent).toBe("2");
    expect(usdtRow?.querySelectorAll("td")[1]?.textContent).toBe("1");
  });

  it("adds full variant context to the accessible detail link", () => {
    render(<StablecoinTable data={[susds]} isLoading={false} activeFilters={[]} pegRates={{}} />);

    expect(screen.getByLabelText("Savings variant")).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: /View Sky Savings USDS \(sUSDS\) details, Savings variant/i }),
    ).toHaveLength(1);
    expect(screen.getByText("Savings")).toBeTruthy();
  });

  it("does not reset vertical scroll on rerender when pinning is disabled", () => {
    const rows = [coin, usdc];
    const activeFilters: never[] = [];
    const pegRates = {};

    const { rerender } = render(
      <StablecoinTable data={rows} isLoading={false} activeFilters={activeFilters} pegRates={pegRates} />,
    );

    const scrollToMock = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollToMock.mockClear();

    rerender(<StablecoinTable data={rows} isLoading={false} activeFilters={activeFilters} pegRates={pegRates} />);

    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("derives stripe state from the stable row index instead of rendered tbody position", () => {
    virtualItemsMock.splice(0, virtualItemsMock.length, { index: 1, start: 40, end: 80 });
    virtualTotalSizeMock.current = 80;

    render(<StablecoinTable data={[coin, usdc]} isLoading={false} activeFilters={[]} pegRates={{}} />);

    const bodyRows = document.querySelectorAll("tbody tr");
    const spacerCell = bodyRows[0]?.querySelector("td");
    const usdcRow = screen.getByText("USDC").closest("tr");

    expect(bodyRows).toHaveLength(2);
    expect(bodyRows[0]?.getAttribute("data-row-striped")).toBeNull();
    expect(spacerCell?.getAttribute("colspan")).toBe(String(screen.getAllByRole("columnheader").length));
    expect(spacerCell?.style.height).toBe("40px");
    expect(spacerCell?.style.padding).toBe("0px");
    expect(usdcRow?.getAttribute("data-row-striped")).toBe("true");
  });

  it("keeps the virtual cursor idle until row intent", async () => {
    render(<StablecoinTable data={[coin]} isLoading={false} activeFilters={[]} pegRates={{}} />);

    const row = screen.getByText("USDT").closest("tr");

    expect(row?.getAttribute("data-cursor")).toBeNull();
    expect(scrollToIndexMock).not.toHaveBeenCalled();

    fireEvent.mouseEnter(row as HTMLTableRowElement);

    await waitFor(() => {
      expect(row?.getAttribute("data-cursor")).toBe("true");
    });
    expect(scrollToIndexMock).not.toHaveBeenCalled();
  });

  it("scrolls the virtual cursor only when keyboard intent targets an offscreen row", async () => {
    render(<StablecoinTable data={[coin, usdc]} isLoading={false} activeFilters={[]} pegRates={{}} />);

    const firstLink = screen.getByRole("link", { name: /View Tether \(USDT\) details/i });
    firstLink.focus();
    fireEvent.keyDown(window, { key: "j" });

    await waitFor(() => {
      expect(scrollToIndexMock).toHaveBeenCalledWith(1);
    });
  });
});
