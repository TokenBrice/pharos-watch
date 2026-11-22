// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { CLIENT_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { DEX_GLOBAL_KEY, type DexLiquidityMap } from "@shared/types/dex-liquidity";
import type { StablecoinData } from "@shared/types/supply";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import { LiquidityClient } from "./client";

const response = vi.hoisted(() => ({
  data: {} as DexLiquidityMap,
  peggedAssets: [] as StablecoinData[],
}));
vi.mock("@/hooks/api-hooks", () => ({
  useDexLiquidity: () => ({ data: response.data, isLoading: false, error: null, dataUpdatedAt: 0, refetch: vi.fn(), meta: null }),
}));
vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: () => ({
    data: { peggedAssets: response.peggedAssets },
    isLoading: false,
    error: null,
    dataUpdatedAt: 0,
    refetch: vi.fn(),
    meta: null,
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", async () => {
  // The mock factory is hoisted, so the shared Link helper cannot be a static import.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

const renderClient = () => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><LiquidityClient /></QueryClientProvider>);

describe("LiquidityClient evidence cohorts", () => {
  it.each([false, true])("keeps positive-pool quarantine unavailable with no-market cohort present=%s", (includeUnobserved) => {
    const [observedNr, quarantined, unobserved] = CLIENT_ACTIVE_STABLECOINS;
    response.data = {
      [observedNr.id]: makeDexLiquidityData({
        totalTvlUsd: 100, poolCount: 1, coverageClass: "primary", liquidityEvidenceClass: "measured",
        liquidityScoreUnavailableReason: "activity-missing",
      }),
      [quarantined.id]: makeDexLiquidityData({
        totalTvlUsd: 987_654_321, poolCount: 8, coverageClass: null, liquidityEvidenceClass: null,
        unavailableReason: "invalid-coverage-evidence", liquidityScoreUnavailableReason: "invalid-coverage-evidence",
      }),
      ...(includeUnobserved ? {
        [unobserved.id]: makeDexLiquidityData({ liquidityScoreUnavailableReason: "no-retained-pools" }),
      } : {}),
    };
    const root = document.createElement("div");
    root.innerHTML = renderClient();
    const unavailable = root.querySelector("#unavailable");
    expect(unavailable?.querySelector("summary")?.textContent).toMatch(/DEX evidence unavailable/);
    expect(unavailable?.querySelector("li")?.getAttribute("data-unavailable-reason")).toBe("invalid-coverage-evidence");
    expect(unavailable?.querySelector("a")?.getAttribute("href")).toBe(buildStablecoinUrl(quarantined.id));
    expect(unavailable?.textContent).not.toMatch(/no retained|not observed|987/);
    // TableSurface exposes the shared table identity as data-table-id, not id.
    const table = root.querySelector('[data-table-id="liquidity-leaderboard"]');
    expect(table).not.toBeNull();
    const observedRow = within(table as HTMLElement).getByRole("link", { name: `Open ${observedNr.symbol} liquidity detail` }).closest("tr")!;
    expect(observedRow.querySelector('[data-reason-code="activity-missing"]')).not.toBeNull();
    expect(within(table as HTMLElement).queryByRole("link", { name: `Open ${quarantined.symbol} liquidity detail` })).toBeNull();
    const noMarket = root.querySelector("#unrated");
    if (includeUnobserved) {
      expect(noMarket?.querySelectorAll("li")).toHaveLength(1);
      expect(noMarket?.querySelector("a")?.getAttribute("href")).toBe(buildStablecoinUrl(unobserved.id));
    } else {
      expect(noMarket).toBeNull();
    }
  });
});

describe("LiquidityClient pool quality fold", () => {
  it("labels the TVL-weighted base-yield share and its map threshold", () => {
    const [coin] = CLIENT_ACTIVE_STABLECOINS;
    response.data = { [coin.id]: makeDexLiquidityData({ totalTvlUsd: 100, poolCount: 1, coverageClass: "primary", liquidityEvidenceClass: "measured" }) };
    const html = renderClient();
    const text = (html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
    expect(text).toContain("Base-yield share, TVL-weighted");
    expect(text).toContain(
      "On the map, rails turn dashed when pool balance is under 70% and flow lines turn dashed when base-yield share is under 60%. Durability is scored per coin; see the Durability column in the leaderboard.",
    );
    expect(text).not.toMatch(/Organic liquidity, fee-based/);
  });
});

describe("LiquidityClient bidirectional route filtering and triage", () => {
  it("filters the table when clicking an exit route door and clears via the active route chip", () => {
    const [curveCoin, fluidCoin] = CLIENT_ACTIVE_STABLECOINS;
    response.peggedAssets = [];
    response.data = {
      [DEX_GLOBAL_KEY]: makeDexLiquidityData({
        totalTvlUsd: 10_000,
        protocolTvl: { curve: 6_000, fluid: 4_000 },
        chainTvl: { ethereum: 10_000 },
        poolCount: 4,
      }),
      [curveCoin.id]: makeDexLiquidityData({
        totalTvlUsd: 6_000,
        liquidityScore: 80,
        protocolTvl: { curve: 6_000 },
        chainTvl: { ethereum: 6_000 },
      }),
      [fluidCoin.id]: makeDexLiquidityData({
        totalTvlUsd: 4_000,
        liquidityScore: 30,
        protocolTvl: { fluid: 4_000 },
        chainTvl: { ethereum: 4_000 },
      }),
    };

    render(<QueryClientProvider client={new QueryClient()}><LiquidityClient /></QueryClientProvider>);

    fireEvent.click(screen.getByTestId("protocol-door-curve"));
    const chip = screen.getByTestId("active-route-filter-chip");
    expect(chip.textContent).toContain("Curve");
    expect(screen.getByRole("link", { name: `Open ${curveCoin.symbol} liquidity detail` })).toBeTruthy();
    expect(screen.queryByRole("link", { name: `Open ${fluidCoin.symbol} liquidity detail` })).toBeNull();

    fireEvent.click(chip);
    expect(screen.queryByTestId("active-route-filter-chip")).toBeNull();
    expect(screen.getByRole("link", { name: `Open ${fluidCoin.symbol} liquidity detail` })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Thin exit" }));
    expect(screen.getByRole("link", { name: `Open ${fluidCoin.symbol} liquidity detail` })).toBeTruthy();
    expect(screen.queryByRole("link", { name: `Open ${curveCoin.symbol} liquidity detail` })).toBeNull();
  });
});
