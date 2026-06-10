import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// Plain `satori` entry (Node build) — deliberately NOT the aliased
// `satori/standalone` stub, so the smoke tests below exercise the real
// layout engine.
import satori from "satori";
// The aliased standalone stub used by handleOg, mocked below so the handler
// tests can inspect the element it would render.
import satoriStandalone from "satori/standalone";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { deriveStablecoinOgCardData, handleOg } from "../og";
import { StablecoinCard, type StablecoinCardData } from "../../lib/og-templates/stablecoin-card";

vi.mock("satori/standalone", () => ({
  init: vi.fn(),
  default: vi.fn(async () => "<svg></svg>"),
}));
import { StabilityIndexCard } from "../../lib/og-templates/stability-index-card";
import { SafetyScoresCard } from "../../lib/og-templates/safety-scores-card";
import { DepegCard } from "../../lib/og-templates/depeg-card";
import { ChainCard } from "../../lib/og-templates/chain-card";

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
    expect(markup).toContain("Fiat");
    expect(markup).toContain("CeFi");
  });

  describe("peg-analytics cache hits", () => {
    const nowSec = Math.floor(Date.now() / 1000);

    function makeOgDb(assets: ReturnType<typeof makeAsset>[]) {
      const stablecoinsValue = JSON.stringify({ peggedAssets: assets });
      // Nav-inclusive payload, mirroring what the report-cards pass publishes.
      const pegAnalyticsValue = JSON.stringify({
        computedAtSec: nowSec,
        depegEventsToday: 0,
        depegEventsYesterday: 0,
        pegData: [
          { id: "fpi-frax", pegScore: 87 },
          { id: "usdt-tether", pegScore: 99 },
        ],
      });
      return mockD1([
        {
          match: "cache",
          rows: [
            { key: "stablecoins", value: stablecoinsValue, updated_at: nowSec },
            { key: "peg-analytics", value: pegAnalyticsValue, updated_at: nowSec },
          ],
        },
        { match: "dex_liquidity", rows: [] },
        { match: "stress_signals", rows: [] },
        { match: "supply_history", rows: [] },
        { match: "depeg_events", rows: [] },
        { match: "mint_burn_hourly", rows: [] },
      ]);
    }

    async function renderedCardData(db: D1Database, path: string): Promise<StablecoinCardData> {
      const satoriMock = vi.mocked(satoriStandalone);
      satoriMock.mockClear();
      const res = await handleOg(db, path);
      expect(res?.status).toBe(200);
      const element = satoriMock.mock.calls[satoriMock.mock.calls.length - 1]?.[0] as React.ReactElement<{ data: StablecoinCardData }>;
      expect(element.type).toBe(StablecoinCard);
      return element.props.data;
    }

    it("forces a null pegScore for nav tokens on the nav-inclusive cache-hit path", async () => {
      const db = makeOgDb([
        makeAsset({
          id: "fpi-frax",
          name: "Frax Price Index",
          symbol: "FPI",
          pegType: "peggedVAR",
          price: 1.12,
          circulating: { peggedVAR: 100_000_000 },
        }),
      ]);

      const data = await renderedCardData(db, "/api/og/stablecoin/fpi-frax");
      // The cache carries 87 (nav-inclusive for peg-summary), but the OG
      // fallback compute excludes nav tokens; both branches must render "—".
      expect(data.pegScore).toBeNull();
    });

    it("serves the cached pegScore for non-nav coins", async () => {
      const db = makeOgDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);

      const data = await renderedCardData(db, "/api/og/stablecoin/usdt-tether");
      expect(data.pegScore).toBe(99);
    });
  });

  it("renders variant context when provided", () => {
    const markup = renderToStaticMarkup(
      <StablecoinCard
        data={{
          name: "Bond USD0",
          symbol: "bUSD0",
          grade: "B+",
          pegPrice: 1,
          dewsBand: "CALM",
          liquidityScore: 70,
          mcap: 10_000_000,
          vol24h: null,
          flow7d: 500_000,
          sparklineData: [0.995, 1.0],
          hasActiveDepeg: false,
          pegScore: 88,
          backing: "rwa",
          governance: "centralized-dependent",
          redemptionScore: 75,
          change24h: 0.1,
          variantLabel: "Bond",
          variantParentSymbol: "USD0",
        }}
      />,
    );

    expect(markup).toContain("Bond of USD0");
  });
});

describe("stability index OG card", () => {
  const baseData = {
    psiBand: "BEDROCK",
    sparklineData: [90, 92, 94],
    bands: [
      { name: "BEDROCK", active: true },
      { name: "STEADY", active: false },
      { name: "TREMOR", active: false },
      { name: "FRACTURE", active: false },
      { name: "CRISIS", active: false },
      { name: "MELTDOWN", active: false },
    ],
    avg7d: 91.2,
    allTimeHigh: 97.5,
    allTimeLow: 11.4,
    flightToQuality: false,
    flightIntensity: null,
  };

  it("places healthy scores near the healthy end of the thermometer", () => {
    const markup = renderToStaticMarkup(
      <StabilityIndexCard
        data={{
          ...baseData,
          psiScore: 92,
          delta24h: 1.3,
        }}
      />,
    );

    expect(markup).toContain("left:8%");
    expect(markup).toContain("color:#22c55e");
  });

  it("places stressed scores near the stressed end of the thermometer", () => {
    const markup = renderToStaticMarkup(
      <StabilityIndexCard
        data={{
          ...baseData,
          psiScore: 15,
          psiBand: "MELTDOWN",
          delta24h: -2.8,
        }}
      />,
    );

    expect(markup).toContain("left:85%");
    expect(markup).toContain("color:#ef4444");
  });
});

// ---------------------------------------------------------------------------
// Satori render smoke tests
//
// renderToStaticMarkup never catches satori-level failures: satori walks the
// element tree itself and throws on inputs React tolerates (e.g. `undefined`
// style values — its expand loop feeds them to css-to-react-native's
// `.trim()`). Exactly that broke /api/og/stablecoin/* in production for every
// coin (MetricRow's optional marginBottom). Each card template must render
// through the real engine.
// ---------------------------------------------------------------------------

describe("og cards render through satori", () => {
  const font = (file: string) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture reads repo-local font assets
    readFileSync(fileURLToPath(new URL(`../../../assets/fonts/${file}`, import.meta.url).href));
  const fonts = [
    { name: "Geist Sans", data: font("Geist-Regular.ttf"), weight: 400 as const, style: "normal" as const },
    { name: "Geist Sans", data: font("Geist-Bold.ttf"), weight: 700 as const, style: "normal" as const },
    { name: "Geist Mono", data: font("GeistMono-Regular.ttf"), weight: 400 as const, style: "normal" as const },
  ];

  const renderSvg = (element: React.ReactNode) =>
    satori(element, { width: 1200, height: 628, fonts });

  const calmCoin: StablecoinCardData = {
    name: "Tether",
    symbol: "USDT",
    grade: "B+",
    pegPrice: 1.0003,
    dewsBand: "CALM",
    liquidityScore: 92,
    mcap: 120_000_000_000,
    vol24h: null,
    flow7d: 250_000_000,
    sparklineData: [1.0001, 1.0002, 0.9999, 1.0, 1.0001, 1.0003, 1.0002],
    hasActiveDepeg: false,
    pegScore: 97.2,
    backing: "rwa-backed",
    governance: "centralized",
    redemptionScore: null,
    change24h: 0.01,
    variantLabel: null,
    variantParentSymbol: null,
    isFrozen: false,
    lastUpdated: "2026-06-10 07:30 UTC",
  };

  it("renders the stablecoin card (calm baseline)", async () => {
    const svg = await renderSvg(<StablecoinCard data={calmCoin} />);
    expect(svg).toContain("<svg");
  });

  it("renders the stablecoin card with depeg, frozen, and variant branches", async () => {
    const svg = await renderSvg(
      <StablecoinCard
        data={{
          ...calmCoin,
          hasActiveDepeg: true,
          dewsBand: "DANGER",
          isFrozen: true,
          variantLabel: "Savings",
          variantParentSymbol: "USDT",
          grade: "NR",
          change24h: null,
          flow7d: -5_000_000,
        }}
      />,
    );
    expect(svg).toContain("<svg");
  });

  it("renders the safety-scores card", async () => {
    const svg = await renderSvg(
      <SafetyScoresCard
        data={{
          gradeDistribution: { "A+": 2, A: 10, "A-": 12, "B+": 30, B: 40, "B-": 25, "C+": 12, C: 8, "C-": 4, D: 3, F: 1 },
          pulseGrade: "B+",
          pulseScore: 78.4,
          coverageRatio: 0.93,
          totalCoins: 401,
          topPerformers: [
            { symbol: "USDC", grade: "A+", score: 95 },
            { symbol: "PYUSD", grade: "A", score: 92 },
            { symbol: "GUSD", grade: "A", score: 91 },
          ],
          bottomPerformers: [
            { symbol: "XUSD", grade: "F", score: 12 },
            { symbol: "YUSD", grade: "D", score: 28 },
            { symbol: "ZUSD", grade: "C-", score: 41 },
          ],
          trend: -0.4,
          lastUpdated: "2026-06-10 07:30 UTC",
        }}
      />,
    );
    expect(svg).toContain("<svg");
  });

  it("renders the depeg card", async () => {
    const svg = await renderSvg(
      <DepegCard
        data={{
          activeDepegCount: 3,
          psiScore: 88.2,
          psiBand: "BEDROCK",
          coinsAtPeg: 380,
          totalCoins: 401,
          dewsDistribution: { danger: 2, alert: 5, warning: 12, normal: 382 },
          activeDepegs: [
            { symbol: "XAUM", name: "Matrixdock Gold", deviationBps: -312 },
            { symbol: "EURS", name: "STASIS EURO", deviationBps: 145 },
          ],
          recoveredToday: 1,
          newToday: 2,
          lastUpdated: "2026-06-10 07:30 UTC",
        }}
      />,
    );
    expect(svg).toContain("<svg");
  });

  it("renders the chain card", async () => {
    const svg = await renderSvg(
      <ChainCard
        data={{
          name: "Ethereum",
          totalUsd: 132_000_000_000,
          change7dPct: 1.8,
          stablecoinCount: 214,
          dominanceShare: 0.52,
          healthScore: 74,
          healthBand: "healthy",
          topStablecoins: [
            { symbol: "USDT", share: 0.42, supplyUsd: 55_000_000_000 },
            { symbol: "USDC", share: 0.31, supplyUsd: 41_000_000_000 },
            { symbol: "DAI", share: 0.04, supplyUsd: 5_000_000_000 },
          ],
          lastUpdated: "2026-06-10 07:30 UTC",
        }}
      />,
    );
    expect(svg).toContain("<svg");
  });

  it("renders the chain card without health data", async () => {
    const svg = await renderSvg(
      <ChainCard
        data={{
          name: "Obscure Chain",
          totalUsd: 1_200_000,
          change7dPct: -12.4,
          stablecoinCount: 1,
          dominanceShare: 0.000004,
          healthScore: null,
          healthBand: null,
          topStablecoins: [{ symbol: "XUSD", share: 1, supplyUsd: 1_200_000 }],
        }}
      />,
    );
    expect(svg).toContain("<svg");
  });

  it("renders the stability-index card", async () => {
    const svg = await renderSvg(
      <StabilityIndexCard
        data={{
          psiScore: 92,
          psiBand: "BEDROCK",
          delta24h: 1.3,
          sparklineData: [90, 92, 94],
          bands: [
            { name: "BEDROCK", active: true },
            { name: "STEADY", active: false },
            { name: "TREMOR", active: false },
            { name: "FRACTURE", active: false },
            { name: "CRISIS", active: false },
            { name: "MELTDOWN", active: false },
          ],
          avg7d: 91.2,
          allTimeHigh: 97.5,
          allTimeLow: 11.4,
          flightToQuality: true,
          flightIntensity: 62,
          lastUpdated: "2026-06-10 07:30 UTC",
        }}
      />,
    );
    expect(svg).toContain("<svg");
  });
});
