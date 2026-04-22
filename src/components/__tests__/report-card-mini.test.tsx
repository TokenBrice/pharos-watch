// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportCard } from "@shared/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock("../radar-chart", () => ({
  ReportCardRadar: () => <div>radar</div>,
}));

vi.mock("../stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <div>{name}</div>,
}));

import { ReportCardMini } from "../report-card-mini";

afterEach(() => {
  cleanup();
});

function makeCard(overrides: Partial<ReportCard> = {}): ReportCard {
  return {
    id: overrides.id ?? "usdc-circle",
    name: overrides.name ?? "USD Coin",
    symbol: overrides.symbol ?? "USDC",
    overallGrade: overrides.overallGrade ?? "A",
    overallScore: overrides.overallScore ?? 92,
    baseScore: overrides.baseScore ?? null,
    dimensions: overrides.dimensions ?? {
      pegStability: { grade: "A", score: 95, detail: "" },
      liquidity: { grade: "A", score: 90, detail: "" },
      resilience: { grade: "B+", score: 85, detail: "" },
      decentralization: { grade: "B", score: 80, detail: "" },
      dependencyRisk: { grade: "A", score: 94, detail: "" },
    },
    ratedDimensions: overrides.ratedDimensions ?? 5,
    rawInputs: overrides.rawInputs ?? {
      pegScore: 95,
      activeDepeg: false,
      activeDepegBps: null,
      depegEventCount: 0,
      lastEventAt: null,
      liquidityScore: 90,
      effectiveExitScore: 90,
      redemptionBackstopScore: null,
      redemptionRouteFamily: null,
      redemptionModelConfidence: null,
      redemptionUsedForLiquidity: false,
      redemptionImmediateCapacityUsd: null,
      redemptionImmediateCapacityRatio: null,
      concentrationHhi: null,
      bluechipGrade: null,
      canBeBlacklisted: null,
      chainTier: null,
      deploymentModel: null,
      collateralQuality: null,
      custodyModel: null,
      governanceTier: null,
      governanceQuality: null,
      dependencies: [],
      navToken: false,
      collateralFromLive: false,
    },
    isDefunct: overrides.isDefunct ?? false,
  } as ReportCard;
}

describe("ReportCardMini", () => {
  it("links live cards to the stablecoin detail route", () => {
    render(<ReportCardMini card={makeCard()} />);

    expect(screen.getByRole("link").getAttribute("href")).toBe("/stablecoin/usdc-circle/");
  });

  it("does not render a detail link for defunct cards", () => {
    render(<ReportCardMini card={makeCard({ id: "usdl-first-usdl-2024-01", isDefunct: true, name: "First USDL", symbol: "USDL" })} />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Defunct")).toBeTruthy();
  });
});
