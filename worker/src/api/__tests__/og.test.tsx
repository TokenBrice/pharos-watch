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
import satoriStandalone from "satori/standalone";
import { createMockD1Preset, mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import type { StablecoinData } from "@shared/types/supply";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { getMintBurnConfigsForStablecoin, MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { mintBurnScanCoverageStatements, mintBurnScanFingerprint } from "../../lib/mint-burn-pipeline/scan-coverage";
import { mintBurnConfigKey } from "../../lib/mint-burn-contract-identity";
import * as activeSafetyScoreSource from "../../lib/safety-score-index";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../lib/safety-score-v9/consumer-freshness";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import { deriveStablecoinOgCardData, handleOg } from "../og";
import { resetOgWasmInitializationForTests } from "../../lib/og-render";
import { SOCIAL_PREVIEW_WIDTH, SOCIAL_PREVIEW_HEIGHT } from "@shared/lib/social-preview";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { handleScorecardOg } from "../og-scorecard";

vi.mock("../og-scorecard", () => ({
  handleScorecardOg: vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } })),
}));
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
import { DepegCard } from "../../lib/og-templates/depeg-card";
import { ChainCard, ChainUnavailableCard, type ChainCardData } from "../../lib/og-templates/chain-card";

afterEach(() => {
  resetOgWasmInitializationForTests();
  vi.restoreAllMocks();
});

function lastOgElement<T = unknown>() {
  const calls = vi.mocked(satoriStandalone).mock.calls;
  return calls[calls.length - 1]?.[0] as React.ReactElement<{ data: T }>;
}

const EMPTY_OG_TABLES: MockTableConfig[] = [
  { match: "stress_signals", rows: [] }, { match: "supply_history", rows: [] },
  { match: "depeg_events", rows: [] }, { match: "mint_burn_hourly", rows: [] }, { match: "mint_burn_scan_coverage", rows: [] },
  { match: "FROM mint_burn_admission", rows: [] }, { match: "FROM mint_burn_publication_policy", rows: [] },
  { match: "pharos:mint-burn-legacy-evidence", rows: [] },
];

function marketTable(assets: StablecoinData[], updatedAt: number, fxFallbackRates?: Record<string, number>): MockTableConfig {
  return {
    match: "FROM cache WHERE key = ?",
    rows: [{ key: "stablecoins", value: JSON.stringify({ peggedAssets: assets, fxFallbackRates }), updated_at: updatedAt }],
  };
}

function makeOgDb(assets = [makeAsset()], marketAt = Math.floor(Date.now() / 1000)) {
  return mockD1([marketTable(assets, marketAt), ...EMPTY_OG_TABLES]);
}

function advanceRenderClock(nowSec: number, elapsed: number) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
  vi.mocked(satoriStandalone).mockImplementationOnce(async () => {
    clock.mockReturnValue((nowSec + elapsed) * 1000);
    return "<svg></svg>";
  });
}

async function captureOgData<T>(db: D1Database, path: string, template: React.ComponentType<{ data: T }>): Promise<T> {
  vi.mocked(satoriStandalone).mockClear();
  const response = await handleOg(db, path);
  expect(response?.status).toBe(200);
  const element = lastOgElement<T>();
  expect(element.type).toBe(template);
  return element.props.data;
}

function expectUnavailable(response: Response | null | undefined, reason?: string) {
  expect(response?.status, reason).toBe(503);
  expect(response?.headers.get("Cache-Control"), reason).toBe("no-store");
}

describe("versioned OG routing", () => {
  it.each(["usdt-tether", "safety-scores"])("dispatches the versioned scorecard subject %s", async (id) => {
    const db = mockD1([]);
    const response = await handleOg(db, API_PATHS.ogScorecard(id));
    expect(handleScorecardOg).toHaveBeenLastCalledWith(db, id);
    expect(response?.headers.get("Content-Type")).toBe("image/png");
  });

  it.each(["/api/og/stablecoin/%E0%A4%A", "/api/og/v2/stablecoin/%E0%A4%A", "/api/og/v2/scorecard/%E0%A4%A"])("rejects malformed captures on %s", async (path) => {
    expect((await handleOg(mockD1([]), path))?.status).toBe(400);
  });

  it.each(["depeg", "stability-index", "safety-scores", "chain/ethereum"])("preserves legacy and versioned %s routes", async (suffix) => {
    const db = mockD1([]);
    const legacy = await handleOg(db, `/api/og/${suffix}`);
    const versioned = await handleOg(db, `/api/og/v2/${suffix}`);
    expect(legacy).not.toBeNull();
    expect(versioned?.status).toBe(legacy?.status);
  });
});

describe("stablecoin OG card data", () => {
  it.each(["%75sdt-tether", "usdt%2dtether", "%2575sdt-tether", "usdt%2Ftether"])("rejects encoded path id %s before reading or rendering", async (id) => {
    for (const prefix of ["/api/og/stablecoin/", "/api/og/v2/stablecoin/"]) {
      const db = mockD1([]);
      vi.mocked(satoriStandalone).mockClear();
      const response = await handleOg(db, `${prefix}${id}`);
      expect(response?.status).toBe(404);
      expect(db.getHistory()).toHaveLength(0);
      expect(satoriStandalone).not.toHaveBeenCalled();
    }
  });

  it("derives flow7d and sparkline data", () => {
    const data = deriveStablecoinOgCardData({
      coin: {
        name: "USD Coin",
        symbol: "USDC",
        price: 1,
        circulating: { peggedUSD: 100_000_000 },
        circulatingPrevWeek: { peggedUSD: 95_000_000 },
      },
      dewsBand: "CALM",
      grade: "A",
      sparklineRows: [{ price: 0.9998 }, { price: 1.0001 }],
      hasActiveDepeg: false,
      mintBurn7d: null,
    });

    expect(data.flow7d).toBe(5_000_000);
    expect(data.flow7dSource).toBe("supply-delta");
    expect(data.sparklineData).toEqual([1.0001, 0.9998]);
    const markup = renderToStaticMarkup(<StablecoinCard data={data} />);
    expect(markup).toContain("PUBLISHED SAFETY GRADE");
    expect(markup).not.toContain("PEG SCORE");
    expect(markup).not.toContain("LIQUIDITY");
    expect(markup).not.toContain("REDEMPTION");
  });
  it("preserves unavailable facts instead of inventing healthy readings or full-cap inflow", () => {
    const input = {
      coin: { name: "Unknown", symbol: "UNK", circulating: { peggedUSD: 100_000_000 } },
      dewsBand: null,
      grade: null,
      sparklineRows: [],
      hasActiveDepeg: false,
      mintBurn7d: null,
    };
    const data = deriveStablecoinOgCardData(input);
    expect(data).toMatchObject({
      pegPrice: null, dewsBand: null,
      flow7d: null, flow7dSource: null, sparklineData: null,
    });
    const markup = renderToStaticMarkup(<StablecoinCard data={data} />);
    expect(markup).not.toContain("$1.0000");
    expect(markup).not.toContain("CALM");
    expect(markup).not.toContain("+$");
    expect(markup).not.toContain("CeFi");
    expect(markup).toContain("Price history unavailable");
    expect(deriveStablecoinOgCardData({ ...input, coin: { ...input.coin, circulating: {} } }).flow7d).toBeNull();
  });

  it("keeps measured zero flow distinct from absence", () => {
    const data = deriveStablecoinOgCardData({
      coin: {
        name: "Zero", symbol: "ZERO", price: 1,
        circulating: { peggedUSD: 100 }, circulatingPrevWeek: { peggedUSD: 50 },
      },
      dewsBand: null, grade: null, sparklineRows: [{ price: 1 }],
      hasActiveDepeg: false, mintBurn7d: { knownNetUsd: 0, knownGrossUsd: 0, completeness: "complete" },
    });
    expect(data.flow7d).toBe(0);
    expect(data.flow7dSource).toBe("mint-burn");
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
      dewsBand: null, grade: null, sparklineRows: [],
      hasActiveDepeg: false,
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
      dewsBand: null, grade: null,
      sparklineRows: [{ price: 1 }, { price: 1 }, { price: 1 }],
      hasActiveDepeg: false, mintBurn7d: null,
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

  it("excludes pending OG legs and withholds flow on materialization debt or a scope read failure", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    const now = Math.floor(Date.now() / 1000);
    const end = Math.floor(now / 3600) * 3600;
    const config = getMintBurnConfigsForStablecoin("usdt-tether")[0];
    const pending = { ...config, chain: { ...config.chain, chainId: "synthetic-pending" } };
    MINT_BURN_CONFIGS.push(pending);
    try {
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)")
        .run(JSON.stringify({ peggedAssets: [makeAsset({ id: "usdt-tether", symbol: "USDT" })] }), now);
      sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
        mint_unpriced_event_count, burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
        VALUES ('usdt-tether', 'ethereum', ?, 1, 0, 0, 0, 100, 0, 100)`).run(end - 3600);
      sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
        mint_unpriced_event_count, burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
        VALUES ('usdt-tether', 'synthetic-pending', ?, 1, 0, 0, 0, 1000000, 0, 1000000)`).run(end - 3600);
      for (const config of getMintBurnConfigsForStablecoin("usdt-tether")) {
        await db.batch(mintBurnScanCoverageStatements(db, {
          configKey: mintBurnConfigKey(config), configFingerprint: mintBurnScanFingerprint(config),
          chainId: config.chain.chainId, fromBlock: 1, toBlock: 2, fromTimestamp: end - 7 * 86400,
          toTimestamp: end, finalizedBlock: 2, acceptedAt: now,
        }));
      }
      expect((await handleOg(db, "/api/og/stablecoin/usdt-tether"))?.status).toBe(200);
      const before = lastOgElement<StablecoinCardData>();
      expect(before.props.data.flow7dSource).toBe("mint-burn");
      expect(before.props.data.flow7d).toBe(100);
      sqlite.exec("UPDATE mint_burn_hourly SET mint_unresolved_event_count = 0, burn_unresolved_event_count = 1 WHERE chain_id = 'ethereum'");
      expect((await handleOg(db, "/api/og/stablecoin/usdt-tether"))?.status).toBe(200);
      const unresolved = lastOgElement<StablecoinCardData>();
      expect(unresolved.props.data.flow7dSource).not.toBe("mint-burn");
      sqlite.exec("UPDATE mint_burn_hourly SET burn_unresolved_event_count = 0 WHERE chain_id = 'ethereum'");
      sqlite.prepare("INSERT INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts) VALUES ('usdt-tether', 'ethereum', ?)")
        .run(end - 3600);
      expect((await handleOg(db, "/api/og/stablecoin/usdt-tether"))?.status).toBe(200);
      const after = lastOgElement<StablecoinCardData>();
      expect(after.props.data.flow7dSource).not.toBe("mint-burn");
      sqlite.exec("DROP TABLE mint_burn_admission");
      expect((await handleOg(db, "/api/og/stablecoin/usdt-tether"))?.status).toBe(200);
      const failed = lastOgElement<StablecoinCardData>();
      expect(failed.props.data.flow7dSource).not.toBe("mint-burn");
    } finally {
      MINT_BURN_CONFIGS.splice(MINT_BURN_CONFIGS.indexOf(pending), 1);
      sqlite.close();
    }
  });

  describe("accepted publication and observation admission", () => {
    const nowSec = Math.floor(Date.now() / 1000);

    function mockSafety(source: activeSafetyScoreSource.ActiveSafetyScoreIndex = activeV9()) {
      return vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue(source);
    }

    function activeV9(updatedAt = nowSec) {
      const snapshot = makeWorkerReportCardsV9Response({
        lifecycle: "active", asOfSec: updatedAt - 60, updatedAt,
        cards: [makeWorkerV9Card({ id: "usdt-tether", score: 88, grade: "A+" })],
      });
      return {
        kind: "v9" as const,
        snapshot,
      };
    }

    const renderedCardData = (db: D1Database, path: string) => captureOgData(db, path, StablecoinCard);


    it("renders an explicit cacheable degraded state when compact safety identity is unavailable", async () => {
      const db = makeOgDb();
      const res = await handleOg(db, "/api/og/stablecoin/usdt-tether");

      expect(res?.status).toBe(200);
      const ttl = Number(res?.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1]);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(API_FRESHNESS_MAX_AGE_SEC.stablecoins);
      expect(res?.headers.get("X-Safety-Score-Status")).toBe("degraded");
      const element = lastOgElement<StablecoinCardData>();
      expect(element.props.data).toMatchObject({
        grade: "Unavailable",
        lastUpdated: expect.stringContaining("Safety publication unavailable"),
      });
    });

    it("renders the complete active V9 publication with explicit model provenance", async () => {
      mockSafety();
      const db = makeOgDb();

      const res = await handleOg(db, "/api/og/stablecoin/usdt-tether");

      expect(res?.headers.get("X-Safety-Score-Model")).toBe("v9");
      expect(res?.headers.get("X-Safety-Score-Status")).toBe("current");
      const element = lastOgElement<StablecoinCardData>();
      expect(element.props.data).toMatchObject({
        grade: "A+",
      });
      expect(renderToStaticMarkup(element)).toContain("Methodology v9.0");
      expect(renderToStaticMarkup(element)).not.toContain("V9 GRADE");
    });

    it("labels the served methodology, not the technical model, and preserves its published grade", async () => {
      const source = activeV9();
      source.snapshot.safetyScoreIdentity.methodologyVersion = "10.2";
      source.snapshot.cards[0].grade = "B";
      mockSafety(source);
      const data = await renderedCardData(makeOgDb(), "/api/og/v2/stablecoin/usdt-tether");
      expect(data.grade).toBe("B");
      expect(data.safetyMethodologyVersion).toBe("10.2");
      const markup = renderToStaticMarkup(<StablecoinCard data={data} />);
      expect(markup).toContain("Methodology v10.2");
      expect(markup).not.toContain("V9");
      expect(markup).toContain("Published");
      expect(markup).toContain("Observed");
      expect(markup).not.toContain("position:absolute");
    });

    it("rejects a held index even when its retained accepted clock is recent", async () => {
      const source = activeV9();
      mockSafety({
        kind: "held", reason: "v9-publication-held", detail: "Publication held", snapshot: source.snapshot,
      });
      const response = await handleOg(makeOgDb(), "/api/og/v2/stablecoin/usdt-tether");
      expect(response?.headers.get("X-Safety-Score-Status")).toBe("degraded");
      expect(response?.headers.get("X-Safety-Score-Reason")).toBe("v9-publication-held");
      const element = lastOgElement<StablecoinCardData>();
      expect(element.props.data.grade).toBe("Unavailable");
    });

    it.each(["stablecoin/usdt-tether", "safety-scores"])("fails closed when Safety expires while rendering %s", async (route) => {
      const source = activeV9(nowSec - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 1);
      source.snapshot.asOfSec = source.snapshot.updatedAt;
      advanceRenderClock(nowSec, 2);
      mockSafety(source);
      const response = await handleOg(makeOgDb(), `/api/og/v2/${route}`);
      expectUnavailable(response);
      expect(response?.headers.get("Content-Type")).not.toBe("image/png");
    });

    it("clips cache lifetime and freshness assessment to the post-render clock", async () => {
      advanceRenderClock(nowSec, 3);
      const source = activeV9(nowSec - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 20);
      source.snapshot.asOfSec = source.snapshot.updatedAt;
      mockSafety(source);
      const response = await handleOg(makeOgDb(), "/api/og/v2/safety-scores");
      expect(response?.status).toBe(200);
      expect(response?.headers.get("Cache-Control")).toBe("public, max-age=17, s-maxage=17");
      expect(response?.headers.get("X-Safety-Score-Assessed-At")).toBe(String(nowSec + 3));
      const calls = vi.mocked(satoriStandalone).mock.calls;
      const options = calls[calls.length - 1]?.[1];
      expect(options).toMatchObject({ width: SOCIAL_PREVIEW_WIDTH, height: SOCIAL_PREVIEW_HEIGHT });
    });

    it.each(["stablecoin/usdt-tether", "safety-scores"])("re-admits accepted health and exact identity after rendering %s", async (route) => {
      for (const fault of ["hold", "generation", "policy", "observation", "grade"] as const) {
        const initial = activeV9();
        const next = activeV9();
        if (fault === "generation") next.snapshot.safetyScoreIdentity.publicationGenerationId = "next-generation";
        if (fault === "policy") next.snapshot.safetyScoreIdentity.policyDigest = "b".repeat(64);
        if (fault === "observation") next.snapshot.asOfSec--;
        if (fault === "grade") next.snapshot.cards[0].grade = "B";
        const loader = vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex");
        loader.mockResolvedValueOnce(initial).mockResolvedValueOnce(fault === "hold"
          ? { kind: "held", reason: "v9-publication-held", detail: "held", snapshot: next.snapshot } : next);
        const response = await handleOg(makeOgDb(), `/api/og/v2/${route}`);
        expectUnavailable(response, fault);
        loader.mockRestore();
      }
    });

    it.each(["stale", "future"] as const)("rejects %s coin market observations before rendering", async (fault) => {
      vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
      const marketAt = fault === "future" ? nowSec + 1 : nowSec - API_FRESHNESS_MAX_AGE_SEC.stablecoins - 1;
      vi.mocked(satoriStandalone).mockClear();
      const response = await handleOg(makeOgDb([makeAsset()], marketAt), "/api/og/v2/stablecoin/usdt-tether");
      expectUnavailable(response);
      expect(satoriStandalone).not.toHaveBeenCalled();
    });

    it.each(["stale", "future", "missing"] as const)("withholds a %s coin quote despite a fresh market and Safety publication", async (fault) => {
      vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
      mockSafety();
      const quoteAt = fault === "missing" ? null : fault === "future" ? nowSec + 1 : nowSec - API_FRESHNESS_MAX_AGE_SEC.stablecoins - 1;
      const data = await renderedCardData(makeOgDb([makeAsset({ price: 0.9876, priceObservedAt: quoteAt, priceUpdatedAt: quoteAt })]), "/api/og/v2/stablecoin/usdt-tether");
      expect(data.grade).toBe("A+");
      expect(data.pegPrice).toBeNull();
      expect(data.lastUpdated).toContain("Quote unavailable");
      expect(renderToStaticMarkup(<StablecoinCard data={data} />)).not.toContain("$0.9876");
    });

    it.each(["market", "quote"] as const)("bounds the coin cache by its %s observation after rendering", async (source) => {
      advanceRenderClock(nowSec, 3);
      const nearExpiry = nowSec - API_FRESHNESS_MAX_AGE_SEC.stablecoins + 8;
      const db = makeOgDb([makeAsset({ priceObservedAt: source === "quote" ? nearExpiry : nowSec })], source === "market" ? nearExpiry : nowSec);
      const response = await handleOg(db, "/api/og/v2/stablecoin/usdt-tether");
      expect(response?.headers.get("Cache-Control")).toBe("public, max-age=5, s-maxage=5");
    });

    it.each(["market", "quote"] as const)("fails closed when the coin %s expires during rendering", async (source) => {
      advanceRenderClock(nowSec, 2);
      const nearExpiry = nowSec - API_FRESHNESS_MAX_AGE_SEC.stablecoins + 1;
      const response = await handleOg(makeOgDb([makeAsset({ priceObservedAt: source === "quote" ? nearExpiry : nowSec })],
        source === "market" ? nearExpiry : nowSec), "/api/og/v2/stablecoin/usdt-tether");
      expectUnavailable(response);
    });

    it("renders pipeline gaps without a fabricated NR and visibly labels partial ratings", async () => {
      const source = activeV9();
      source.snapshot.cards = [makeReportCardsV9PipelineGapCard("control", "A", { id: "usdt-tether" })];
      mockSafety(source);
      const db = makeOgDb();
      await handleOg(db, "/api/og/stablecoin/usdt-tether");
      let element = lastOgElement<StablecoinCardData>();
      expect(element.props.data.grade).toBe("Pipeline gap");
      expect(renderToStaticMarkup(element)).not.toContain(">NR<");
      source.snapshot.cards = [makeReportCardsV9PartialCard("exit", "B", { id: "usdt-tether" })];
      await handleOg(db, "/api/og/stablecoin/usdt-tether");
      element = lastOgElement<StablecoinCardData>();
      expect(renderToStaticMarkup(element)).toContain("Partial evidence: pipeline gap");
    });

    it("degrades a structurally valid active V9 publication after two producer cadences", async () => {
      mockSafety(activeV9(nowSec - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - 1));
      const db = makeOgDb();

      const res = await handleOg(db, "/api/og/stablecoin/usdt-tether");

      expect(res?.headers.get("X-Safety-Score-Model")).toBe("v9");
      expect(res?.headers.get("X-Safety-Score-Status")).toBe("degraded");
      expect(res?.headers.get("X-Safety-Score-Reason")).toBe("stale-cache");
      const element = lastOgElement<StablecoinCardData>();
      expect(element.props.data).toMatchObject({
        grade: "Unavailable",
      });
    });

    it.each([60, SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 1, -1])("publishes safety freshness against its accepted generation at age %s", async (age) => {
      vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
      const source = activeV9(nowSec - age);
      mockSafety(source);
      const response = await handleOg(makeOgDb(), "/api/og/safety-scores");
      expect(response?.headers.get("X-Safety-Score-Status")).toBe(age === 60 ? "current" : "degraded");
      expect(response?.headers.get("X-Safety-Score-Updated-At")).toBe(String(source.snapshot.updatedAt));
      expect(response?.headers.get("X-Safety-Score-Generation")).toBe(source.snapshot.safetyScoreIdentity.publicationGenerationId);
      expect(response?.headers.get("X-Safety-Score-Assessed-At")).toBe(String(nowSec));
      expect(response?.headers.get("X-Safety-Score-Freshness-Budget")).toBe(String(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC));
    });

    it("keeps the supplied average score ungraded without inventing a weekly trend", async () => {
      mockSafety();
      await handleOg(makeOgDb(), "/api/og/safety-scores");
      const element = lastOgElement<SafetyScoresCardData>();
      expect(element.props.data.pulseScore).toBe(88);
      const markup = renderToStaticMarkup(element);
      expect(markup).toContain(">88.0<");
      expect(markup).toContain("no aggregate grade");
      expect(markup).toContain("GRADE DISTRIBUTION");
      expect(markup).not.toContain("TOP 3 SAFEST");
      expect(markup).not.toMatch(/vs last week|[\u2190-\u2193]/);
    });

    it("accounts separately for rated, not-rated and pipeline-gap overview members", async () => {
      const source = activeV9();
      source.snapshot.cards.push(makeWorkerV9Card({ id: "not-rated", score: null }),
        makeReportCardsV9PipelineGapCard("control", "A", { id: "quarantined" }));
      source.snapshot.completeness.expectedCount = 3;
      mockSafety(source);
      await handleOg(makeOgDb(), "/api/og/v2/safety-scores");
      const element = lastOgElement<SafetyScoresCardData>();
      expect(element.props.data).toMatchObject({ totalCoins: 3, unavailableCount: 1, coverageRatio: 1 / 3, pulseScore: 88 });
      expect(Object.values(element.props.data.gradeDistribution).reduce((sum, count) => sum + count, 0) + element.props.data.unavailableCount!).toBe(3);
      expect(renderToStaticMarkup(element)).toContain("1 not rated \u00b7 1 unavailable (pipeline gap)");
    });

    it("renders a degraded safety aggregate as unavailable rather than 0.0", async () => {
      const db = makeOgDb();

      const res = await handleOg(db, "/api/og/safety-scores");

      expect(res?.headers.get("X-Safety-Score-Status")).toBe("degraded");
      const element = lastOgElement<SafetyScoresCardData>();
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
        mockSafety(source);
      }
      await handleOg(makeOgDb(), "/api/og/safety-scores");
      const element = lastOgElement<SafetyScoresCardData>();
      expect(element.props.data.coverageRatio).toBe(state === "observed-zero" ? 0 : null);
      const markup = renderToStaticMarkup(element);
      if (state === "observed-zero") expect(markup).toContain(">0%");
      else expect(markup).not.toContain(">0%");
    });

    it("does not round a one-asset coverage gap up to a complete-coverage claim", async () => {
      // 624 expected assets with one genuinely unrated (NR) asset: coverage is
      // rated/expectedCount = 623/624, so the headline may not print 100%.
      vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
      mockSafety({
        kind: "v9",
        snapshot: makeWorkerReportCardsV9Response({
          lifecycle: "active",
          asOfSec: nowSec - 60,
          updatedAt: nowSec,
          cards: [
            ...Array.from({ length: 623 }, (_, index) => makeWorkerV9Card({ id: `rated-${index}`, score: 80 })),
            makeWorkerV9Card({ id: "unrated-active-asset", score: null }),
          ],
        }),
      });
      await handleOg(makeOgDb([makeAsset({ id: "rated-0", symbol: "RATED" })]), "/api/og/safety-scores");

      const element = lastOgElement<SafetyScoresCardData>();
      expect(element.props.data.coverageRatio).toBeCloseTo(623 / 624, 6);
      expect(element.props.data.totalCoins).toBe(624);
      const markup = renderToStaticMarkup(element);
      const distribution = markup.slice(markup.indexOf("GRADE DISTRIBUTION"));
      expect(distribution).toContain(">NR<");
      expect(markup).not.toContain(">100% rated coverage");
      expect(markup).not.toContain(">100.0% rated coverage");
      expect(markup).not.toContain("—");
    });

    it("does not round a measured sliver of safety coverage down to the observed zero", () => {
      const markup = renderToStaticMarkup(<SafetyScoresCard data={{
        gradeDistribution: { "A+": 0, A: 0, "A-": 0, "B+": 0, B: 2, "B-": 0, "C+": 0, C: 0, "C-": 0, D: 0, F: 0, NR: 498 },
        pulseScore: 79.4,
        coverageRatio: 2 / 500,
        totalCoins: 500,
        unavailableCount: 0,
      }} />);
      expect(markup).not.toContain(">0%<");
      expect(markup).not.toContain(">0.0%<");
      expect(markup).not.toContain("—");
    });

  });

  it("returns a no-store 503 when the stablecoins cache has no usable payload", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeOgDb([], nowSec);

    const res = await handleOg(db, "/api/og/stablecoin/usdt-tether");

    // A transient 503 must not be CDN-pinned on share-image URLs (og-4).
    expectUnavailable(res);
    expect(res?.headers.get("Retry-After")).toBe("60");
  });

});

describe("chain OG route", () => {
  const nowSec = Math.floor(Date.now() / 1000);



  const renderedChainData = (db: D1Database) => captureOgData(db, "/api/og/chain/ethereum", ChainCard);

  const ogStamp = (timestamp: number) =>
    new Date(timestamp * 1000).toISOString().slice(0, 16).replace("T", " ");

  it("depends only on the observed market generation, never an unused Safety publication", async () => {
    const marketUpdatedAt = nowSec - 300;
    const safetyLoader = vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex")
      .mockRejectedValue(new Error("unused Safety dependency"));
    const data = await renderedChainData(makeOgDb([makeAsset()], marketUpdatedAt));
    expect(data.totalUsd).toBe(50_000_000);
    expect(data.lastUpdated).toBe(`Market ${ogStamp(marketUpdatedAt)} UTC`);
    expect(safetyLoader).not.toHaveBeenCalled();
  });

  it("renders a figure-free degraded card when a known chain is absent from the aggregate", async () => {
    // Asset with no chain attribution → aggregateChains() emits no chains, so
    // "ethereum" (a CHAIN_META id whose page bakes this og:image URL) is
    // absent from the aggregate and must still resolve to a 200 PNG. Absence
    // is not an observed zero, so the card must not print "$0".
    const db = makeOgDb([makeAsset({ chainCirculating: {}, chains: [] })]);
    vi.mocked(satoriStandalone).mockClear();

    const res = await handleOg(db, "/api/og/chain/ethereum");
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("image/png");
    expect(res?.headers.get("X-Og-Status")).toBe("degraded");
    expect(res?.headers.get("X-Og-Reason")).toBe("chain-not-in-aggregate");

    const element = lastOgElement();
    expect(element.type).toBe(ChainUnavailableCard);
    const markup = renderToStaticMarkup(element);
    expect(markup).toContain("Ethereum Stablecoins");
    expect(markup).toContain("No current supply observation");
    expect(markup).not.toContain("$0");
  });

  it("converts the chain 7d ratio to a percentage before rendering", async () => {
    // Regression: aggregateChains() emits change7dPct as a 0-1 Ratio, but the card
    // renders a "%" suffix. Forwarding the ratio unconverted printed a +8% week as
    // "0.1% 7d" on every chain OG image.
    const db = makeOgDb([
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
    vi.mocked(satoriStandalone).mockClear();

    const res = await handleOg(db, "/api/og/chain/ethereum");
    expect(res?.status).toBe(200);

    const element = lastOgElement<ChainCardData>();
    expect(element.props.data.change7dPercent).toBeCloseTo(8, 6);
    expect(renderToStaticMarkup(element)).toContain("8.0% 7d");
  });

  it("returns 404 for an id outside CHAIN_META", async () => {
    const res = await handleOg(mockD1([]), "/api/og/chain/not-a-chain");
    expect(res?.status).toBe(404);
  });

  it.each(["stale", "future"] as const)("rejects %s chain market generations", async (fault) => {
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const marketAt = fault === "future" ? nowSec + 1 : nowSec - API_FRESHNESS_MAX_AGE_SEC.chains - 1;
    vi.mocked(satoriStandalone).mockClear();
    const response = await handleOg(makeOgDb([makeAsset()], marketAt), "/api/og/chain/ethereum");
    expect(response?.status).toBe(503);
    expect(satoriStandalone).not.toHaveBeenCalled();
  });

  it.each([3, 9])("bounds chain supply freshness at the post-render clock, elapsed=%s", async (elapsed) => {
    advanceRenderClock(nowSec, elapsed);
    const response = await handleOg(makeOgDb([makeAsset()], nowSec - API_FRESHNESS_MAX_AGE_SEC.chains + 8), "/api/og/chain/ethereum");
    expect(response?.status).toBe(elapsed < 8 ? 200 : 503);
    expect(response?.headers.get("Cache-Control")).toBe(elapsed < 8 ? "public, max-age=5, s-maxage=5" : "no-store");
  });

  it.each(["chain", "global"] as const)("preserves unavailable %s supply coverage rather than claiming complete totals or shares", async (gap) => {
    const data = await renderedChainData(makeOgDb([
      makeAsset(),
      makeAsset({ id: "usdc-circle", symbol: "USDC", circulating: gap === "global" ? {} : { peggedUSD: 50_000_000 },
        chainCirculating: gap === "chain" ? { Ethereum: { current: null } } : {} }),
    ]));
    expect(data.totalUsd).toBe(50_000_000);
    expect(data.unavailableSupplyObservationCount).toBe(gap === "chain" ? 1 : 0);
    expect(data.aggregateUnavailableAssetCount).toBe(gap === "global" ? 1 : 0);
    const markup = renderToStaticMarkup(<ChainCard data={data} />);
    expect(markup).toContain("SHARE OF GLOBAL UNAVAILABLE");
    if (gap === "chain") {
      expect(markup).toContain("OBSERVED SUPPLY SUBTOTAL");
      expect(markup).toContain("Shares of observed chain subtotal");
    } else {
      expect(markup).toContain("1 global supply observations unavailable");
    }
  });

});

describe("depeg OG handler aggregation", () => {
  const makeDepegDb = createMockD1Preset([
    { match: "FROM cache WHERE key = ?", rows: [], first: null },
    { match: "peak_deviation_bps", rows: [] },
    { match: "ended_at IS NOT NULL", rows: [] },
    { match: "started_at >", rows: [], first: { count: 0 } },
  ]);

  function incident(stablecoin_id: string, symbol: string, peak_deviation_bps: number) {
    return { stablecoin_id, symbol, direction: "below", peak_deviation_bps, peg_reference: 1 };
  }

  const captureDepegData = (db: D1Database) => captureOgData(db, "/api/og/depeg", DepegCard);

  it("keeps the coin's visible warning on its completed DEWS generation without reading it for depeg cards", async () => {
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
    const db = makeDepegDb([
      { match: "FROM cache WHERE key = ?", matchBinds: ["dews:published-generation"], rows: [pointer], first: pointer },
      { match: "pharos:stress-signals:latest-all", rows: [superseded] },
      { match: "pharos:stress-signals:latest-one", rows: [superseded], first: superseded },
      { match: "FROM stress_signal_publication_rows", rows: [current], first: current },
      { match: "FROM stress_signals", rows: [unpublished], first: unpublished },
      marketTable([makeAsset({ id: "usdt-tether" })], now),
      ...EMPTY_OG_TABLES,
    ]);
    const aggregate = await captureDepegData(db);
    expect(aggregate).not.toHaveProperty("dewsDistribution");
    expect(db.getHistory().some(({ sql }) => /stress_signal|stability_index_samples/.test(sql))).toBe(false);
    await handleOg(db, "/api/og/stablecoin/usdt-tether");
    const element = lastOgElement<StablecoinCardData>();
    expect(element.props.data.dewsBand).toBe("WARNING");
  });


  it("uses current incident quotes independently of removed PSI and DEWS cohorts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const assets = [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 1, priceObservedAt: now - 30 }),
      makeAsset({ id: "usdc-circle", symbol: "USDC", price: 0.99, priceObservedAt: now - 30 }),
      makeAsset({ id: "dai-makerdao", symbol: "DAI", price: null, priceObservedAt: now - 30 }),
      makeAsset({ id: "usds-sky", symbol: "USDS", price: 1, circulating: {}, priceObservedAt: now - 30 }),
    ];
    const db = makeDepegDb([
      marketTable(assets, now - 30),
      { match: "peak_deviation_bps", rows: [
        incident("usdc-circle", "USDC", 5000),
        incident("usdc-circle", "USDC", 4000),
        incident("usds-sky", "USDS", 6000),
        incident("removed", "REMOVED", 9000),
        incident("usr-resolv", "USR", 9000),
      ] },
      { match: "started_at >", rows: [], first: { count: 4 } },
    ]);
    const data = await captureDepegData(db);
    expect(data).toMatchObject({ activeDepegCount: 2, newToday: 4 });
    expect(data.activeDepegs[0]).toMatchObject({ symbol: "USDC", deviationBps: -100, peakBps: -5000 });
    const markup = renderToStaticMarkup(<DepegCard data={data} />);
    expect(markup).toContain("-100 bps (peak -5000)");
    expect(markup).not.toContain("-5000 bps</span>");
  });

  it("excludes reviewed disputes from the OG active, recovered and new-today counts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const open = (stablecoin_id: string, symbol: string, audit_verdict: string | null) => ({
      stablecoin_id, symbol, direction: "below", peak_deviation_bps: -500, peg_reference: 1,
      peg_type: "peggedUSD", source: "live", started_at: now - 60, start_price: 0.995, audit_verdict,
    });
    const closed = (audit_verdict: string | null) => ({
      ended_at: now - 60, close_reason: "recovered-primary", recovery_price: 1, audit_verdict,
    });
    const data = await captureDepegData(makeDepegDb([
      { match: "peak_deviation_bps", rows: [
        open("usdt-tether", "USDT", "confirmed"),
        open("usdc-circle", "USDC", "disputed"),
        open("dai-makerdao", "DAI", "false_positive"),
        open("usds-sky", "USDS", null),
      ] },
      { match: "ended_at IS NOT NULL", rows: [
        closed("confirmed"), closed("disputed"), closed("false_positive"), closed(null),
      ] },
      { match: "started_at >", rows: [], first: { count: 2 } },
    ]));

    expect(data.activeDepegCount).toBe(2);
    expect(data.activeDepegs.map((row) => row.symbol)).toEqual(["USDT", "USDS"]);
    expect(data.recoveredToday).toBe(2);
    expect(data.newToday).toBe(2);
  });

  it("holds a weekend metal deviation instead of printing a live peg move", async () => {
    // Sunday 16:00 UTC: spot metals repeat Friday's close while the token trades.
    const now = 1_794_758_400;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const assets = [
      makeAsset({ id: "xaum-matrixdock", symbol: "XAUm", pegType: "peggedGOLD", price: 3900, circulating: { peggedGOLD: 100e6 }, priceObservedAt: now - 60 }),
      makeAsset({ id: "usdc-circle", symbol: "USDC", price: 1.002, priceObservedAt: now - 60 }),
    ];
    const data = await captureDepegData(makeDepegDb([
      marketTable(assets, now - 60, { peggedGOLD: 4000 }),
      { match: "peak_deviation_bps", rows: [
        { stablecoin_id: "xaum-matrixdock", symbol: "XAUm", direction: "below", peak_deviation_bps: 600, peg_reference: 4000 },
      ] },
    ]));
    expect(data.activeDepegs[0]).toMatchObject({ symbol: "XAUm", deviationBps: null, deviationHeld: true, peakBps: -600 });
    expect(renderToStaticMarkup(<DepegCard data={data} />)).toContain("Reference market closed; peak -600 bps");
  });

  it("keeps missing quotes unavailable without loading removed PSI or DEWS summaries", async () => {
    const db = makeDepegDb();
    const data = await captureDepegData(db);
    expect(data.activeDepegs).toEqual([]);
    expect(data).not.toHaveProperty("psiScore");
    expect(db.getHistory().some(({ sql }) => /stress_signal|stability_index_samples/.test(sql))).toBe(false);
  });

  it.each([
    ["recovered-primary", null, 1], ["recovered-dex", null, 1], ["recovered-native", null, 1],
    [null, 1, 1], [null, null, 0], ["coverage-lost-supply", null, 0],
    ["superseded-direction", 1, 0], ["orphan-tracking-removed", 1, 0], ["unknown", 1, 0],
  ] as const)("counts only classified OG recoveries %s with price %s", async (close_reason, recovery_price, expected) => {
    const now = Math.floor(Date.now() / 1000);
    const data = await captureDepegData(makeDepegDb([
      { match: "ended_at IS NOT NULL", rows: [{ ended_at: now - 60, close_reason, recovery_price }] },
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
    const data = await captureDepegData(makeDepegDb([
      marketTable(assets, now - 30),
      { match: "peak_deviation_bps", rows: [
        incident("usdc-circle", "USDC", 5000),
        incident("usdt-tether", "USDT", 300),
        incident("dai-makerdao", "DAI", 9000),
      ] },
    ]));
    expect(data.activeDepegs.map((row) => row.symbol)).toEqual(["USDT", "USDC", "DAI"]);
    expect(data.activeDepegs[2]).toMatchObject({ deviationBps: null, peakBps: -9000 });
    expect(data.lastUpdated).not.toContain("stale");
    expect(renderToStaticMarkup(<DepegCard data={data} />)).toContain("Current unavailable; peak -9000 bps");
  });

  it("formats market source stamps neutrally beyond their 600s admission budget", async () => {
    const now = Math.floor(Date.now() / 1000);
    const data = await captureDepegData(makeDepegDb([
      marketTable([makeAsset({ id: "usdt-tether", price: 0.98, priceObservedAt: now - 601 })], now - 601),
    ]));
    expect(data.lastUpdated).toContain("Market");
    expect(data.lastUpdated).not.toContain("stale");
    expect(data.lastUpdated).not.toContain("budget");
  });
});

const PSI_BUDGET = API_FRESHNESS_MAX_AGE_SEC.stabilityIndex;
const PSI_PRODUCER_INTERVAL_SEC = CRON_INTERVALS["stability-index"];

describe("stability-index OG handler aggregation", () => {
  const captureStabilityData = (db: D1Database) => captureOgData(db, "/api/og/stability-index", StabilityIndexCard);

  const nowSec = Math.floor(Date.now() / 1000);
  const makePsiDb = createMockD1Preset([
    { match: "WHERE stored_at <= ?", rows: [], first: null },
    { match: "stored_at DESC LIMIT 1", rows: [], first: { score: 73.5, band: "STEADY", stored_at: nowSec } },
    { match: "AVG(score)", rows: [], first: { avg: null } },
    { match: "FROM stability_index ORDER BY computed_at", rows: [] },
    { match: "MAX(score)", rows: [], first: { max: null } },
    { match: "MIN(score)", rows: [], first: { min: null } },
  ]);

  function psiSample(stored_at: number): MockTableConfig {
    return { match: "stored_at DESC LIMIT 1", rows: [], first: { score: 73.5, band: "STEADY", stored_at } };
  }

  it("fails closed when a PSI sample expires during PNG rendering", async () => {
    advanceRenderClock(nowSec, 2);
    const db = makePsiDb([psiSample(nowSec - PSI_BUDGET + 1)]);
    const response = await handleOg(db, "/api/og/v2/stability-index");
    expectUnavailable(response);
    expect(response?.headers.get("Content-Type")).not.toBe("image/png");
  });

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
      const element = lastOgElement<StabilityIndexCardData>();
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

  it("preserves retained extrema in source data without adding more preview microfacts", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare("INSERT INTO stability_index_samples (stored_at, score, band, components, input_snapshot) VALUES (?, ?, 'STEADY', '{}', '{}')");
      insert.run(nowSec - 92 * 86400, 100);
      insert.run(nowSec - 91 * 86400, 0);
      insert.run(nowSec - 2 * 86400, 80);
      insert.run(nowSec, 70);
      sqlite.prepare("INSERT INTO stability_index (computed_at, score, band, components, input_snapshot) VALUES (?, 99, 'BEDROCK', '{}', '{}')").run(nowSec - 86400);
      const beforePrune = await captureStabilityData(db);
      expect([beforePrune.retainedSampleHigh, beforePrune.retainedSampleLow]).toEqual([100, 0]);
      sqlite.prepare("DELETE FROM stability_index_samples WHERE stored_at < ?").run(nowSec - 90 * 86400);
      const data = await captureStabilityData(db);
      expect([data.retainedSampleHigh, data.retainedSampleLow]).toEqual([80, 70]);
      const markup = renderToStaticMarkup(<StabilityIndexCard data={data} />);
      expect(markup).not.toContain("High:");
      expect(markup).not.toContain("Low:");
      expect(markup).toContain("7D AVG");
      expect(markup).not.toMatch(/\b(?:ATH|ATL)\b|all.time/i);
      expect(markup).not.toContain("FLIGHT TO QUALITY");
    } finally {
      sqlite.close();
    }
  });

  it("preserves unavailable window aggregates and insufficient history without synthetic observations", async () => {
    // One history row cannot establish a trend.
    const db = makePsiDb([{ match: "FROM stability_index ORDER BY computed_at", rows: [{ score: 80 }] }]);

    const data = await captureStabilityData(db);
    expect(data.psiScore).toBe(73.5);
    expect(data.psiBand).toBe("STEADY");
    expect(data.delta24h).toBeNull();
    expect(data.avg7d).toBeNull();
    expect(data.retainedSampleHigh).toBeNull();
    expect(data.retainedSampleLow).toBeNull();
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
    const db = makePsiDb([psiSample(sourceAt)]);
    const response = await handleOg(db, "/api/og/stability-index");
    expect(response?.headers.get("X-Data-Updated-At")).toBe(String(sourceAt));
    expect(response?.headers.get("X-Data-Freshness")).toBe("stale");
    expect(response?.headers.get("X-Data-Assessed-At")).toBe(String(nowSec));
    expect(response?.headers.get("X-Data-Freshness-Budget")).toBe(String(API_FRESHNESS_MAX_AGE_SEC.stabilityIndex));
    const markup = renderToStaticMarkup(lastOgElement());
    expect(markup).toContain("Pharos Stability Index");
    expect(markup).toContain("Market-wide Peg Health");
    expect(markup).not.toContain("unavailable");
    expect(markup).not.toContain("stale");
    expect(markup).not.toContain(" UTC");
    expect(markup).not.toContain(">73.5<");
  });

  it.each([
    PSI_BUDGET - 1, PSI_BUDGET, PSI_BUDGET + 1,
    12 * PSI_PRODUCER_INTERVAL_SEC - 1, 12 * PSI_PRODUCER_INTERVAL_SEC, 12 * PSI_PRODUCER_INTERVAL_SEC + 1,
  ])("keeps PSI admission at its own budget and never prints a stale label at %ss", async (age) => {
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const sourceAt = nowSec - age;
    const admitted = age <= PSI_BUDGET;
    const db = makePsiDb([
      psiSample(sourceAt),
      { match: "AVG(score)", rows: [], first: { avg: 70 } },
      { match: "MAX(score)", rows: [], first: { max: 90 } },
      { match: "MIN(score)", rows: [], first: { min: 50 } },
    ]);
    const response = await handleOg(db, "/api/og/stability-index");
    expect(response?.headers.get("X-Data-Updated-At")).toBe(String(sourceAt));
    expect(response?.headers.get("X-Data-Freshness-Budget")).toBe(String(PSI_BUDGET));
    expect(response?.headers.get("X-Data-Freshness")).toBe(admitted ? null : "stale");
    expect(response?.headers.get("X-Data-Freshness-Reason")).toBe(admitted ? null : "psi-source-stale");
    const markup = renderToStaticMarkup(lastOgElement());
    expect(markup).not.toContain("stale");
    expect(markup.includes(">73.5<")).toBe(admitted);
    if (admitted) expect(markup).toContain(new Date(sourceAt * 1000).toISOString().slice(0, 16).replace("T", " "));
  });

  it("renders unavailable without inventing a zero score or MELTDOWN band when no sample exists", async () => {
    const db = makePsiDb([{ match: "stored_at DESC LIMIT 1", rows: [], first: null }]);

    const res = await handleOg(db, "/api/og/stability-index");
    expect(res?.status).toBe(200);
    const markup = renderToStaticMarkup(lastOgElement());

    expect(markup).toContain("Pharos Stability Index");
    expect(markup).not.toContain("unavailable");
    expect(markup).not.toContain("MELTDOWN");
    expect(markup).not.toContain(">0.0<");
  });
});

// Satori render smoke tests
//
// renderToStaticMarkup never catches satori-level failures: satori walks the
// element tree itself and throws on inputs React tolerates (e.g. `undefined`
// style values — its expand loop feeds them to css-to-react-native's
// `.trim()`). Exactly that broke /api/og/stablecoin/* in production for every
// coin (MetricRow's optional marginBottom). Each card template must render
// through the real engine.

describe("og cards render through satori", () => {
  const font = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../../../assets/fonts/${file}`, import.meta.url).href));
  const fonts = [
    { name: "Geist Sans", data: font("Geist-Regular.ttf"), weight: 400 as const, style: "normal" as const },
    { name: "Geist Sans", data: font("Geist-Bold.ttf"), weight: 700 as const, style: "normal" as const },
    { name: "Geist Mono", data: font("GeistMono-Regular.ttf"), weight: 400 as const, style: "normal" as const },
  ];

  const renderSvg = (element: React.ReactNode) => satori(element, { width: SOCIAL_PREVIEW_WIDTH, height: SOCIAL_PREVIEW_HEIGHT, fonts });

  const calmCoin: StablecoinCardData = {
    name: "Tether", symbol: "USDT", grade: "B+", pegPrice: 1.0003, dewsBand: "CALM",
    flow7d: 250_000_000, flow7dSource: "mint-burn",
    sparklineData: [1.0001, 1.0002, 0.9999, 1.0, 1.0001, 1.0003, 1.0002],
    hasActiveDepeg: false,
    variantLabel: null, variantParentSymbol: null, isFrozen: false, lastUpdated: "2026-06-10 07:30 UTC",
  };

  const emptyChain: ChainCardData = {
    name: "Ethereum", totalUsd: 0, change7dPercent: 0, stablecoinCount: 0, dominanceShare: 0,
    unavailableSupplyObservationCount: 0, aggregateUnavailableAssetCount: 0, topStablecoins: [],
  };

  const OG_CARD_FIXTURES = [
    {
      name: "renders the stablecoin card (calm baseline)",
      element: <StablecoinCard data={calmCoin} />,
    },
    {
      name: "renders the stablecoin card with depeg, frozen, and variant branches",
      element: <StablecoinCard data={{
        ...calmCoin, hasActiveDepeg: true, dewsBand: "DANGER", isFrozen: true, variantLabel: "Savings",
        variantParentSymbol: "USDT", grade: "NR", flow7d: -5_000_000,
      }} />,
    },
    {
      name: "renders the safety-scores card",
      element: <SafetyScoresCard data={{
        gradeDistribution: {
          "A+": 2, A: 10, "A-": 12, "B+": 30, B: 40, "B-": 25, "C+": 12, C: 8, "C-": 4, D: 3, F: 1,
        },
        pulseScore: 78.4, coverageRatio: 0.93, totalCoins: 401, unavailableCount: 0,
        lastUpdated: "2026-06-10 07:30 UTC",
      }} />,
    },
    {
      name: "renders the safety-scores unavailable aggregate without a numeric zero",
      element: <SafetyScoresCard data={{
        gradeDistribution: {
          "A+": 0, A: 0, "A-": 0, "B+": 0, B: 0, "B-": 0, "C+": 0, C: 0, "C-": 0, D: 0, F: 0, NR: 0,
        },
        pulseScore: null, coverageRatio: null, totalCoins: 401, unavailableCount: null,
        lastUpdated: "Safety publication unavailable",
      }} />,
    },
    {
      name: "renders the depeg card",
      element: <DepegCard data={{
        activeDepegCount: 3,
        activeDepegs: [
          { symbol: "XAUM", deviationBps: -312 },
          { symbol: "EURS", deviationBps: 145 },
        ],
        recoveredToday: 1, newToday: 2, lastUpdated: "2026-06-10 07:30 UTC",
      }} />,
    },
    {
      name: "renders the chain card",
      element: <ChainCard data={{
        ...emptyChain, totalUsd: 132_000_000_000, change7dPercent: 1.8, stablecoinCount: 214, dominanceShare: 0.52,
        topStablecoins: [
          { symbol: "USDT", share: 0.42 },
          { symbol: "USDC", share: 0.31 },
          { symbol: "DAI", share: 0.04 },
        ],
        lastUpdated: "2026-06-10 07:30 UTC",
      }} />,
    },
    {
      name: "renders the chain card with zero tracked supply (degraded profile)",
      element: <ChainCard data={emptyChain} />,
    },
    {
      name: "renders the chain card with a measured supply sliver",
      element: <ChainCard data={{
        ...emptyChain, name: "Obscure Chain", totalUsd: 1_200_000, change7dPercent: -12.4, stablecoinCount: 1,
        dominanceShare: 0.000004,
        topStablecoins: [{ symbol: "XUSD", share: 1 }],
      }} />,
    },
    {
      name: "renders the stability-index card",
      element: <StabilityIndexCard data={{
        psiScore: 92, psiBand: "BEDROCK", delta24h: 1.3, sparklineData: [90, 92, 94],
        bands: [
          { name: "BEDROCK", active: true },
          { name: "STEADY", active: false },
          { name: "TREMOR", active: false },
          { name: "FRACTURE", active: false },
          { name: "CRISIS", active: false },
          { name: "MELTDOWN", active: false },
        ],
        avg7d: 91.2, retainedSampleHigh: 97.5, retainedSampleLow: 11.4,
        lastUpdated: "2026-06-10 07:30 UTC",
      }} />,
    },
  ];

  it.each(OG_CARD_FIXTURES)("$name", async ({ element }) => {
    const svg = await renderSvg(element);
    expect(svg).toContain("<svg");
  });

  it.each([null, 0])("renders unavailable evidence without converting flow %s to another fact", async (flow7d) => {
    const data: StablecoinCardData = {
      ...calmCoin, pegPrice: null, dewsBand: null,
      flow7d, flow7dSource: flow7d == null ? null : "mint-burn", sparklineData: null,
    };
    const svg = await satori(<StablecoinCard data={data} />, {
      width: SOCIAL_PREVIEW_WIDTH, height: SOCIAL_PREVIEW_HEIGHT, fonts, embedFont: false,
    });
    const visibleText = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]).join(" ").replace(/\s+/g, " ");
    expect(visibleText).toContain("Price history unavailable");
    expect(visibleText).not.toMatch(/\$\s*1\s*\.\s*0000/);
    expect(visibleText).not.toContain("CALM");
    expect(visibleText).not.toMatch(/\+\s*\$/);
    if (flow7d === 0) expect(visibleText).toMatch(/\$\s*0/);
    else expect(visibleText).not.toMatch(/\$\s*0/);
  });


  it("renders unavailable chain history without inventing zero growth", () => {
    const markup = renderToStaticMarkup(<ChainCard data={{
      ...emptyChain, totalUsd: 100, change7dPercent: null, stablecoinCount: 1, dominanceShare: 1,
    }} />);
    expect(markup).toContain("— 7d");
    expect(markup).not.toContain("0.0% 7d");
  });

  it("renders an unavailable global chain share distinctly from observed zero", () => {
    const data: ChainCardData = {
      ...emptyChain, totalUsd: 100, change7dPercent: null, stablecoinCount: 1, dominanceShare: null,
    };
    expect(renderToStaticMarkup(<ChainCard data={data} />)).toContain("Unavailable");
    expect(renderToStaticMarkup(<ChainCard data={data} />)).not.toContain("0.0%");
    expect(renderToStaticMarkup(<ChainCard data={{ ...data, dominanceShare: 0 }} />)).toContain("0.0%");
  });

  it("rounds a measured sliver of global chain supply below 0.1%, never to an observed zero", () => {
    // ~$1.2M of a ~$300B observed global supply is dominanceShare 0.000004.
    const markup = renderToStaticMarkup(<ChainCard data={{
      ...emptyChain, name: "Obscure Chain", totalUsd: 1_200_000, change7dPercent: null, stablecoinCount: 1,
      dominanceShare: 0.000004,
      topStablecoins: [{ symbol: "XUSD", share: 0.000004 }],
    }} />);
    expect(markup).toContain("&lt;0.1%");
    expect(markup).not.toContain("0.0%");
  });

  it("retains every published bucket in legible letter-family totals", () => {
    // 2026-10-27 published V9 dataset: 394 graded assets over 11 letter grades,
    // including the riskiest C- 77, D 82 and F 21 buckets.
    const gradeDistribution: Record<string, number> = {
      "A+": 1, A: 8, "A-": 5, "B+": 8, B: 12, "B-": 29,
      "C+": 72, C: 79, "C-": 77, D: 82, F: 21, NR: 0,
    };
    const markup = renderToStaticMarkup(<SafetyScoresCard data={{
      gradeDistribution, pulseScore: 61.5, coverageRatio: 394 / 624, totalCoins: 624,
      unavailableCount: 230,
    }} />);
    const distribution = markup.slice(markup.indexOf("GRADE DISTRIBUTION"));
    const expectedFamilies = { A: 14, B: 49, C: 228, D: 82, F: 21, NR: 0 };
    expect(Object.values(expectedFamilies).reduce((sum, count) => sum + count, 0)).toBe(394);
    for (const [grade, count] of Object.entries(expectedFamilies)) {
      expect(distribution, `${grade} family`).toContain(`>${grade}<`);
      expect(distribution, `${grade} count`).toContain(`>${count}<`);
    }
  });

});
