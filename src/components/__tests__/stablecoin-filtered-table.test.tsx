// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StablecoinFilteredTable } from "../stablecoin-directory/stablecoin-filtered-table";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";

const mocks = vi.hoisted(() => ({ stablecoins: vi.fn(), peg: vi.fn(), liquidity: vi.fn(), ratings: vi.fn() }));
vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: mocks.stablecoins }));
vi.mock("@/hooks/api-hooks", () => ({ usePegSummary: mocks.peg, useDexLiquidityTable: mocks.liquidity, useReportCardsV9Table: mocks.ratings }));
vi.mock("@/lib/logos", () => ({ logosById: {} }));
vi.mock("@/hooks/use-coin-states", () => ({ useCoinStates: () => ({ byId: new Map(), liveReady: false }) }));
vi.mock("@/lib/stablecoin-table-inputs", () => ({
  buildStablecoinTableInputs: ({ pegSummaryCoins, reportCardsV9 }: { pegSummaryCoins: unknown; reportCardsV9?: { cards: unknown } }) => ({
    pegRateSources: {}, pegScores: pegSummaryCoins, reportCards: reportCardsV9?.cards,
  }),
}));
vi.mock("@/components/stablecoin-directory/stablecoin-table", () => ({
  StablecoinTable: (props: Record<string, unknown>) => <div data-testid="saved-table">{JSON.stringify(props)}</div>,
}));
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});
// Vitest hoists this factory; a static helper import is not initialized yet.

function query(data: unknown) {
  return { data, dataUpdatedAt: Date.now(), isLoading: false, error: null as unknown,
    meta: { updatedAt: Date.now() / 1000, status: "fresh", ageSeconds: 0 }, refetch: vi.fn() };
}

beforeEach(() => {
  mocks.stablecoins.mockReturnValue(query({ peggedAssets: [{ id: "usdc-circle", circulating: { peggedUSD: 100 } }] }));
  mocks.peg.mockReturnValue(query({ coins: [{ id: "usdc-circle", currentDeviationBps: -15 }] }));
  mocks.liquidity.mockReturnValue(query({ "usdc-circle": { liquidityScore: 72 } }));
  mocks.ratings.mockReturnValue(query({ cards: [{ id: "usdc-circle", grade: "B+" }] }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each([
  ["peg", "pegSummary"], ["liquidity", "dexLiquidity"], ["ratings", "reportCards"],
] as const)("exposes only stale %s health while retaining saved table values", (key, preset) => {
  const saved = mocks[key]();
  const label = DATA_HEALTH_PRESETS[preset].label;
  mocks[key].mockReturnValue({ ...saved, meta: { ...saved.meta, status: "stale" } });
  const view = render(<StablecoinFilteredTable activeFilters={[]} />);
  expect(screen.getByRole("status").textContent).toContain(label);
  expect(screen.getByRole("status").textContent).not.toContain("Prices");
  expect(screen.getByTestId("saved-table").textContent).toContain('"liquidityScore":72');
  expect(screen.getByTestId("saved-table").textContent).toContain('"currentDeviationBps":-15');
  expect(screen.getByTestId("saved-table").textContent).toContain('"grade":"B+"');

  // Degraded and failed-over-saved-data reads are operator signal (ADR-42).
  mocks[key].mockReturnValue({ ...saved, meta: { ...saved.meta, status: "degraded" } });
  view.rerender(<StablecoinFilteredTable activeFilters={[]} />);
  expect(screen.queryByRole("status")).toBeNull();
  mocks[key].mockReturnValue({ ...saved, error: new Error("HTTP 502") });
  view.rerender(<StablecoinFilteredTable activeFilters={[]} />);
  expect(screen.queryByRole("status")).toBeNull();

  mocks[key].mockReturnValue({ ...saved, error: new Error("HTTP 502"), meta: { ...saved.meta, status: "stale" } });
  view.rerender(<StablecoinFilteredTable activeFilters={[]} />);
  expect(screen.getByRole("status").textContent).toContain(label);
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(saved.refetch).toHaveBeenCalledOnce();
  expect(mocks.stablecoins().refetch).not.toHaveBeenCalled();
  expect(screen.getByTestId("saved-table").textContent).toContain('"grade":"B+"');
});

it("opens cohort hubs in grade order, matching their Ranked by Risk title", () => {
  render(<StablecoinFilteredTable activeFilters={["rwa-backed"]} />);
  expect(screen.getByTestId("saved-table").textContent).toContain('"initialSort":{"key":"grade","direction":"desc"}');
});

it("marks a failed stablecoins read as unavailable for the shared table", () => {
  mocks.stablecoins.mockReturnValue({ ...query(undefined), error: new Error("HTTP 503") });
  render(<StablecoinFilteredTable activeFilters={["rwa-backed"]} />);
  expect(screen.getByTestId("saved-table").textContent).toContain('"unavailable":true');
});

it("shows neither held publication nor a failed refresh over saved ratings", () => {
  const saved = mocks.ratings();
  mocks.ratings.mockReturnValue({ ...saved, error: new Error("HTTP 502"), data: {
    ...saved.data, publicationHealth: { status: "held", heldSinceSec: null, reasons: [] },
  } });
  render(<StablecoinFilteredTable activeFilters={[]} />);
  expect(screen.queryByText(/Ratings are held at the last verified snapshot/)).toBeNull();
  expect(screen.queryByText("Refresh failed; showing saved data")).toBeNull();
  expect(screen.getByTestId("saved-table").textContent).toContain('"grade":"B+"');
});

it("renders the cohort summary KPI strip with null-safe unavailable handling and wires inline coin search", () => {
  mocks.stablecoins.mockReturnValue(query({
    peggedAssets: [
      { id: "usdc-circle", name: "USD Coin", symbol: "USDC", circulating: { peggedUSD: 600 } },
      { id: "usdt-tether", name: "Tether", symbol: "USDT", circulating: { peggedUSD: 400 } },
      { id: "dai-makerdao", name: "Dai", symbol: "DAI", circulating: {} },
    ],
  }));
  mocks.ratings.mockReturnValue(query({
    cards: {
      "usdc-circle": { grade: "A-", score: 84 },
      "usdt-tether": { grade: "B", score: 70 },
    },
  }));

  render(<StablecoinFilteredTable activeFilters={[]} />);

  const summary = screen.getByRole("region", { name: "Cohort summary" });
  expect(summary.textContent).toContain("$1.00K");
  expect(summary.textContent).toContain("2 of 3 observed");
  expect(summary.textContent).toContain("of known active cap");
  expect(summary.textContent).toContain("B+");
  expect(summary.textContent).toContain("2 of 3 rated");
  expect(summary.textContent).toContain("USDC, USDT");

  const searchInput = screen.getByLabelText("Filter coins in this cohort by name or symbol");
  fireEvent.change(searchInput, { target: { value: "usdc" } });
  expect(screen.getByTestId("saved-table").textContent).toContain('"searchQuery":"usdc"');
  // Cohort summary stats stay anchored to the full unfiltered cohort (R7 / ADR-34).
  expect(summary.textContent).toContain("$1.00K");

  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByTestId("saved-table").textContent).toContain('"searchQuery":""');
});

it("preserves unavailable cohort KPIs as dashes when no supply is observed", () => {
  mocks.stablecoins.mockReturnValue(query({
    peggedAssets: [{ id: "usdc-circle", name: "USD Coin", symbol: "USDC", circulating: {} }],
  }));
  mocks.ratings.mockReturnValue(query(undefined));

  render(<StablecoinFilteredTable activeFilters={[]} />);

  const summary = screen.getByRole("region", { name: "Cohort summary" });
  expect(summary.textContent).toContain("Supply unavailable");
  expect(summary.textContent).toContain("Share unavailable");
  expect(summary.textContent).toContain("Grades unavailable");
  expect(summary.textContent).toContain("Concentration unavailable");
  expect(summary.textContent).not.toContain("$0");
});
