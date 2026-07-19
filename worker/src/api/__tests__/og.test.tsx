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
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";
import { deriveStablecoinOgCardData, handleOg } from "../og";
import { StablecoinCard, type StablecoinCardData } from "../../lib/og-templates/stablecoin-card";

vi.mock("satori/standalone", () => ({
  init: vi.fn(),
  default: vi.fn(async () => "<svg></svg>"),
}));
import { StabilityIndexCard, type StabilityIndexCardData } from "../../lib/og-templates/stability-index-card";
import { SafetyScoresCard } from "../../lib/og-templates/safety-scores-card";
import { DepegCard, type DepegCardData } from "../../lib/og-templates/depeg-card";
import { ChainCard, type ChainCardData } from "../../lib/og-templates/chain-card";

describe("stablecoin OG card data", () => {
  it("derives flow7d and sparkline data", () => {
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
      backing: "rwa-backed",
      governance: "centralized",
      redemptionScore: 85,
      change24h: 0.5,
    });

    expect(data.flow7d).toBe(5_000_000);
    expect(data.sparklineData).toEqual([1.0001, 0.9998]);
    expect(data.pegScore).toBe(95);
    expect(data.backing).toBe("rwa-backed");
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
          flow7d: 10_000_000,
          sparklineData: [0.999, 1.001],
          hasActiveDepeg: false,
          pegScore: 92,
          backing: "rwa-backed",
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
    expect(markup).toContain("RWA");
    expect(markup).toContain("CeFi");
    expect(markup).toContain("background-color:#f8f8fa");
    expect(markup).not.toContain("background-color:#0a0f1e");
  });

  describe("peg-analytics cache hits", () => {
    const nowSec = Math.floor(Date.now() / 1000);

    function completeReportCardCache(updatedAt: number) {
      const publicationGenerationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${updatedAt}`;
      return {
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        updatedAt,
        safetyScoreIdentity: buildSafetyScoreV8PublicationIdentity({
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
          publicationGenerationId,
        }),
        publicationGenerationId,
        completeness: {
          generationId: publicationGenerationId,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          expectedCount: ACTIVE_IDS.size,
          scoredCount: ACTIVE_IDS.size,
          notRatedCount: 0,
          notRatedIds: [],
        },
        scores: Object.fromEntries([...ACTIVE_IDS].map((id) => [id, { score: 92, grade: "A" }])),
      };
    }

    function makeOgDb(assets: ReturnType<typeof makeAsset>[], reportCardCache?: unknown) {
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
            ...(reportCardCache
              ? [{ key: "report_card_cache", value: JSON.stringify(reportCardCache), updated_at: nowSec }]
              : []),
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
      const element = satoriMock.mock.calls[satoriMock.mock.calls.length - 1]?.[0] as React.ReactElement<{
        data: StablecoinCardData;
      }>;
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

    it("renders an explicit cacheable degraded state when compact safety identity is unavailable", async () => {
      const db = makeOgDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
      const res = await handleOg(db, "/api/og/stablecoin/usdt-tether");

      expect(res?.status).toBe(200);
      expect(res?.headers.get("Cache-Control")).toBe("public, max-age=900, s-maxage=900");
      expect(res?.headers.get("X-Safety-Score-Status")).toBe("degraded");
      const calls = vi.mocked(satoriStandalone).mock.calls;
      const element = calls[calls.length - 1]?.[0] as React.ReactElement<{ data: StablecoinCardData }>;
      expect(element.props.data).toMatchObject({
        grade: "NR",
        lastUpdated: "DEGRADED: Safety score unavailable",
      });
    });

    it("renders a cacheable degraded state for a complete V9 compact publication on the V8 release", async () => {
      const v8Cache = completeReportCardCache(nowSec);
      const v9GenerationId = `safety-score-v9:9.0:${nowSec}`;
      const v9Cache = {
        ...v8Cache,
        safetyScoreIdentity: {
          model: "v9",
          schemaVersion: 1,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          policyId: "v9-policy-2026-05",
          policyDigest: "b".repeat(64),
          evaluationBuildDigest: "c".repeat(64),
          baseInputGenerationId: `report-cards-input:v1:${"d".repeat(64)}`,
          publicationGenerationId: v9GenerationId,
        },
        publicationGenerationId: v9GenerationId,
        completeness: {
          ...v8Cache.completeness,
          generationId: v9GenerationId,
        },
      };
      const db = makeOgDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })], v9Cache);

      const res = await handleOg(db, "/api/og/stablecoin/usdt-tether");

      expect(res?.status).toBe(200);
      expect(res?.headers.get("Cache-Control")).toBe("public, max-age=900, s-maxage=900");
      expect(res?.headers.get("X-Safety-Score-Status")).toBe("degraded");
      expect(res?.headers.get("X-Safety-Score-Reason")).toBe("invalid-payload");
      const calls = vi.mocked(satoriStandalone).mock.calls;
      const element = calls[calls.length - 1]?.[0] as React.ReactElement<{ data: StablecoinCardData }>;
      expect(element.props.data).toMatchObject({
        grade: "NR",
        lastUpdated: "DEGRADED: Safety score unavailable",
      });
    });

    it("renders a cacheable degraded state for a different V8 evaluation build", async () => {
      const v8Cache = completeReportCardCache(nowSec);
      const currentDigest = v8Cache.safetyScoreIdentity.evaluationBuildDigest;
      const mismatchedCache = {
        ...v8Cache,
        safetyScoreIdentity: {
          ...v8Cache.safetyScoreIdentity,
          evaluationBuildDigest: currentDigest === "b".repeat(64) ? "c".repeat(64) : "b".repeat(64),
        },
      };
      const db = makeOgDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })], mismatchedCache);

      const res = await handleOg(db, "/api/og/stablecoin/usdt-tether");

      expect(res?.status).toBe(200);
      expect(res?.headers.get("Cache-Control")).toBe("public, max-age=900, s-maxage=900");
      expect(res?.headers.get("X-Safety-Score-Status")).toBe("degraded");
      expect(res?.headers.get("X-Safety-Score-Reason")).toBe("identity-mismatch");
      const calls = vi.mocked(satoriStandalone).mock.calls;
      const element = calls[calls.length - 1]?.[0] as React.ReactElement<{ data: StablecoinCardData }>;
      expect(element.props.data).toMatchObject({ grade: "NR" });
    });

    it("serves cacheable degraded OG headers for stale complete compact safety data", async () => {
      const db = makeOgDb(
        [makeAsset({ id: "usdt-tether", symbol: "USDT" })],
        completeReportCardCache(nowSec - 3 * 60 * 60),
      );

      const res = await handleOg(db, "/api/og/stablecoin/usdt-tether");

      expect(res?.status).toBe(200);
      expect(res?.headers.get("Cache-Control")).toBe("public, max-age=900, s-maxage=900");
      expect(res?.headers.get("X-Safety-Score-Status")).toBe("degraded");
      expect(res?.headers.get("X-Safety-Score-Reason")).toBe("stale-cache");
    });

    it("anchors 24h price change to the latest snapshot instead of wall-clock time", async () => {
      const db = mockD1([
        {
          match: "cache",
          rows: [
            {
              key: "stablecoins",
              value: JSON.stringify({ peggedAssets: [makeAsset({ id: "usdt-tether", symbol: "USDT" })] }),
              updated_at: nowSec,
            },
            {
              key: "peg-analytics",
              value: JSON.stringify({ computedAtSec: nowSec, pegData: [{ id: "usdt-tether", pegScore: 99 }] }),
              updated_at: nowSec,
            },
          ],
        },
        { match: "dex_liquidity", rows: [] },
        { match: "stress_signals", rows: [] },
        { match: "current_snapshot", rows: [], first: { current_price: 1.02, prev_day_price: 0.99 } },
        { match: "supply_history", rows: [{ price: 1.02 }, { price: 0.99 }] },
        { match: "depeg_events", rows: [] },
        { match: "mint_burn_hourly", rows: [] },
      ]);

      const data = await renderedCardData(db, "/api/og/stablecoin/usdt-tether");

      expect(data.change24h).toBeCloseTo(3.0303, 4);
      const priceQuery = db.getHistory().find((entry) => entry.sql.includes("current_snapshot"));
      expect(priceQuery?.binds).toEqual(["usdt-tether", "usdt-tether", 86_400]);
      expect(priceQuery?.sql).toContain("snapshot_date <= current_snapshot.snapshot_date - ?");
    });
  });

  it("returns a no-store 503 when the stablecoins cache has no usable payload", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: JSON.stringify({ peggedAssets: [] }), updated_at: nowSec }],
      },
      { match: "dex_liquidity", rows: [] },
      { match: "stress_signals", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "mint_burn_hourly", rows: [] },
    ]);

    const res = await handleOg(db, "/api/og/stablecoin/usdt-tether");

    expect(res?.status).toBe(503);
    // A transient 503 must not be CDN-pinned on share-image URLs (og-4).
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
    expect(res?.headers.get("Retry-After")).toBe("60");
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
          flow7d: 500_000,
          sparklineData: [0.995, 1.0],
          hasActiveDepeg: false,
          pegScore: 88,
          backing: "rwa-backed",
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

describe("chain OG route", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  function makeChainOgDb(assets: ReturnType<typeof makeAsset>[]) {
    const stablecoinsValue = JSON.stringify({ peggedAssets: assets });
    return mockD1([
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: stablecoinsValue, updated_at: nowSec }],
      },
    ]);
  }

  it("renders a degraded card when a known chain has no tracked supply", async () => {
    // Asset with no chain attribution → aggregateChains() emits no chains, so
    // "ethereum" (a CHAIN_META id whose page bakes this og:image URL) is
    // absent from the aggregate and must still resolve to a 200 PNG.
    const db = makeChainOgDb([makeAsset({ chainCirculating: {}, chains: [] })]);
    const satoriMock = vi.mocked(satoriStandalone);
    satoriMock.mockClear();

    const res = await handleOg(db, "/api/og/chain/ethereum");
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("image/png");

    const element = satoriMock.mock.calls[satoriMock.mock.calls.length - 1]?.[0] as React.ReactElement<{
      data: ChainCardData;
    }>;
    expect(element.type).toBe(ChainCard);
    expect(element.props.data).toMatchObject({
      name: "Ethereum",
      totalUsd: 0,
      stablecoinCount: 0,
      healthScore: null,
      healthBand: null,
      topStablecoins: [],
    });
    expect(renderToStaticMarkup(element)).toContain("No tracked stablecoin supply");
  });

  it("returns 404 for an id outside CHAIN_META", async () => {
    const res = await handleOg(mockD1([]), "/api/og/chain/not-a-chain");
    expect(res?.status).toBe(404);
  });

  it("answers HEAD without loading data or rendering the PNG", async () => {
    const db = makeChainOgDb([makeAsset({ chainCirculating: {}, chains: [] })]);
    const satoriMock = vi.mocked(satoriStandalone);
    satoriMock.mockClear();

    const res = await handleOg(db, "/api/og/chain/ethereum", "HEAD");

    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("image/png");
    expect((await res?.arrayBuffer())?.byteLength).toBe(0);
    expect(satoriMock).not.toHaveBeenCalled();
  });
});

describe("depeg OG handler aggregation", () => {
  function captureDepegData(db: D1Database) {
    return (async () => {
      const satoriMock = vi.mocked(satoriStandalone);
      satoriMock.mockClear();
      const res = await handleOg(db, "/api/og/depeg");
      expect(res?.status).toBe(200);
      const element = satoriMock.mock.calls[satoriMock.mock.calls.length - 1]?.[0] as React.ReactElement<{
        data: DepegCardData;
      }>;
      expect(element.type).toBe(DepegCard);
      return element.props.data;
    })();
  }

  it("maps stress bands to the DEWS distribution and counts daily flux", async () => {
    const db = mockD1([
      // active-depeg COUNT(*) (ended_at IS NULL)
      { match: "COUNT(*) as count FROM depeg_events WHERE ended_at IS NULL", rows: [], first: { count: 1 } },
      { match: "stability_index_samples", rows: [], first: { score: 88.2, band: "BEDROCK" } },
      {
        match: "stress_signals",
        rows: [
          { band: "DANGER" },
          { band: "ALERT" },
          { band: "WARNING" },
          { band: "CALM" }, // default branch → normal
          { band: "WATCH" }, // default branch → normal
        ],
      },
      // active-depeg details (peak_deviation_bps)
      {
        match: "peak_deviation_bps",
        rows: [{ stablecoin_id: "usdt-tether", symbol: "USDT", peak_deviation_bps: -150 }],
      },
      // recovered today (ended_at IS NOT NULL)
      { match: "ended_at IS NOT NULL", rows: [], first: { count: 3 } },
      // new today (started_at > ?)
      { match: "started_at >", rows: [], first: { count: 4 } },
    ]);

    const data = await captureDepegData(db);
    expect(data.dewsDistribution).toEqual({ danger: 1, alert: 1, warning: 1, normal: 2 });
    expect(data.totalCoins).toBe(5);
    expect(data.activeDepegCount).toBe(1);
    expect(data.coinsAtPeg).toBe(4); // 5 - 1
    expect(data.recoveredToday).toBe(3);
    expect(data.newToday).toBe(4);
    expect(data.psiScore).toBe(88.2);
    expect(data.activeDepegs).toEqual([{ symbol: "USDT", name: "Tether", deviationBps: -150 }]);
  });

  it("clamps coinsAtPeg to zero when active depegs exceed tracked coins", async () => {
    const db = mockD1([
      { match: "COUNT(*) as count FROM depeg_events WHERE ended_at IS NULL", rows: [], first: { count: 5 } },
      { match: "stability_index_samples", rows: [], first: null }, // psi fallbacks
      { match: "stress_signals", rows: [{ band: "DANGER" }, { band: "ALERT" }] },
      { match: "peak_deviation_bps", rows: [] },
      { match: "ended_at IS NOT NULL", rows: [], first: { count: 0 } },
      { match: "started_at >", rows: [], first: { count: 0 } },
    ]);

    const data = await captureDepegData(db);
    expect(data.totalCoins).toBe(2);
    expect(data.activeDepegCount).toBe(5);
    expect(data.coinsAtPeg).toBe(0); // max(0, 2 - 5)
    expect(data.psiScore).toBe(0); // psiRow null → 0
    expect(data.psiBand).toBe("BEDROCK"); // psiRow null → default band
  });
});

describe("stability-index OG handler aggregation", () => {
  function captureStabilityData(db: D1Database) {
    return (async () => {
      const satoriMock = vi.mocked(satoriStandalone);
      satoriMock.mockClear();
      const res = await handleOg(db, "/api/og/stability-index");
      expect(res?.status).toBe(200);
      const element = satoriMock.mock.calls[satoriMock.mock.calls.length - 1]?.[0] as React.ReactElement<{
        data: StabilityIndexCardData;
      }>;
      expect(element.type).toBe(StabilityIndexCard);
      return element.props.data;
    })();
  }

  const nowSec = Math.floor(Date.now() / 1000);

  it("pads a short sparkline and falls back to psiScore for avg/ATH/ATL", async () => {
    const db = mockD1([
      {
        match: "stored_at DESC LIMIT 1",
        rows: [],
        first: { score: 73.5, band: "STEADY", stored_at: nowSec },
      },
      // avg24h and avg7d share SQL; both resolve to null so they exercise the
      // psiScore fallback together — a single shared match is sufficient.
      { match: "AVG(score)", rows: [], first: { avg: null } },
      // single history row → sparkline padded to length 2 with psiScore.
      { match: "FROM stability_index ORDER BY computed_at", rows: [{ score: 80 }] },
      { match: "MAX(score)", rows: [], first: { max: null } },
      { match: "MIN(score)", rows: [], first: { min: null } },
    ]);

    const data = await captureStabilityData(db);
    expect(data.psiScore).toBe(73.5);
    expect(data.psiBand).toBe("STEADY");
    expect(data.delta24h).toBe(0); // avg24h falls back to psiScore → delta 0
    expect(data.avg7d).toBe(73.5); // avg7d null → psiScore
    expect(data.allTimeHigh).toBe(73.5); // max null → psiScore
    expect(data.allTimeLow).toBe(73.5); // min null → psiScore
    // 1 history row reversed → [80], then padded with psiScore twice.
    expect(data.sparklineData).toEqual([80, 73.5, 73.5]);
    expect(data.bands.find((b) => b.name === "STEADY")?.active).toBe(true);
  });

  it("falls back to a derived band and zero score when no sample exists", async () => {
    const db = mockD1([
      { match: "stored_at DESC LIMIT 1", rows: [], first: null },
      { match: "AVG(score)", rows: [], first: { avg: null } },
      { match: "FROM stability_index ORDER BY computed_at", rows: [] },
      { match: "MAX(score)", rows: [], first: { max: null } },
      { match: "MIN(score)", rows: [], first: { min: null } },
    ]);

    const data = await captureStabilityData(db);
    expect(data.psiScore).toBe(0);
    // Empty history → sparkline padded entirely from psiScore (0, 0).
    expect(data.sparklineData).toEqual([0, 0]);
    expect(data.allTimeHigh).toBe(0);
    expect(data.allTimeLow).toBe(0);
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

  const renderSvg = (element: React.ReactNode) => satori(element, { width: 1200, height: 628, fonts });

  const calmCoin: StablecoinCardData = {
    name: "Tether",
    symbol: "USDT",
    grade: "B+",
    pegPrice: 1.0003,
    dewsBand: "CALM",
    liquidityScore: 92,
    mcap: 120_000_000_000,
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
          gradeDistribution: {
            "A+": 2,
            A: 10,
            "A-": 12,
            "B+": 30,
            B: 40,
            "B-": 25,
            "C+": 12,
            C: 8,
            "C-": 4,
            D: 3,
            F: 1,
          },
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

  it("renders the chain card with zero tracked supply (degraded profile)", async () => {
    const svg = await renderSvg(
      <ChainCard
        data={{
          name: "Ethereum",
          totalUsd: 0,
          change7dPct: 0,
          stablecoinCount: 0,
          dominanceShare: 0,
          healthScore: null,
          healthBand: null,
          topStablecoins: [],
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
