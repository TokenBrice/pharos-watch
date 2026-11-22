// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
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

const { useCoinStatesMock } = vi.hoisted(() => ({ useCoinStatesMock: vi.fn() }));
vi.mock("@/hooks/use-coin-states", () => ({ useCoinStates: useCoinStatesMock }));

vi.mock("@/components/dependency-watershed/dependency-map-basin-list", () => ({
  DependencyMapBasinList: ({ model }: { model: { hubs: readonly unknown[] } }) => (
    <div data-testid="mobile-summary">summary:{model.hubs.length}</div>
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
    dataUpdatedAt: data ? Date.now() : 0,
    refetch: vi.fn(),
  };
}

describe("DependencyMapClient", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/dependency-map/");
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 768px)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    mockUseDependencyGraph.mockReset();
    mockUseStablecoins.mockReset();
    useCoinStatesMock.mockReturnValue({ byId: new Map(), liveReady: true });

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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the graph visible when the market-cap endpoint fails", async () => {
    mockUseStablecoins.mockReturnValue({
      ...makeQueryResult(undefined),
      error: new Error("Stablecoins unavailable"),
    } as unknown as ReturnType<typeof useStablecoins>);
    render(<DependencyMapClient />);
    expect(await screen.findByRole("group", { name: /Dependency watershed/ })).toBeTruthy();
    expect(screen.getByText(/Market-cap data is unavailable/)).toBeTruthy();
    expect(screen.getByText("Supply data unavailable")).toBeTruthy();
    expect(screen.getByText(/Excludes 1 coins without supply data/)).toBeTruthy();
  });

  it("defaults desktop to Watershed and switches to Network on demand", async () => {
    render(<DependencyMapClient />);
    expect(screen.getByRole("group", { name: /Dependency watershed/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Watershed" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Network" }));
    expect(await screen.findByRole("figure", { name: /Dependency graph showing/ })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("view")).toBe("network");
  });

  it("feeds the live coin-state layer to the incidents list and the graph nodes", async () => {
    useCoinStatesMock.mockReturnValue({
      byId: new Map([["usdc-circle", [{ kind: "depeg", deviationBps: -150, ddrTier: null, ddrMethodologyVersion: null }]]]),
      liveReady: true,
    });
    render(<DependencyMapClient />);
    const incidents = screen.getByRole("region", { name: "Live incidents upstream" });
    expect(within(incidents).getByRole("listitem").textContent).toMatch(/USD Coin.*Depeg.*below peg/);
    fireEvent.click(screen.getByRole("button", { name: "Network" }));
    expect(await screen.findByRole("button", { name: /^USDC, .*Depeg/ })).toBeTruthy();
  });

  it("does not turn a first supply read in flight into an unavailable claim", () => {
    mockUseStablecoins.mockReturnValue({
      ...makeQueryResult(undefined),
      isLoading: true,
    } as unknown as ReturnType<typeof useStablecoins>);
    render(<DependencyMapClient />);
    // The summary renders before the dynamically imported graph resolves.
    expect(screen.getByText("Mapped direct exposure").nextElementSibling?.textContent).toBe("—");
    expect(screen.queryByText("Supply data unavailable")).toBeNull();
    expect(screen.queryByText(/market cap as of unknown/)).toBeNull();
    expect(screen.queryByText(/Excludes 1 coins without supply data/)).toBeNull();
  });

  it("retains supply sizes and its as-of clock through a failed stablecoins refetch", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const graph = mockUseDependencyGraph()!.data as { updatedAt: number };
    graph.updatedAt = nowSec - 60;
    const supply = mockUseStablecoins()!.data;
    const meta = { updatedAt: nowSec - 120, ageSeconds: 120, status: "fresh" as const };
    mockUseStablecoins.mockReturnValue({ ...makeQueryResult(supply), meta, dataUpdatedAt: Date.now() } as unknown as ReturnType<typeof useStablecoins>);
    const view = render(<DependencyMapClient />);
    await screen.findByRole("group", { name: /Dependency watershed/ });
    const asOf = screen.getByText(/^market cap as of /).textContent;
    expect(asOf).not.toContain("unknown");

    mockUseStablecoins.mockReturnValue({
      ...makeQueryResult(supply), meta, dataUpdatedAt: Date.now(), error: new Error("Stablecoins unavailable"),
    } as unknown as ReturnType<typeof useStablecoins>);
    view.rerender(<DependencyMapClient />);
    expect(screen.getByText(/^market cap as of /).textContent).toBe(asOf);
    expect(screen.queryByText(/Market-cap data is unavailable/)).toBeNull();
    expect(screen.queryByText("Supply data unavailable")).toBeNull();
    // A mild failed refresh over retained data is operator signal (ADR-42).
    expect(screen.queryByText("Showing an older snapshot")).toBeNull();
    expect(screen.queryByText("Refresh failed")).toBeNull();
  });

  it("warns through the shared banner once the retained graph passes its stale band", async () => {
    const graph = mockUseDependencyGraph()!.data as { updatedAt: number };
    graph.updatedAt = Math.floor(Date.now() / 1000) - 400 * 86_400;
    render(<DependencyMapClient />);
    await screen.findByRole("group", { name: /Dependency watershed/ });
    expect(await screen.findByText("Showing an older snapshot")).toBeTruthy();
  });

  it("keeps held publication off the page and retains unpublished v5 coverage and supply facts", async () => {
    const full = makeReportCardsV9Response({ cards: [makeV9Card({ id: "usdc-circle", supply: undefined, dependencyCoverage: undefined }), makeV9Card({ id: "dai-makerdao", supply: undefined, dependencyCoverage: undefined })],
      dependencyGraph: { edges: [{ from: "usdc-circle", to: "dai-makerdao", kind: "basket", materiality: "basket-weighted", weight: 0.4, upstreamScore: 80 }] } });
    full.publicationHealth.status = "held";
    full.publicationHealth.heldSinceSec = 1790710000;
    const slim = projectDependencyGraph(full);
    expect(slim.nodes.every(node => node.circulatingUsdAtEvaluation === null && node.supplyAsOfSec === null && node.dependencyCoverageCount === null)).toBe(true);
    mockUseDependencyGraph.mockReturnValue(makeQueryResult(slim) as unknown as ReturnType<typeof useDependencyGraph>);
    render(<DependencyMapClient />);
    await screen.findByRole("group", { name: /Dependency watershed/ });
    expect(screen.queryByText(/Ratings are held at the last verified snapshot/)).toBeNull();
    expect(screen.getByText(/Not published for this generation/)).toBeTruthy();
    expect(screen.getByRole("group", { name: /Dependency watershed/ })).toBeTruthy();
  });
});
