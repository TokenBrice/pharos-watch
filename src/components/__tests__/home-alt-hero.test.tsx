// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeAltHero } from "@/components/home-alt-hero";
import { buildLiveHomepageHeroSnapshot } from "@shared/lib/homepage-hero-snapshot";
import { HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS } from "@/lib/homepage-hero-snapshot";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import type { ApiMeta } from "@/lib/api";

const { useStablecoinsMock } = vi.hoisted(() => ({ useStablecoinsMock: vi.fn() }));
vi.mock("@/hooks/api-hooks", () => ({
  useHomepageSnapshot: () => {
    const query = useStablecoinsMock();
    return { ...query, data: query.data ? { market: {
      data: buildLiveHomepageHeroSnapshot(query.data, query.meta?.updatedAt ?? undefined),
      meta: query.meta,
    } } : undefined };
  },
}));
vi.mock("@/components/home-alt-hero-chart-gate", () => ({ HomeAltHeroChartGate: () => <div /> }));
vi.mock("@/components/home-market-state-line", () => ({ HomeMarketStateLine: () => null }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));
vi.mock("@/lib/analytics", () => ({ trackFreshDataReady: vi.fn() }));

const NOW = Date.parse("2026-10-10T12:00:00Z");
const data = { peggedAssets: [makeStablecoin({ id: "usdt-tether", circulating: { peggedUSD: 100 } })] };
const fallback = buildLiveHomepageHeroSnapshot(data, NOW / 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("HomeAltHero producer freshness", () => {
  it("shows shares of the known subtotal with incomplete supply coverage", () => {
    useStablecoinsMock.mockReturnValue({
      data: { peggedAssets: [
        makeStablecoin({ id: "usdt-tether", circulating: { peggedUSD: 80 } }),
        makeStablecoin({ id: "eurc-circle", pegType: "peggedEUR", circulating: { peggedEUR: 20 } }),
      ] },
      dataUpdatedAt: NOW, error: null, refetch: vi.fn(),
      meta: { updatedAt: NOW / 1000, ageSeconds: 0, status: "fresh" },
    });
    render(<HomeAltHero snapshot={fallback} fallbackSelectedAtMs={NOW} />);
    expect(screen.getByText("Core market cap, known subtotal")).toBeTruthy();
    expect(screen.queryByText("Core market cap")).toBeNull();
    expect(screen.getByText("Shares of known market cap subtotal")).toBeTruthy();
    expect(screen.getByText("80.0%")).toBeTruthy();
    expect(screen.getAllByText("20.0%")).toHaveLength(2);
    expect(screen.queryByText("share unavailable")).toBeNull();
  });

  // Homepage rule (docs/homepage.md): producer health never renders as a
  // warning; figures carry a neutral producer-generation stamp only.
  it("stamps a fresh producer generation without state words", () => {
    useStablecoinsMock.mockReturnValue({
      data, dataUpdatedAt: NOW, error: null, refetch: vi.fn(),
      meta: { updatedAt: NOW / 1000, ageSeconds: 0, status: "fresh" },
    });
    render(<HomeAltHero snapshot={fallback} fallbackSelectedAtMs={NOW} />);
    expect(screen.getByText(/^As of October 10, 2026/)).toBeTruthy();
    const headline = screen.getByText(/^Core market cap/);
    expect(headline.getAttribute("title")).toBe("Excludes 2 off-catalog PSI historical assets");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    ["old producer", { updatedAt: (NOW - DATA_HEALTH_PRESETS.stablecoins.staleTime * (FRESHNESS_RATIOS.DEGRADED + 1)) / 1000, ageSeconds: 0, status: "fresh" }, NOW],
    ["degraded producer", { updatedAt: NOW / 1000, ageSeconds: 0, status: "degraded" }, NOW],
    ["missing authority", undefined, 0],
  ] satisfies [string, ApiMeta | undefined, number][])("keeps %s data visible without a warning", (_case, meta, dataUpdatedAt) => {
    useStablecoinsMock.mockReturnValue({ data, dataUpdatedAt, error: null, meta, refetch: vi.fn() });
    const view = render(<HomeAltHero snapshot={fallback} fallbackSelectedAtMs={NOW} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(view.container.textContent).not.toMatch(/Stale|Degraded|Freshness unavailable|Refresh failed|Retained|Live ·/);
    expect(screen.getAllByText(/^\$100(?:\.0)?$/).length).toBeGreaterThan(0);
  });

  it.each([
    ["absent", undefined],
    ["explicitly unavailable", { updatedAt: null, ageSeconds: null, status: "unknown", reason: "missing-generation" }],
    ["warning-only", { status: "degraded", warning: "source warning" }],
  ] satisfies [string, ApiMeta | undefined][])("does not treat a recent receipt as producer time with %s metadata", (_case, meta) => {
    useStablecoinsMock.mockReturnValue({ data, dataUpdatedAt: NOW, meta, error: null, refetch: vi.fn() });
    render(<HomeAltHero snapshot={fallback} fallbackSelectedAtMs={NOW} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/as of October 10, 2026/i)).toBeNull();
    expect(screen.getAllByText(/^\$100(?:\.0)?$/).length).toBeGreaterThan(0);
  });

  it("keeps retained figures after a failed refresh without a failure notice", () => {
    useStablecoinsMock.mockReturnValue({
      data, dataUpdatedAt: NOW, error: new Error("refresh failed"), refetch: vi.fn(),
      meta: { updatedAt: NOW / 1000 - 60, ageSeconds: 60, status: "fresh" },
    });
    const view = render(<HomeAltHero snapshot={fallback} fallbackSelectedAtMs={NOW} />);
    expect(screen.getByText(/^As of/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(view.container.textContent).not.toMatch(/Refresh failed|Last successful update/);
  });

  it("expires the static fallback to a neutral placeholder while the page remains mounted", () => {
    const asOfMs = NOW - HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS;
    const boundaryFallback = buildLiveHomepageHeroSnapshot(data, asOfMs / 1000);
    useStablecoinsMock.mockReturnValue({ data: undefined, dataUpdatedAt: 0, error: null, refetch: vi.fn() });
    render(<HomeAltHero snapshot={boundaryFallback} fallbackSelectedAtMs={NOW} />);
    expect(screen.getByText(/^As of/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByText(/^As of/)).toBeNull();
    expect(screen.getByText("Updating")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    // Unavailable keeps the plain Core headline, never a known-subtotal claim.
    expect(screen.getByText("Core market cap")).toBeTruthy();
    expect(screen.queryByText(/known subtotal/)).toBeNull();
  });

  it("ages a healthy producer generation during a long-lived page session without a warning", () => {
    useStablecoinsMock.mockReturnValue({
      data, dataUpdatedAt: NOW, error: null, refetch: vi.fn(),
      meta: { updatedAt: NOW / 1000, ageSeconds: 0, status: "fresh" },
    });
    render(<HomeAltHero snapshot={fallback} fallbackSelectedAtMs={NOW} />);
    act(() => { vi.advanceTimersByTime(DATA_HEALTH_PRESETS.stablecoins.staleTime * (FRESHNESS_RATIOS.DEGRADED + 1)); });
    expect(screen.queryByText(/^Stale ·/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
