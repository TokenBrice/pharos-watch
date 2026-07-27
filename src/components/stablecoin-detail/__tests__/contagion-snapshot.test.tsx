// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";

const useReportCardsV9Mock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/api-hooks", () => ({
  useReportCardsV9: useReportCardsV9Mock,
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
  });

  afterEach(cleanup);

  it("renders native V9 dependency materiality and weight", () => {
    render(
      <ContagionSnapshot
        stablecoinId="usde-ethena"
        variantRelationshipCard={<div data-testid="variant-card">VARIANT</div>}
      />,
    );

    expect(screen.getByText("Dependency Context")).toBeTruthy();
    expect(screen.getByText(/upstream dependency · basket weighted · 80%/)).toBeTruthy();
    expect(screen.getByTestId("variant-card").textContent).toBe("VARIANT");
  });

  it("renders collateral usage beside V9 dependencies", () => {
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

    expect(screen.getByText(/depends on this asset · basket weighted · 80%/)).toBeTruthy();
    expect(screen.getByTestId("collateral-usage-mock").textContent).toBe(
      "collateral-usage:usde-ethena",
    );
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
