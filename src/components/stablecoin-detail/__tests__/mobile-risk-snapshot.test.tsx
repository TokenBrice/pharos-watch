// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MobileRiskSnapshot } from "../mobile-risk-snapshot";
import type { ReportCard } from "@shared/types";

const REPORT_CARD: ReportCard = {
  id: "usdc-circle",
  name: "USD Coin",
  symbol: "USDC",
  overallGrade: "B+",
  overallScore: 79,
  baseScore: 79,
  dimensions: {
    pegStability: { grade: "A", score: 95, detail: "Strong peg stability" },
    liquidity: { grade: "B+", score: 82, detail: "Deep exit liquidity" },
    resilience: {
      grade: "B",
      score: 70,
      detail: "Collateral: Real-world assets (off-chain) (50). Custody: Regulated custodian (55).",
      detailItems: [
        { label: "Collateral", value: "Real-world assets (off-chain)", detail: "50" },
        { label: "Custody", value: "Regulated custodian", detail: "55" },
      ],
    },
    decentralization: { grade: "B-", score: 66, detail: "Centralized governance" },
    dependencyRisk: { grade: "C", score: 55, detail: "Meaningful dependencies" },
  },
  ratedDimensions: 5,
  rawInputs: {
    pegScore: 95,
    activeDepeg: false,
    activeDepegBps: null,
    depegEventCount: 0,
    lastEventAt: null,
    liquidityScore: 82,
    effectiveExitScore: 82,
    redemptionBackstopScore: null,
    redemptionRouteFamily: null,
    redemptionModelConfidence: null,
    redemptionUsedForLiquidity: false,
    redemptionImmediateCapacityUsd: null,
    redemptionImmediateCapacityRatio: null,
    concentrationHhi: 0.2,
    bluechipGrade: null,
    canBeBlacklisted: true,
    chainTier: "ethereum",
    deploymentModel: "native-multichain",
    collateralQuality: "rwa",
    custodyModel: "institutional-regulated",
    governanceTier: "centralized",
    governanceQuality: "regulated-entity",
    dependencies: [],
    navToken: false,
    collateralFromLive: false,
    dependencyFromLive: false,
  },
  isDefunct: false,
};

afterEach(cleanup);

describe("MobileRiskSnapshot", () => {
  it("renders nothing without a report card", () => {
    const { container } = render(<MobileRiskSnapshot reportCard={null} />);

    expect(container.textContent).toBe("");
  });

  it("summarizes grade, peg, resilience, and the weakest dimension", () => {
    render(<MobileRiskSnapshot reportCard={REPORT_CARD} />);

    expect(screen.getByText("Risk Snapshot")).toBeTruthy();
    expect(screen.getByText("A peg stability")).toBeTruthy();
    expect(screen.getByText("Real-world assets (off-chain)")).toBeTruthy();
    expect(screen.getByText("Regulated custodian")).toBeTruthy();
    expect(screen.getByText("Dependency Risk is the lowest dimension at C.")).toBeTruthy();
  });

  it("surfaces an active depeg from existing raw report-card inputs", () => {
    render(
      <MobileRiskSnapshot
        reportCard={{
          ...REPORT_CARD,
          rawInputs: {
            ...REPORT_CARD.rawInputs,
            activeDepeg: true,
            activeDepegBps: -142,
          },
        }}
      />,
    );

    expect(screen.getByText("Active depeg -142 bps")).toBeTruthy();
  });
});
