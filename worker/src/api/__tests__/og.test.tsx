import { makeReportCardsV9PipelineGapCard, makeReportCardsV9PartialCard } from "@shared/test-utils/report-cards-v9";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// Plain `satori` entry (Node build) — deliberately NOT the aliased
// `satori/standalone` stub, so the smoke tests below exercise the real
// layout engine.
import satori from "satori";
// The aliased standalone stub used by handleOg, mocked below so the handler
// tests can inspect the element it would render.
import satoriStandalone, { init as initSatoriStandalone } from "satori/standalone";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import * as activeSafetyScoreSource from "../../lib/safety-score-index";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../lib/safety-score-v9/consumer-freshness";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";
import { loadStressSignalCurrentRowForCoin, loadStressSignalCurrentRows } from "../../lib/stress-signals-current-rows";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import { deriveStablecoinOgCardData, handleOg, resetOgWasmInitializationForTests } from "../og";
import { StablecoinCard, type StablecoinCardData } from "../../lib/og-templates/stablecoin-card";

vi.mock("satori/standalone", () => ({
  init: vi.fn(),
  default: vi.fn(async () => "<svg></svg>"),
}));
import { StabilityIndexCard, type StabilityIndexCardData } from "../../lib/og-templates/stability-index-card";
import {
  SafetyScoresCard,
  type SafetyScoresCardData,
} from "../../lib/og-templates/safety-scores-card";
import { DepegCard, type DepegCardData } from "../../lib/og-templates/depeg-card";
import { ChainCard, type ChainCardData } from "../../lib/og-templates/chain-card";

afterEach(() => {
  resetOgWasmInitializationForTests();
  vi.restoreAllMocks();
});

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
      mintBurn7d: null,
      pegScore: 95,
      backing: "rwa-backed",
      governance: "centralized",
      redemptionScore: 85,
      change24h: 0.5,
    });

    expect(data.flow7d).toBe(5_000_000);
    expect(data.flow7dSource).toBe("supply-delta");
    expect(data.sparklineData).toEqual([1.0001, 0.9998]);
    expect(data.pegScore).toBe(95);
    expect(data.backing).toBe("rwa-backed");
    expect(data.governance).toBe("centralized");
  });
  it("preserves unavailable facts instead of inventing healthy readings or full-cap inflow", () => {
    const input = {
      coin: { name: "Unknown", symbol: "UNK", circulating: { peggedUSD: 100_000_000 } },
      dexLiquidityScore: null,
      dewsBand: null,
      grade: null,
      sparklineRows: [],
      hasActiveDepeg: false,
      mintBurn7d: null,
      pegScore: null,
      backing: null,
      governance: null,
      redemptionScore: null,
      change24h: null,
    };
    const data = deriveStablecoinOgCardData(input);
    expect(data).toMatchObject({
      pegPrice: null, dewsBand: null, liquidityScore: null,
      flow7d: null, flow7dSource: null, sparklineData: null,
      backing: null, governance: null, mcap: 100_000_000,
    });
    const markup = renderToStaticMarkup(<StablecoinCard data={data} />);
    expect(markup).not.toContain("$1.0000");
    expect(markup).not.toContain("CALM");
    expect(markup).not.toContain("+$");
    expect(markup).not.toContain("CeFi");
    expect(markup).toContain("Price history unavailable");
    expect(deriveStablecoinOgCardData({ ...input, coin: { ...input.coin, circulating: {} } }).mcap).toBeNull();
  });

  it("keeps measured zero flow and zero liquidity distinct from absence", () => {
    const data = deriveStablecoinOgCardData({
      coin: {
        name: "Zero", symbol: "ZERO", price: 1,
        circulating: { peggedUSD: 100 }, circulatingPrevWeek: { peggedUSD: 50 },
      },
      dexLiquidityScore: 0, dewsBand: null, grade: null, sparklineRows: [{ price: 1 }],
      hasActiveDepeg: false, mintBurn7d: { knownNetUsd: 0, knownGrossUsd: 0, completeness: "complete" }, pegScore: null, backing: null,
      governance: null, redemptionScore: null, change24h: null,
    });
    expect(data.flow7d).toBe(0);
    expect(data.flow7dSource).toBe("mint-burn");
    expect(data.liquidityScore).toBe(0);
    expect(data.sparklineData).toBeNull();
    const markup = renderToStaticMarkup(<StablecoinCard data={data} />);
    expect(markup).toContain("7D NET MINT/BURN");
    expect(markup).toContain("$0");
    expect(markup).not.toContain("7D SUPPLY DELTA");
  });

  it("never renders a signed net for a partial window: the known gross is a lower bound", () => {
    const base = {
      coin: {
        name: "Mixed", symbol: "MIX", price: 1,
        circulating: { peggedUSD: 100_000_000 }, circulatingPrevWeek: { peggedUSD: 90_000_000 },
      },
      dexLiquidityScore: null, dewsBand: null, grade: null, sparklineRows: [],
      hasActiveDepeg: false, pegScore: null, backing: null,
      governance: null, redemptionScore: null, change24h: null,
    };
    // Unknown-value mint plus a priced $1M burn: the known net is -$1M, but that is not a bound.
    const partial = deriveStablecoinOgCardData({
      ...base,
      mintBurn7d: { knownNetUsd: -1_000_000, knownGrossUsd: 1_000_000, completeness: "partial" },
    });
    expect(partial).toMatchObject({ flow7d: 1_000_000, flow7dSource: "mint-burn-partial-gross" });
    const partialMarkup = renderToStaticMarkup(<StablecoinCard data={partial} />);
    expect(partialMarkup).toContain("7D GROSS (MIN)");
    expect(partialMarkup).toContain("$1.0M+");
    expect(partialMarkup).not.toContain("-$1.0M");
    expect(partialMarkup).not.toContain("7D SUPPLY DELTA");

    const legacy = deriveStablecoinOgCardData({
      ...base,
      mintBurn7d: { knownNetUsd: -1_000_000, knownGrossUsd: 1_000_000, completeness: "unknown" },
    });
    expect(legacy).toMatchObject({ flow7d: -1_000_000, flow7dSource: "mint-burn-coverage-unknown" });
    expect(renderToStaticMarkup(<StablecoinCard data={legacy} />)).toContain("7D NET (UNVERIFIED)");
  });

  it("labels nominal par and draws no price line from legacy supply-history par rows", () => {
    const input = {
      coin: {
        name: "Par", symbol: "PAR", price: 1, priceSource: "protocol-par", priceObservedAtMode: "nominal_reference",
        circulating: { peggedUSD: 100 },
      },
      dexLiquidityScore: null, dewsBand: null, grade: null,
      sparklineRows: [{ price: 1 }, { price: 1 }, { price: 1 }],
      hasActiveDepeg: false, mintBurn7d: null, pegScore: null, backing: null,
      governance: null, redemptionScore: null, change24h: null,
    };
    const nominal = deriveStablecoinOgCardData(input);
    expect(nominal).toMatchObject({ pegPrice: 1, pegPriceIsNominal: true, sparklineData: null });
    const nominalMarkup = renderToStaticMarkup(<StablecoinCard data={nominal} />);
    expect(nominalMarkup).toContain("NOMINAL PAR");
    expect(nominalMarkup).not.toContain(">PRICE<");

    const observed = deriveStablecoinOgCardData({
      ...input,
      coin: { ...input.coin, priceSource: "binance", priceObservedAtMode: "upstream" },
    });
    expect(observed).toMatchObject({ pegPriceIsNominal: false, sparklineData: [1, 1, 1] });
    const observedMarkup = renderToStaticMarkup(<StablecoinCard data={observed} />);
    expect(observedMarkup).toContain(">PRICE<");
    expect(observedMarkup).not.toContain("NOMINAL PAR");
  });

  describe("peg-analytics cache hits", () => {
    const nowSec = Math.floor(Date.now() / 1000);

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

    function activeV9(updatedAt = nowSec) {
      const snapshot = makeWorkerReportCardsV9Response({
        lifecycle: "active",
        asOfSec: updatedAt - 60,
        updatedAt,
        cards: [
          makeWorkerV9Card({
            id: "usdt-tether",
            score: 88,
            grade: "A+",
          }),
        ],
      });
      return {
        kind: "v9" as const,
        marker: {
          policyId: snapshot.safetyScoreIdentity.policyId,
          policyDigest: snapshot.safetyScoreIdentity.policyDigest,
          evaluationBuildDigest: snapshot.safetyScoreIdentity.evaluationBuildDigest,
          methodologyVersion: snapshot.safetyScoreIdentity.methodologyVersion,
        },
        activationUpdatedAt: nowSec - 30,
        snapshot,
      };
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

    it("reinitializes WASM only after isolate-local state is reset", async () => {
      const db = makeOgDb([makeAsset({ id: "usdt-tether" })]);
      const initMock = vi.mocked(initSatoriStandalone);
      initMock.mockClear();

      await handleOg(db, "/api/og/stablecoin/usdt-tether");
      await handleOg(db, "/api/og/stablecoin/usdt-tether");
      expect(initMock).toHaveBeenCalledTimes(1);

      resetOgWasmInitializationForTests();
      await handleOg(db, "/api/og/stablecoin/usdt-tether");
      expect(initMock).toHaveBeenCalledTimes(2);
    });

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
      // The cache carries 87 (nav-inclusive for peg-summary), but OG cards omit
      // nav-token peg stats and therefore still render "—".
      expect(data.pegScore).toBeNull();
    });

    it("renders a degraded card and skips the peg analytics event scan on cache miss", async () => {
      const stablecoinsValue = JSON.stringify({
        peggedAssets: [makeAsset({ id: "usdt-tether", symbol: "USDT" })],
      });
      const db = mockD1([
        {
          match: "cache",
          rows: [{ key: "stablecoins", value: stablecoinsValue, updated_at: nowSec }],
        },
        { match: "dex_liquidity", rows: [] },
        { match: "stress_signals", rows: [] },
        { match: "supply_history", rows: [] },
        { match: "depeg_events", rows: [] },
        { match: "mint_burn_hourly", rows: [] },
      ]);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const res = await handleOg(db, "/api/og/stablecoin/usdt-tether");

      expect(res?.status).toBe(200);
      expect(res?.headers.get("Content-Type")).toBe("image/png");
      const calls = vi.mocked(satoriStandalone).mock.calls;
      const element = calls[calls.length - 1]?.[0] as React.ReactElement<{
        data: StablecoinCardData;
      }>;
      expect(element.type).toBe(StablecoinCard);
      expect(element.props.data.pegScore).toBeNull();
      expect(
        db.getHistory().filter((entry) => entry.sql.includes("pharos:peg-analytics:recent-depeg-events")),
      ).toHaveLength(0);

      const logRecord = JSON.parse(String(warnSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(logRecord).toMatchObject({
        event: "og.peg_cache_miss",
        metadata: { stablecoinId: "usdt-tether" },
      });
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
        grade: "Unavailable",
        lastUpdated: expect.stringContaining("Safety DEGRADED: V9 safety score unavailable"),
      });
    });

    it("renders the complete active V9 publication with explicit model provenance", async () => {
      vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex")
        .mockResolvedValue(activeV9());
      const db = makeOgDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);

      const res = await handleOg(db, "/api/og/stablecoin/usdt-tether");

      expect(res?.headers.get("X-Safety-Score-Model")).toBe("v9");
      expect(res?.headers.get("X-Safety-Score-Status")).toBe("current");
      const calls = vi.mocked(satoriStandalone).mock.calls;
      const element = calls[calls.length - 1]?.[0] as React.ReactElement<{
        data: StablecoinCardData;
      }>;
      expect(element.props.data).toMatchObject({
        grade: "A+",
        safetyModel: "v9",
      });
      expect(renderToStaticMarkup(element)).toContain("V9 GRADE");
    });

    it("renders pipeline gaps without a fabricated NR and visibly labels partial ratings", async () => {
      const source = activeV9();
      source.snapshot.cards = [makeReportCardsV9PipelineGapCard("control", "A", { id: "usdt-tether" })];
      vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue(source);
      const db = makeOgDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
      await handleOg(db, "/api/og/stablecoin/usdt-tether");
      let calls = vi.mocked(satoriStandalone).mock.calls;
      let element = calls[calls.length - 1]?.[0] as React.ReactElement<{ data: StablecoinCardData }>;
      expect(element.props.data.grade).toBe("Pipeline gap");
      expect(renderToStaticMarkup(element)).not.toContain(">NR<");
      source.snapshot.cards = [makeReportCardsV9PartialCard("exit", "B", { id: "usdt-tether" })];
      await handleOg(db, "/api/og/stablecoin/usdt-tether");
      calls = vi.mocked(satoriStandalone).mock.calls;
      element = calls[calls.length - 1]?.[0] as React.ReactElement<{ data: StablecoinCardData }>;
      expect(renderToStaticMarkup(element)).toContain("Partial evidence: pipeline gap");
    });

    it("degrades a structurally valid active V9 publication after two producer cadences", async () => {
      vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex")
        .mockResolvedValue(activeV9(nowSec - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - 1));
      const db = makeOgDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);

      const res = await handleOg(db, "/api/og/stablecoin/usdt-tether");

      expect(res?.headers.get("X-Safety-Score-Model")).toBe("v9");
      expect(res?.headers.get("X-Safety-Score-Status")).toBe("degraded");
      expect(res?.headers.get("X-Safety-Score-Reason")).toBe("stale-cache");
      const calls = vi.mocked(satoriStandalone).mock.calls;
      const element = calls[calls.length - 1]?.[0] as React.ReactElement<{
        data: StablecoinCardData;
      }>;
      expect(element.props.data).toMatchObject({
        grade: "Unavailable",
        safetyModel: null,
      });
    });

    it.each([60, SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 1, -1])("publishes safety freshness against its accepted generation at age %s", async (age) => {
      vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
      const source = activeV9(nowSec - age);
      vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue(source);
      const response = await handleOg(makeOgDb([makeAsset({ id: "usdt-tether" })]), "/api/og/safety-scores");
      expect(response?.headers.get("X-Safety-Score-Status")).toBe(age === 60 ? "current" : "degraded");
      expect(response?.headers.get("X-Safety-Score-Updated-At")).toBe(String(source.snapshot.updatedAt));
      expect(response?.headers.get("X-Safety-Score-Generation")).toBe(source.snapshot.safetyScoreIdentity.publicationGenerationId);
      expect(response?.headers.get("X-Safety-Score-Assessed-At")).toBe(String(nowSec));
      expect(response?.headers.get("X-Safety-Score-Freshness-Budget")).toBe(String(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC));
    });

    it("renders a degraded safety aggregate as unavailable rather than 0.0", async () => {
      const db = makeOgDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);

      const res = await handleOg(db, "/api/og/safety-scores");

      expect(res?.headers.get("X-Safety-Score-Status")).toBe("degraded");
      const calls = vi.mocked(satoriStandalone).mock.calls;
      const element = calls[calls.length - 1]?.[0] as React.ReactElement<{
        data: SafetyScoresCardData;
      }>;
      expect(element.props.data.pulseScore).toBeNull();
      expect(element.props.data.coverageRatio).toBeNull();
      const markup = renderToStaticMarkup(element);
      expect(markup).toContain("NR");
      expect(markup).toContain("Safety score unavailable");
      expect(markup).not.toContain(">0%");
      // Match a rendered text node, not the raw markup: the card frame inlines the brand-mark
      // SVG, whose path geometry legitimately contains "0.0" inside `d="…"` coordinates.
      expect(markup).not.toContain(">0.0");
    });
    it.each(["missing", "stale", "observed-zero"] as const)("preserves safety coverage availability for %s source", async (state) => {
      if (state !== "missing") {
        const source = activeV9(state === "stale" ? nowSec - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - 1 : nowSec);
        source.snapshot.cards = [makeReportCardsV9PipelineGapCard("control", "A", { id: "usdt-tether" })];
        vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue(source);
      }
      await handleOg(makeOgDb([makeAsset({ id: "usdt-tether" })]), "/api/og/safety-scores");
      const calls = vi.mocked(satoriStandalone).mock.calls;
      const element = calls[calls.length - 1][0] as React.ReactElement<{ data: SafetyScoresCardData }>;
      expect(element.props.data.coverageRatio).toBe(state === "observed-zero" ? 0 : null);
      const markup = renderToStaticMarkup(element);
      if (state === "observed-zero") expect(markup).toContain(">0%");
      else expect(markup).not.toContain(">0%");
    });

    it("requires a fresh exactly adjacent snapshot pair for 24h price change", async () => {
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
        { match: "current_snapshot", rows: [], first: { current_price: 1.02, current_date: nowSec - 3600, prev_day_price: 0.99, prev_day_date: nowSec - 3600 - 86400 } },
        { match: "supply_history", rows: [{ price: 1.02 }, { price: 0.99 }] },
        { match: "depeg_events", rows: [] },
        { match: "mint_burn_hourly", rows: [] },
      ]);

      const data = await renderedCardData(db, "/api/og/stablecoin/usdt-tether");

      expect(data.change24h).toBeCloseTo(3.0303, 4);
    });

    it.each([
      ["stale", nowSec - 2 * 86400, nowSec - 3 * 86400, 0.99],
      ["missing yesterday", nowSec - 3600, null, null],
      ["older baseline", nowSec - 3600, nowSec - 3600 - 2 * 86400, 0.99],
    ] as const)("omits a %s market price pair despite fresh safety publication", async (_label, current_date, prev_day_date, prev_day_price) => {
      vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue(activeV9());
      const marketAt = nowSec - 2 * 86400;
      const db = mockD1([
        { match: "cache", rows: [
          { key: "stablecoins", value: JSON.stringify({ peggedAssets: [makeAsset({ id: "usdt-tether", priceObservedAt: marketAt })] }), updated_at: marketAt },
          { key: "peg-analytics", value: JSON.stringify({ computedAtSec: nowSec, pegData: [{ id: "usdt-tether", pegScore: 99 }] }), updated_at: nowSec },
        ] },
        { match: "dex_liquidity", rows: [] }, { match: "stress_signals", rows: [] },
        { match: "current_snapshot", rows: [], first: { current_price: 1.02, current_date, prev_day_date, prev_day_price } },
        { match: "supply_history", rows: [] }, { match: "depeg_events", rows: [] }, { match: "mint_burn_hourly", rows: [] },
      ]);
      const data = await renderedCardData(db, "/api/og/stablecoin/usdt-tether");
      expect(data.change24h).toBeNull();
      expect(data.lastUpdated).toContain("24h price pair unavailable");
      expect(data.lastUpdated).toContain("(stale; budget");
      expect(data.lastUpdated).toContain(new Date(marketAt * 1000).toISOString().slice(0, 16).replace("T", " "));
      expect(data.grade).toBe("A+");
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
          flow7dSource: "mint-burn",
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

  it("converts the chain 7d ratio to a percentage before rendering", async () => {
    // Regression: aggregateChains() emits change7dPct as a 0-1 Ratio, but the card
    // renders a "%" suffix. Forwarding the ratio unconverted printed a +8% week as
    // "0.1% 7d" on every chain OG image.
    const db = makeChainOgDb([
      makeAsset({
        chainCirculating: {
          Ethereum: {
            current: 108_000_000,
            circulatingPrevDay: 108_000_000,
            circulatingPrevWeek: 100_000_000,
            circulatingPrevMonth: 100_000_000,
          },
        },
        chains: ["Ethereum"],
      }),
    ]);
    const satoriMock = vi.mocked(satoriStandalone);
    satoriMock.mockClear();

    const res = await handleOg(db, "/api/og/chain/ethereum");
    expect(res?.status).toBe(200);

    const element = satoriMock.mock.calls[satoriMock.mock.calls.length - 1]?.[0] as React.ReactElement<{
      data: ChainCardData;
    }>;
    expect(element.props.data.change7dPercent).toBeCloseTo(8, 6);
    expect(renderToStaticMarkup(element)).toContain("8.0% 7d");
  });

  it("returns 404 for an id outside CHAIN_META", async () => {
    const res = await handleOg(mockD1([]), "/api/og/chain/not-a-chain");
    expect(res?.status).toBe(404);
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

  it("renders the owner's completed generation instead of superseded or unpublished signals", async () => {
    const now = Math.floor(Date.now() / 1000);
    const completedAt = now - 60;
    const current = { stablecoin_id: "usdt-tether", score: 30, band: "WARNING", signals_json: "{}", computed_at: completedAt };
    const superseded = { ...current, band: "CALM", computed_at: completedAt - 900 };
    const unpublished = { ...current, band: "DANGER", computed_at: now };
    const pointer = {
      key: "dews:published-generation",
      updated_at: completedAt,
      value: JSON.stringify({
        updatedAt: completedAt, source: "compute-dews", publishStatus: "published", coverageVersion: 2,
        expectedRowCount: 1, stablecoinIdsDigest: buildDewsStablecoinIdsDigest([current.stablecoin_id]),
      }),
    };
    const db = mockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: ["dews:published-generation"], rows: [pointer], first: pointer },
      { match: "pharos:stress-signals:latest-all", rows: [superseded] },
      { match: "pharos:stress-signals:latest-one", rows: [superseded], first: superseded },
      { match: "FROM stress_signal_publication_rows", rows: [current], first: current },
      { match: "FROM stress_signals", rows: [unpublished], first: unpublished },
      { match: "cache", rows: [{
        key: "stablecoins", value: JSON.stringify({ peggedAssets: [makeAsset({ id: "usdt-tether" })] }), updated_at: now,
      }] },
      { match: "dex_liquidity", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "mint_burn_hourly", rows: [] },
      { match: "stability_index_samples", rows: [] },
    ]);
    const options = { staleAfterSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals * 8 };
    expect((await loadStressSignalCurrentRows(db, now, options)).results).toEqual([current]);
    expect((await loadStressSignalCurrentRowForCoin(db, current.stablecoin_id, now, options))?.band).toBe("WARNING");
    const aggregate = await captureDepegData(db);
    expect(aggregate.dewsDistribution).toEqual({ danger: 0, alert: 0, warning: 1, normal: 0 });
    await handleOg(db, "/api/og/stablecoin/usdt-tether");
    const element = vi.mocked(satoriStandalone).mock.calls[vi.mocked(satoriStandalone).mock.calls.length - 1]?.[0] as React.ReactElement<{ data: StablecoinCardData }>;
    expect(element.props.data.dewsBand).toBe("WARNING");
  });

  it("uses fresh live peg observations independently of the DEWS and incident cohorts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const assets = [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 1, priceObservedAt: now - 30 }),
      makeAsset({ id: "usdc-circle", symbol: "USDC", price: 0.99, priceObservedAt: now - 30 }),
      makeAsset({ id: "dai-makerdao", symbol: "DAI", price: null, priceObservedAt: now - 30 }),
      makeAsset({ id: "usds-sky", symbol: "USDS", price: 1, circulating: {}, priceObservedAt: now - 30 }),
    ];
    const db = mockD1([
      { match: "FROM cache WHERE key = ?", rows: [{ key: "stablecoins", value: JSON.stringify({ peggedAssets: assets }), updated_at: now - 30 }] },
      { match: "stability_index_samples", first: { score: 88.2, band: "BEDROCK", stored_at: now - 60 }, rows: [] },
      { match: "stress_signals", rows: [{ stablecoin_id: "usdt-tether", band: "WATCH", computed_at: now - 60 }] },
      { match: "peak_deviation_bps", rows: [
        { stablecoin_id: "usdc-circle", symbol: "USDC", direction: "below", peak_deviation_bps: 5000, peg_reference: 1 },
        { stablecoin_id: "usdc-circle", symbol: "USDC", direction: "below", peak_deviation_bps: 4000, peg_reference: 1 },
        { stablecoin_id: "usds-sky", symbol: "USDS", direction: "below", peak_deviation_bps: 6000, peg_reference: 1 },
        { stablecoin_id: "removed", symbol: "REMOVED", direction: "below", peak_deviation_bps: 9000, peg_reference: 1 },
        { stablecoin_id: "usr-resolv", symbol: "USR", direction: "below", peak_deviation_bps: 9000, peg_reference: 1 },
      ] },
      { match: "ended_at IS NOT NULL", rows: [] },
      { match: "started_at >", rows: [], first: { count: 4 } },
    ]);
    const data = await captureDepegData(db);
    expect(data).toMatchObject({ coinsAtPeg: 1, totalCoins: 2, activeDepegCount: 2, psiScore: 88.2, newToday: 4 });
    expect(data.activeDepegs[0]).toMatchObject({ symbol: "USDC", deviationBps: -100, peakBps: -5000 });
    const markup = renderToStaticMarkup(<DepegCard data={data} />);
    expect(markup).toContain("-100 bps (peak -5000)");
    expect(markup).not.toContain("-5000 bps</span>");
  });

  it("withholds the at-peg statistic and PSI when observations are absent instead of clamping cohorts", async () => {
    const db = mockD1([
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
      { match: "stability_index_samples", rows: [], first: null },
      { match: "stress_signals", rows: [{ band: "DANGER" }, { band: "ALERT" }] },
      { match: "peak_deviation_bps", rows: [] },
      { match: "ended_at IS NOT NULL", rows: [] },
      { match: "started_at >", rows: [], first: { count: 0 } },
    ]);
    const data = await captureDepegData(db);
    expect(data).toMatchObject({ totalCoins: 0, coinsAtPeg: null, psiScore: null, psiBand: null });
    expect(renderToStaticMarkup(<DepegCard data={data} />)).toContain("Unavailable");
  });

  it.each([
    ["recovered-primary", null, 1], ["recovered-dex", null, 1], ["recovered-native", null, 1],
    [null, 1, 1], [null, null, 0], ["coverage-lost-supply", null, 0],
    ["superseded-direction", 1, 0], ["orphan-tracking-removed", 1, 0], ["unknown", 1, 0],
  ] as const)("counts only classified OG recoveries %s with price %s", async (close_reason, recovery_price, expected) => {
    const now = Math.floor(Date.now() / 1000);
    const data = await captureDepegData(mockD1([
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
      { match: "ended_at IS NOT NULL", rows: [{ ended_at: now - 60, close_reason, recovery_price }] },
      { match: "stability_index_samples", rows: [], first: null },
      { match: "stress_signals", rows: [] },
      { match: "peak_deviation_bps", rows: [] },
      { match: "started_at >", rows: [], first: { count: 0 } },
    ]));
    expect(data.recoveredToday).toBe(expected);
  });

  it("ranks current deviations rather than lifetime peaks and labels stale quotes historical", async () => {
    const now = Math.floor(Date.now() / 1000);
    const assets = [
      makeAsset({ id: "usdt-tether", price: 0.98, priceObservedAt: now - 30 }),
      makeAsset({ id: "usdc-circle", price: 0.99, priceObservedAt: now - 30 }),
      makeAsset({ id: "dai-makerdao", price: 0.5, priceObservedAt: now - 86400 }),
    ];
    const data = await captureDepegData(mockD1([
      { match: "FROM cache WHERE key = ?", rows: [{ key: "stablecoins", value: JSON.stringify({ peggedAssets: assets }), updated_at: now - 30 }] },
      { match: "peak_deviation_bps", rows: [
        { stablecoin_id: "usdc-circle", symbol: "USDC", direction: "below", peak_deviation_bps: 5000, peg_reference: 1 },
        { stablecoin_id: "usdt-tether", symbol: "USDT", direction: "below", peak_deviation_bps: 300, peg_reference: 1 },
        { stablecoin_id: "dai-makerdao", symbol: "DAI", direction: "below", peak_deviation_bps: 9000, peg_reference: 1 },
      ] },
      { match: "stability_index_samples", first: { score: 80, band: "STEADY", stored_at: now - 86400 }, rows: [] },
      { match: "stress_signals", rows: [] },
      { match: "ended_at IS NOT NULL", rows: [] },
      { match: "started_at >", rows: [], first: { count: 0 } },
    ]));
    expect(data.activeDepegs.map((row) => row.symbol)).toEqual(["USDT", "USDC", "DAI"]);
    expect(data.activeDepegs[2]).toMatchObject({ deviationBps: null, peakBps: -9000 });
    expect(data.psiScore).toBeNull();
    expect(data.psiBand).toBeNull();
    expect(data.lastUpdated).toContain("(stale; budget");
    expect(renderToStaticMarkup(<DepegCard data={data} />)).toContain("Current unavailable; peak -9000 bps");
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

  it.each([
    ["linear increase", 80, 100, 20],
    ["late reversal", 100, 90, -10],
    ["missing baseline", null, 90, null],
  ] as const)("uses a dated 24-hour baseline, not a rolling mean, for %s", async (label, firstScore, lastScore, expected) => {
    const sourceAt = nowSec - 300;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare("INSERT INTO stability_index_samples (stored_at, score, band, components, input_snapshot) VALUES (?, ?, 'BEDROCK', '{}', '{}')");
      if (firstScore != null) {
        for (let step = 0; step < 48; step++) {
          const score = label === "linear increase" ? firstScore + step * 20 / 48 : step === 0 ? firstScore : 65;
          insert.run(sourceAt - 86400 + step * 1800, score);
        }
      }
      insert.run(sourceAt, lastScore);
      const response = await handleOg(db, "/api/og/stability-index");
      const calls = vi.mocked(satoriStandalone).mock.calls;
      const element = calls[calls.length - 1][0] as React.ReactElement<{ data: StabilityIndexCardData }>;
      expect(element.type).toBe(StabilityIndexCard);
      expect(element.props.data.delta24h).toBe(expected);
      expect(response?.headers.get("X-Data-Updated-At")).toBe(String(sourceAt));
      expect(response?.headers.get("X-Data-Assessed-At")).toBe(String(nowSec));
      expect(response?.headers.get("X-Data-Freshness-Budget")).toBe(String(API_FRESHNESS_MAX_AGE_SEC.stabilityIndex));
      const markup = renderToStaticMarkup(element);
      expect(markup).toContain(expected == null ? "24h change unavailable" : `${expected > 0 ? "+" : ""}${expected.toFixed(2)} 24h`);
    } finally {
      sqlite.close();
    }
  });

  it("preserves unavailable window aggregates and insufficient history without synthetic observations", async () => {
    const db = mockD1([
      { match: "WHERE stored_at <= ?", rows: [], first: null },
      {
        match: "stored_at DESC LIMIT 1",
        rows: [],
        first: { score: 73.5, band: "STEADY", stored_at: nowSec },
      },
      { match: "AVG(score)", rows: [], first: { avg: null } },
      // One history row cannot establish a trend.
      { match: "FROM stability_index ORDER BY computed_at", rows: [{ score: 80 }] },
      { match: "MAX(score)", rows: [], first: { max: null } },
      { match: "MIN(score)", rows: [], first: { min: null } },
    ]);

    const data = await captureStabilityData(db);
    expect(data.psiScore).toBe(73.5);
    expect(data.psiBand).toBe("STEADY");
    expect(data.delta24h).toBeNull();
    expect(data.avg7d).toBeNull();
    expect(data.allTimeHigh).toBeNull();
    expect(data.allTimeLow).toBeNull();
    expect(data.sparklineData).toBeNull();
    const markup = renderToStaticMarkup(<StabilityIndexCard data={data} />);
    expect(markup).toContain("7D AVG: —");
    expect(markup).toContain("History unavailable");
    expect(data.bands.find((b) => b.name === "STEADY")?.active).toBe(true);
    expect(data.lastUpdated).toContain(new Date(nowSec * 1000).toISOString().slice(0, 16).replace("T", " "));
  });

  it("does not re-certify an old PSI sample with the render clock", async () => {
    const sourceAt = nowSec - 8 * 86400;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const db = mockD1([
      { match: "stored_at DESC LIMIT 1", rows: [], first: { score: 73.5, band: "STEADY", stored_at: sourceAt } },
      { match: "AVG(score)", rows: [], first: { avg: null } },
      { match: "FROM stability_index ORDER BY computed_at", rows: [] },
      { match: "MAX(score)", rows: [], first: { max: null } },
      { match: "MIN(score)", rows: [], first: { min: null } },
    ]);
    const response = await handleOg(db, "/api/og/stability-index");
    expect(response?.headers.get("X-Data-Updated-At")).toBe(String(sourceAt));
    expect(response?.headers.get("X-Data-Freshness")).toBe("stale");
    expect(response?.headers.get("X-Data-Assessed-At")).toBe(String(nowSec));
    expect(response?.headers.get("X-Data-Freshness-Budget")).toBe(String(API_FRESHNESS_MAX_AGE_SEC.stabilityIndex));
    const calls = vi.mocked(satoriStandalone).mock.calls;
    const markup = renderToStaticMarkup(calls[calls.length - 1][0]);
    expect(markup).toContain("Stability index unavailable");
    expect(markup).toContain("(stale; budget");
    expect(markup).toContain(new Date(sourceAt * 1000).toISOString().slice(0, 16).replace("T", " "));
    expect(markup).not.toContain(">73.5<");
  });

  it("renders unavailable without inventing a zero score or MELTDOWN band when no sample exists", async () => {
    const db = mockD1([
      { match: "stored_at DESC LIMIT 1", rows: [], first: null },
      { match: "AVG(score)", rows: [], first: { avg: null } },
      { match: "FROM stability_index ORDER BY computed_at", rows: [] },
      { match: "MAX(score)", rows: [], first: { max: null } },
      { match: "MIN(score)", rows: [], first: { min: null } },
    ]);

    const res = await handleOg(db, "/api/og/stability-index");
    expect(res?.status).toBe(200);
    const calls = vi.mocked(satoriStandalone).mock.calls;
    const element = calls[calls.length - 1]?.[0] as React.ReactElement;
    const markup = renderToStaticMarkup(element);

    expect(markup).toContain("Stability index unavailable");
    expect(markup).not.toContain("MELTDOWN");
    expect(markup).not.toContain(">0.0<");
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
    flow7dSource: "mint-burn",
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

  it.each([null, 0])("renders unavailable evidence without converting flow %s to another fact", async (flow7d) => {
    const data: StablecoinCardData = {
      ...calmCoin, pegPrice: null, dewsBand: null, liquidityScore: null,
      mcap: null, flow7d, flow7dSource: flow7d == null ? null : "mint-burn",
      sparklineData: null, backing: null, governance: null,
    };
    const svg = await satori(<StablecoinCard data={data} />, {
      width: 1200, height: 628, fonts, embedFont: false,
    });
    const visibleText = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]).join(" ").replace(/\s+/g, " ");
    expect(visibleText).toContain("Price history unavailable");
    expect(visibleText).not.toMatch(/\$\s*1\s*\.\s*0000/);
    expect(visibleText).not.toContain("CALM");
    expect(visibleText).not.toMatch(/\+\s*\$/);
    if (flow7d === 0) expect(visibleText).toMatch(/\$\s*0/);
    else expect(visibleText).not.toMatch(/\$\s*0/);
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

  it("renders the safety-scores unavailable aggregate without a numeric zero", async () => {
    const svg = await renderSvg(
      <SafetyScoresCard
        data={{
          gradeDistribution: {
            "A+": 0,
            A: 0,
            "A-": 0,
            "B+": 0,
            B: 0,
            "B-": 0,
            "C+": 0,
            C: 0,
            "C-": 0,
            D: 0,
            F: 0,
            NR: 0,
          },
          pulseGrade: null,
          pulseScore: null,
          coverageRatio: 0,
          totalCoins: 401,
          topPerformers: [],
          bottomPerformers: [],
          trend: null,
          safetyModel: null,
          lastUpdated: "DEGRADED: V9 safety score unavailable",
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
          change7dPercent: 1.8,
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
          change7dPercent: 0,
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

  it("renders unavailable chain history without inventing zero growth", () => {
    const markup = renderToStaticMarkup(<ChainCard data={{
      name: "Ethereum", totalUsd: 100, change7dPercent: null, stablecoinCount: 1,
      dominanceShare: 1, healthScore: null, healthBand: null, topStablecoins: [],
    }} />);
    expect(markup).toContain("— 7d");
    expect(markup).not.toContain("0.0% 7d");
  });

  it("renders the chain card without health data", async () => {
    const svg = await renderSvg(
      <ChainCard
        data={{
          name: "Obscure Chain",
          totalUsd: 1_200_000,
          change7dPercent: -12.4,
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
