// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";

const useReportCardsV9Mock = vi.hoisted(() => vi.fn());
const useStablecoinsMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/api-hooks", () => ({
  useReportCardsV9: useReportCardsV9Mock,
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

vi.mock("@/hooks/use-logos", () => ({
  useLogos: () => ({ data: {} }),
}));

// The focused map is exercised in src/components/__tests__/contagion-graph.test.tsx;
// here we only assert that the snapshot hands it the right focus and edge set.
vi.mock("next/dynamic", () => ({
  default: () =>
    function ContagionGraphStub({
      focusCoinId,
      dependencyEdges,
    }: {
      focusCoinId?: string;
      dependencyEdges?: readonly unknown[];
    }) {
      return (
        <div data-testid="contagion-graph" data-focus={focusCoinId} data-edge-count={dependencyEdges?.length ?? 0} />
      );
    },
}));

vi.mock("@/components/stablecoin-detail/collateral-usage-section", () => ({
  CollateralUsageSection: ({ entries }: { entries: Array<{ coin: { id: string } }> }) => (
    <div data-testid="collateral-usage-mock">
      collateral-usage:{entries.map((entry) => entry.coin.id).join(",")}
    </div>
  ),
}));

import { ContagionSnapshot } from "../contagion-snapshot";

function makeDependencyResponse() {
  return makeReportCardsV9Response({
    cards: [
      makeV9Card({ id: "usdc-circle" }),
      makeV9Card({
        id: "usde-ethena",
        dependencies: {
          serial: [],
          basket: [
            {
              upstreamAssetId: "usdc-circle",
              weight: 0.8,
              score: 84,
              boundedUnknown: false,
            },
          ],
          cycleBlocked: false,
          reasonCodes: [],
        },
      }),
    ],
  });
}

describe("ContagionSnapshot", () => {
  beforeEach(() => {
    useReportCardsV9Mock.mockReset();
    useReportCardsV9Mock.mockReturnValue({
      data: makeDependencyResponse(),
      error: null,
      dataUpdatedAt: 1,
      refetch: vi.fn(),
    });
    useStablecoinsMock.mockReset();
    useStablecoinsMock.mockReturnValue({
      data: {
        peggedAssets: [
          { id: "usdc-circle", circulating: { peggedUSD: 60_000_000_000 } },
          { id: "usde-ethena", circulating: { peggedUSD: 5_000_000_000 } },
        ],
      },
      error: null,
      dataUpdatedAt: 1,
      refetch: vi.fn(),
    });
  });

  afterEach(cleanup);

  it("renders the focused dependency map for the current asset", () => {
    render(
      <ContagionSnapshot
        stablecoinId="usde-ethena"
        variantRelationshipCard={<div data-testid="variant-card">VARIANT</div>}
      />,
    );

    expect(screen.getByText("Dependency Context")).toBeTruthy();
    const graph = screen.getByTestId("contagion-graph");
    expect(graph.getAttribute("data-focus")).toBe("usde-ethena");
    expect(graph.getAttribute("data-edge-count")).toBe("1");
    expect(screen.getByTestId("variant-card").textContent).toBe("VARIANT");
  });

  it("renders collateral usage beside the dependency map", () => {
    render(
      <ContagionSnapshot
        stablecoinId="usdc-circle"
        hasCollateralUsage
        collateralUsageEntries={[
          {
            coin: { id: "usde-ethena", name: "Ethena USDe", symbol: "USDe" },
            weight: 0.8,
            type: "collateral",
          },
        ]}
      />,
    );

    expect(screen.getByTestId("contagion-graph").getAttribute("data-focus")).toBe("usdc-circle");
    expect(screen.getByTestId("collateral-usage-mock").textContent).toBe(
      "collateral-usage:usde-ethena",
    );
  });

  it("ignores edges whose counterparty is not a published V9 card", () => {
    useReportCardsV9Mock.mockReturnValue({
      data: makeReportCardsV9Response({
        cards: [
          makeV9Card({
            id: "usde-ethena",
            dependencies: {
              serial: [],
              basket: [
                {
                  upstreamAssetId: "untracked-coin",
                  weight: 0.8,
                  score: 84,
                  boundedUnknown: false,
                },
              ],
              cycleBlocked: false,
              reasonCodes: [],
            },
          }),
        ],
      }),
      error: null,
      dataUpdatedAt: 1,
      refetch: vi.fn(),
    });

    const { container } = render(<ContagionSnapshot stablecoinId="usde-ethena" />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null without dependencies, supplemental context, or an error", () => {
    useReportCardsV9Mock.mockReturnValue({
      data: makeReportCardsV9Response({ cards: [makeV9Card({ id: "usde-ethena" })] }),
      error: null,
      dataUpdatedAt: 1,
      refetch: vi.fn(),
    });

    const { container } = render(<ContagionSnapshot stablecoinId="usde-ethena" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an unavailable notice instead of falling back to V8", () => {
    useReportCardsV9Mock.mockReturnValue({
      data: undefined,
      error: new Error("V9 unavailable"),
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });

    render(<ContagionSnapshot stablecoinId="usde-ethena" />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Dependency graph data is temporarily unavailable",
    );
  });

  it("retains right-column context when V9 data is missing", () => {
    useReportCardsV9Mock.mockReturnValue({
      data: undefined,
      error: null,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });

    render(
      <ContagionSnapshot
        stablecoinId="usde-ethena"
        variantRelationshipCard={<div data-testid="variant-card">VARIANT</div>}
      />,
    );

    expect(screen.getByText("Dependency Context")).toBeTruthy();
    expect(screen.getByTestId("variant-card").textContent).toBe("VARIANT");
  });
});
