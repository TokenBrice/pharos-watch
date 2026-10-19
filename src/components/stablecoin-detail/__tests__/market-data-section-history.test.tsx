// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const ANNUAL_HISTORY = [{ date: SEED_HISTORY[SEED_HISTORY.length - 1].date - 300 * DAY, circulatingUsd: 50, price: null }, ...SEED_HISTORY];
const ANNUAL_DOMAIN = `${ANNUAL_HISTORY[0].date}-${ANNUAL_HISTORY[ANNUAL_HISTORY.length - 1].date}`;

const fullHistoryResponse = () => new Response(JSON.stringify(FULL_HISTORY));

function makeSeededQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    FRONTEND_API_QUERY_DESCRIPTORS
      .supplyHistory("usdt-tether", STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS)
      .queryKey,
    { data: SEED_HISTORY, meta: { updatedAt: Date.now() / 1000, ageSeconds: 0, status: "fresh" } },
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

function renderSeededSection(queryClient = makeSeededQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
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
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("range=all");
    await waitFor(() => expect(marketCapDomain()).toBe(FULL_DOMAIN));
    // The real brush strip re-domains onto the expanded history.
    const slider = screen.getByRole("slider", { name: "Brush time window" });
    expect(slider.getAttribute("aria-valuemin")).toBe(String(FULL_HISTORY[0].date * 1000));
    expect(slider.getAttribute("aria-valuemax")).toBe(
      String(FULL_HISTORY[FULL_HISTORY.length - 1].date * 1000),
    );
  });

  it("keeps the expanded-history freshness chip on its old producer clock after a successful read", async () => {
    const updatedAtSec = Math.floor(Date.now() / 1000) - 3 * DAY;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(FULL_HISTORY, {
      headers: { "X-Data-Updated-At": String(updatedAtSec), "X-Data-Age": String(3 * DAY) },
    })));
    const { container } = renderSeededSection();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(marketCapDomain()).toBe(FULL_DOMAIN));
    await waitFor(() => expect(container.querySelector("time")?.getAttribute("datetime")).toBe(new Date(updatedAtSec * 1000).toISOString()));
    expect(container.querySelector("time")?.getAttribute("data-state")).toBe("stale");
  });

  it.each(["All", "1Y"])("keeps the seed visibly bounded while %s loads", async (range) => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    renderSeededSection();
    fireEvent.click(screen.getByRole("button", { name: range }));
    expect(screen.getByRole("status", { name: "Market history coverage" }).textContent).toContain(`Loading ${range} history`);
    expect(screen.getByRole("status", { name: "Market history coverage" }).textContent).toContain("Only the available 90-day window is shown");
    expect(marketCapDomain()).toBe(SEED_DOMAIN);
    expect(screen.getByRole("button", { name: range }).getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["All", "1Y"])("discloses failed %s coverage, preserves the source clock and retries only the expanded key", async (range) => {
    let failing = true;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      if (failing) throw new Error("history upstream down");
      return Response.json(range === "All" ? FULL_HISTORY : ANNUAL_HISTORY);
    }));
    const { container } = renderSeededSection();
    const seedClock = container.querySelector("time")?.getAttribute("datetime");
    fireEvent.click(screen.getByRole("button", { name: range }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Market history coverage" }).textContent).toContain(`${range} history could not be loaded`), { timeout: 4500 });
    expect(screen.getByRole("status", { name: "Market history coverage" }).textContent).toContain("Only the available 90-day window is shown");
    expect(marketCapDomain()).toBe(SEED_DOMAIN);
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(seedClock);
    expect(screen.getByRole("button", { name: range }).getAttribute("aria-pressed")).toBe("true");
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: `Retry ${range} history` }));
    await waitFor(() => expect(marketCapDomain()).toBe(range === "All" ? FULL_DOMAIN : ANNUAL_DOMAIN));
    expect(requests.every((url) => range === "All" ? url.includes("range=all") && !url.includes("days=") : url.includes("days=365") && !url.includes("range="))).toBe(true);
    expect(screen.queryByRole("button", { name: `Retry ${range} history` })).toBeNull();
  });

  it.each(["All", "1Y"])("distinguishes a successful empty %s expansion from a transport failure", async (range) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    renderSeededSection();
    fireEvent.click(screen.getByRole("button", { name: range }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Market history coverage" }).textContent).toContain(`No observations returned for ${range} history`));
    expect(screen.getByRole("status", { name: "Market history coverage" }).textContent).toContain("Only the available 90-day window is shown");
    expect(marketCapDomain()).toBe(SEED_DOMAIN);
    expect(screen.queryByRole("button", { name: `Retry ${range} history` })).toBeNull();
  });

  it("retains expanded observations and their clock when the expanded refresh fails", async () => {
    const client = makeSeededQueryClient();
    const key = FRONTEND_API_QUERY_DESCRIPTORS.supplyHistory("usdt-tether", "all").queryKey;
    const updatedAt = Math.floor(Date.now() / 1000) - 3 * DAY;
    client.setQueryData(key, { data: FULL_HISTORY, meta: { updatedAt, ageSeconds: 3 * DAY, status: "stale" } });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("refresh failed"); }));
    const { container } = renderSeededSection(client);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByRole("status", { name: "Market history coverage" }).textContent).toContain("All history is stale");
    act(() => { void client.refetchQueries({ queryKey: key, exact: true }); });
    await waitFor(() => expect(screen.getByRole("status", { name: "Market history coverage" }).textContent).toContain("All history refresh failed"), { timeout: 4500 });
    expect(screen.getByRole("status", { name: "Market history coverage" }).textContent).toContain("Showing retained observations from");
    expect(screen.getByRole("status", { name: "Market history coverage" }).textContent).not.toContain("90-day");
    expect(marketCapDomain()).toBe(FULL_DOMAIN);
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(new Date(updatedAt * 1000).toISOString());
    expect(screen.getByRole("button", { name: "Retry All history" })).toBeTruthy();
  });

  it("bounds 1Y independently from All and restores the 90-day seed on return", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json(ANNUAL_HISTORY));
    vi.stubGlobal("fetch", fetchMock);
    renderSeededSection();

    fireEvent.click(screen.getByRole("button", { name: "1Y" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("days=365");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("range=");
    await waitFor(() => expect(marketCapDomain()).toBe(ANNUAL_DOMAIN));
    const slider = screen.getByRole("slider", { name: "Brush time window" });
    expect(slider.getAttribute("aria-valuemin")).toBe(String((ANNUAL_HISTORY[ANNUAL_HISTORY.length - 1].date - 365 * DAY) * 1000));

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
