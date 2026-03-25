// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StablecoinTable } from "@/components/stablecoin-table";
import type { ReportCard, StablecoinData } from "@shared/types";

const push = vi.fn();

vi.mock("@/components/table-toolbar", () => ({
  TableToolbar: () => <div data-testid="table-toolbar" />,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [{ index: 0, start: 0, end: 40 }],
    getTotalSize: () => 40,
  }),
}));

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));

const coin = {
  id: "usdt-tether",
  name: "Tether",
  symbol: "USDT",
  pegType: "peggedUSD",
  price: 1,
  circulating: { peggedUSD: 100_000_000 },
  circulatingPrevDay: { peggedUSD: 99_000_000 },
  circulatingPrevWeek: { peggedUSD: 98_000_000 },
  circulatingPrevMonth: { peggedUSD: 97_000_000 },
  chainCirculating: {},
  chains: ["Ethereum"],
} as unknown as StablecoinData;

const reportCard = {
  id: "usdt-tether",
  name: "Tether",
  symbol: "USDT",
  overallGrade: "B+",
  overallScore: 80,
  baseScore: 80,
  dimensions: {
    pegStability: { grade: "A", score: 95, detail: "ok" },
    liquidity: { grade: "B+", score: 82, detail: "ok" },
    resilience: { grade: "B", score: 72, detail: "ok" },
    decentralization: { grade: "C", score: 55, detail: "ok" },
    dependencyRisk: { grade: "B", score: 74, detail: "ok" },
  },
  ratedDimensions: 5,
  rawInputs: {
    pegScore: 95,
    activeDepeg: false,
    depegEventCount: 0,
    lastEventAt: null,
    liquidityScore: 89,
    effectiveExitScore: 89,
    redemptionBackstopScore: null,
    redemptionRouteFamily: null,
    redemptionModelConfidence: null,
    redemptionUsedForLiquidity: false,
    redemptionImmediateCapacityUsd: null,
    redemptionImmediateCapacityRatio: null,
    concentrationHhi: 0.1,
    bluechipGrade: null,
    canBeBlacklisted: true,
    chainTier: "ethereum",
    deploymentModel: "multi-chain",
    collateralQuality: "cash",
    custodyModel: "institutional-regulated",
    governanceTier: "centralized",
    governanceQuality: "single-entity",
    dependencies: [],
    navToken: false,
    collateralFromLive: false,
  },
  isDefunct: false,
} as const satisfies ReportCard;

describe("StablecoinTable", () => {
  beforeEach(() => {
    localStorage.clear();
    push.mockReset();
  });

  it("normalizes persisted column visibility from localStorage", () => {
    localStorage.setItem("pharos-table-columns", JSON.stringify(["mcap", "bogus"]));

    render(
      <StablecoinTable
        data={[coin]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
      />,
    );

    expect(screen.getByText("Market Cap")).toBeTruthy();
    expect(screen.queryByText("Price")).toBeNull();
  });

  it("keeps horizontal scrolling enabled on the table viewport", () => {
    render(
      <StablecoinTable
        data={[coin]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
      />,
    );

    const table = screen.getAllByRole("table")[0];
    const scrollContainer = table?.parentElement;

    expect(scrollContainer?.className).toContain("overflow-x-auto");
    expect(scrollContainer?.className).not.toContain("overflow-x-hidden");
    expect(scrollContainer?.className).not.toContain("xl:overflow-x-hidden");
  });

  it("renders the blacklistable column when enabled", () => {
    localStorage.setItem("pharos-table-columns", JSON.stringify(["mcap", "blacklistable"]));

    render(
      <StablecoinTable
        data={[coin]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
        reportCards={{ [coin.id]: reportCard }}
      />,
    );

    expect(screen.getAllByText("Blacklistable").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Yes").length).toBeGreaterThan(0);
  });
});
