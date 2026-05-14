import { describe, expect, it } from "vitest";
import type { DimensionKey } from "@shared/types";
import { buildHeldCardIds, buildPortfolioRadarCard, parseUsdInput } from "./model";

const dimensionScores: Record<DimensionKey, number | null> = {
  pegStability: 90,
  liquidity: 80,
  resilience: 70,
  decentralization: null,
  dependencyRisk: 60,
};

describe("portfolio page model", () => {
  it("parses supported USD input formats", () => {
    expect(parseUsdInput("$1,234.50")).toBe(1234.5);
    expect(parseUsdInput("2500")).toBe(2500);
    expect(parseUsdInput("12abc")).toBe(0);
  });

  it("builds a synthetic radar card only when the portfolio has a score", () => {
    expect(
      buildPortfolioRadarCard({
        holdingCount: 0,
        portfolioGrade: "NR",
        portfolioScore: null,
        dimensionScores,
      }),
    ).toBeNull();

    const card = buildPortfolioRadarCard({
      holdingCount: 2,
      portfolioGrade: "B+",
      portfolioScore: 82,
      dimensionScores,
    });

    expect(card).toMatchObject({
      id: "__portfolio__",
      overallGrade: "B+",
      overallScore: 82,
      ratedDimensions: 4,
    });
  });

  it("builds held card id sets from holdings", () => {
    expect(
      buildHeldCardIds([
        { coinId: "usdc-circle", amount: 10 },
        { coinId: "usdt-tether", amount: 20 },
      ]),
    ).toEqual(new Set(["usdc-circle", "usdt-tether"]));
  });
});
