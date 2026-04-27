// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StablecoinDetailClient from "./client";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { buildStablecoinDetailMetadata } from "@/lib/page-metadata";
import type { StablecoinMeta, StablecoinObituary } from "@shared/types";

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

const obituary: StablecoinObituary = {
  causeOfDeath: "abandoned",
  deathDate: "2026-04",
  epitaph: "Sunset by issuer.",
  obituary: "Wound down following protocol-level losses.",
  sourceUrl: "https://example.com/shutdown",
  sourceLabel: "Issuer announcement",
};

function makeFrozenViewModel(coin: StablecoinMeta) {
  const frozenCoin: StablecoinMeta = {
    ...coin,
    status: "frozen",
    frozenAt: "2026-04-27",
    obituary,
  };
  return {
    status: "ready" as const,
    id: frozenCoin.id,
    coin: frozenCoin,
    summary: null,
    logoSrc: undefined,
    reportCard: null,
    variantParent: null,
    variantSiblings: [],
    childVariants: [],
    isVariant: false,
    hasVariants: false,
    coinData: {
      id: frozenCoin.id,
      name: frozenCoin.name,
      symbol: frozenCoin.symbol,
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
  };
}

describe("StablecoinDetailClient (frozen)", () => {
  beforeEach(() => {
    useStablecoinDetailViewModelMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the FrozenStateBanner above the hero when status === frozen", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeFrozenViewModel(coin));
    render(<StablecoinDetailClient id={coin.id} summary={null} coin={coin} />);
    expect(screen.getByText("Sunset by issuer.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /cemetery/i })).toBeTruthy();
  });

  it("renders FrozenDataNote labels above each chart section", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeFrozenViewModel(coin));
    render(<StablecoinDetailClient id={coin.id} summary={null} coin={coin} />);
    const notes = screen.getAllByText(/no longer collects new metrics/i);
    // Market chart, Distribution, Liquidity, History — non-flow / non-blacklist
    // sections render unconditionally for this fixture.
    expect(notes.length).toBeGreaterThanOrEqual(4);
  });
});

describe("buildStablecoinDetailMetadata (frozen)", () => {
  it("uses the archive-themed title and preserves the OG image", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const frozen: StablecoinMeta = { ...coin, status: "frozen", frozenAt: "2026-04-27", obituary };
    const meta = buildStablecoinDetailMetadata(frozen);
    expect(typeof meta.title === "string" ? meta.title : "").toContain("Frozen Stablecoin Archive");
    const ogImages = meta.openGraph?.images;
    const firstImage = Array.isArray(ogImages) ? ogImages[0] : ogImages;
    const imageUrl = typeof firstImage === "object" && firstImage && "url" in firstImage ? firstImage.url : firstImage;
    expect(String(imageUrl)).toContain(`/api/og/stablecoin/${frozen.id}`);
  });
});
