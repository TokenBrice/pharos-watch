import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveStablecoinOgCardData } from "../og";
import { StablecoinCard } from "../../lib/og-templates/stablecoin-card";

describe("stablecoin OG card data", () => {
  it("marks unavailable 24h volume as null", () => {
    const data = deriveStablecoinOgCardData({
      coin: {
        name: "USD Coin",
        symbol: "USDC",
        price: 1,
        circulating: { peggedUSD: 100_000_000 },
        circulatingPrevWeek: { peggedUSD: 95_000_000 },
      },
      dexLiquidityScore: 81,
      dewsBand: "CALM",
      grade: "A",
      sparklineRows: [{ price: 0.9998 }, { price: 1.0001 }],
      hasActiveDepeg: false,
      flow7d: null,
      pegScore: 95,
      backing: "fiat",
      governance: "centralized",
      redemptionScore: 85,
      change24h: 0.5,
    });

    expect(data.vol24h).toBeNull();
    expect(data.flow7d).toBe(5_000_000);
    expect(data.sparklineData).toEqual([1.0001, 0.9998]);
    expect(data.pegScore).toBe(95);
    expect(data.backing).toBe("fiat");
    expect(data.governance).toBe("centralized");
    // PSI should not be on individual coin cards
    expect((data as unknown as Record<string, unknown>).psiScore).toBeUndefined();
  });

  it("hides the volume block when volume is unavailable", () => {
    const markup = renderToStaticMarkup(
      <StablecoinCard
        data={{
          name: "USD Coin",
          symbol: "USDC",
          grade: "A",
          pegPrice: 1,
          dewsBand: "CALM",
          liquidityScore: 80,
          mcap: 1_000_000_000,
          vol24h: null,
          flow7d: 10_000_000,
          sparklineData: [0.999, 1.001],
          hasActiveDepeg: false,
          pegScore: 92,
          backing: "fiat",
          governance: "centralized",
          redemptionScore: 88,
          change24h: 0.25,
        }}
      />,
    );

    expect(markup).not.toContain("24H VOLUME");
    expect(markup).toContain("MARKET CAP");
    expect(markup).toContain("7D FLOW");
    expect(markup).toContain("PEG SCORE");
    expect(markup).toContain("BACKING");
  });
});
