// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChainsLeaderboardClient } from "./client";
import { makeChain } from "@/hooks/__tests__/chain-profile-fixtures";
import { formatCompactUsd } from "@shared/lib/format";

const { useChainsMock } = vi.hoisted(() => ({ useChainsMock: vi.fn() }));
vi.mock("@/hooks/use-chains", () => ({ useChains: useChainsMock }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./nautical-chart", () => ({ NauticalChart: () => null }));
vi.mock("./selected-harbor-panel", () => ({ SelectedHarborPanel: () => null }));
vi.mock("./dominance-breakdown", () => ({ DominanceBreakdown: () => null }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("ChainsLeaderboardClient", () => {
  it("labels excluded-input global and chain totals as partial without recomputing them", () => {
    useChainsMock.mockReturnValue({
      data: {
        chains: [makeChain({ totalUsd: 123_000_000, unavailableSupplyObservationCount: 2 })],
        globalTotalUsd: 456_000_000,
        globalChange7dPct: null,
        supplyCoverage: { aggregateUnavailableAssetCount: 3, chainUnavailableObservationCount: 4,
          chainIdsWithUnavailableObservations: ["ethereum", "tron"] },
      },
      isLoading: false, isError: false, error: null, refetch: vi.fn(), dataUpdatedAt: 0, meta: null,
    });
    render(<ChainsLeaderboardClient />);
    expect(screen.getByText("Partial Stablecoin Supply")).toBeTruthy();
    expect(screen.getByText(/3 assets excluded from global supply/).textContent).toContain("4 unavailable chain observations");
    expect(screen.getByText(/Partial · 2 unavailable/)).toBeTruthy();
    expect(screen.getByText(formatCompactUsd(456_000_000))).toBeTruthy();
    expect(screen.getByText(formatCompactUsd(123_000_000))).toBeTruthy();
  });
});
