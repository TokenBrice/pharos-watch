// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StablecoinDetailClient from "./client";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

const { useStablecoinDetailViewModelMock } = vi.hoisted(() => ({
  useStablecoinDetailViewModelMock: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => <div data-testid="dynamic-detail-section" />,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock("@/hooks/use-stablecoin-detail-view-model", () => ({
  useStablecoinDetailViewModel: useStablecoinDetailViewModelMock,
}));

vi.mock("@/hooks/use-depeg-events", () => ({
  useInfiniteDepegEvents: () => ({ data: { total: 0 } }),
}));

vi.mock("@/hooks/use-logos", () => ({
  useLogos: () => ({ data: {} }),
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/components/stale-data-banner", () => ({
  StaleDataBanner: () => null,
}));

vi.mock("@/components/query-error-notice", () => ({
  QueryErrorNotice: () => null,
}));

vi.mock("@/components/longform-scrollspy-nav", () => ({
  LongformScrollspyNav: () => <nav data-testid="scrollspy" />,
}));

vi.mock("@/components/stablecoin-detail/hero-card", () => ({
  HeroCard: () => <div data-testid="hero-card" />,
}));

vi.mock("@/components/stablecoin-detail/notices-and-summary-section", () => ({
  NoticesAndSummarySection: () => <div data-testid="notices-and-summary" />,
}));

vi.mock("@/components/feedback-modal", () => ({
  FeedbackModal: () => null,
}));

vi.mock("@/components/exploit-notice-banner", () => ({
  ExploitNoticeBanner: () => null,
}));

vi.mock("@/components/report-card", () => ({
  ReportCardDetail: () => <div data-testid="report-card" />,
}));

function makeReadyViewModel(overrides: Record<string, unknown> = {}) {
  const coin = TRACKED_META_BY_ID.get("usds-sky")!;
  return {
    status: "ready" as const,
    id: coin.id,
    coin,
    summary: null,
    logoSrc: undefined,
    reportCard: null,
    variantParent: null,
    variantSiblings: [],
    childVariants: [TRACKED_META_BY_ID.get("susds-sky")!, TRACKED_META_BY_ID.get("stusds-sky")!],
    isVariant: false,
    hasVariants: true,
    coinData: {
      id: coin.id,
      name: coin.name,
      symbol: coin.symbol,
      pegType: "peggedUSD",
      price: 1,
      circulating: { peggedUSD: 100 },
      circulatingPrevDay: { peggedUSD: 99 },
      circulatingPrevWeek: { peggedUSD: 98 },
      circulatingPrevMonth: { peggedUSD: 97 },
      chainCirculating: {},
      chains: ["ethereum"],
    },
    mcap: 100,
    supply: 100,
    prevDay: 99,
    prevWeek: 98,
    prevMonth: 97,
    performanceVsUsd1y: null,
    pegRef: 1,
    deviationBps: 0,
    gaugeDeviationBps: 0,
    isNavToken: false,
    pegScoreResult: null,
    consensusSources: [],
    agreeSources: [],
    dexPriceCheck: null,
    liquidityData: undefined,
    yieldRanking: null,
    hasYieldSection: false,
    stressSignal: null,
    redemptionBackstop: undefined,
    hasFlows: false,
    hasBlacklist: false,
    supplyHistory: [],
    earliestTrackingDate: null,
    reserves: null,
    reserveFetchError: null,
    supplyError: null,
    staleQueries: [],
    handleRetryAll: vi.fn(),
    ...overrides,
  };
}

describe("StablecoinDetailClient", () => {
  beforeEach(() => {
    useStablecoinDetailViewModelMock.mockReset();
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel());
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the parent variants card inside the single overview section", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const { container } = render(
      <StablecoinDetailClient id={coin.id} summary={null} coin={coin} />,
    );

    const overviewSections = container.querySelectorAll("#overview");
    expect(overviewSections).toHaveLength(1);
    expect(screen.getByText("Variants")).toBeTruthy();
    expect(overviewSections[0]?.contains(screen.getByText("Variants"))).toBe(true);
    expect(screen.getAllByText("Sky Savings USDS").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Staked USDS").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Browse all tracked variants" })).toBeTruthy();
  });

  it("renders the underlying asset card inside the single overview section for variants", () => {
    const coin = TRACKED_META_BY_ID.get("susds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      id: coin.id,
      coin,
      variantParent: TRACKED_META_BY_ID.get("usds-sky")!,
      variantSiblings: [TRACKED_META_BY_ID.get("stusds-sky")!],
      childVariants: [],
      isVariant: true,
      hasVariants: false,
      coinData: {
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol,
        pegType: "peggedUSD",
        price: 1.01,
        circulating: { peggedUSD: 100 },
        circulatingPrevDay: { peggedUSD: 99 },
        circulatingPrevWeek: { peggedUSD: 98 },
        circulatingPrevMonth: { peggedUSD: 97 },
        chainCirculating: {},
        chains: ["ethereum"],
      },
      isNavToken: true,
    }));

    const { container } = render(
      <StablecoinDetailClient id={coin.id} summary={null} coin={coin} />,
    );

    const overviewSections = container.querySelectorAll("#overview");
    expect(overviewSections).toHaveLength(1);
    expect(screen.getByText("Underlying Asset")).toBeTruthy();
    expect(overviewSections[0]?.contains(screen.getByText("Underlying Asset"))).toBe(true);
    expect(screen.getAllByText("Sky Dollar").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Browse all savings variants" })).toBeTruthy();
  });

  it("falls back to tracked variants browse link for bond variants", () => {
    const coin = TRACKED_META_BY_ID.get("busd0-usual")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      id: coin.id,
      coin,
      variantParent: TRACKED_META_BY_ID.get("usd0-usual")!,
      variantSiblings: [],
      childVariants: [],
      isVariant: true,
      hasVariants: false,
      coinData: {
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol,
        pegType: "peggedUSD",
        price: 1,
        circulating: { peggedUSD: 100 },
        circulatingPrevDay: { peggedUSD: 99 },
        circulatingPrevWeek: { peggedUSD: 98 },
        circulatingPrevMonth: { peggedUSD: 97 },
        chainCirculating: {},
        chains: ["ethereum"],
      },
      isNavToken: true,
    }));

    render(<StablecoinDetailClient id={coin.id} summary={null} coin={coin} />);

    const browseLink = screen.getByRole("link", { name: "Browse all tracked variants" });
    expect(browseLink.getAttribute("href")).toBe("/?variant=variant-tracked");
  });
});
