// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketDataSection } from "@/components/stablecoin-detail/market-data-section";
import { useSupplyHistory } from "@/hooks/use-stablecoins";
import {
  FRONTEND_API_QUERY_DESCRIPTORS,
  STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS,
} from "@/lib/api-query-descriptors";

vi.mock("@/components/lazy-section", () => ({
  LazySection: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/mcap-chart", () => ({
  McapChart: ({ data }: { data: Array<{ date: number }> }) => (
    <output data-testid="market-cap-domain">
      {data.length > 0 ? `${data[0].date}-${data[data.length - 1].date}` : "empty"}
    </output>
  ),
}));

vi.mock("@/components/peg-deviation-chart", () => ({
  PegDeviationChart: () => <div />,
}));

vi.mock("@/components/chart-primitives/annotations", () => ({
  ChartAnnotationLegend: () => null,
}));

vi.mock("@/hooks/use-chart-annotations", () => ({
  useChartAnnotations: () => ({ data: [] }),
}));

// jsdom lacks ResizeObserver; the real ChartBrush wires one up on mount.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const DAY = 86_400;
const SEED_HISTORY = Array.from({ length: 90 }, (_, index) => ({
  date: 1_700_000_000 + index * DAY,
  circulatingUsd: 100 + index,
  price: 1,
}));
const SEED_DOMAIN = `${SEED_HISTORY[0].date}-${SEED_HISTORY[SEED_HISTORY.length - 1].date}`;
// Expanded history: one earlier point plus the identical recent window, so a
// fallback to the seed is always a distinct, observable domain.
const FULL_HISTORY = [{ date: 1_500_000_000, circulatingUsd: 10, price: 1 }, ...SEED_HISTORY];
const FULL_DOMAIN = `${FULL_HISTORY[0].date}-${FULL_HISTORY[FULL_HISTORY.length - 1].date}`;

const fullHistoryResponse = () => new Response(JSON.stringify(FULL_HISTORY));

function makeSeededQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    FRONTEND_API_QUERY_DESCRIPTORS
      .supplyHistory("usdt-tether", STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS)
      .queryKey,
    SEED_HISTORY,
    { updatedAt: Date.now() },
  );
  return queryClient;
}

function SeededMarketDataSection() {
  const history = useSupplyHistory("usdt-tether", STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS);
  return (
    <MarketDataSection
      stablecoinId="usdt-tether"
      supplyHistory={history.data}
      pegCurrency="USD"
      updatedAtMs={history.dataUpdatedAt}
    />
  );
}

function renderSeededSection() {
  return render(
    <QueryClientProvider client={makeSeededQueryClient()}>
      <SeededMarketDataSection />
    </QueryClientProvider>,
  );
}

const marketCapDomain = () => screen.getByTestId("market-cap-domain").textContent;

describe("MarketDataSection history expansion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetches the distinct full-history query when All is selected after a fresh 90-day seed", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => fullHistoryResponse());
    vi.stubGlobal("fetch", fetchMock);
    renderSeededSection();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(marketCapDomain()).toBe(SEED_DOMAIN);

    fireEvent.click(screen.getByRole("button", { name: "All" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("days=1825");
    await waitFor(() => expect(marketCapDomain()).toBe(FULL_DOMAIN));
    // The real brush strip re-domains onto the expanded history.
    const slider = screen.getByRole("slider", { name: "Brush time window" });
    expect(slider.getAttribute("aria-valuemin")).toBe(String(FULL_HISTORY[0].date * 1000));
    expect(slider.getAttribute("aria-valuemax")).toBe(
      String(FULL_HISTORY[FULL_HISTORY.length - 1].date * 1000),
    );
  });

  it("keeps the seeded 90-day chart visible while the full-history request is in flight", async () => {
    let resolveFull: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      (_input: string | URL | Request) =>
        new Promise<Response>((resolve) => {
          resolveFull = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderSeededSection();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // No blank chart while the expanded query runs: the seed stays on screen.
    expect(marketCapDomain()).toBe(SEED_DOMAIN);

    resolveFull(fullHistoryResponse());
    await waitFor(() => expect(marketCapDomain()).toBe(FULL_DOMAIN));
  });

  it("falls back to the seeded 90-day chart when the expanded query fails or comes back empty", async () => {
    const failing = vi.fn(async (_input: string | URL | Request) => {
      throw new Error("history upstream down");
    });
    vi.stubGlobal("fetch", failing);
    const { unmount } = renderSeededSection();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    expect(marketCapDomain()).toBe(SEED_DOMAIN);
    unmount();

    const empty = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify([])));
    vi.stubGlobal("fetch", empty);
    renderSeededSection();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(empty).toHaveBeenCalledTimes(1));
    expect(marketCapDomain()).toBe(SEED_DOMAIN);
  });

  it("expands through 1y on the same full-history query and restores the 90-day seed on return", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => fullHistoryResponse());
    vi.stubGlobal("fetch", fetchMock);
    renderSeededSection();

    fireEvent.click(screen.getByRole("button", { name: "1Y" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("days=1825");
    await waitFor(() => expect(marketCapDomain()).toBe(FULL_DOMAIN));

    // Back to a seeded range: the seed domain returns and the expanded query
    // disables again.
    fireEvent.click(screen.getByRole("button", { name: "90D" }));
    expect(marketCapDomain()).toBe(SEED_DOMAIN);
  });

  it("clears a brush selection when the time range changes", () => {
    renderSeededSection();
    const slider = screen.getByRole("slider", { name: "Brush time window" });
    expect(slider.getAttribute("aria-valuemax")).toBe(
      String(SEED_HISTORY[SEED_HISTORY.length - 1].date * 1000),
    );

    // Keyboard seeds a selection through the real sync provider.
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider.getAttribute("aria-valuenow")).not.toBe(slider.getAttribute("aria-valuemin"));
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();

    // The explicit clear control returns the slider to the full domain.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(slider.getAttribute("aria-valuenow")).toBe(slider.getAttribute("aria-valuemin"));
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();

    // A selection made on 90d cannot survive a domain change.
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "30D" }));
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(slider.getAttribute("aria-valuenow")).toBe(slider.getAttribute("aria-valuemin"));
  });
});
