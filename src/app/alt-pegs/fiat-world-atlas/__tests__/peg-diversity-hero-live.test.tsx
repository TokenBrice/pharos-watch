// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { StablecoinData } from "@shared/types";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { useStablecoins } from "@/hooks/use-stablecoins";
import type { PegCluster, ShelfGroup } from "@/lib/alt-peg-hero";
import { PegDiversityHeroLive } from "@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live";

vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: vi.fn() }));

vi.mock("@/app/alt-pegs/fiat-world-atlas/fiat-emblems", () => ({
  FiatEmblems: ({ clusters }: { clusters: readonly PegCluster[] }) => (
    <ul data-testid="emblems">
      {clusters.flatMap((cluster) => cluster.coins).map((coin) => (
        <li key={coin.id} data-id={coin.id}>{coin.marketCap === null ? "unavailable" : String(coin.marketCap)}</li>
      ))}
    </ul>
  ),
}));

vi.mock("@/app/alt-pegs/fiat-world-atlas/off-map-shelf", () => ({
  OffMapShelf: ({ groups }: { groups: readonly ShelfGroup[] }) => (
    <ul data-testid="shelf">
      {groups.flatMap((group) => group.coins).map((coin) => <li key={coin.id} data-id={coin.id} />)}
    </ul>
  ),
}));

const mockUseStablecoins = vi.mocked(useStablecoins);
const UNAVAILABLE = "Live coin layer unavailable; the ranking and table below still list every peg.";

const assets: StablecoinData[] = [
  makeStablecoin({ id: "eurc-circle", pegType: "peggedEUR", priceSource: "defillama", circulating: { peggedEUR: 430_000_000 } }),
  // Observed zero stays a numeric mark.
  makeStablecoin({ id: "eurs-stasis", pegType: "peggedEUR", priceSource: "defillama", circulating: { peggedEUR: 0 } }),
];

function mockQuery(overrides: {
  data?: { peggedAssets: StablecoinData[] };
  isLoading?: boolean;
  error?: Error | null;
  updatedAt?: number;
}) {
  const now = Date.now();
  mockUseStablecoins.mockReturnValue({
    data: overrides.data,
    isLoading: overrides.isLoading ?? false,
    isError: !!overrides.error,
    error: overrides.error ?? null,
    dataUpdatedAt: overrides.data ? now : 0,
    meta: overrides.data
      ? { updatedAt: overrides.updatedAt ?? Math.floor(now / 1000), ageSeconds: 0, status: "fresh" }
      : null,
  } as unknown as ReturnType<typeof useStablecoins>);
}

function emblemValues(): string[] {
  return Array.from(screen.getByTestId("emblems").querySelectorAll("li")).map((li) => `${li.dataset.id}:${li.textContent}`);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe.each(["default", "fullscreen"] as const)("PegDiversityHeroLive (%s)", (variant) => {
  it("keeps retained positions through a failed refresh without the unavailable overlay", () => {
    mockQuery({ data: { peggedAssets: assets } });
    const view = render(<PegDiversityHeroLive worldMap={null} variant={variant} />);
    const before = emblemValues();
    expect(before).toContain("eurc-circle:430000000");
    expect(before).toContain("eurs-stasis:0");
    expect(screen.queryByRole("status")).toBeNull();

    mockQuery({ data: { peggedAssets: assets }, error: new Error("Offline") });
    view.rerender(<PegDiversityHeroLive worldMap={null} variant={variant} />);
    expect(emblemValues()).toEqual(before);
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    // A mild failed refresh is operator signal (ADR-42).
    expect(screen.queryByText("Showing an older snapshot")).toBeNull();
  });

  it("keeps registry marks with unavailable supply when the asset is omitted", () => {
    mockQuery({ data: { peggedAssets: [assets[0]] }, error: new Error("Offline") });
    render(<PegDiversityHeroLive worldMap={null} variant={variant} />);
    expect(emblemValues()).toContain("eurc-circle:430000000");
    expect(emblemValues()).toContain("eurs-stasis:unavailable");
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  it("is honest while loading and after an initial failure with nothing retained", () => {
    mockQuery({ isLoading: true });
    const view = render(<PegDiversityHeroLive worldMap={null} variant={variant} />);
    expect(screen.getByRole("status").textContent).toBe("Loading live coin positions.");

    mockQuery({ error: new Error("Offline") });
    view.rerender(<PegDiversityHeroLive worldMap={null} variant={variant} />);
    expect(screen.getByRole("status").textContent).toBe(UNAVAILABLE);
    expect(screen.queryByText("Refresh failed")).toBeNull();
  });

  it("names material staleness inside the dialog only", () => {
    const staleSec = Math.floor(Date.now() / 1000)
      - (FRESHNESS_RATIOS.DEGRADED + 1) * API_FRESHNESS_MAX_AGE_SEC.stablecoins;
    mockQuery({ data: { peggedAssets: assets }, error: new Error("Offline"), updatedAt: staleSec });
    render(<PegDiversityHeroLive worldMap={null} variant={variant} />);
    expect(screen.queryByText("Showing an older snapshot") !== null).toBe(variant === "fullscreen");
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });
});
