// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HomepageSafetyOverview } from "@/components/homepage-safety-overview";
import type { ReportCard, StablecoinData } from "@shared/types";

afterEach(() => {
  cleanup();
});

function makeCard(overrides: Partial<ReportCard>): ReportCard {
  return {
    id: overrides.id ?? "usdc-circle",
    name: overrides.name ?? "USD Coin",
    symbol: overrides.symbol ?? "USDC",
    overallGrade: overrides.overallGrade ?? "A",
    overallScore: overrides.overallScore ?? 90,
    baseScore: null,
    ratedDimensions: 5,
    rawInputs: { dependencies: [] },
    dimensions: {},
    isDefunct: overrides.isDefunct ?? false,
  } as ReportCard;
}

function makeAsset(id: string, peggedUsd: number): StablecoinData {
  return {
    id,
    chains: [],
    circulating: { peggedUSD: peggedUsd },
  } as StablecoinData;
}

describe("HomepageSafetyOverview", () => {
  it("renders grade mix and systemic cards from shared safety grade metadata", () => {
    render(
      <HomepageSafetyOverview
        cards={[
          makeCard({ id: "usdc-circle", symbol: "USDC", overallGrade: "A", overallScore: 90 }),
          makeCard({ id: "frax", symbol: "FRAX", overallGrade: "D", overallScore: 44 }),
          makeCard({ id: "old", symbol: "OLD", overallGrade: "F", overallScore: 12, isDefunct: true }),
        ]}
        peggedAssets={[
          makeAsset("usdc-circle", 1_000_000),
          makeAsset("frax", 500_000),
        ]}
      />,
    );

    expect(screen.getByText("A:1")).toBeTruthy();
    expect(screen.getByText("D:1")).toBeTruthy();
    expect(screen.getByText("F:0")).toBeTruthy();
    expect(screen.getByText("USDC")).toBeTruthy();
    expect(screen.getByText("FRAX")).toBeTruthy();
  });
});
