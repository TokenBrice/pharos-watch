import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { PSI_HEX_COLORS } from "@shared/lib/classification";
import { CLIENT_ACTIVE_STABLECOINS, CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";
import { makeAsset } from "../../../test-helpers/__shared/fixtures";

const mocks = vi.hoisted(() => ({
  loadStablecoinsCache: vi.fn(),
  handlePegSummary: vi.fn(),
  handleStabilityIndex: vi.fn(),
  handleChains: vi.fn(),
  handleMintBurnFlows: vi.fn(),
  handleDexLiquidity: vi.fn(),
  handleYieldRankings: vi.fn(),
  loadActiveSafetyScoreCohort: vi.fn(),
  projectDependencyGraph: vi.fn(),
}));

vi.mock("../../../lib/stablecoins-cache", () => ({ loadStablecoinsCache: mocks.loadStablecoinsCache }));
vi.mock("../../peg-summary", () => ({ handlePegSummary: mocks.handlePegSummary }));
vi.mock("../../stability-index", () => ({ handleStabilityIndex: mocks.handleStabilityIndex }));
vi.mock("../../chains", () => ({ handleChains: mocks.handleChains }));
vi.mock("../../mint-burn-flows", () => ({ handleMintBurnFlows: mocks.handleMintBurnFlows }));
vi.mock("../../dex-liquidity", () => ({ handleDexLiquidity: mocks.handleDexLiquidity }));
vi.mock("../../yield-rankings-cache", () => ({ handleYieldRankings: mocks.handleYieldRankings }));
vi.mock("../../../lib/safety-score-active-source", () => ({ loadActiveSafetyScoreCohort: mocks.loadActiveSafetyScoreCohort }));
vi.mock("@shared/types/dependency-graph", () => ({ projectDependencyGraph: mocks.projectDependencyGraph }));
// Owner bodies are validated against their published schemas in production; these
// tests exercise the loaders' own decisions, so they read the fixture body as served.
vi.mock("../types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../types")>()),
  readOwnerJson: async (response: Response) => (response.ok ? response.json() : null),
}));

import { OG_PAGE_LOADERS } from "../index";
import { OG_SOURCE_BUDGET_SEC } from "../types";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS, getCacheRatioThresholds } from "@shared/lib/status-thresholds";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../../lib/safety-score-v9/consumer-freshness";

const NOW = 1_790_000_000;
const db = {} as D1Database;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stablecoinsCache(assets: unknown[], updatedAt = NOW - 60) {
  return { kind: "ok", payload: { peggedAssets: assets }, updatedAt };
}

function pegSummary(coins: Array<{ id: string; activeDepeg: boolean }>, asOf = NOW - 60) {
  return json({ coins, summary: null, methodology: { asOf } });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("route-card admission budgets", () => {
  it("admit a figure for as long as its page publishes it as fresh", () => {
    expect(OG_SOURCE_BUDGET_SEC.mintBurnFlows).toBe(API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows * FRESHNESS_RATIOS.FRESH);
    expect(OG_SOURCE_BUDGET_SEC.yieldRankings).toBe(
      Math.max(2 * CRON_INTERVALS["sync-yield-data"]!, API_FRESHNESS_MAX_AGE_SEC.yieldRankings * getCacheRatioThresholds("yield-data").degraded),
    );
    // Sources that publish an explicit fresh budget adopt it instead of the 8x ratio.
    expect(OG_SOURCE_BUDGET_SEC.reportCards).toBe(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC);
  });
});

describe("home route card", () => {
  const coreAssets = () => [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS].map((id) => makeAsset({ id, circulating: { peggedUSD: 1_000_000_000 } }));

  it("publishes the complete core market cap with independently failing support items", async () => {
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets()));
    mocks.handleStabilityIndex.mockRejectedValue(new Error("psi read failed"));
    mocks.handlePegSummary.mockResolvedValue(pegSummary([{ id: [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS][0]!, activeDepeg: true }]));

    const load = await OG_PAGE_LOADERS.home(db, NOW);
    expect(load).toMatchObject({ kind: "ok", asOfSec: NOW - 60, budgetSec: OG_SOURCE_BUDGET_SEC.stablecoins });
    if (load.kind !== "ok") throw new Error("expected a live card");
    expect(load.hero).toMatch(/^\$\d/);
    // The failed PSI read is dropped, not rendered as a zero or a calm band.
    expect(load.support).toEqual(["1 active depeg"]);
  });

  it("swatches the PSI support item with the band it read this render", async () => {
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets()));
    mocks.handleStabilityIndex.mockResolvedValue(json({ current: { score: 91, band: "BEDROCK", avg24h: 92.4, avg24hBand: "STEADY", computedAt: NOW - 60 } }));
    mocks.handlePegSummary.mockResolvedValue(json({ error: "unavailable" }, 503));
    const load = await OG_PAGE_LOADERS.home(db, NOW);
    expect(load).toMatchObject({ kind: "ok", support: [{ text: "PSI Steady 92.4", swatchHex: PSI_HEX_COLORS.STEADY }] });
  });

  it("stays live through one missed producer run and fails closed only past two", async () => {
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets(), NOW - CRON_INTERVALS["sync-stablecoins"]! - 300));
    await expect(OG_PAGE_LOADERS.home(db, NOW)).resolves.toMatchObject({ kind: "ok" });

    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets(), NOW - OG_SOURCE_BUDGET_SEC.stablecoins - 1));
    await expect(OG_PAGE_LOADERS.home(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "stale-cache" });
  });

  it("mirrors the page's known subtotal with its partial note instead of going timeless", async () => {
    const partial = coreAssets();
    partial.pop();
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(partial));
    const expected = CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size;
    await expect(OG_PAGE_LOADERS.home(db, NOW)).resolves.toMatchObject({
      kind: "ok",
      context: "known market cap subtotal of tracked stablecoins",
      stampNote: `Partial · ${expected - 1}/${expected} assets observed`,
    });

    mocks.loadStablecoinsCache.mockResolvedValue({ kind: "error", reason: "missing-cache" });
    await expect(OG_PAGE_LOADERS.home(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "cache-missing" });
  });
});

describe("chains route card", () => {
  const chainsBody = (overrides: Record<string, unknown> = {}) => ({
    chains: [
      { id: "tron", name: "Tron", totalUsd: 30, dominanceShare: 0.3 },
      { id: "ethereum", name: "Ethereum", totalUsd: 50, dominanceShare: 0.5 },
      { id: "bsc", name: "BSC", totalUsd: 10, dominanceShare: 0.1 },
      { id: "base", name: "Base", totalUsd: 5, dominanceShare: 0.05 },
    ],
    globalTotalUsd: 100_000_000_000,
    supplyCoverage: { aggregateUnavailableAssetCount: 0, chainUnavailableObservationCount: 0, chainIdsWithUnavailableObservations: [] },
    updatedAt: NOW - 60,
    ...overrides,
  });

  const coreAssets = () => [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS].map((id) => makeAsset({ id, circulating: { peggedUSD: 1_000_000 } }));

  it("uses a figure-null timeless fallback for unavailable global totals or chain shares", async () => {
    for (const overrides of [
      { globalTotalUsd: null },
      { chains: [{ id: "ethereum", name: "Ethereum", totalUsd: 50, dominanceShare: null }] },
    ]) {
      mocks.handleChains.mockResolvedValue(json(chainsBody(overrides)));
      await expect(OG_PAGE_LOADERS.chains(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "figure-null" });
    }
  });

  it("leads with the largest chain's share, then the next two and the observed total", async () => {
    mocks.handleChains.mockResolvedValue(json(chainsBody()));
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets()));
    const card = await OG_PAGE_LOADERS.chains(db, NOW);
    expect(card).toMatchObject({
      kind: "ok",
      hero: "50.0%",
      context: "of observed supply is on Ethereum, the largest of 4 chains",
      support: ["Tron 30.0%", "BSC 10.0%", "$100.00B observed supply"],
      visual: { kind: "share-bar", shares: [0.5, 0.3, 0.1] },
    });
    expect(card).not.toHaveProperty("stampNote");
  });

  it("labels a partial total with the homepage completeness verdict, counting absent members too", async () => {
    // `supplyCoverage` reports nothing missing; the core member is absent from the cache entirely.
    mocks.handleChains.mockImplementation(async () => json(chainsBody()));
    const partial = coreAssets();
    partial.pop();
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(partial));
    const expected = CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size;
    await expect(OG_PAGE_LOADERS.chains(db, NOW)).resolves.toMatchObject({
      kind: "ok",
      hero: "50.0%",
      support: ["Tron 30.0%", "BSC 10.0%", "$100.00B known supply subtotal"],
      stampNote: `Partial · ${expected - 1}/${expected} assets observed`,
    });

    // The two reads must be one stablecoins generation.
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets(), NOW - 30));
    await expect(OG_PAGE_LOADERS.chains(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "owner-error" });
  });

  it("keeps the share over gaps outside the top two, labelled partial with one Partial prefix", async () => {
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets()));
    mocks.handleChains.mockImplementation(async () => json(chainsBody({
      supplyCoverage: { aggregateUnavailableAssetCount: 0, chainUnavailableObservationCount: 3, chainIdsWithUnavailableObservations: ["base"] },
    })));
    await expect(OG_PAGE_LOADERS.chains(db, NOW)).resolves.toMatchObject({
      kind: "ok",
      hero: "50.0%",
      context: "of observed supply is on Ethereum, the largest of 4 chains · partial",
      stampNote: "Partial · 3 chain observations unavailable",
    });

    // both gaps: the homepage verdict carries the prefix, the chain gap joins it without repeating "Partial"
    const partial = coreAssets();
    partial.pop();
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(partial));
    const expected = CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size;
    await expect(OG_PAGE_LOADERS.chains(db, NOW)).resolves.toMatchObject({
      stampNote: `Partial · ${expected - 1}/${expected} assets observed · 3 chain observations unavailable`,
    });
  });

  it("goes timeless when the leader or runner-up has an unobserved row, since the identity claim is unproven", async () => {
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets()));
    for (const id of ["ethereum", "tron"]) {
      mocks.handleChains.mockResolvedValue(json(chainsBody({
        supplyCoverage: { aggregateUnavailableAssetCount: 0, chainUnavailableObservationCount: 1, chainIdsWithUnavailableObservations: [id] },
      })));
      await expect(OG_PAGE_LOADERS.chains(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "incomplete-coverage" });
    }
  });

  it("drops the bar when chain rows over-attribute supply and goes timeless without a chain or owner body", async () => {
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets()));
    mocks.handleChains.mockResolvedValue(json(chainsBody({
      chains: [
        { id: "ethereum", name: "Ethereum", totalUsd: 60, dominanceShare: 0.6 },
        { id: "tron", name: "Tron", totalUsd: 45, dominanceShare: 0.45 },
      ],
    })));
    const overAttributed = await OG_PAGE_LOADERS.chains(db, NOW);
    expect(overAttributed).toMatchObject({ kind: "ok", hero: "60.0%" });
    expect(overAttributed).not.toHaveProperty("visual");

    mocks.handleChains.mockResolvedValue(json(chainsBody({ chains: [] })));
    await expect(OG_PAGE_LOADERS.chains(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "figure-null" });

    mocks.handleChains.mockResolvedValue(json({ error: "Data not yet available" }, 503));
    await expect(OG_PAGE_LOADERS.chains(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "owner-error" });
  });
});

describe("timeline route card", () => {
  it("counts the full open set over the active registry, keeping an observed zero", async () => {
    const [activeA, activeB] = CLIENT_ACTIVE_STABLECOINS;
    mocks.handlePegSummary.mockResolvedValue(pegSummary([
      { id: activeA!.id, activeDepeg: true },
      { id: activeB!.id, activeDepeg: false },
      { id: "not-a-tracked-coin", activeDepeg: true },
    ]));
    await expect(OG_PAGE_LOADERS.timeline(db, NOW)).resolves.toMatchObject({ kind: "ok", hero: "1", context: "open depeg incident across tracked stablecoins" });

    mocks.handlePegSummary.mockResolvedValue(pegSummary([{ id: activeA!.id, activeDepeg: false }]));
    await expect(OG_PAGE_LOADERS.timeline(db, NOW)).resolves.toMatchObject({ kind: "ok", hero: "0", context: "open depeg incidents across tracked stablecoins" });
  });

  it("never publishes a count from a stale peg summary", async () => {
    mocks.handlePegSummary.mockResolvedValue(pegSummary([], NOW - OG_SOURCE_BUDGET_SEC.pegSummary - 1));
    await expect(OG_PAGE_LOADERS.timeline(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "stale-cache" });
  });
});

describe("flows route card", () => {
  const gauge = (overrides: Record<string, unknown> = {}) => ({
    score: -5.64,
    band: "NEUTRAL",
    partialValuationInputs: 0,
    ...overrides,
  });
  const coin = (pressureShiftScore: number | null) => ({ id: "usdt-tether", pressureShiftScore, mintVolume24hUsd: 0, burnVolume24hUsd: 0 });
  const flowsBody = (gaugeBody: unknown, coins: unknown[] = [coin(-5.64)]) => ({ gauge: gaugeBody, coins, updatedAt: NOW - 60 });

  it("leads with the Bank Run Gauge and its published band, with no net figure", async () => {
    mocks.handleMintBurnFlows.mockResolvedValue(json(flowsBody(gauge())));
    const load = await OG_PAGE_LOADERS.flows(db, NOW);
    expect(load).toMatchObject({
      kind: "ok",
      hero: "\u22126",
      context: "Bank Run Gauge · Neutral · pressure vs each coin's 30-day norm",
      support: [],
    });
    expect(load).not.toHaveProperty("visual");
    expect(load).not.toHaveProperty("stampNote");
    expect(JSON.stringify(load)).not.toMatch(/\$|printed|shredded/i);
  });

  it("keeps the band when withheld weight cannot move it, and names the withheld coins", async () => {
    // -48 with 1% of the weight withheld stays in Stress whatever the withheld intensity.
    mocks.handleMintBurnFlows.mockResolvedValue(json(flowsBody(gauge({
      score: -48, band: "STRESS", partialValuationInputs: 2, scoredMcapUsd: 99, partialValuationMcapUsd: 1,
    }))));
    await expect(OG_PAGE_LOADERS.flows(db, NOW)).resolves.toMatchObject({
      kind: "ok",
      hero: "\u221248",
      context: "Bank Run Gauge · Stress · pressure vs each coin's 30-day norm",
      stampNote: "partial: 2 weighted coins withheld",
    });
  });

  it("drops the band when withheld weight could carry the score across an edge (same rule as the digest)", async () => {
    for (const unsettled of [
      gauge({ score: -48, band: "STRESS", partialValuationInputs: 1, scoredMcapUsd: 50, partialValuationMcapUsd: 50 }),
      // A withheld count without published weights is unbounded.
      gauge({ score: -48, band: "STRESS", partialValuationInputs: 1 }),
    ]) {
      mocks.handleMintBurnFlows.mockResolvedValue(json(flowsBody(unsettled)));
      const load = await OG_PAGE_LOADERS.flows(db, NOW);
      expect(load).toMatchObject({
        kind: "ok",
        hero: "\u221248",
        context: "Bank Run Gauge · pressure vs each coin's 30-day norm",
        stampNote: "band unsettled: 1 weighted coin withheld",
      });
      expect(JSON.stringify(load)).not.toContain("Stress");
    }
  });

  it("falls back to the timeless card when the gauge is not rated, never 0", async () => {
    mocks.handleMintBurnFlows.mockResolvedValue(json(flowsBody(gauge({ score: null, band: null }))));
    await expect(OG_PAGE_LOADERS.flows(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "figure-null" });
  });
});

describe("freezewatch route card", () => {
  const activeAssets = () => CLIENT_ACTIVE_STABLECOINS.map((meta) => makeAsset({ id: meta.id, circulating: { peggedUSD: 1_000_000 } }));

  it("publishes the page's freezable share from complete supply", async () => {
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(activeAssets()));
    const load = await OG_PAGE_LOADERS.freezewatch(db, NOW);
    expect(load).toMatchObject({ kind: "ok" });
    if (load.kind !== "ok") throw new Error("expected a live card");
    expect(load.hero).toMatch(/%$/);
  });

  it("falls back to figure-null when no freeze-exposed member reports supply", async () => {
    const assets = CLIENT_ACTIVE_STABLECOINS
      .filter((meta) => CLIENT_TRACKED_META_BY_ID.get(meta.id)?.blacklistStatus === false)
      .map((meta) => makeAsset({ id: meta.id, circulating: { peggedUSD: 1_000_000 } }));
    expect(assets.length).toBeGreaterThan(0);
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(assets));
    await expect(OG_PAGE_LOADERS.freezewatch(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "figure-null" });
  });

  it("fails closed when supply coverage is partial", async () => {
    const assets = activeAssets();
    assets.pop();
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(assets));
    await expect(OG_PAGE_LOADERS.freezewatch(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "incomplete-coverage" });
  });
});

describe("liquidity route card", () => {
  it("publishes the global DEX TVL and fails closed on invalid coverage evidence", async () => {
    mocks.handleDexLiquidity.mockResolvedValue(json({ __global__: { totalTvlUsd: 4_750_000_000, updatedAt: NOW - 60, unavailableReason: null } }));
    await expect(OG_PAGE_LOADERS.liquidity(db, NOW)).resolves.toMatchObject({ kind: "ok", hero: "$4.75B" });

    mocks.handleDexLiquidity.mockResolvedValue(json({ __global__: { totalTvlUsd: 4_750_000_000, updatedAt: NOW - 60, unavailableReason: "invalid-coverage-evidence" } }));
    await expect(OG_PAGE_LOADERS.liquidity(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "incomplete-coverage" });

    mocks.handleDexLiquidity.mockResolvedValue(json({}));
    await expect(OG_PAGE_LOADERS.liquidity(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "figure-null" });
  });
});

describe("yield route card", () => {
  const row = (id: string, safetyGrade: string | null, apy30d: number) => ({ id, safetyGrade, apy30d, sourceTvlUsd: 1, confidence: 1 });

  it("counts ranked yields and supports with the A/B median, never the top APY", async () => {
    mocks.handleYieldRankings.mockResolvedValue(json({
      rankings: [row("a", "A", 4), row("b", "B+", 6), row("c", "C", 25), row("d", null, 30)],
      updatedAt: NOW - 60,
    }));
    const load = await OG_PAGE_LOADERS.yield(db, NOW);
    expect(load).toMatchObject({ kind: "ok", hero: "4", support: ["Median 30D APY, A/B safety grade: 5.00%"] });
    expect(JSON.stringify(load)).not.toContain("30.00%");
  });

  it("keeps a degraded generation the page still shows and fails closed on a stale verdict", async () => {
    mocks.handleYieldRankings.mockResolvedValue(json({ rankings: [row("a", "A", 4)], updatedAt: NOW - 60, _meta: { status: "degraded" } }));
    await expect(OG_PAGE_LOADERS.yield(db, NOW)).resolves.toMatchObject({ kind: "ok" });
    mocks.handleYieldRankings.mockResolvedValue(json({ rankings: [row("a", "A", 4)], updatedAt: NOW - 60, _meta: { status: "stale" } }));
    await expect(OG_PAGE_LOADERS.yield(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "stale-cache" });
  });
});

describe("dependency-map route card", () => {
  it("serves the timeless card for a held publication", async () => {
    mocks.loadActiveSafetyScoreCohort.mockResolvedValue({ kind: "held", snapshot: {} });
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache([]));
    mocks.projectDependencyGraph.mockReturnValue({ publicationStatus: "held", nodes: [], edges: [], updatedAt: NOW - 60 });
    await expect(OG_PAGE_LOADERS["dependency-map"](db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "held-publication" });
  });

  it("publishes mapped exposure with the older read's stamp", async () => {
    mocks.loadActiveSafetyScoreCohort.mockResolvedValue({ kind: "v9", snapshot: {} });
    mocks.projectDependencyGraph.mockReturnValue({
      publicationStatus: "current",
      publicationGenerationId: "gen-1",
      methodologyVersion: "10.17",
      updatedAt: NOW - 120,
      nodes: [{ id: "dai-makerdao", sharedBookId: null }, { id: "susds-sky", sharedBookId: null }],
      edges: [{ from: "dai-makerdao", to: "susds-sky", kind: "serial", wrapperForm: "pure", weight: 1 }],
    });
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache([
      makeAsset({ id: "dai-makerdao", circulating: { peggedUSD: 1_000 } }),
      makeAsset({ id: "susds-sky", circulating: { peggedUSD: 500 } }),
    ]));
    await expect(OG_PAGE_LOADERS["dependency-map"](db, NOW)).resolves.toMatchObject({
      kind: "ok",
      support: ["1 upstream hubs", "1 direct dependents"],
      stampNote: "methodology v10.17",
      // Stamped with the older read and expiring with the first budget to lapse.
      asOfSec: NOW - 120,
      freshUntilSec: Math.min(NOW - 120 + OG_SOURCE_BUDGET_SEC.reportCards, NOW - 60 + OG_SOURCE_BUDGET_SEC.stablecoins),
    });

    // No dependent with supply: the page publishes no figure, so neither does the card.
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache([makeAsset({ id: "dai-makerdao", circulating: { peggedUSD: 1_000 } })]));
    await expect(OG_PAGE_LOADERS["dependency-map"](db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "figure-null" });
  });
});
