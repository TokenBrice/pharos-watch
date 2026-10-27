// @vitest-environment jsdom
import { createElement } from "react";
import { within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { CLIENT_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { DexLiquidityMap } from "@shared/types";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import { LiquidityClient } from "./client";

const response = vi.hoisted(() => ({ data: {} as DexLiquidityMap }));
vi.mock("@/hooks/api-hooks", () => ({
  useDexLiquidity: () => ({ data: response.data, isLoading: false, error: null, dataUpdatedAt: 0, refetch: vi.fn(), meta: null }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", async () => {
  // The mock factory is hoisted, so the shared Link helper cannot be a static import.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

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
    root.innerHTML = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(LiquidityClient)));
    const unavailable = root.querySelector("#unavailable");
    expect(unavailable?.querySelector("summary")?.textContent).toMatch(/DEX evidence unavailable/);
    expect(unavailable?.querySelector("li")?.getAttribute("data-unavailable-reason")).toBe("invalid-coverage-evidence");
    expect(unavailable?.querySelector("a")?.getAttribute("href")).toBe(buildStablecoinUrl(quarantined.id));
    expect(unavailable?.textContent).not.toMatch(/no retained|not observed|987/);
    // TableSurface exposes the shared table identity as data-table-id, not id.
    const table = root.querySelector('[data-table-id="liquidity-leaderboard"]');
    expect(table).not.toBeNull();
    // Leaderboard navigation is owned by the accessible link-role row.
    const observedRow = within(table as HTMLElement).getByRole("link", { name: `Open ${observedNr.symbol} liquidity detail` });
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
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(LiquidityClient)));
    const text = (html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
    expect(text).toContain("Base-yield share, TVL-weighted");
    expect(text).toContain(
      "On the map, rails turn dashed when pool balance is under 70% and flow lines turn dashed when base-yield share is under 60%. Durability is scored per coin; see the Durability column in the leaderboard.",
    );
    expect(text).not.toMatch(/Organic liquidity, fee-based/);
  });
});
