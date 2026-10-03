// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { useDependencyGraph } from "@/hooks/use-dependency-graph";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { projectDependencyGraph } from "@shared/types/dependency-graph";

vi.mock("@/hooks/use-dependency-graph", () => ({
  useDependencyGraph: vi.fn(),
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: vi.fn(),
}));

vi.mock("@/components/dependency-map-mobile-summary", () => ({
  DependencyMapMobileSummary: ({ model }: { model: { hubs: readonly unknown[] } }) => (
    <div data-testid="mobile-summary">summary:{model.hubs.length}</div>
  ),
}));

vi.mock("./dependency-hubs-board", () => ({
  DependencyHubsBoard: ({ model }: { model: { hubs: readonly unknown[] } }) => (
    <div data-testid="dependency-hubs-board">board:{model.hubs.length}</div>
  ),
}));

const { DependencyMapClient } = await import("@/app/dependency-map/client");

const mockUseDependencyGraph = vi.mocked(useDependencyGraph);
const mockUseStablecoins = vi.mocked(useStablecoins);

function makeQueryResult(data: unknown) {
  return {
    data,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
}

afterEach(cleanup);
describe("DependencyMapClient", () => {
  beforeEach(() => {
    mockUseDependencyGraph.mockReset();
    mockUseStablecoins.mockReset();

    mockUseDependencyGraph.mockReturnValue(
      makeQueryResult(projectDependencyGraph(makeReportCardsV9Response({
        cards: [
          makeV9Card({ id: "usdc-circle" }),
          makeV9Card({ id: "usdt-tether" }),
          makeV9Card({
            id: "dai-makerdao",
            dependencies: {
              serial: [],
              basket: [
                { upstreamAssetId: "usdc-circle", weight: 0.4, score: 84, boundedUnknown: false, ratingStatus: "rated", partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [] },
              ],
              cycleBlocked: false,
              reasonCodes: [],
            },
          }),
        ],
      }))) as unknown as ReturnType<typeof useDependencyGraph>,
    );
    mockUseStablecoins.mockReturnValue(
      makeQueryResult({
        peggedAssets: [
          { id: "usdc-circle", circulating: { usd: 77_700_000_000 } },
          { id: "usdt-tether", circulating: { usd: 143_000_000_000 } },
          { id: "dai-makerdao", circulating: { usd: 5_300_000_000 } },
        ],
      }) as unknown as ReturnType<typeof useStablecoins>,
    );
  });

  it("renders the dependency graph alongside the V9 hub summaries", () => {
    render(<DependencyMapClient />);

    expect(screen.getByRole("figure", { name: /Dependency graph showing/ })).toBeTruthy();
    // Only the two dependency-linked cards enter the map; the isolated one is pruned.
    expect(screen.getAllByRole("button", { name: /market cap/i })).toHaveLength(2);
    expect(screen.getByTestId("dependency-hubs-board")).toBeTruthy();
    expect(screen.getByTestId("mobile-summary")).toBeTruthy();
  });

  it("keeps the graph visible when the market-cap endpoint fails", () => {
    mockUseStablecoins.mockReturnValue({
      ...makeQueryResult(undefined),
      error: new Error("Stablecoins unavailable"),
    } as unknown as ReturnType<typeof useStablecoins>);
    render(<DependencyMapClient />);
    expect(screen.getByRole("figure", { name: /Dependency graph showing/ })).toBeTruthy();
    expect(screen.getByText(/Market-cap data is unavailable/)).toBeTruthy();
    expect(screen.getByText("Supply data unavailable")).toBeTruthy();
    expect(screen.getByText(/Excludes 1 coins without supply data/)).toBeTruthy();
  });

  it("renders the V9 graph while market-cap data is still loading", () => {
    mockUseStablecoins.mockReturnValue({
      ...makeQueryResult(undefined),
      isLoading: true,
    } as unknown as ReturnType<typeof useStablecoins>);
    render(<DependencyMapClient />);
    expect(screen.getByRole("figure", { name: /Dependency graph showing/ })).toBeTruthy();
  });

  it("retains the held notice and unpublished v5 coverage and supply facts", () => {
    const full = makeReportCardsV9Response({ cards: [makeV9Card({ id: "usdc-circle", supply: undefined, dependencyCoverage: undefined }), makeV9Card({ id: "dai-makerdao", supply: undefined, dependencyCoverage: undefined })],
      dependencyGraph: { edges: [{ from: "usdc-circle", to: "dai-makerdao", kind: "basket", materiality: "basket-weighted", weight: 0.4, upstreamScore: 80 }] } });
    full.publicationHealth.status = "held";
    full.publicationHealth.heldSinceSec = 1790710000;
    const slim = projectDependencyGraph(full);
    expect(slim.nodes.every(node => node.circulatingUsdAtEvaluation === null && node.supplyAsOfSec === null && node.dependencyCoverageCount === null)).toBe(true);
    mockUseDependencyGraph.mockReturnValue(makeQueryResult(slim) as unknown as ReturnType<typeof useDependencyGraph>);
    render(<DependencyMapClient />);
    expect(screen.getByRole("status").textContent).toContain("Ratings are held at the last verified snapshot");
    expect(screen.getByText(/Not published for this generation/)).toBeTruthy();
    expect(screen.getByRole("figure", { name: /Dependency graph showing/ })).toBeTruthy();
  });
});
