// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { useEffect, useReducer, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StablecoinDetailClient from "./client";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinStaticMeta } from "@/lib/stablecoin-static-meta";

const { useStablecoinDetailViewModelMock, pendingDynamicLoads } = vi.hoisted(() => ({
  useStablecoinDetailViewModelMock: vi.fn(),
  pendingDynamicLoads: [] as Promise<unknown>[],
}));

// Resolve dynamic() loaders so module-level vi.mocks take effect behind the
// page's dynamic boundaries — but only swap in components explicitly marked
// with RENDER_IN_DYNAMIC_STUB (set on test mocks whose content is asserted).
// Real modules resolve too (their imports are drained in afterEach so they
// don't outlive the environment) but keep rendering the opaque placeholder,
// since they'd need providers (QueryClient etc.) this harness doesn't mount.
// Await with findBy* when asserting marked sections' content.
const RENDER_IN_DYNAMIC_STUB = "__renderInDynamicStub";

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<ComponentType | { default: ComponentType }>) => {
    let Resolved: ComponentType | null = null;
    function DynamicStub(props: Record<string, unknown>) {
      const [, force] = useReducer((x: number) => x + 1, 0);
      useEffect(() => {
        let mounted = true;
        const load = Promise.resolve(loader()).then((mod) => {
          const component = (typeof mod === "function" ? mod : mod.default) as ComponentType;
          if ((component as unknown as Record<string, unknown>)[RENDER_IN_DYNAMIC_STUB] === true) {
            Resolved = component;
            if (mounted) force();
          }
        });
        // Track in-flight module loads so afterEach can drain them before
        // vitest tears the environment down (heavy unmocked modules would
        // otherwise reject with EnvironmentTeardownError after the test).
        pendingDynamicLoads.push(load.catch(() => undefined));
        return () => {
          mounted = false;
        };
      }, []);
      if (!Resolved) return <div data-testid="dynamic-detail-section" />;
      const Component = Resolved;
      return <Component {...props} />;
    }
    return DynamicStub;
  },
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

vi.mock("@/components/stablecoin-detail/reserve-panel", () => {
  const ReservePanel = ({
    reserves,
    onRetry,
    isFetching,
  }: {
    reserves?: { mode?: string } | null;
    onRetry?: () => Promise<unknown> | void;
    isFetching?: boolean;
  }) => (
    <section id="reserves" data-testid="reserve-panel">
      <span>{reserves?.mode ?? "no-reserves"}</span>
      <button type="button" disabled={isFetching} onClick={() => { void onRetry?.(); }}>
        Retry reserves
      </button>
    </section>
  );
  // ReservePanel renders behind a dynamic() boundary; mark the mock so the
  // next/dynamic stub swaps it in (see RENDER_IN_DYNAMIC_STUB above).
  (ReservePanel as unknown as Record<string, unknown>).__renderInDynamicStub = true;
  return { ReservePanel };
});

vi.mock("@/components/stablecoin-detail/price-transparency-card", () => ({
  PriceTransparencyCard: () => <div data-testid="price-transparency-card" />,
}));

vi.mock("@/components/stablecoin-detail/redemption-backstop-card", () => ({
  RedemptionBackstopCard: ({ entry }: { entry: { stablecoinId: string } }) => (
    <section data-testid="redemption-backstop-card">{entry.stablecoinId}</section>
  ),
}));

vi.mock("@/components/ai-summary", () => ({
  AiSummary: () => null,
}));

vi.mock("@/components/dews-detail", () => ({
  DEWSDetail: () => null,
}));

vi.mock("@/components/coin-notice", () => ({
  CoinNotices: () => null,
}));

vi.mock("@/components/tape-for-coin-teaser", () => ({
  TapeForCoinTeaser: () => null,
}));

vi.mock("@/components/feedback-modal", () => ({
  FeedbackModal: () => null,
}));

vi.mock("@/components/exploit-notice-banner", () => ({
  ExploitNoticeBanner: () => null,
}));

vi.mock("@/components/stablecoin-detail/recent-blacklist-banner", () => ({
  RecentBlacklistBanner: () => null,
}));

vi.mock("@/components/stablecoin-detail/contagion-snapshot", () => ({
  // Render the `variantRelationshipCard` child so tests can still assert it
  // exists outside the overview section; suppress the inner contagion graph
  // which would otherwise pull in the live useReportCards query.
  ContagionSnapshot: ({ variantRelationshipCard }: { variantRelationshipCard?: import("react").ReactNode }) => (
    <div data-testid="contagion-snapshot-mock">{variantRelationshipCard}</div>
  ),
}));

vi.mock("@/components/report-card", () => ({
  ReportCardDetail: ({ rightColumn }: { rightColumn?: ReactNode }) => (
    <div data-testid="report-card">{rightColumn}</div>
  ),
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
    reportCardUpdatedAt: null,
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
    refetchReserves: null,
    isFetchingReserves: false,
    supplyError: null,
    staleQueries: [],
    verdict: {
      archetype: "uncategorized",
      label: "Uncategorized",
    },
    mintAuthority: { status: "not-reviewed" as const },
    handleRetryAll: vi.fn(),
    ...overrides,
  };
}

describe("StablecoinDetailClient", () => {
  beforeEach(() => {
    useStablecoinDetailViewModelMock.mockReset();
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel());
  });

  afterEach(async () => {
    cleanup();
    await Promise.allSettled(pendingDynamicLoads.splice(0));
  });

  it("renders static profile content in the loading fallback", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue({ status: "loading" });

    const { container } = render(
      <StablecoinDetailClient
        id={coin.id}
        coin={coin}
        summary={null}
        staticCoin={buildStablecoinStaticMeta(coin)}
        staticProfileContent={<section data-testid="static-profile">Static stablecoin profile</section>}
      />,
    );

    const staticProfile = screen.getByTestId("static-profile");
    expect(staticProfile.textContent).toContain("Static stablecoin profile");
    expect(container.textContent).toContain("Loading research dossier");
  });

  it("renders the parent variants card outside the overview section", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const { container } = render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const overviewSections = container.querySelectorAll("#overview");
    expect(overviewSections).toHaveLength(1);
    expect(screen.getByText("Variants")).toBeTruthy();
    expect(overviewSections[0]?.contains(screen.getByText("Variants"))).toBe(false);
    expect(screen.getAllByText("Sky Savings USDS").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Staked USDS").length).toBeGreaterThan(0);
  });

  it("renders reserve view in the overview stream when report-card data is unavailable", async () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const refetchReserves = vi.fn().mockResolvedValue({ status: "success" });
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      reportCard: null,
      reserves: {
        reserves: [{ name: "Curated reserve", pct: 100, risk: "low" }],
        estimated: false,
        mode: "curated-fallback",
      },
      refetchReserves,
      isFetchingReserves: true,
    }));

    const { container } = render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const reservePanel = await screen.findByTestId("reserve-panel");
    const reportCardAnchor = container.querySelector("#report-card");
    expect(screen.queryByTestId("report-card")).toBeNull();
    expect(reservePanel.textContent).toContain("curated-fallback");
    expect(reportCardAnchor?.contains(reservePanel)).toBe(false);
    expect(screen.getByRole("button", { name: "Retry reserves" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders the underlying asset card outside the overview section for variants", () => {
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
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const overviewSections = container.querySelectorAll("#overview");
    expect(overviewSections).toHaveLength(1);
    expect(screen.getByText("Underlying Asset")).toBeTruthy();
    expect(overviewSections[0]?.contains(screen.getByText("Underlying Asset"))).toBe(false);
    expect(screen.getAllByText("Sky Dollar").length).toBeGreaterThan(0);
  });

  it("mounts redemption backstop data in the liquidity zone", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      redemptionBackstop: {
        stablecoinId: coin.id,
      },
    }));

    render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    const priceCard = screen.getByTestId("price-transparency-card");
    const priceSection = priceCard.closest("section");
    const redemptionCard = screen.getByTestId("redemption-backstop-card");
    expect(redemptionCard.parentElement).toBe(priceSection?.parentElement);
  });

  it("keeps the liquidity price panel when redemption backstop data is absent", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      redemptionBackstop: undefined,
    }));

    render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    expect(screen.getByTestId("price-transparency-card")).toBeTruthy();
    expect(screen.queryByTestId("redemption-backstop-card")).toBeNull();
  });

  it("keeps redemption in the liquidity zone when price transparency data is absent", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      coinData: {
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol,
        pegType: "peggedUSD",
        price: null,
        circulating: { peggedUSD: 100 },
        circulatingPrevDay: { peggedUSD: 99 },
        circulatingPrevWeek: { peggedUSD: 98 },
        circulatingPrevMonth: { peggedUSD: 97 },
        chainCirculating: {},
        chains: ["ethereum"],
      },
      dexPriceCheck: null,
      redemptionBackstop: {
        stablecoinId: coin.id,
      },
    }));

    const { container } = render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    expect(screen.queryByTestId("price-transparency-card")).toBeNull();
    const redemptionCard = screen.getByTestId("redemption-backstop-card");
    const liquiditySection = container.querySelector("#dex-liquidity");
    expect(liquiditySection?.parentElement?.contains(redemptionCard)).toBe(true);
  });

  it("omits the liquidity detail grid when price transparency and redemption data are absent", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeReadyViewModel({
      coinData: {
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol,
        pegType: "peggedUSD",
        price: null,
        circulating: { peggedUSD: 100 },
        circulatingPrevDay: { peggedUSD: 99 },
        circulatingPrevWeek: { peggedUSD: 98 },
        circulatingPrevMonth: { peggedUSD: 97 },
        chainCirculating: {},
        chains: ["ethereum"],
      },
      dexPriceCheck: null,
      redemptionBackstop: undefined,
    }));

    render(
      <StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />,
    );

    expect(screen.queryByTestId("price-transparency-card")).toBeNull();
    expect(screen.queryByTestId("redemption-backstop-card")).toBeNull();
  });
});
