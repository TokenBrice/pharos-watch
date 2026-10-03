// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioClient } from "./client";
import type { ReportCardsV9Response } from "@shared/types";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";

let portfolioState: {
  holdings: Array<{ coinId: string; amount: number }>;
  initialized: boolean;
  upstreamExposure: Array<{ coinId: string; name: string; symbol: string; usd: number; pct: number; isCollateral: boolean }>;
  upstreamExposureGrouped: Array<{ coinId: string; name: string; symbol: string; usd: number; pct: number; isCollateral: boolean }>;
  portfolioGrade: string;
  portfolioScore: number | null;
  dimensionScores: Record<string, number | null>;
  totalUsd: number;
  addCoin: ReturnType<typeof vi.fn>;
  clearAll: ReturnType<typeof vi.fn>;
  removeCoin: ReturnType<typeof vi.fn>;
  setAmount: ReturnType<typeof vi.fn>;
  shareUrl: ReturnType<typeof vi.fn>;
};

const reportCardsState: {
  data: ReportCardsV9Response | undefined;
  isLoading: boolean;
  dataUpdatedAt: number;
  error: Error | null;
  meta: Record<string, unknown>;
} = {
  data: undefined,
  isLoading: false,
  dataUpdatedAt: 0,
  error: null,
  meta: {},
};

vi.mock("@/hooks/api-hooks", () => ({
  useReportCardsV9: () => ({
    ...reportCardsState,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/lib/logos", () => ({
  logosById: {},
}));

vi.mock("@/hooks/use-portfolio", () => ({
  usePortfolio: () => portfolioState,
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div>skeleton</div>,
}));

vi.mock("@/components/coin-selector", () => ({
  CoinSelector: () => <div>coin-selector</div>,
}));

vi.mock("@/components/radar-chart", () => ({
  ReportCardRadar: () => <div>radar</div>,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <div>{name}</div>,
}));

vi.mock("@/components/stale-data-banner", () => ({
  StaleDataBanner: () => null,
}));

vi.mock("@/components/query-error-notice", () => ({
  QueryErrorNotice: () => null,
}));

vi.mock("@/components/portfolio-empty-state", () => ({
  PortfolioEmptyState: () => <div>portfolio-empty-state</div>,
}));

function basePortfolioState(): typeof portfolioState {
  return {
    holdings: [],
    initialized: true,
    upstreamExposure: [],
    upstreamExposureGrouped: [],
    portfolioGrade: "NR",
    portfolioScore: null,
    dimensionScores: {
      pegStability: null,
      liquidity: null,
      resilience: null,
      decentralization: null,
      dependencyRisk: null,
    },
    totalUsd: 0,
    addCoin: vi.fn(),
    clearAll: vi.fn(),
    removeCoin: vi.fn(),
    setAmount: vi.fn(),
    shareUrl: vi.fn(() => "https://pharos.watch/portfolio/"),
  };
}

describe("PortfolioClient URL sync", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    portfolioState = basePortfolioState();
    reportCardsState.data = undefined;
    window.history.replaceState(null, "", "/portfolio/");
  });

  it("removes stale legacy portfolio params when nothing valid survives", async () => {
    window.history.replaceState(null, "", "/portfolio/?p=1:25");

    render(<PortfolioClient />);

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
  });

  it("rewrites stale portfolio params to canonical holdings", async () => {
    portfolioState = {
      ...basePortfolioState(),
      holdings: [{ coinId: "usdt-tether", amount: 25 }],
    };
    window.history.replaceState(null, "", "/portfolio/?p=1:25");

    render(<PortfolioClient />);

    await waitFor(() => {
      expect(window.location.search).toBe("?p=usdt-tether%3A25");
    });
  });

  it("preserves canonical portfolio params", async () => {
    portfolioState = {
      ...basePortfolioState(),
      holdings: [{ coinId: "usdc-circle", amount: 25 }],
    };
    window.history.replaceState(null, "", "/portfolio/?p=usdc-circle:25");

    render(<PortfolioClient />);

    await waitFor(() => {
      expect(window.location.search).toBe("?p=usdc-circle%3A25");
    });
  });
  it("labels partial score and pillar averages by their own known-only holding coverage", () => {
    portfolioState = { ...basePortfolioState(), holdings: [{ coinId: "usdc-circle", amount: 100 }, { coinId: "usdt-tether", amount: 300 }] };
    const complete = makeV9Card({ id: "usdc-circle", score: 80, pillars: {
      ...makeV9Card().pillars, backing: { ...makeV9Card().pillars.backing, score: 80 }, exit: { ...makeV9Card().pillars.exit, score: 60 }, control: { ...makeV9Card().pillars.control, score: 80 },
    } });
    const partialPillars = makeReportCardsV9PartialCard("exit", "B").pillars;
    const partial = makeReportCardsV9PartialCard("exit", "B", { id: "usdt-tether", score: 90,
      pillars: { ...partialPillars, backing: { ...partialPillars.backing, score: 90 }, control: { ...partialPillars.control, score: 90 } } });
    reportCardsState.data = makeReportCardsV9Response({ cards: [complete, partial] });
    render(<PortfolioClient />);
    expect(screen.getByText("Known-only weighted V10 safety subtotal")).toBeTruthy();
    expect(screen.getByText("exit · known-only subtotal").parentElement?.textContent).toContain("60/100");
    expect(screen.getByText("exit · known-only subtotal").parentElement?.textContent).toContain("100 USD of 400 USD");
    expect(screen.getByText(/public data awaiting curation \(B\)/)).toBeTruthy();
    expect(screen.queryByText("15/100")).toBeNull();
  });

  it("does not manufacture a grade or aggregate when every holding has a Pipeline gap", () => {
    portfolioState = { ...basePortfolioState(), holdings: [{ coinId: "usdc-circle", amount: 100 }] };
    reportCardsState.data = makeReportCardsV9Response({ cards: [makeReportCardsV9PipelineGapCard("control", "A", { id: "usdc-circle" })] });
    render(<PortfolioClient />);
    expect(screen.getByText("Pipeline gap")).toBeTruthy();
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    expect(screen.getByText(/Pipeline gap · fewer than two pillars available/)).toBeTruthy();
    expect(screen.queryByText(/NR|0\/100|100\/100/)).toBeNull();
  });
});
