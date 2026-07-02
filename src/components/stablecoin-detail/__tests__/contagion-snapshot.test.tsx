// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCard } from "@/test/fixtures/safety-scores";
import type { ReportCard, ReportCardGrade, ReportCardsResponse } from "@shared/types";

interface ContagionGraphMockProps {
  cards: ReportCard[];
  dependencyEdges?: ReportCardsResponse["dependencyGraph"]["edges"];
  mcapMap: Map<string, number>;
  focusCoinId?: string;
}

const { useReportCardsMock, useStablecoinsMock, useLogosMock, contagionGraphMock } = vi.hoisted(() => ({
  useReportCardsMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
  useLogosMock: vi.fn(),
  contagionGraphMock: vi.fn<(props: ContagionGraphMockProps) => void>(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useReportCards: useReportCardsMock,
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

vi.mock("@/hooks/use-logos", () => ({
  useLogos: useLogosMock,
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockDynamicContagionGraph(props: ContagionGraphMockProps) {
      const { focusCoinId } = props;
      contagionGraphMock(props);
      return <div data-testid="contagion-graph-mock">graph:{focusCoinId}</div>;
    },
}));

vi.mock("@/components/contagion-graph", () => ({
  ContagionGraph: ({ focusCoinId }: { focusCoinId?: string }) => (
    <div data-testid="contagion-graph-mock">graph:{focusCoinId}</div>
  ),
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  MethodologyTriggerButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/stablecoin-detail/collateral-usage-section", () => ({
  CollateralUsageSection: ({ entries }: { entries: Array<{ coin: { id: string } }> }) => (
    <div data-testid="collateral-usage-mock">collateral-usage:{entries.map((entry) => entry.coin.id).join(",")}</div>
  ),
}));

import { ContagionSnapshot } from "../contagion-snapshot";

const DIMENSION_STUB = { grade: "B" as ReportCardGrade, score: 70, detail: "" };
const RAW_INPUTS_STUB: ReportCard["rawInputs"] = {
  pegScore: 95,
  activeDepeg: false,
  activeDepegBps: null,
  depegEventCount: 0,
  lastEventAt: null,
  liquidityScore: 60,
  effectiveExitScore: null,
  redemptionBackstopScore: null,
  redemptionRouteFamily: null,
  redemptionModelConfidence: null,
  redemptionUsedForLiquidity: false,
  redemptionImmediateCapacityUsd: null,
  redemptionImmediateCapacityRatio: null,
  concentrationHhi: null,
  bluechipGrade: null,
  canBeBlacklisted: false,
  chainTier: "ethereum",
  deploymentModel: "native-multichain",
  collateralQuality: "rwa",
  custodyModel: "institutional-regulated",
  governanceTier: "centralized",
  governanceQuality: "regulated-entity",
  dependencies: [],
  navToken: false,
  collateralFromLive: false,
};

function makeCard(id: string, symbol: string): ReportCard {
  return makeReportCard({
    id,
    name: symbol,
    symbol,
    overallGrade: "B",
    overallScore: 70,
    baseScore: 70,
    ratedDimensions: 5,
    dimensions: {
      pegStability: DIMENSION_STUB,
      liquidity: DIMENSION_STUB,
      resilience: DIMENSION_STUB,
      decentralization: DIMENSION_STUB,
      dependencyRisk: DIMENSION_STUB,
    },
    rawInputs: RAW_INPUTS_STUB,
  });
}

function makeReportCardsResponse(
  cards: ReportCard[],
  edges: ReportCardsResponse["dependencyGraph"]["edges"] = [],
): { cards: ReportCard[]; dependencyGraph: { edges: typeof edges } } {
  return {
    cards,
    dependencyGraph: { edges },
  };
}

const STABLECOINS_PAYLOAD = {
  peggedAssets: [
    { id: "usde-ethena", circulating: { peggedUSD: 5_000_000_000 }, chains: ["ethereum"] },
    { id: "usdtb-ethena", circulating: { peggedUSD: 2_000_000_000 }, chains: ["ethereum"] },
    { id: "usdc-circle", circulating: { peggedUSD: 60_000_000_000 }, chains: ["ethereum"] },
  ],
};

function getGraphCall(index: number): ContagionGraphMockProps {
  const props = contagionGraphMock.mock.calls[index]?.[0];
  if (!props) {
    throw new Error(`Missing contagion graph render ${index}`);
  }
  return props;
}

describe("ContagionSnapshot", () => {
  beforeEach(() => {
    useReportCardsMock.mockReset();
    useStablecoinsMock.mockReset();
    useLogosMock.mockReset();
    contagionGraphMock.mockReset();
    useStablecoinsMock.mockReturnValue({ data: STABLECOINS_PAYLOAD });
    useLogosMock.mockReturnValue({ data: {} });
  });

  afterEach(cleanup);

  it("renders the variantRelationshipCard prop and the contagion graph chrome when edges exist", () => {
    useReportCardsMock.mockReturnValue({
      data: makeReportCardsResponse(
        [makeCard("usde-ethena", "USDe"), makeCard("usdc-circle", "USDC")],
        [{ from: "usde-ethena", to: "usdc-circle", weight: 0.8, type: "collateral" }],
      ),
    });

    render(
      <ContagionSnapshot
        stablecoinId="usde-ethena"
        variantRelationshipCard={<div data-testid="variant-card">VARIANT</div>}
      />,
    );

    expect(screen.getByText("Dependency Context")).toBeTruthy();
    expect(screen.getByTestId("variant-card").textContent).toBe("VARIANT");
    expect(screen.getByTestId("contagion-graph-mock").textContent).toBe("graph:usde-ethena");
    // No collateral-usage card when the prop is not set.
    expect(screen.queryByTestId("collateral-usage-mock")).toBeNull();
  });

  it("honors hasCollateralUsage by rendering the CollateralUsageSection", () => {
    useReportCardsMock.mockReturnValue({
      data: makeReportCardsResponse(
        [makeCard("usde-ethena", "USDe"), makeCard("usdc-circle", "USDC")],
        [{ from: "usde-ethena", to: "usdc-circle", weight: 0.8, type: "collateral" }],
      ),
    });

    render(
      <ContagionSnapshot
        stablecoinId="usdc-circle"
        hasCollateralUsage
        collateralUsageEntries={[
          { coin: { id: "usde-ethena", name: "Ethena USDe", symbol: "USDe" }, weight: 0.8, type: "collateral" },
        ]}
      />,
    );

    expect(screen.getByTestId("collateral-usage-mock").textContent).toBe("collateral-usage:usde-ethena");
    expect(screen.getByTestId("contagion-graph-mock")).toBeTruthy();
  });

  it("keeps derived graph inputs stable across unrelated rerenders", () => {
    const reportCards = makeReportCardsResponse(
      [makeCard("usde-ethena", "USDe"), makeCard("usdc-circle", "USDC")],
      [{ from: "usde-ethena", to: "usdc-circle", weight: 0.8, type: "collateral" }],
    );
    useReportCardsMock.mockReturnValue({ data: reportCards });

    const { rerender } = render(
      <ContagionSnapshot
        stablecoinId="usde-ethena"
        variantRelationshipCard={<div data-testid="variant-card">VARIANT</div>}
      />,
    );
    const firstProps = getGraphCall(0);

    rerender(
      <ContagionSnapshot
        stablecoinId="usde-ethena"
        variantRelationshipCard={<div data-testid="variant-card">UPDATED</div>}
      />,
    );
    const secondProps = getGraphCall(1);

    expect(contagionGraphMock).toHaveBeenCalledTimes(2);
    expect(secondProps.cards).toBe(firstProps.cards);
    expect(secondProps.dependencyEdges).toBe(firstProps.dependencyEdges);
    expect(secondProps.mcapMap).toBe(firstProps.mcapMap);
    expect(secondProps.mcapMap.get("usdc-circle")).toBe(60_000_000_000);
  });

  it("returns null when no contagion edges exist and no right column is configured", () => {
    useReportCardsMock.mockReturnValue({
      data: makeReportCardsResponse([makeCard("usde-ethena", "USDe")], []),
    });

    const { container } = render(<ContagionSnapshot stablecoinId="usde-ethena" />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null when report cards data is missing", () => {
    useReportCardsMock.mockReturnValue({ data: undefined });
    const { container } = render(<ContagionSnapshot stablecoinId="usde-ethena" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders right-column dependency context when report cards data is missing", () => {
    useReportCardsMock.mockReturnValue({ data: undefined });

    render(
      <ContagionSnapshot
        stablecoinId="usde-ethena"
        variantRelationshipCard={<div data-testid="variant-card">VARIANT</div>}
        hasCollateralUsage
        collateralUsageEntries={[
          { coin: { id: "usdtb-ethena", name: "Ethena USDtb", symbol: "USDtb" }, weight: 0.6, type: "collateral" },
        ]}
      />,
    );

    expect(screen.getByText("Dependency Context")).toBeTruthy();
    expect(screen.getByTestId("variant-card").textContent).toBe("VARIANT");
    expect(screen.getByTestId("collateral-usage-mock").textContent).toBe("collateral-usage:usdtb-ethena");
    expect(screen.queryByTestId("contagion-graph-mock")).toBeNull();
  });

  it("renders right-column dependency context when the report-card focus entry is missing", () => {
    useReportCardsMock.mockReturnValue({
      data: makeReportCardsResponse([makeCard("usdc-circle", "USDC")], []),
    });

    render(
      <ContagionSnapshot
        stablecoinId="usde-ethena"
        variantRelationshipCard={<div data-testid="variant-card">VARIANT</div>}
      />,
    );

    expect(screen.getByText("Dependency Context")).toBeTruthy();
    expect(screen.getByTestId("variant-card").textContent).toBe("VARIANT");
    expect(screen.queryByTestId("contagion-graph-mock")).toBeNull();
  });
});
