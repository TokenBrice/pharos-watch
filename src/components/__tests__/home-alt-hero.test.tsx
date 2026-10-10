// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeAltHero } from "@/components/home-alt-hero";
import { buildLiveHomepageHeroSnapshot, HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS } from "@/lib/homepage-hero-snapshot";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import type { ApiMeta } from "@/lib/api";

const { useStablecoinsMock } = vi.hoisted(() => ({ useStablecoinsMock: vi.fn() }));
vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: useStablecoinsMock }));
vi.mock("@/components/home-alt-hero-chart-gate", () => ({ HomeAltHeroChartGate: () => <div /> }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

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
  it("reserves Live for a fresh successful producer generation", () => {
    useStablecoinsMock.mockReturnValue({
      data, dataUpdatedAt: NOW, error: null, refetch: vi.fn(),
      meta: { updatedAt: NOW / 1000, ageSeconds: 0, status: "fresh" },
    });
    render(<HomeAltHero snapshot={fallback} fallbackSelectedAtMs={NOW} />);
    expect(screen.getByText(/^Live · as of/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    ["old producer", { updatedAt: (NOW - DATA_HEALTH_PRESETS.stablecoins.staleTime * (FRESHNESS_RATIOS.DEGRADED + 1)) / 1000, ageSeconds: 0, status: "fresh" }, NOW, /^Stale ·/, /older snapshot/],
    ["degraded producer", { updatedAt: NOW / 1000, ageSeconds: 0, status: "degraded" }, NOW, /^Degraded ·/, /quality warning/],
    ["missing authority", undefined, 0, /^Freshness unavailable ·/, /initial data/],
  ] satisfies [string, ApiMeta | undefined, number, RegExp, RegExp][])("retains %s data without calling a new receipt live", (_case, meta, dataUpdatedAt, label, warning) => {
    useStablecoinsMock.mockReturnValue({ data, dataUpdatedAt, error: null, meta, refetch: vi.fn() });
    render(<HomeAltHero snapshot={fallback} fallbackSelectedAtMs={NOW} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(warning);
    expect(screen.queryByText(/^Live ·/)).toBeNull();
    expect(screen.getAllByText(/^\$100(?:\.0)?$/).length).toBeGreaterThan(0);
  });

  it("uses the query update timestamp when producer metadata is absent", () => {
    useStablecoinsMock.mockReturnValue({ data, dataUpdatedAt: NOW, error: null, refetch: vi.fn() });
    render(<HomeAltHero snapshot={fallback} fallbackSelectedAtMs={NOW} />);
    expect(screen.getByText("Live · as of October 10, 2026")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("labels retained figures after a failed refresh and exposes their producer update", () => {
    useStablecoinsMock.mockReturnValue({
      data, dataUpdatedAt: NOW, error: new Error("refresh failed"), refetch: vi.fn(),
      meta: { updatedAt: NOW / 1000 - 60, ageSeconds: 60, status: "fresh" },
    });
    render(<HomeAltHero snapshot={fallback} fallbackSelectedAtMs={NOW} />);
    expect(screen.getByText(/^Refresh failed · as of/)).toBeTruthy();
    expect(screen.queryByText(/^Live ·/)).toBeNull();
    expect(screen.getAllByRole("status").some((notice) => /Last successful update/.test(notice.textContent ?? ""))).toBe(true);
  });

  it("expires the static fallback while the page remains mounted", () => {
    const asOfMs = NOW - HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS;
    const boundaryFallback = buildLiveHomepageHeroSnapshot(data, asOfMs / 1000);
    useStablecoinsMock.mockReturnValue({ data: undefined, dataUpdatedAt: 0, error: null, refetch: vi.fn() });
    render(<HomeAltHero snapshot={boundaryFallback} fallbackSelectedAtMs={NOW} />);
    expect(screen.getByText(/^Fallback · as of/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByText(/^Fallback ·/)).toBeNull();
    expect(screen.getByText("Live market data unavailable")).toBeTruthy();
  });

  it("ages a healthy producer generation during a long-lived page session", () => {
    useStablecoinsMock.mockReturnValue({
      data, dataUpdatedAt: NOW, error: null, refetch: vi.fn(),
      meta: { updatedAt: NOW / 1000, ageSeconds: 0, status: "fresh" },
    });
    render(<HomeAltHero snapshot={fallback} fallbackSelectedAtMs={NOW} />);
    act(() => { vi.advanceTimersByTime(DATA_HEALTH_PRESETS.stablecoins.staleTime * (FRESHNESS_RATIOS.DEGRADED + 1)); });
    expect(screen.queryByText(/^Live ·/)).toBeNull();
    expect(screen.getByText(/^Stale ·/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/older snapshot/);
  });
});
