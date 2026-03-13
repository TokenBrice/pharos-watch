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
      psiScore: 74,
      psiBand: "STEADY",
      grade: "A",
      sparklineRows: [{ price: 0.9998 }, { price: 1.0001 }],
      hasActiveDepeg: false,
      flow7d: null,
    });

    expect(data.vol24h).toBeNull();
    expect(data.flow7d).toBe(5_000_000);
    expect(data.sparklineData).toEqual([1.0001, 0.9998]);
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
          psiScore: 72,
          psiBand: "STEADY",
          mcap: 1_000_000_000,
          vol24h: null,
          flow7d: 10_000_000,
          sparklineData: [0.999, 1.001],
          hasActiveDepeg: false,
        }}
      />,
    );

    expect(markup).not.toContain("24H VOLUME");
    expect(markup).toContain("MARKET CAP");
    expect(markup).toContain("7D FLOW");
  });
});
