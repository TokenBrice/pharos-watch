// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SelectorLowerRanked, SelectorRecommendation } from "@shared/lib/selector";

import { SelectorLowerRankedRow } from "@/components/selector/selector-lower-ranked-row";
import { SelectorShortlistCard } from "@/components/selector/selector-shortlist-card";
import { cleanupFrontendTest } from "@/test-utils/frontend";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/hooks/use-stablecoins", () => ({
  useSupplyHistory: () => ({
    data: [],
    dataUpdatedAt: 1,
    isLoading: false,
    isSuccess: true,
    error: null,
  }),
}));

afterEach(() => {
  cleanupFrontendTest();
});

const baseRecommendation: SelectorRecommendation = {
  id: "usdc-usd-coin",
  symbol: "USDC",
  name: "USD Coin",
  rank: 1,
  score: 87,
  confidence: 58,
  components: [
    {
      key: "resilience",
      weight: 20,
      rawValue: 91,
      normalizedValue: 91,
      contribution: 18.2,
      redistributed: false,
    },
    {
      key: "dependencyRisk",
      weight: 17,
      rawValue: 88,
      normalizedValue: 88,
      contribution: 14.96,
      redistributed: false,
    },
  ],
  whyKeys: ["top-safety", "strong-resilience"],
  lowestSubDimension: {
    key: "decentralization",
    score: 45,
    contextKeys: [],
  },
  chainHints: { topByLiquidity: ["Ethereum"], topByYield: [], primary: "Ethereum" },
  isRecentListing: false,
  bluechipGrade: "A",
  safetyGrade: "A",
  supplyUsd: 32_000_000_000,
  isBeta: true,
  profile: "treasury",
  recommendedSource: null,
  perInputStaleness: null,
};

describe("SelectorShortlistCard", () => {
  it("does not render raw why keys when prose is unavailable", () => {
    render(<SelectorShortlistCard rank={1} recommendation={baseRecommendation} profile="treasury" isMobile={false} />);

    expect(screen.getByText(/passed the selected profile filters/i)).toBeTruthy();
    expect(screen.queryByText(/top-safety/i)).toBeNull();
    expect(screen.queryByText(/strong-resilience/i)).toBeNull();
  });

  it("renders evidence chip accessible text as screen-reader content", () => {
    render(
      <SelectorShortlistCard
        rank={1}
        recommendation={baseRecommendation}
        profile="treasury"
        isMobile={false}
      />,
    );

    expect(screen.getByText("Safety grade A")).toBeTruthy();
    expect(screen.getByText("Resilience score 91 of 100")).toBeTruthy();
  });

  it("renders an expandable effective score breakdown", () => {
    render(
      <SelectorShortlistCard
        rank={1}
        recommendation={{
          ...baseRecommendation,
          components: [
            ...baseRecommendation.components,
            {
              key: "dewsInverted",
              weight: 0,
              rawValue: null,
              normalizedValue: null,
              contribution: 0,
              redistributed: true,
            },
          ],
        }}
        profile="treasury"
        isMobile={false}
      />,
    );

    expect(screen.getByText(/Score breakdown/i)).toBeTruthy();
    expect(screen.getByText(/effective per-coin weights/i)).toBeTruthy();
    // After the mono/tabular pass, numbers live in nested <span>s, so use
    // normalizer-aware matchers that flatten descendant text content.
    const breakdown = screen.getByText(/Score breakdown/i).closest("details") as HTMLElement;
    expect(breakdown.textContent).toMatch(/Weight\s*20\s*%/);
    expect(breakdown.textContent).toMatch(/Normalized\s*91/);
    expect(breakdown.textContent).toMatch(/\+18\.2\s*pts/);
    expect(breakdown.textContent).toMatch(/Redistributed/);
  });

  it("discloses yield rail risk and freshness", () => {
    render(
      <SelectorShortlistCard
        rank={1}
        recommendation={{
          ...baseRecommendation,
          profile: "yield",
          recommendedSource: {
            protocol: "Aave",
            chain: "Ethereum",
            apy30d: 5.4,
            pharosYieldScore: 82,
            sourceRiskTier: "mid",
            freshness: { capturedAt: 1_700_000_000_000, ageSeconds: 180 },
          },
          perInputStaleness: null,
        }}
        profile="yield"
        isMobile={false}
        yieldInspectionHref="/stablecoin/usdc-usd-coin/yield/"
      />,
    );

    expect(screen.getByText(/Source risk: mid/i)).toBeTruthy();
    expect(screen.getByText(/Data freshness: 3m old/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Inspect on Yield Intelligence/i }).getAttribute("href")).toBe(
      "/stablecoin/usdc-usd-coin/yield/",
    );
  });
});

describe("SelectorLowerRankedRow", () => {
  it("does not render raw reason keys when prose is unavailable", () => {
    const entry: SelectorLowerRanked = {
      id: "coin",
      symbol: "COIN",
      name: "Coin",
      slot: "A",
      reasonKey: "weak-liquidity",
      failedComponent: "liquidity",
      hypotheticalScore: 42,
    };

    render(<SelectorLowerRankedRow entry={entry} pegCurrency="USD" />);

    expect(screen.getByText(/COIN needs review/i)).toBeTruthy();
    expect(screen.getByText(/liquidity reading/i)).toBeTruthy();
    expect(screen.queryByText(/weak-liquidity/i)).toBeNull();
  });
});
