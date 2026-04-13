// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportCardDetail } from "@/components/report-card";
import type { ReportCard } from "@shared/types";

vi.mock("@/components/radar-chart", () => ({
  ReportCardRadar: () => <div data-testid="report-card-radar" />,
}));

function makeReportCard(): ReportCard {
  return {
    id: "test-usd",
    name: "Test USD",
    symbol: "TUSD",
    overallGrade: "B",
    overallScore: 75,
    baseScore: 78,
    ratedDimensions: 5,
    isDefunct: false,
    dependencies: [],
    dimensions: {
      pegStability: {
        grade: "A",
        score: 95,
        detail: "Stable peg.",
      },
      liquidity: {
        grade: "B",
        score: 72,
        detail: "Observed liquidity.",
      },
      resilience: {
        grade: "B-",
        score: 68,
        detail: "Collateral: Reserve assets (20). Custody: institutional (-5). Blacklist: possible (-10)",
      },
      decentralization: {
        grade: "C",
        score: 55,
        detail: "Governance: single entity (-10)",
      },
      dependencyRisk: {
        grade: "A",
        score: 90,
        detail: "Exposure: none (0)",
      },
    },
    rawInputs: {
      pegScore: 95,
      activeDepeg: false,
      activeDepegBps: null,
      depegEventCount: 0,
      lastEventAt: null,
      liquidityScore: 72,
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
      deploymentModel: "single-chain",
      collateralQuality: "rwa",
      custodyModel: "institutional-regulated",
      governanceTier: "centralized",
      governanceQuality: "regulated-entity",
      dependencies: [],
      navToken: false,
      collateralFromLive: false,
    },
  };
}

describe("ReportCardDetail", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps dimension disclosure controls separate from methodology hint buttons", () => {
    const { container } = render(<ReportCardDetail card={makeReportCard()} liquidityComponents={null} />);

    expect(container.querySelector("button button")).toBeNull();
    expect(screen.getByRole("button", { name: "Show Resilience details" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Explain Resilience" }).length).toBeGreaterThan(0);
  });

  it("expands dimension details from the disclosure control", () => {
    render(<ReportCardDetail card={makeReportCard()} liquidityComponents={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Show Resilience details" }));

    expect(screen.getByRole("button", { name: "Hide Resilience details" })).toBeTruthy();
    expect(screen.getByText("Collateral:")).toBeTruthy();
    expect(screen.getByText("Reserve assets")).toBeTruthy();
  });
});
