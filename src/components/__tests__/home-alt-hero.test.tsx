// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeAltHero } from "@/components/homepage/home-alt-hero";
import { buildLiveHomepageHeroSnapshot } from "@shared/lib/homepage-hero-snapshot";
import { HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS } from "@/lib/homepage-hero-snapshot";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC } from "@shared/lib/stablecoins/aggregate-universe";
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
vi.mock("@/components/homepage/home-alt-hero-chart-gate", () => ({ HomeAltHeroChartGate: () => <div /> }));
vi.mock("@/components/homepage/home-market-state-line", () => ({ HomeMarketStateLine: () => null }));
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
  // ADR-42: incomplete supply coverage never renders completeness text on the homepage.
  it("keeps the plain headline and cohort shares with incomplete supply coverage", () => {
    useStablecoinsMock.mockReturnValue({
      data: { peggedAssets: [
        makeStablecoin({ id: "usdt-tether", circulating: { peggedUSD: 80 } }),
        makeStablecoin({ id: "eurc-circle", pegType: "peggedEUR", circulating: { peggedEUR: 20 } }),
      ] },
      dataUpdatedAt: NOW, error: null, refetch: vi.fn(),
      meta: { updatedAt: NOW / 1000, ageSeconds: 0, status: "fresh" },
    });
    const view = render(<HomeAltHero snapshot={fallback} fallbackSelectedAtMs={NOW} />);
    expect(screen.getByText("Core market cap")).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/known|subtotal|Partial|assets observed/);
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

  it("renders domain-explicit subtitle, clickable cohort links, and 7d/30d supply deltas", () => {
    const historyMeta = {
      source: "stablecoin-charts",
      updatedAt: NOW / 1000,
      ageSeconds: 0,
      assessedAt: NOW / 1000,
      freshBudgetSec: 3600,
      degradedBudgetSec: 7200,
      status: "fresh" as const,
      reason: null,
      warning: null,
    };
    const snapshotWithHistory = {
      ...fallback,
      history: {
        sources: { total: historyMeta, usdt: historyMeta, usdc: historyMeta, usds: historyMeta, dai: historyMeta },
        rows: [
          { ts: NOW - 30 * 86_400_000, total: 100, usdt: 60, usdc: 20, sky: 10, others: 10, nonUsd: 2 },
          { ts: NOW - 7 * 86_400_000, total: 105, usdt: 62, usdc: 22, sky: 10, others: 11, nonUsd: 2 },
          { ts: NOW, total: 110, usdt: 65, usdc: 24, sky: 10, others: 11, nonUsd: 2 },
        ],
      },
    };
    useStablecoinsMock.mockReturnValue({
      data, dataUpdatedAt: NOW, error: null, refetch: vi.fn(),
      meta: { updatedAt: NOW / 1000, ageSeconds: 0, status: "fresh" },
    });
    const view = render(<HomeAltHero snapshot={snapshotWithHistory} fallbackSelectedAtMs={NOW} />);
    expect(view.container.textContent).toMatch(/Independent safety grades, peg stress, freeze risk, and liquidity across \d+ active stablecoins\./);
    expect(screen.getByText("+4.8%")).toBeTruthy();
    expect(screen.getByText("+10.0%")).toBeTruthy();
    expect(screen.getByRole("link", { name: /USDT/ }).getAttribute("href")).toMatch(/^\/stablecoin\/usdt-tether\/?$/);
    expect(screen.getByRole("link", { name: /USDC/ }).getAttribute("href")).toMatch(/^\/stablecoin\/usdc-circle\/?$/);
    expect(screen.getByRole("link", { name: /USDS \+ DAI/ }).getAttribute("href")).toMatch(/^\/compare\/usds-sky-vs-dai-makerdao\/?$/);
    expect(screen.getByRole("link", { name: /Non-USD share/ }).getAttribute("href")).toMatch(/^\/alt-pegs\/?$/);
  });

  it("withholds 7d and 30d hero supply deltas across the listing-policy v2 market-wide cutover", () => {
    const cutoverMs = CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC * 1000;
    const postCutoverMs = cutoverMs + 2 * 86_400_000;
    vi.setSystemTime(postCutoverMs);
    const historyMeta = {
      source: "stablecoin-charts",
      updatedAt: postCutoverMs / 1000,
      ageSeconds: 0,
      assessedAt: postCutoverMs / 1000,
      freshBudgetSec: 3600,
      degradedBudgetSec: 7200,
      status: "fresh" as const,
      reason: null,
      warning: null,
    };
    const postFallback = {
      ...buildLiveHomepageHeroSnapshot(data, postCutoverMs / 1000),
      history: {
        sources: { total: historyMeta, usdt: historyMeta, usdc: historyMeta, usds: historyMeta, dai: historyMeta },
        rows: [
          { ts: postCutoverMs - 30 * 86_400_000, total: 260, usdt: 150, usdc: 60, sky: 10, others: 40, nonUsd: 4 },
          { ts: postCutoverMs - 7 * 86_400_000, total: 260, usdt: 150, usdc: 60, sky: 10, others: 40, nonUsd: 4 },
          { ts: postCutoverMs, total: 248, usdt: 150, usdc: 60, sky: 10, others: 28, nonUsd: 2 },
        ],
      },
    };
    useStablecoinsMock.mockReturnValue({
      data, dataUpdatedAt: postCutoverMs, error: null, refetch: vi.fn(),
      meta: { updatedAt: postCutoverMs / 1000, ageSeconds: 0, status: "fresh" },
    });
    render(<HomeAltHero snapshot={postFallback} fallbackSelectedAtMs={postCutoverMs} />);
    expect(screen.queryByText(/-\d+\.\d+%/)).toBeNull();
    expect(screen.queryByText("7d")).toBeNull();
    expect(screen.queryByText("30d")).toBeNull();
  });
});
